import { createHash } from 'node:crypto';
import type { CommerceClient } from '../client.js';
import type { Operations } from '../generated/operations.js';
import { UnknownOutcomeError, ValidationError } from '../types.js';
import { validateRequest } from '../validation.js';
import { validateResponse } from '../response.js';
export type CheckoutCart = Operations['getCheckoutSession']['response'];
export type CheckoutPayment = Operations['completeCheckout']['body'];
export type CompletedCheckout = Operations['completeCheckout']['response'];

/** Persist metadata and hashes, never the payment payload. Results contain personal order data. */
export interface CheckoutAttempt {
    id: string;
    scope: string;
    sessionId: string;
    cartHash: string;
    paymentHash: string;
    state: 'submitting' | 'completed' | 'unknown';
    result?: CompletedCheckout;
}
export interface AttemptStore {
    get(scope: string, id: string): Promise<CheckoutAttempt | undefined>;
    /** Atomically reserve BOTH (scope,id) and (scope,sessionId). Never expire unresolved claims. */
    claim(attempt: CheckoutAttempt): Promise<boolean>;
    /** Update an existing immutable binding. A completed state must never be overwritten. */
    save(attempt: CheckoutAttempt): Promise<void>;
}
export class CartChangedError extends Error {
    constructor() { super('The checkout changed after approval. Obtain approval for the current cart.'); this.name = 'CartChangedError'; }
}
export class AttemptConflictError extends Error {
    constructor() { super('This attempt ID is already bound to another checkout or payment payload.'); this.name = 'AttemptConflictError'; }
}
export class CheckoutNotReadyError extends Error {
    constructor() { super('The requested checkout is not ready for payment with a valid total.'); this.name = 'CheckoutNotReadyError'; }
}
export class CheckoutApprovalDeclinedError extends Error {
    constructor() { super('Checkout approval declined'); this.name = 'CheckoutApprovalDeclinedError'; }
}
function canonical(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(key => record[key] !== undefined).sort()
        .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Stable upstream key includes the trusted merchant scope to avoid cross-account collisions. */
export function checkoutIdempotencyKey(scope: string, attemptId: string): string {
    return hash(['icc-sdk:checkout:v1', scope, attemptId]);
}
/** Financial and fulfillment fields expected to survive completion unchanged. */
function purchaseFingerprint(cart: CheckoutCart | CompletedCheckout): string {
    return hash({ id: cart.id, currency: cart.currency, line_items: cart.line_items,
        totals: cart.totals.map(({ type, amount }) => ({ type, amount })),
        fulfillment_address: cart.fulfillment_address, fulfillment_option_id: cart.fulfillment_option_id });
}
/** Bind approval to purchase fields, buyer, readiness and available payment/fulfillment options. */
export function cartFingerprint(cart: CheckoutCart): string {
    return hash({ purchase: purchaseFingerprint(cart), status: cart.status, buyer: cart.buyer,
        fulfillment_options: cart.fulfillment_options, payment_provider: cart.payment_provider });
}
function requireReady(cart: CheckoutCart, sessionId: string, payment: CheckoutPayment): void {
    const totals = cart.totals.filter(total => total.type === 'total');
    if (cart.id !== sessionId || cart.status !== 'ready_for_payment' || !/^[A-Z]{3}$/.test(cart.currency)
        || totals.length !== 1 || !Number.isSafeInteger(totals[0].amount) || totals[0].amount < 0
        || (cart.payment_provider?.provider && cart.payment_provider.provider !== payment.payment_data.provider))
        throw new CheckoutNotReadyError();
}
function validateCompleted(result: CompletedCheckout, attempt: CheckoutAttempt): void {
    validateResponse('completeCheckout', 200, result);
    if (result.id !== attempt.sessionId || result.status !== 'completed' || !result.order.id?.trim()
        || (result.order.checkout_session_id && result.order.checkout_session_id !== attempt.sessionId)
        || purchaseFingerprint(result) !== attempt.cartHash)
        throw new Error('Completed checkout does not match the approved purchase');
}
function cached(attempt: CheckoutAttempt, sessionId: string, paymentHash: string): CompletedCheckout {
    if (attempt.sessionId !== sessionId || attempt.paymentHash !== paymentHash) throw new AttemptConflictError();
    if (attempt.state === 'completed' && attempt.result) {
        validateCompleted(attempt.result, attempt);
        return structuredClone(attempt.result);
    }
    throw new UnknownOutcomeError('completeCheckout');
}
export interface CheckoutOptions {
    client: CommerceClient;
    store: AttemptStore;
    /** Trusted, stable merchant/account identity. Never take this directly from request input. */
    scope: string;
    /** Stable ID for one attempt; a scope-derived hash is sent as the upstream idempotency key. */
    attemptId: string;
    sessionId: string;
    payment: CheckoutPayment;
    /** Receives a detached provider cart with the completion buyer applied. Treat it as sensitive. */
    approve: (cart: Readonly<CheckoutCart>) => Promise<boolean>;
    signal?: AbortSignal;
}
/** A claimed checkout session is never submitted a second time, even with a new attempt ID. */
export async function completeApprovedCheckout(options: CheckoutOptions): Promise<CompletedCheckout> {
    const { client, store, scope, attemptId, sessionId, approve, signal } = options;
    if ([scope, attemptId, sessionId].some(value => typeof value !== 'string' || !value.trim()))
        throw new ValidationError(['scope, attemptId and sessionId are required']);
    signal?.throwIfAborted();
    validateRequest('completeCheckout', options.payment);
    const payment = structuredClone(options.payment);
    if (!payment.payment_data.token.trim() || !payment.payment_data.provider.trim())
        throw new ValidationError(['payment_data.token and provider must not be empty']);
    const paymentHash = hash(payment);
    const existing = await store.get(scope, attemptId);
    if (existing) return cached(existing, sessionId, paymentHash);
    const initial = await client.checkout.acp.get(sessionId, { signal });
    validateResponse('getCheckoutSession', initial.status, initial.data);
    const snapshot = structuredClone(initial.data);
    requireReady(snapshot, sessionId, payment);
    const approvedHash = cartFingerprint(snapshot);
    signal?.throwIfAborted();
    const approvalCart = structuredClone(snapshot);
    if (payment.buyer) approvalCart.buyer = structuredClone(payment.buyer);
    if (await approve(approvalCart) !== true) throw new CheckoutApprovalDeclinedError();
    signal?.throwIfAborted();
    const revalidated = await client.checkout.acp.get(sessionId, { signal });
    validateResponse('getCheckoutSession', revalidated.status, revalidated.data);
    requireReady(revalidated.data, sessionId, payment);
    if (approvedHash !== cartFingerprint(revalidated.data)) throw new CartChangedError();
    const attempt: CheckoutAttempt = { id: attemptId, scope, sessionId,
        cartHash: purchaseFingerprint(snapshot), paymentHash, state: 'submitting' };
    signal?.throwIfAborted();
    if (!await store.claim(attempt)) {
        const winner = await store.get(scope, attemptId);
        if (winner) return cached(winner, sessionId, paymentHash);
        throw new UnknownOutcomeError('completeCheckout');
    }
    try {
        const result = await client.checkout.acp.complete(sessionId, payment, checkoutIdempotencyKey(scope, attemptId), { signal });
        validateCompleted(result.data, attempt);
        await store.save({ ...attempt, state: 'completed', result: result.data });
        const persisted = await store.get(scope, attemptId);
        if (!persisted) throw new UnknownOutcomeError('completeCheckout');
        return cached(persisted, sessionId, paymentHash);
    } catch {
        // A write or persistence failure cannot prove whether an order exists. Keep the fence.
        try { await store.save({ ...attempt, state: 'unknown' }); } catch { /* original claim remains */ }
        throw new UnknownOutcomeError('completeCheckout');
    }
}
/**
 * Resolve using authoritative merchant/PSP lookup in this account, by session and derived key.
 * Undefined means still unresolved; it never releases the claim or permits resubmission.
 */
export async function reconcileCheckout(store: AttemptStore, scope: string, attemptId: string,
    lookup: (attempt: Readonly<CheckoutAttempt>) => Promise<CompletedCheckout | undefined>): Promise<CompletedCheckout | undefined> {
    const attempt = await store.get(scope, attemptId);
    if (!attempt) throw new Error('Attempt not found');
    if (attempt.state === 'completed' && attempt.result) {
        validateCompleted(attempt.result, attempt);
        return structuredClone(attempt.result);
    }
    const order = await lookup(structuredClone(attempt));
    if (!order) return undefined;
    validateCompleted(order, attempt);
    await store.save({ ...attempt, state: 'completed', result: structuredClone(order) });
    const persisted = await store.get(scope, attemptId);
    if (!persisted) throw new UnknownOutcomeError('completeCheckout');
    return cached(persisted, attempt.sessionId, attempt.paymentHash);
}
/** Demo/test storage. Use one shared durable store across all production workers. */
export class InMemoryAttemptStore implements AttemptStore {
    private attempts = new Map<string, CheckoutAttempt>();
    private sessions = new Set<string>();
    private key(scope: string, id: string) { return JSON.stringify([scope, id]); }
    async get(scope: string, id: string) {
        const item = this.attempts.get(this.key(scope, id));
        return item ? structuredClone(item) : undefined;
    }
    async claim(attempt: CheckoutAttempt) {
        const key = this.key(attempt.scope, attempt.id);
        const sessionKey = this.key(attempt.scope, attempt.sessionId);
        if (this.attempts.has(key) || this.sessions.has(sessionKey)) return false;
        if (attempt.state !== 'submitting' || attempt.result !== undefined) throw new Error('A claim must begin submitting');
        this.attempts.set(key, structuredClone(attempt));
        this.sessions.add(sessionKey);
        return true;
    }
    async save(attempt: CheckoutAttempt) {
        const key = this.key(attempt.scope, attempt.id);
        const current = this.attempts.get(key);
        if (!current || current.sessionId !== attempt.sessionId || current.paymentHash !== attempt.paymentHash || current.cartHash !== attempt.cartHash)
            throw new AttemptConflictError();
        if (current.state === 'completed') return;
        if (attempt.state === 'submitting' || (attempt.state === 'completed' && !attempt.result))
            throw new Error('Invalid checkout attempt transition');
        this.attempts.set(key, structuredClone(attempt));
    }
}
