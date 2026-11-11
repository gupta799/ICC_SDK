import contracts from './generated/contracts.json' with { type: 'json' };
import type { Operations } from './generated/operations.js';
import { ValidationError, ApiError, UnknownOutcomeError, type Operation, type Transport, type EvidenceSink, type CallOptions, type Result, type Response } from './types.js';
import { validateRequest } from './validation.js';
export class CommerceClient {
    private transport: Transport;
    private evidence?: EvidenceSink;
    constructor(options: {
        transport: Transport;
        evidence?: EvidenceSink;
    }) { this.transport = options.transport; this.evidence = options.evidence; }
    async call<N extends Operation>(operation: N, body: Operations[N]['body'], options: CallOptions = {}): Promise<Result<Operations[N]['response']>> {
        validateRequest(operation, body);
        const contract = contracts[operation];
        const path = contract.path.replace(/\{([^}]+)\}/g, (_, key: string) => { const v = options.path?.[key]; if (!v)
            throw new ValidationError([`path.${key}: required`]); return encodeURIComponent(v); });
        const headers = { ...options.headers };
        if (operation === 'completeCheckout' || operation === 'ucpCompleteCheckout') {
            const key = Object.entries(headers).find(([k]) => k.toLowerCase() === 'idempotency-key')?.[1];
            if (!key?.trim())
                throw new ValidationError(['Idempotency-Key: required for order completion']);
        }
        options.signal?.throwIfAborted();
        let response: Response;
        try {
            response = await this.transport.send({ operation, method: contract.method, path, body, headers, query: options.query ?? {}, signal: options.signal });
        }
        catch {
            if (contract.method !== 'GET')
                throw new UnknownOutcomeError(operation);
            throw new ApiError(0, 'TRANSPORT_ERROR');
        }
        if (response.status < 200 || response.status >= 300) {
            const b = response.body as {
                reason?: unknown;
            };
            throw new ApiError(response.status, typeof b?.reason === 'string' ? b.reason : undefined);
        }
        let kind: Result<unknown>['kind'] = 'success';
        if (operation === 'retrievePaymentCredentials')
            kind = 'unverified';
        else if (response.status === 202)
            kind = ['submitProductFeedJson', 'confirmTransactionEvents'].includes(operation) ? 'accepted' : 'action_required';
        // Audit failures cannot turn an already completed mutation into an apparent transport failure.
        if (this.evidence)
            try {
                await this.evidence.record({ operation, status: response.status, outcome: kind });
            }
            catch { /* Caller owns monitoring of its evidence sink. */ }
        return { kind, status: response.status, data: response.body as Operations[N]['response'] };
    }
    merchant = {
        register: (body: Operations['registerMerchant']['body']) => this.call('registerMerchant', body),
        get: (merchantId: string) => this.call('getMerchant', undefined, { path: { merchantId } }),
        update: (merchantId: string, body: Operations['updateMerchant']['body']) => this.call('updateMerchant', body, { path: { merchantId } })
    };
    catalog = {
        submit: (body: Operations['submitProductFeedJson']['body']) => this.call('submitProductFeedJson', body),
        status: (jobId: string) => this.call('getFeedJobStatus', {}, { path: { jobId } }),
        list: (page = 0, size = 300) => this.call('getAllProducts', {}, { query: { page, size } })
    };
    checkout = {
        acp: { create: (body: Operations['createCheckoutSession']['body'], options?: CallOptions) => this.call('createCheckoutSession', body, options),
            complete: (sessionId: string, body: Operations['completeCheckout']['body'], idempotencyKey: string) => this.call('completeCheckout', body, { path: { session_id: sessionId }, headers: { 'Idempotency-Key': idempotencyKey } }) },
        ucp: { create: (body: Operations['ucpCreateCheckoutSession']['body'], options?: CallOptions) => this.call('ucpCreateCheckoutSession', body, options),
            complete: (sessionId: string, body: Operations['ucpCompleteCheckout']['body'], idempotencyKey: string) => this.call('ucpCompleteCheckout', body, { path: { session_id: sessionId }, headers: { 'idempotency-key': idempotencyKey } }) }
    };
}
