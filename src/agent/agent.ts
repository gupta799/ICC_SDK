import { PurchaseConflictError, PurchaseNotFoundError, PurchasePolicyError, PaymentConfirmationDeferredError,
    type AgentOptions, type ApprovalRequest, type ExecutePurchase, type PreparePurchase, type PurchaseContext,
    type PurchaseRecord, type PurchaseView, type MerchantCheckoutConnector, type CheckoutContext,
    type PaymentAuthorization, type MerchantOrder } from './types.js';
import { validatePurchaseRecord } from './stores.js';
import { enforcePolicy, normalizeItems, normalizeOrder, normalizePolicy, normalizeQuote,
    purchaseOperationKey, purchaseView, stableHash, text, validateContext } from './policy.js';

/** Server-side purchasing orchestration. No credential or authentication evidence enters durable/public state. */
export class PurchasingAgent {
    private readonly merchants: Map<string, MerchantCheckoutConnector>;
    private readonly options: AgentOptions;
    private readonly now: () => number;
    constructor(options: AgentOptions) {
        this.options = { ...options };
        this.now = options.now ?? Date.now;
        this.merchants = new Map();
        text(options.payments.id, 'INVALID_PROVIDER_ID');
        if (typeof options.payments.authorize !== 'function') throw new PurchasePolicyError('INVALID_PROVIDER');
        for (const merchant of options.merchants) {
            text(merchant.id, 'INVALID_MERCHANT_ID');
            if (this.merchants.has(merchant.id)) throw new PurchasePolicyError('DUPLICATE_MERCHANT');
            for (const method of ['quote', 'refresh', 'complete', 'lookup'] as const)
                if (typeof merchant[method] !== 'function') throw new PurchasePolicyError('INVALID_MERCHANT_CONNECTOR');
            this.merchants.set(merchant.id, merchant);
        }
        if (!this.merchants.size) throw new PurchasePolicyError('NO_MERCHANTS');
    }
    private connector(record: Pick<PurchaseRecord, 'merchantId' | 'paymentProviderId'>): MerchantCheckoutConnector {
        const merchant = this.merchants.get(record.merchantId);
        if (!merchant || record.paymentProviderId !== this.options.payments.id) throw new PurchasePolicyError('CONNECTOR_CONFIGURATION_CHANGED');
        return merchant;
    }
    private async record(context: PurchaseContext): Promise<PurchaseRecord> {
        validateContext(context);
        const { scope, purchaseId, customerId } = context;
        const record = await this.options.store.get(scope, purchaseId);
        if (record) validatePurchaseRecord(record);
        if (!record || record.customerId !== customerId || record.scope !== scope || record.id !== purchaseId)
            throw new PurchaseNotFoundError();
        this.connector(record);
        return record;
    }
    private context(record: PurchaseRecord, signal?: AbortSignal): PurchaseContext {
        return { scope: record.scope, purchaseId: record.id, customerId: record.customerId, signal };
    }
    private checkout(record: PurchaseRecord, operation: 'checkout' | 'confirm', signal?: AbortSignal): CheckoutContext {
        return { ...this.context(record, signal), quote: structuredClone(record.quote),
            idempotencyKey: purchaseOperationKey(record.scope, record.id, operation) };
    }
    private approval(record: PurchaseRecord, signal?: AbortSignal): ApprovalRequest {
        return { ...this.context(record, signal), quote: structuredClone(record.quote), policy: structuredClone(record.policy) };
    }
    private async current(record: PurchaseRecord): Promise<PurchaseRecord> {
        return this.record(this.context(record));
    }
    private async transition(record: PurchaseRecord, update: Partial<Pick<PurchaseRecord, 'state' | 'authorization' | 'order' | 'action' | 'reasonCode' | 'confirmation'>>): Promise<PurchaseRecord | undefined> {
        const next = { ...record, ...update, version: record.version + 1 };
        return await this.options.store.compareAndSet(next, record.version) ? next : undefined;
    }
    private async refresh(record: PurchaseRecord, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        enforcePolicy(record.quote, record.policy, record.items, record.merchantId, this.now());
        const current = normalizeQuote(await this.connector(record).refresh(this.checkout(record, 'checkout', signal)));
        enforcePolicy(current, record.policy, record.items, record.merchantId, this.now());
        if (stableHash(current) !== stableHash(record.quote)) throw new PurchasePolicyError('QUOTE_CHANGED');
        signal?.throwIfAborted();
    }
    async prepare(input: PreparePurchase): Promise<PurchaseView> {
        input = { ...input };
        validateContext(input); input.signal?.throwIfAborted();
        const merchantId = text(input.merchantId, 'INVALID_MERCHANT_ID');
        const items = normalizeItems(input.items), policy = normalizePolicy(input.policy);
        const connector = this.merchants.get(merchantId);
        if (!connector || !policy.allowedMerchantIds.includes(merchantId)) throw new PurchasePolicyError('MERCHANT_NOT_ALLOWED');
        if (Date.parse(policy.expiresAt) <= this.now()) throw new PurchasePolicyError('POLICY_EXPIRED');
        const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
        if (!Number.isSafeInteger(quantity) || quantity > policy.maxQuantity) throw new PurchasePolicyError('QUANTITY_EXCEEDED');
        const requestHash = stableHash({ customerId: input.customerId, merchantId, items, policy, paymentProviderId: this.options.payments.id });
        const existing = await this.options.store.get(input.scope, input.purchaseId);
        if (existing) {
            validatePurchaseRecord(existing);
            if (existing.customerId !== input.customerId) throw new PurchaseNotFoundError();
            if (existing.requestHash !== requestHash) throw new PurchaseConflictError();
            this.connector(existing);
            return purchaseView(existing);
        }
        let quote;
        try {
            quote = normalizeQuote(await connector.quote({ scope: input.scope, purchaseId: input.purchaseId, customerId: input.customerId,
                signal: input.signal, items: structuredClone(items), idempotencyKey: purchaseOperationKey(input.scope, input.purchaseId, 'quote') }));
        } catch (error) {
            if (error instanceof PurchasePolicyError) throw error;
            throw new PurchasePolicyError('QUOTE_UNAVAILABLE');
        }
        enforcePolicy(quote, policy, items, merchantId, this.now());
        input.signal?.throwIfAborted();
        const record: PurchaseRecord = { scope: input.scope, id: input.purchaseId, customerId: input.customerId, merchantId,
            requestHash, items, policy, quote, paymentProviderId: this.options.payments.id, state: 'prepared', version: 0,
            confirmation: this.options.payments.confirm ? 'pending' : 'not_required' };
        if (!await this.options.store.create(record)) {
            const winner = await this.options.store.get(input.scope, input.purchaseId);
            if (!winner || winner.customerId !== input.customerId || winner.requestHash !== requestHash) throw new PurchaseConflictError();
            return purchaseView(winner);
        }
        return purchaseView(record);
    }
    async get(context: PurchaseContext): Promise<PurchaseView | undefined> {
        try { return purchaseView(await this.record(context)); }
        catch (error) { if (error instanceof PurchaseNotFoundError) return undefined; throw error; }
    }
    async execute(input: ExecutePurchase): Promise<PurchaseView> {
        input = { ...input };
        input.signal?.throwIfAborted();
        let record = await this.record(input);
        if (!['prepared', 'authentication_required'].includes(record.state)) return purchaseView(record);
        if (typeof input.approve !== 'function' || typeof input.authenticate !== 'function') throw new PurchasePolicyError('TRUSTED_CALLBACKS_REQUIRED');
        const claimed = await this.transition(record, { state: 'approving', action: undefined, reasonCode: undefined });
        if (!claimed) return purchaseView(await this.current(record));
        record = claimed;
        let authorization: PaymentAuthorization | undefined;
        let authorizedStarted = false;
        try {
            await this.refresh(record, input.signal);
            if (await input.approve(this.approval(record, input.signal)) !== true) {
                const declined = await this.transition(record, { state: 'declined', reasonCode: 'APPROVAL_DECLINED' });
                return purchaseView(declined ?? await this.current(record));
            }
            await this.refresh(record, input.signal);
            const authentication = await input.authenticate(this.approval(record, input.signal));
            input.signal?.throwIfAborted();
            if (authentication?.kind === 'action_required') {
                const action = { type: text(authentication.action.type, 'INVALID_AUTHENTICATION_ACTION', 128),
                    id: text(authentication.action.id, 'INVALID_AUTHENTICATION_ACTION', 1024) };
                const pending = await this.transition(record, { state: 'authentication_required', action });
                return purchaseView(pending ?? await this.current(record));
            }
            if (authentication?.kind === 'declined') {
                const declined = await this.transition(record, { state: 'declined', reasonCode: 'AUTHENTICATION_DECLINED' });
                return purchaseView(declined ?? await this.current(record));
            }
            if (authentication?.kind !== 'authenticated' || authentication.evidence === undefined)
                throw new PurchasePolicyError('INVALID_AUTHENTICATION_RESULT');
            await this.refresh(record, input.signal);
            const authorizing = await this.transition(record, { state: 'authorizing' });
            if (!authorizing) return purchaseView(await this.current(record));
            record = authorizing;
            authorizedStarted = true;
            const issued = await this.options.payments.authorize({ ...this.approval(record, input.signal),
                authentication: structuredClone(authentication.evidence), idempotencyKey: purchaseOperationKey(record.scope, record.id, 'authorize') });
            if (!issued || issued.reference?.providerId !== record.paymentProviderId || issued.credential === undefined)
                throw new PurchasePolicyError('INVALID_AUTHORIZATION');
            authorization = { reference: { providerId: record.paymentProviderId, id: text(issued.reference.id, 'INVALID_AUTHORIZATION_REFERENCE', 4096) }, credential: issued.credential };
            const submitting = await this.transition(record, { state: 'submitting', authorization: authorization.reference });
            if (!submitting) return purchaseView(await this.current(record));
            record = submitting;
            await this.refresh(record, input.signal);
            const order = normalizeOrder(await this.connector(record).complete({ ...this.checkout(record, 'checkout', input.signal), authorization }), record.quote);
            const completed = await this.complete(record, order);
            return purchaseView(await this.confirm(completed, input.signal));
        } catch (error) {
            const fresh = await this.current(record);
            if (fresh.state === 'completed') return purchaseView(fresh);
            const code = authorizedStarted ? 'OUTCOME_UNKNOWN' : error instanceof PurchasePolicyError ? error.code : 'APPROVAL_OR_AUTHENTICATION_FAILED';
            if (['approving', 'authorizing', 'submitting'].includes(fresh.state)) {
                const next = await this.transition(fresh, { state: authorizedStarted ? 'unknown' : 'failed', reasonCode: code });
                return purchaseView(next ?? await this.current(fresh));
            }
            return purchaseView(fresh);
        } finally {
            // Remove our references promptly; provider/connector lifecycle and memory protection are app-owned.
            authorization = undefined;
        }
    }
    private async complete(record: PurchaseRecord, order: MerchantOrder): Promise<PurchaseRecord> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const fresh = await this.current(record);
            if (fresh.state === 'completed') return fresh;
            if (!fresh.authorization || !['submitting', 'unknown'].includes(fresh.state)) throw new PurchasePolicyError('COMPLETION_NOT_RECONCILABLE');
            const completed = await this.transition(fresh, { state: 'completed', order, reasonCode: undefined, action: undefined });
            if (completed) return completed;
        }
        throw new PurchasePolicyError('PERSISTENCE_CONFLICT');
    }
    private async confirm(record: PurchaseRecord, signal?: AbortSignal): Promise<PurchaseRecord> {
        if (record.state !== 'completed' || record.confirmation !== 'pending' || !this.options.payments.confirm) return record;
        const sending = await this.transition(record, { confirmation: 'sending' });
        if (!sending) return this.current(record);
        try {
            await this.options.payments.confirm({ ...this.checkout(sending, 'confirm', signal), authorization: structuredClone(sending.authorization!), order: structuredClone(sending.order!) });
            return await this.transition(sending, { confirmation: 'confirmed' }) ?? await this.current(sending);
        } catch (error) {
            return await this.transition(sending, { confirmation: error instanceof PaymentConfirmationDeferredError ? 'pending' : 'unknown' }) ?? await this.current(sending);
        }
    }
    /** Read-only merchant reconciliation. Never authorizes again or resubmits an uncertain checkout. */
    async reconcile(context: PurchaseContext): Promise<PurchaseView> {
        context.signal?.throwIfAborted();
        let record = await this.record(context);
        if (record.state === 'completed') {
            if (record.confirmation === 'sending')
                record = await this.transition(record, { confirmation: 'unknown' }) ?? await this.current(record);
            if (record.confirmation === 'pending' && record.order?.paymentStatus === 'unknown') {
                let order;
                try { order = await this.connector(record).lookup(this.checkout(record, 'checkout', context.signal)); }
                catch { throw new PurchasePolicyError('RECONCILIATION_UNAVAILABLE'); }
                if (order) {
                    const verified = normalizeOrder(order, record.quote);
                    if (verified.id !== record.order.id) throw new PurchasePolicyError('ORDER_DOES_NOT_MATCH_QUOTE');
                    if (verified.paymentStatus !== 'unknown')
                        record = await this.transition(record, { order: verified }) ?? await this.current(record);
                }
            }
            return purchaseView(await this.confirm(record, context.signal));
        }
        if (!['authorizing', 'submitting', 'unknown'].includes(record.state)) return purchaseView(record);
        if (record.authorization) {
            let order;
            try { order = await this.connector(record).lookup(this.checkout(record, 'checkout', context.signal)); }
            catch { throw new PurchasePolicyError('RECONCILIATION_UNAVAILABLE'); }
            if (order) {
                const completed = await this.complete(record, normalizeOrder(order, record.quote));
                return purchaseView(await this.confirm(completed, context.signal));
            }
        }
        record = await this.current(record);
        if (record.state === 'completed') return purchaseView(record);
        if (record.state !== 'unknown') record = await this.transition(record, { state: 'unknown', reasonCode: 'OUTCOME_UNKNOWN' }) ?? await this.current(record);
        return purchaseView(record);
    }
}
