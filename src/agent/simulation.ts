import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalRequest, AuthorizationRequest, CheckoutContext, ConfirmationRequest,
    ConsumerAuthenticator, MerchantCheckoutConnector, MerchantOrder, PaymentAuthorization,
    PaymentAuthorizationProvider, PurchaseItem, PurchaseQuote, QuoteRequest } from './types.js';

export interface SimulatedProduct { id: string; title: string; unitAmountMinor: number; inventory: number }
export interface SimulatedCommerceOptions {
    merchantId?: string;
    currency?: string;
    catalog?: SimulatedProduct[];
    quoteLifetimeMs?: number;
    /** Integer basis points; taxes are rounded once on the item subtotal. */
    taxBps?: number;
    shippingMinor?: number;
    now?: () => number;
}
export interface SimulationStats { quotes: number; authorizations: number; orders: number; confirmations: number }

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function positiveInteger(value: unknown, label: string, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`${label} must be a safe integer of at least ${minimum}`);
}
function sameContext(left: { scope: string; customerId: string; purchaseId: string }, right: { scope: string; customerId: string; purchaseId: string }): boolean {
    return left.scope === right.scope && left.customerId === right.customerId && left.purchaseId === right.purchaseId;
}
function opaqueString(value: unknown, property: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const field = (value as Record<string, unknown>)[property];
    return typeof field === 'string' ? field : undefined;
}

/** Explicit opt-in local commerce engine. Synthetic authentication and credentials never represent Visa access. */
export function createSimulatedCommerce(options: SimulatedCommerceOptions = {}) {
    const id = options.merchantId ?? 'simulation-store';
    const currency = options.currency ?? 'USD';
    const lifetime = options.quoteLifetimeMs ?? 300_000;
    const taxBps = options.taxBps ?? 0;
    const shippingMinor = options.shippingMinor ?? 0;
    const now = options.now ?? Date.now;
    if (typeof id !== 'string' || !id.trim() || !/^[A-Z]{3}$/.test(currency)) throw new TypeError('Invalid simulation merchant or currency');
    positiveInteger(lifetime, 'quoteLifetimeMs', 1);
    positiveInteger(taxBps, 'taxBps');
    if (taxBps > 10_000) throw new TypeError('taxBps must not exceed 10000');
    positiveInteger(shippingMinor, 'shippingMinor');
    const products = new Map<string, SimulatedProduct>();
    for (const product of options.catalog ?? [
        { id: 'headphones', title: 'Simulation headphones', unitAmountMinor: 7_500, inventory: 10 },
        { id: 'mug', title: 'Simulation mug', unitAmountMinor: 1_500, inventory: 20 },
    ]) {
        if (!product.id?.trim() || typeof product.title !== 'string' || products.has(product.id)) throw new TypeError('Simulation catalog IDs must be unique');
        positiveInteger(product.unitAmountMinor, 'unitAmountMinor');
        positiveInteger(product.inventory, 'inventory');
        products.set(product.id, { ...product });
    }
    interface QuoteEntry { context: QuoteRequest; quote: PurchaseQuote; requestHash: string }
    interface AuthorizationEntry { context: AuthorizationRequest; referenceId: string; token: string; used: boolean; confirmation?: string }
    interface OrderEntry { context: CheckoutContext; order: MerchantOrder; key: string }
    const quotes = new Map<string, QuoteEntry>();
    const quoteKeys = new Map<string, string>();
    const authentication = new Map<string, ApprovalRequest>();
    const authorizationKeys = new Map<string, string>();
    const authorizations = new Map<string, AuthorizationEntry>();
    const orderKeys = new Map<string, OrderEntry>();
    const orders = new Map<string, OrderEntry>();
    let confirmations = 0;
    let loseCompletion = false;
    let failConfirmation = false;
    const key = (scope: string, value: string) => JSON.stringify([scope, value]);
    function calculate(items: PurchaseItem[], quoteId: string, expiresAt: string): PurchaseQuote {
        if (!items.length) throw new Error('Simulation quote requires products');
        const seen = new Set<string>();
        let subtotal = 0;
        const lines = items.map(item => {
            if (typeof item.id !== 'string' || seen.has(item.id)) throw new Error('Simulation products must be unique');
            positiveInteger(item.quantity, 'quantity', 1);
            const product = products.get(item.id);
            if (!product || product.inventory < item.quantity) throw new Error('Simulation product unavailable');
            seen.add(item.id);
            const totalMinor = product.unitAmountMinor * item.quantity;
            positiveInteger(totalMinor, 'line total');
            subtotal += totalMinor;
            positiveInteger(subtotal, 'subtotal');
            return { id: item.id, title: product.title, quantity: item.quantity, totalMinor };
        });
        // BigInt avoids unsafe intermediate multiplication for large minor-unit totals.
        const tax = Number((BigInt(subtotal) * BigInt(taxBps) + 5_000n) / 10_000n);
        const totalMinor = subtotal + tax + shippingMinor;
        positiveInteger(totalMinor, 'grand total');
        const revision = digest({ id: quoteId, merchantId: id, currency, totalMinor, items: lines, tax, shippingMinor });
        return { id: quoteId, merchantId: id, merchantName: 'Simulation Store', merchantUrl: 'https://simulation.invalid',
            currency, totalMinor, items: lines, expiresAt, revision };
    }
    function entryFor(context: CheckoutContext): QuoteEntry {
        const entry = quotes.get(context.quote.id);
        if (!entry || context.quote.merchantId !== id || !sameContext(entry.context, context)) throw new Error('Simulation quote does not belong to this purchase');
        return entry;
    }
    function currentQuote(context: CheckoutContext): PurchaseQuote {
        const entry = entryFor(context);
        return calculate(entry.context.items, entry.quote.id, entry.quote.expiresAt);
    }
    function assertCurrent(context: CheckoutContext): void {
        const current = currentQuote(context);
        if (current.revision !== context.quote.revision || current.totalMinor !== context.quote.totalMinor || current.currency !== context.quote.currency)
            throw new Error('Simulation quote changed');
        if (Date.parse(current.expiresAt) <= now()) throw new Error('Simulation quote expired');
    }
    const authenticate: ConsumerAuthenticator = async request => {
        request.signal?.throwIfAborted();
        assertCurrent({ ...request, idempotencyKey: 'authentication' });
        const assertion = randomUUID();
        authentication.set(assertion, { ...request, quote: structuredClone(request.quote), policy: structuredClone(request.policy), signal: undefined });
        return { kind: 'authenticated', evidence: { simulation: true, assertion } };
    };
    const payments: PaymentAuthorizationProvider = {
        id: 'simulation-payments',
        async authorize(request) {
            request.signal?.throwIfAborted();
            assertCurrent(request);
            const assertion = opaqueString(request.authentication, 'assertion');
            const proof = assertion ? authentication.get(assertion) : undefined;
            if (!proof || !sameContext(proof, request) || proof.quote.revision !== request.quote.revision)
                throw new Error('Synthetic authentication is required for this simulation purchase');
            const cacheKey = key(request.scope, request.idempotencyKey);
            const priorId = authorizationKeys.get(cacheKey);
            if (priorId) {
                const prior = authorizations.get(priorId)!;
                if (!sameContext(prior.context, request) || prior.context.quote.revision !== request.quote.revision)
                    throw new Error('Simulation authorization key was reused for another purchase');
                return { reference: { providerId: payments.id, id: prior.referenceId }, credential: { simulation: true, token: prior.token } };
            }
            const referenceId = `simulation-auth-${randomUUID()}`;
            const token = randomUUID();
            authorizations.set(referenceId, { referenceId, token, context: { ...request, authentication: undefined,
                signal: undefined, quote: structuredClone(request.quote), policy: structuredClone(request.policy) }, used: false });
            authorizationKeys.set(cacheKey, referenceId);
            // Authentication assertions are single-use for new authorizations.
            authentication.delete(assertion!);
            return { reference: { providerId: payments.id, id: referenceId }, credential: { simulation: true, token } };
        },
        async confirm(request: ConfirmationRequest) {
            request.signal?.throwIfAborted();
            const authorization = authorizations.get(request.authorization.id);
            const order = orders.get(request.order.quoteId);
            if (request.authorization.providerId !== payments.id || !authorization || !order
                || !sameContext(authorization.context, request) || !sameContext(order.context, request)
                || order.order.id !== request.order.id || !authorization.used)
                throw new Error('Simulation confirmation does not match an order');
            if (failConfirmation) { failConfirmation = false; throw new Error('Simulated confirmation response loss'); }
            if (authorization.confirmation && authorization.confirmation !== request.idempotencyKey)
                throw new Error('Simulation confirmation already recorded with another key');
            if (!authorization.confirmation) { authorization.confirmation = request.idempotencyKey; confirmations++; }
        },
    };
    const merchant: MerchantCheckoutConnector = {
        id,
        async quote(request) {
            request.signal?.throwIfAborted();
            const requestHash = digest({ items: request.items, customerId: request.customerId, purchaseId: request.purchaseId });
            const cacheKey = key(request.scope, request.idempotencyKey);
            const priorId = quoteKeys.get(cacheKey);
            if (priorId) {
                const entry = quotes.get(priorId)!;
                if (entry.requestHash !== requestHash) throw new Error('Simulation quote key was reused for another request');
                return structuredClone(entry.quote);
            }
            const quoteId = `simulation-quote-${digest(cacheKey).slice(0, 24)}`;
            const quote = calculate(request.items, quoteId, new Date(now() + lifetime).toISOString());
            quotes.set(quote.id, { context: { ...request, items: structuredClone(request.items), signal: undefined }, quote: structuredClone(quote), requestHash });
            quoteKeys.set(cacheKey, quote.id);
            return quote;
        },
        async refresh(request) { request.signal?.throwIfAborted(); return currentQuote(request); },
        async complete(request: CheckoutContext & { authorization: PaymentAuthorization }) {
            request.signal?.throwIfAborted();
            const cacheKey = key(request.scope, request.idempotencyKey);
            const existing = orderKeys.get(cacheKey);
            if (existing) {
                if (!sameContext(existing.context, request) || existing.order.quoteId !== request.quote.id)
                    throw new Error('Simulation completion key was reused for another order');
                return structuredClone(existing.order);
            }
            assertCurrent(request);
            if (orders.has(request.quote.id)) throw new Error('Simulation quote already completed');
            const authorization = authorizations.get(request.authorization.reference.id);
            if (request.authorization.reference.providerId !== payments.id || !authorization || authorization.used
                || !sameContext(authorization.context, request) || authorization.context.quote.revision !== request.quote.revision
                || opaqueString(request.authorization.credential, 'token') !== authorization.token)
                throw new Error('Simulation payment credential is invalid for this purchase');
            const order: MerchantOrder = { id: `simulation-order-${randomUUID()}`, quoteId: request.quote.id,
                merchantId: id, currency, totalMinor: request.quote.totalMinor, status: 'completed', paymentStatus: 'unknown' };
            // No await between availability checks, credential consumption, inventory changes and order insertion.
            for (const item of request.quote.items) products.get(item.id)!.inventory -= item.quantity;
            authorization.used = true;
            const entry: OrderEntry = { context: { scope: request.scope, purchaseId: request.purchaseId,
                customerId: request.customerId, idempotencyKey: request.idempotencyKey, quote: structuredClone(request.quote) }, order, key: cacheKey };
            orderKeys.set(cacheKey, entry); orders.set(request.quote.id, entry);
            if (loseCompletion) { loseCompletion = false; throw new Error('Simulated completion response loss after order placement'); }
            return structuredClone(order);
        },
        async lookup(request) {
            request.signal?.throwIfAborted();
            entryFor(request);
            const entry = orders.get(request.quote.id);
            if (!entry) return undefined;
            if (!sameContext(entry.context, request) || entry.key !== key(request.scope, request.idempotencyKey))
                throw new Error('Simulation lookup key does not match the submitted order');
            return structuredClone(entry.order);
        },
    };
    return {
        simulation: true as const, merchant, payments, authenticate,
        catalog: () => [...products.values()].map(product => ({ ...product })),
        stats: (): SimulationStats => ({ quotes: quotes.size, authorizations: authorizations.size, orders: orders.size, confirmations }),
        setPrice(productId: string, unitAmountMinor: number) {
            positiveInteger(unitAmountMinor, 'unitAmountMinor');
            const product = products.get(productId); if (!product) throw new Error('Unknown simulation product');
            product.unitAmountMinor = unitAmountMinor;
        },
        setInventory(productId: string, inventory: number) {
            positiveInteger(inventory, 'inventory');
            const product = products.get(productId); if (!product) throw new Error('Unknown simulation product');
            product.inventory = inventory;
        },
        loseNextCompletionResponse() { loseCompletion = true; },
        failNextConfirmation() { failConfirmation = true; },
    };
}
