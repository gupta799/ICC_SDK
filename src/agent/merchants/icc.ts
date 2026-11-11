import { createHash } from 'node:crypto';
import type { CommerceClient } from '../../client.js';
import type { Operations } from '../../generated/operations.js';
import { validateResponse } from '../../response.js';
import type { CheckoutCart, CheckoutPayment } from '../../workflows/checkout.js';
import type { CheckoutContext, MerchantCheckoutConnector, MerchantOrder, PaymentAuthorization,
    PurchaseQuote, QuoteItem, QuoteRequest } from '../types.js';

export interface ICCMerchantConnectorOptions {
    /** Trusted account binding. The supplied client must be configured for this merchant. */
    id: string;
    client: CommerceClient;
    /** Local maximum approval window; this is not a promise about ICC server expiry. */
    quoteLifetimeMs: number;
    merchantName?: string;
    merchantUrl?: string;
    now?: () => number;
    /** Include approved buyer/fulfillment inputs needed to obtain a ready checkout. */
    createRequest?: (request: QuoteRequest) => Operations['createCheckoutSession']['body'] | Promise<Operations['createCheckoutSession']['body']>;
    /** Explicitly map a verified backend credential into this merchant's supported payment format. */
    toCheckoutPayment: (authorization: PaymentAuthorization, request: CheckoutContext) => CheckoutPayment | Promise<CheckoutPayment>;
    /** Authoritative merchant/PSP lookup; must match account, checkout and stable completion key. */
    lookupOrder: (request: CheckoutContext) => Promise<MerchantOrder | undefined>;
}

function canonical(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(key => record[key] !== undefined).sort()
        .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function integer(value: unknown, label: string, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`ICC checkout has invalid ${label}`);
}
function normalizedItems(cart: CheckoutCart): QuoteItem[] {
    const seen = new Set<string>();
    return cart.line_items.map(line => {
        const id = line.item?.id ?? line.id;
        const quantity = line.item?.quantity;
        if (typeof id !== 'string' || !id.trim() || seen.has(id)) throw new Error('ICC checkout requires unique product identifiers');
        integer(quantity, 'item quantity', 1);
        integer(line.total, 'item total');
        seen.add(id);
        return { id, quantity, totalMinor: line.total, ...(line.item?.name === undefined ? {} : { title: line.item.name }) };
    });
}
function total(cart: CheckoutCart): number {
    const totals = cart.totals.filter(part => part.type === 'total');
    if (totals.length !== 1) throw new Error('ICC checkout requires exactly one grand total');
    integer(totals[0].amount, 'grand total');
    return totals[0].amount;
}
function sameItems(left: Pick<QuoteItem, 'id' | 'quantity'>[], right: Pick<QuoteItem, 'id' | 'quantity'>[]): boolean {
    return digest(left.map(({ id, quantity }) => ({ id, quantity })).sort((a, b) => a.id.localeCompare(b.id)))
        === digest(right.map(({ id, quantity }) => ({ id, quantity })).sort((a, b) => a.id.localeCompare(b.id)));
}
/** Capture binding fields before any callback or transport can yield control. */
function checkoutSnapshot(request: CheckoutContext): CheckoutContext {
    return { scope: request.scope, purchaseId: request.purchaseId, customerId: request.customerId,
        quote: structuredClone(request.quote), idempotencyKey: request.idempotencyKey, signal: request.signal };
}
function quoteSnapshot(request: QuoteRequest): QuoteRequest {
    return { scope: request.scope, purchaseId: request.purchaseId, customerId: request.customerId,
        items: structuredClone(request.items), idempotencyKey: request.idempotencyKey, signal: request.signal };
}
function assertOrder(order: MerchantOrder, request: CheckoutContext): void {
    if (!order || order.status !== 'completed' || typeof order.id !== 'string' || !order.id.trim()
        || order.quoteId !== request.quote.id || order.merchantId !== request.quote.merchantId
        || order.currency !== request.quote.currency || order.totalMinor !== request.quote.totalMinor
        || !['unknown', 'authorized', 'captured'].includes(order.paymentStatus))
        throw new Error('ICC merchant order does not match the approved purchase');
}

/** Outbound ACP checkout connector. Does not implement an inbound merchant ACP server or TAP. */
export class ICCMerchantConnector implements MerchantCheckoutConnector {
    readonly id: string;
    private readonly options: ICCMerchantConnectorOptions;
    private readonly now: () => number;
    constructor(options: ICCMerchantConnectorOptions) {
        if (typeof options.id !== 'string' || !options.id.trim()) throw new TypeError('A trusted merchant id is required');
        if (!Number.isSafeInteger(options.quoteLifetimeMs) || options.quoteLifetimeMs <= 0)
            throw new TypeError('quoteLifetimeMs must be a positive safe integer');
        if (typeof options.toCheckoutPayment !== 'function' || typeof options.lookupOrder !== 'function')
            throw new TypeError('Payment mapping and authoritative order lookup are required');
        this.id = options.id;
        this.options = { ...options };
        this.now = options.now ?? Date.now;
    }
    private normalize(cart: CheckoutCart, expiresAt: string): PurchaseQuote {
        if (!cart.id?.trim() || cart.status !== 'ready_for_payment' || !/^[A-Z]{3}$/.test(cart.currency))
            throw new Error('ICC session is not ready for a purchase quote');
        const revision = digest({ id: cart.id, status: cart.status, currency: cart.currency,
            line_items: cart.line_items, totals: cart.totals, buyer: cart.buyer,
            fulfillment_address: cart.fulfillment_address, fulfillment_options: cart.fulfillment_options,
            fulfillment_option_id: cart.fulfillment_option_id, payment_provider: cart.payment_provider });
        return { id: cart.id, merchantId: this.id, currency: cart.currency, totalMinor: total(cart),
            items: normalizedItems(cart), revision, expiresAt,
            ...(this.options.merchantName === undefined ? {} : { merchantName: this.options.merchantName }),
            ...(this.options.merchantUrl === undefined ? {} : { merchantUrl: this.options.merchantUrl }) };
    }
    async quote(request: QuoteRequest): Promise<PurchaseQuote> {
        request = quoteSnapshot(request);
        request.signal?.throwIfAborted();
        const body = this.options.createRequest ? await this.options.createRequest(quoteSnapshot(request))
            : { items: structuredClone(request.items) };
        const result = await this.options.client.checkout.acp.create(body, {
            headers: { 'Idempotency-Key': request.idempotencyKey }, signal: request.signal,
        });
        validateResponse('createCheckoutSession', result.status, result.data);
        const expiresAt = new Date(this.now() + this.options.quoteLifetimeMs).toISOString();
        const quote = this.normalize(result.data, expiresAt);
        if (!sameItems(quote.items, request.items)) throw new Error('ICC checkout does not match the requested products');
        return quote;
    }
    async refresh(request: CheckoutContext): Promise<PurchaseQuote> {
        request = checkoutSnapshot(request);
        if (request.quote.merchantId !== this.id) throw new Error('Checkout belongs to another merchant');
        const result = await this.options.client.checkout.acp.get(request.quote.id, { signal: request.signal });
        validateResponse('getCheckoutSession', result.status, result.data);
        if (result.data.id !== request.quote.id) throw new Error('ICC checkout returned another session');
        // Never extend the original local approval deadline during revalidation.
        return this.normalize(result.data, request.quote.expiresAt);
    }
    async complete(input: CheckoutContext & { authorization: PaymentAuthorization }): Promise<MerchantOrder> {
        const request = checkoutSnapshot(input);
        // The credential is an opaque backend value and may be a non-cloneable handle.
        // Detach the reference and all dispatch bindings; only the credential itself is shared with its mapper.
        const authorization: PaymentAuthorization = {
            reference: { ...input.authorization.reference }, credential: input.authorization.credential,
        };
        const current = await this.refresh(request);
        if (current.revision !== request.quote.revision || current.totalMinor !== request.quote.totalMinor
            || current.currency !== request.quote.currency || !sameItems(current.items, request.quote.items))
            throw new Error('ICC checkout changed before payment submission');
        if (!Number.isFinite(Date.parse(request.quote.expiresAt)) || Date.parse(request.quote.expiresAt) <= this.now()) throw new Error('ICC checkout approval window expired');
        const payment = await this.options.toCheckoutPayment(authorization, checkoutSnapshot(request));
        const result = await this.options.client.checkout.acp.complete(request.quote.id, payment, request.idempotencyKey, { signal: request.signal });
        validateResponse('completeCheckout', result.status, result.data);
        if (result.data.id !== request.quote.id || !result.data.order.id?.trim()
            || (result.data.order.checkout_session_id !== undefined && result.data.order.checkout_session_id !== request.quote.id)
            || !sameItems(normalizedItems(result.data), request.quote.items))
            throw new Error('ICC completion does not match the approved checkout');
        const order: MerchantOrder = { id: result.data.order.id, quoteId: result.data.id, merchantId: this.id,
            currency: result.data.currency, totalMinor: total(result.data), status: 'completed', paymentStatus: 'unknown' };
        assertOrder(order, request);
        return order;
    }
    async lookup(request: CheckoutContext): Promise<MerchantOrder | undefined> {
        request = checkoutSnapshot(request);
        if (request.quote.merchantId !== this.id) throw new Error('Checkout belongs to another merchant');
        const order = await this.options.lookupOrder(checkoutSnapshot(request));
        if (!order) return undefined;
        assertOrder(order, request);
        // Deliberately expose no provider extensions, PANs or raw response objects.
        return { id: order.id, quoteId: order.quoteId, merchantId: order.merchantId,
            currency: order.currency, totalMinor: order.totalMinor, status: 'completed', paymentStatus: order.paymentStatus };
    }
}
