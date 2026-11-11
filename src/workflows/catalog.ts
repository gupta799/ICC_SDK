import { setTimeout as delay } from 'node:timers/promises';
import type { CommerceClient } from '../client.js';
export class FeedFailedError extends Error {
    constructor(public jobId: string) { super(`Catalog feed ${jobId} failed`); }
}
/** Poll a submitted job until ingestion and requested protocol syndication finish. */
export async function waitForCatalog(client: CommerceClient, jobId: string, options: {
    protocols: string[];
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
}) {
    const timeoutMs = options.timeoutMs ?? 60000;
    const intervalMs = options.intervalMs ?? 1000;
    if (timeoutMs <= 0 || intervalMs <= 0)
        throw new Error('Polling intervals must be positive');
    const deadline = Date.now() + timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    while (true) {
        signal.throwIfAborted();
        const job = (await client.call('getFeedJobStatus', {}, { path: { jobId }, signal })).data;
        signal.throwIfAborted();
        const outcomes = options.protocols.map(p => (job.syndication?.[p] as {
            status?: string;
        } | undefined)?.status);
        if (job.status === 'FAILED' || outcomes.includes('FAILED'))
            throw new FeedFailedError(jobId);
        if (job.status === 'COMPLETED' && outcomes.every(s => s === 'SUCCESS')) {
            if ((job.processing?.failureCount ?? 0) > 0)
                throw new FeedFailedError(jobId);
            return job;
        }
        await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
}
