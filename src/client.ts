import contracts from './generated/contracts.json' with { type: 'json' };
import type { Operations } from './generated/operations.js';
import { ValidationError, ApiError, UnknownOutcomeError, TransportConfigurationError,
    type Operation, type Transport, type EvidenceSink, type CallOptions, type Result, type Response } from './types.js';
import { validateRequest } from './validation.js';
import { validateResponse } from './response.js';

export interface ClientOptions {
    transport: Transport;
    evidence?: EvidenceSink;
    /** Disable only while investigating documented sandbox contract discrepancies. */
    responseValidation?: 'strict' | 'none';
}

export class CommerceClient {
    private readonly transport: Transport;
    private readonly evidence?: EvidenceSink;
    private readonly responseValidation: 'strict' | 'none';
    constructor(options: ClientOptions) {
        this.transport = options.transport;
        this.evidence = options.evidence;
        this.responseValidation = options.responseValidation ?? 'strict';
        if (!['strict', 'none'].includes(this.responseValidation))
            throw new ValidationError(['responseValidation: expected strict or none']);
    }
    async call<N extends Operation>(operation: N, body: Operations[N]['body'], options: CallOptions = {}): Promise<Result<Operations[N]['response']>> {
        if (!Object.hasOwn(contracts, operation)) throw new ValidationError(['operation: unsupported']);
        options.signal?.throwIfAborted();
        validateRequest(operation, body);
        const contract = contracts[operation];
        const path = contract.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
            const value = options.path?.[key];
            if (typeof value !== 'string' || !value.trim()) throw new ValidationError([`path.${key}: required`]);
            return encodeURIComponent(value);
        });
        const headers: Record<string, string> = {};
        const seen = new Set<string>();
        for (const [name, value] of Object.entries(options.headers ?? {})) {
            const normalized = name.toLowerCase();
            if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) || typeof value !== 'string' || /[\r\n\0]/.test(value))
                throw new ValidationError(['headers: invalid HTTP header']);
            if (seen.has(normalized)) throw new ValidationError(['headers: duplicate header name']);
            seen.add(normalized);
            headers[name] = value;
        }
        if (operation === 'completeCheckout' || operation === 'ucpCompleteCheckout') {
            const key = Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
            if (!key?.trim()) throw new ValidationError(['Idempotency-Key: required for order completion']);
        }
        const query = { ...options.query };
        for (const value of Object.values(query)) {
            if (!((typeof value === 'string') || (typeof value === 'number' && Number.isFinite(value))))
                throw new ValidationError(['query: expected finite numbers or strings']);
        }
        // Snapshot caller-owned data before handing control to an async transport.
        const payload = body === undefined ? undefined : structuredClone(body);
        let response: Response;
        try {
            response = await this.transport.send({ operation, method: contract.method, path, body: payload, headers, query, signal: options.signal });
        } catch (error) {
            if (error instanceof TransportConfigurationError) throw error;
            if (contract.method !== 'GET') throw new UnknownOutcomeError(operation);
            options.signal?.throwIfAborted();
            throw new ApiError(0, 'TRANSPORT_ERROR');
        }
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
            if (contract.method !== 'GET') throw new UnknownOutcomeError(operation);
            throw new ApiError(0, 'INVALID_HTTP_STATUS');
        }
        if (response.status < 200 || response.status >= 300) {
            const reason = (response.body as { reason?: unknown } | null)?.reason;
            // Reason codes, unlike response prose, may be safely used for classification.
            throw new ApiError(response.status, typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason) ? reason : undefined);
        }
        if (this.responseValidation === 'strict') validateResponse(operation, response.status, response.body);
        let kind: Result<unknown>['kind'] = 'success';
        if (operation === 'retrievePaymentCredentials') kind = 'unverified';
        else if (response.status === 202)
            kind = ['submitProductFeedJson', 'confirmTransactionEvents'].includes(operation) ? 'accepted' : 'action_required';
        if (this.evidence) {
            try { await this.evidence.record({ operation, status: response.status, outcome: kind }); }
            catch { /* Sink delivery is best effort; no payment material is sent to it. */ }
        }
        return { kind, status: response.status, data: response.body as Operations[N]['response'], headers: response.headers };
    }
    merchant = {
        register: (body: Operations['registerMerchant']['body'], options?: CallOptions) => this.call('registerMerchant', body, options),
        get: (merchantId: string, options?: CallOptions) => this.call('getMerchant', undefined, { ...options, path: { merchantId } }),
        update: (merchantId: string, body: Operations['updateMerchant']['body'], options?: CallOptions) => this.call('updateMerchant', body, { ...options, path: { merchantId } }),
    };
    catalog = {
        submit: (body: Operations['submitProductFeedJson']['body'], options?: CallOptions) => this.call('submitProductFeedJson', body, options),
        status: (jobId: string, options?: CallOptions) => this.call('getFeedJobStatus', {}, { ...options, path: { jobId } }),
        list: (page = 0, size = 300, options?: CallOptions) => this.call('getAllProducts', {}, { ...options, query: { ...options?.query, page, size } }),
    };
    checkout = {
        acp: {
            create: (body: Operations['createCheckoutSession']['body'], options?: CallOptions) => this.call('createCheckoutSession', body, options),
            get: (sessionId: string, options?: CallOptions) => this.call('getCheckoutSession', {}, { ...options, path: { session_id: sessionId } }),
            update: (sessionId: string, body: Operations['updateCheckoutSession']['body'], options?: CallOptions) => this.call('updateCheckoutSession', body, { ...options, path: { session_id: sessionId } }),
            cancel: (sessionId: string, options?: CallOptions) => this.call('cancelCheckout', undefined, { ...options, path: { session_id: sessionId } }),
            complete: (sessionId: string, body: Operations['completeCheckout']['body'], idempotencyKey: string, options?: CallOptions) => this.call('completeCheckout', body, completionOptions(sessionId, idempotencyKey, options)),
        },
        ucp: {
            create: (body: Operations['ucpCreateCheckoutSession']['body'], options?: CallOptions) => this.call('ucpCreateCheckoutSession', body, options),
            get: (sessionId: string, options?: CallOptions) => this.call('ucpGetCheckoutSession', {}, { ...options, path: { session_id: sessionId } }),
            update: (sessionId: string, body: Operations['ucpUpdateCheckoutSession']['body'], options?: CallOptions) => this.call('ucpUpdateCheckoutSession', body, { ...options, path: { session_id: sessionId } }),
            cancel: (sessionId: string, options?: CallOptions) => this.call('ucpCancelCheckout', undefined, { ...options, path: { session_id: sessionId } }),
            complete: (sessionId: string, body: Operations['ucpCompleteCheckout']['body'], idempotencyKey: string, options?: CallOptions) => this.call('ucpCompleteCheckout', body, completionOptions(sessionId, idempotencyKey, options)),
        },
    };
}
function completionOptions(sessionId: string, key: string, options?: CallOptions): CallOptions {
    const headers = Object.fromEntries(Object.entries(options?.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'idempotency-key'));
    return { ...options, path: { session_id: sessionId }, headers: { ...headers, 'Idempotency-Key': key } };
}
