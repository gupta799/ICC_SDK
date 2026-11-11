import { createHash } from 'node:crypto';
import type { CommerceClient } from '../client.js';
import type { Operations } from '../generated/operations.js';
import { UnknownOutcomeError } from '../types.js';
type Cart = Operations['getCheckoutSession']['response'];
type Payment = Operations['completeCheckout']['body'];
type Completed = Operations['completeCheckout']['response'];
/** Persist metadata and hashes, never the payment payload. */
export interface CheckoutAttempt {
    id: string;
    scope: string;
    sessionId: string;
    cartHash: string;
    paymentHash: string;
    state: 'submitting' | 'completed' | 'unknown';
    result?: Completed;
}
export interface AttemptStore {
    get(scope: string, id: string): Promise<CheckoutAttempt | undefined>;
    /** Must atomically insert only if absent. Required for concurrent callers. */
    claim(attempt: CheckoutAttempt): Promise<boolean>;
    save(attempt: CheckoutAttempt): Promise<void>;
}
export class CartChangedError extends Error {
    constructor() {
        super('The checkout changed after approval. Obtain approval for the current cart.');
        this.name = 'CartChangedError';
    }
}
export class AttemptConflictError extends Error {
    constructor() {
        super('This attempt ID is already bound to another session or payment payload.');
        this.name = 'AttemptConflictError';
    }
}
function canonical(value: unknown): string {
    if (value === undefined)
        return 'null';
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(k => record[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Bind approval to purchase-relevant fields rather than transient messages/links. */
export function cartFingerprint(cart: Cart): string {
    return hash({ id: cart.id, status: cart.status, currency: cart.currency,
        line_items: cart.line_items, totals: cart.totals, buyer: cart.buyer,
        fulfillment_address: cart.fulfillment_address,
        fulfillment_options: cart.fulfillment_options,
        fulfillment_option_id: cart.fulfillment_option_id,
        payment_provider: cart.payment_provider });
}
export interface CheckoutOptions {
    client: CommerceClient;
    store: AttemptStore;
    /** Stable merchant/account identity; scopes attempts across tenants. */
    scope: string;
    /** Stable ID for one completion attempt, also used as its idempotency key. */
    attemptId: string;
    sessionId: string;
    payment: Payment;
    approve: (cart: Readonly<Cart>) => Promise<boolean>;
}
/**
 * Complete an existing ACP session after approval and quote revalidation.
 * A claimed attempt is never submitted a second time by this workflow.
 * The server remains responsible for atomically enforcing checkout totals.
 */
export async function completeApprovedCheckout(options: CheckoutOptions): Promise<Completed> {
    const { client, store, scope, attemptId, sessionId, approve } = options;
    if (!scope.trim() || !attemptId.trim())
        throw new Error('scope and attemptId are required');
    // Clone before awaiting anything: callers cannot alter the approved payment mid-flight.
    const payment = structuredClone(options.payment);
    const paymentHash = hash(payment);
    const existing = await store.get(scope, attemptId);
    if (existing) {
        if (existing.sessionId !== sessionId || existing.paymentHash !== paymentHash)
            throw new AttemptConflictError();
        if (existing.state === 'completed' && existing.result)
            return existing.result;
        throw new UnknownOutcomeError('completeCheckout');
    }
    const snapshot = (await client.call('getCheckoutSession', {}, { path: { session_id: sessionId } })).data;
    const approvedHash = cartFingerprint(snapshot);
    if (!await approve(structuredClone(snapshot)))
        throw new Error('Checkout approval declined');
    const current = (await client.call('getCheckoutSession', {}, { path: { session_id: sessionId } })).data;
    if (approvedHash !== cartFingerprint(current))
        throw new CartChangedError();
    const attempt: CheckoutAttempt = { id: attemptId, scope, sessionId,
        cartHash: approvedHash, paymentHash, state: 'submitting' };
    if (!await store.claim(attempt))
        throw new UnknownOutcomeError('completeCheckout');
    try {
        const result = await client.checkout.acp.complete(sessionId, payment, attemptId);
        if (result.data.status !== 'completed')
            throw new UnknownOutcomeError('completeCheckout');
        await store.save({ ...attempt, state: 'completed', result: result.data });
        return result.data;
    }
    catch {
        // Even persistence can fail after Visa/merchant accepted the order. Keep it unresolved.
        try {
            await store.save({ ...attempt, state: 'unknown' });
        }
        catch { /* claim remains */ }
        throw new UnknownOutcomeError('completeCheckout');
    }
}
/**
 * Resolve a claimed attempt using authoritative merchant/processor lookup.
 * Lookup must match the supplied account, session and attempt. No order is resubmitted.
 */
export async function reconcileCheckout(store: AttemptStore, scope: string, attemptId: string, lookup: (attempt: Readonly<CheckoutAttempt>) => Promise<Completed | undefined>): Promise<Completed | undefined> {
    const attempt = await store.get(scope, attemptId);
    if (!attempt)
        throw new Error('Attempt not found');
    if (attempt.state === 'completed')
        return attempt.result;
    const order = await lookup(structuredClone(attempt));
    if (!order)
        return undefined;
    if (order.id !== attempt.sessionId || order.status !== 'completed')
        throw new Error('Reconciliation result does not match a completed checkout session');
    await store.save({ ...attempt, state: 'completed', result: order });
    return order;
}
/** Process-local demo/test implementation. Use durable atomic storage in production. */
export class InMemoryAttemptStore implements AttemptStore {
    private attempts = new Map<string, CheckoutAttempt>();
    private key(scope: string, id: string) { return JSON.stringify([scope, id]); }
    async get(scope: string, id: string) {
        const item = this.attempts.get(this.key(scope, id));
        return item ? structuredClone(item) : undefined;
    }
    async claim(attempt: CheckoutAttempt) {
        const key = this.key(attempt.scope, attempt.id);
        if (this.attempts.has(key))
            return false;
        this.attempts.set(key, structuredClone(attempt));
        return true;
    }
    async save(attempt: CheckoutAttempt) {
        this.attempts.set(this.key(attempt.scope, attempt.id), structuredClone(attempt));
    }
}
