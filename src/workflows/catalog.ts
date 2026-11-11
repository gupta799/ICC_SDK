import { setTimeout as delay } from 'node:timers/promises';
import type { CommerceClient } from '../client.js';
import type { Operations } from '../generated/operations.js';
import { ResponseValidationError } from '../types.js';

export class FeedFailedError extends Error {
    constructor(
        public jobId: string,
        public phase: 'ingestion' | 'syndication' = 'ingestion',
        public protocol?: string,
    ) {
        super(`Catalog feed ${jobId} failed during ${phase}`);
        this.name = 'FeedFailedError';
    }
}

export interface CatalogWaitOptions {
    /** Wait for each named protocol in addition to successful ingestion. Empty means ingestion only. */
    protocols: string[];
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
}

type FeedJob = Operations['getFeedJobStatus']['response'];
const ingestionStates = new Set(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']);
const syndicationStates = new Set(['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/** The contract makes fields optional; the workflow requires a usable lifecycle state. */
function validateJob(job: FeedJob, expectedId: string, status: number): void {
    const issues: string[] = [];
    if (!isRecord(job)) {
        issues.push('$: expected catalog job object');
    } else {
        if (!ingestionStates.has(job.status as string))
            issues.push('$.status: expected a documented ingestion state');
        if (job.jobId !== undefined && job.jobId !== expectedId)
            issues.push('$.jobId: does not match requested job');
        if (job.processing !== undefined) {
            if (!isRecord(job.processing)) {
                issues.push('$.processing: expected object');
            } else {
                for (const key of ['totalSubmitted', 'successCount', 'failureCount'] as const) {
                    const count = job.processing[key];
                    if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0))
                        issues.push(`$.processing.${key}: expected nonnegative safe integer`);
                }
            }
        }
        if (job.syndication !== undefined) {
            if (!isRecord(job.syndication)) {
                issues.push('$.syndication: expected object');
            } else {
                for (const [protocol, outcome] of Object.entries(job.syndication)) {
                    if (!isRecord(outcome) || (outcome.status !== undefined && !syndicationStates.has(outcome.status as string)))
                        issues.push(`$.syndication.${protocol}.status: expected a documented syndication state`);
                }
            }
        }
    }
    if (issues.length)
        throw new ResponseValidationError('getFeedJobStatus', status, issues);
}

/** Stops waiting at the deadline even when a configured transport cannot cancel its request. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Poll a submitted job until ingestion and all requested protocol syndication finish.
 * Rejected records fail immediately. Polling never resubmits the feed.
 */
export async function waitForCatalog(client: CommerceClient, jobId: string, options: CatalogWaitOptions): Promise<FeedJob> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 1_000;
    for (const [name, value] of Object.entries({ timeoutMs, intervalMs })) {
        // Node timers clamp larger values to 1ms. Reject instead of silently spinning.
        if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647)
            throw new RangeError(`${name} must be a positive integer no greater than 2147483647`);
    }
    if (typeof jobId !== 'string' || !jobId.trim())
        throw new TypeError('jobId is required');
    if (!Array.isArray(options.protocols) || options.protocols.some(p => typeof p !== 'string' || !p.trim()))
        throw new TypeError('protocols must contain nonempty protocol names');
    // Copy before awaiting so caller mutation cannot weaken the requested readiness check.
    const protocols = [...new Set(options.protocols)];
    const deadlineController = new AbortController();
    const timer = setTimeout(() => deadlineController.abort(new DOMException('Catalog polling timed out', 'TimeoutError')), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadlineController.signal]) : deadlineController.signal;
    try {
        while (true) {
            signal.throwIfAborted();
            const result = await withSignal(client.call('getFeedJobStatus', {}, { path: { jobId }, signal }), signal);
            signal.throwIfAborted();
            const job = result.data;
            validateJob(job, jobId, result.status);
            if (job.status === 'FAILED' || (job.processing?.failureCount ?? 0) > 0)
                throw new FeedFailedError(jobId);
            const outcomes = protocols.map(protocol => ({ protocol, status: (job.syndication?.[protocol] as { status?: string } | undefined)?.status }));
            const failed = outcomes.find(outcome => outcome.status === 'FAILED');
            if (failed)
                throw new FeedFailedError(jobId, 'syndication', failed.protocol);
            if (job.status === 'COMPLETED' && outcomes.every(outcome => outcome.status === 'SUCCESS'))
                return job;
            await delay(intervalMs, undefined, { signal });
        }
    } catch (error) {
        if (signal.aborted)
            throw signal.reason;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
