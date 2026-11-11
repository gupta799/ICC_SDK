import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommerceClient } from '../dist/client.js';
import { ICCMerchantConnector, type ICCMerchantConnectorOptions } from '../dist/agent/merchants/icc.js';
import { createSimulatedCommerce } from '../dist/agent/simulation.js';
import type { CheckoutContext, MerchantOrder, PaymentAuthorization, PurchasePolicy } from '../src/agent/types.ts';
import { createReferenceMerchant } from './fixtures/reference-merchant.ts';

const quoteRequest = { scope: 'merchant-account', customerId: 'customer-1', purchaseId: 'purchase-1',
    idempotencyKey: 'quote-key', items: [{ id: 'headphones', quantity: 2 }] };
function policy(): PurchasePolicy { return { allowedMerchantIds: ['simulation-store'], currency: 'USD', maxTotalMinor: 20_000,
    maxQuantity: 5, expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
async function authorize(commerce: ReturnType<typeof createSimulatedCommerce>, quote: CheckoutContext['quote'], authorizationKey = 'authorize-key') {
    const request = { ...quoteRequest, quote, policy: policy() };
    const authentication = await commerce.authenticate(request);
    assert.equal(authentication.kind, 'authenticated');
    if (authentication.kind !== 'authenticated') throw new Error('Expected simulation proof');
    return commerce.payments.authorize({ ...request, authentication: authentication.evidence, idempotencyKey: authorizationKey });
}
const iccCart = { id: 'session-1', status: 'ready_for_payment', currency: 'USD',
    line_items: [{ id: 'line-1', item: { id: 'headphones', name: 'Headphones', quantity: 2 }, total: 15_000 }],
    totals: [{ type: 'total', display_text: 'Total', amount: 15_000 }], fulfillment_option_id: 'digital', fulfillment_options: [],
    buyer: { first_name: 'Test', email: 'test@example.com' }, messages: [], links: [] };
const iccCompleted = { ...iccCart, status: 'completed', order: { id: 'order-1', checkout_session_id: iccCart.id } };
function iccFixture(callbacks: Partial<Pick<ICCMerchantConnectorOptions, 'createRequest' | 'toCheckoutPayment' | 'lookupOrder'>> = {}) {
    let clock = Date.now();
    let current: any = structuredClone(iccCart);
    const requests: any[] = [];
    let lookup: MerchantOrder | undefined;
    const client = new CommerceClient({ transport: { async send(request) {
        requests.push(request);
        return { status: request.operation === 'createCheckoutSession' ? 201 : 200,
            body: request.operation === 'completeCheckout' ? iccCompleted : current };
    } } });
    const connector = new ICCMerchantConnector({ id: 'merchant-1', client, quoteLifetimeMs: 60_000, now: () => clock,
        merchantName: 'Merchant One', merchantUrl: 'https://merchant.example',
        toCheckoutPayment: authorization => {
            assert.equal((authorization.credential as any).verified, true);
            return { payment_data: { token: 'merchant-specific-token', provider: 'test-provider' } };
        },
        lookupOrder: async () => lookup,
        ...callbacks,
    });
    return { connector, requests, setCart(value: any) { current = value; }, setClock(value: number) { clock = value; },
        setLookup(value: MerchantOrder | undefined) { lookup = value; } };
}

test('ICC connector creates a normalized quote with a stable upstream key and local expiry', async () => {
    const f = iccFixture();
    const quote = await f.connector.quote(quoteRequest);
    assert.equal(quote.merchantId, 'merchant-1'); assert.equal(quote.totalMinor, 15_000);
    assert.deepEqual(quote.items, [{ id: 'headphones', quantity: 2, title: 'Headphones', totalMinor: 15_000 }]);
    assert.equal(f.requests[0].headers['Idempotency-Key'], 'quote-key');
    assert.equal(JSON.stringify(quote).includes('test@example.com'), false);
    f.setClock(Date.now() + 5_000);
    const refreshed = await f.connector.refresh({ ...quoteRequest, quote });
    assert.equal(refreshed.expiresAt, quote.expiresAt); assert.equal(refreshed.revision, quote.revision);
});

test('ICC connector refuses missing quantities, unrelated products and non-ready sessions', async () => {
    for (const cart of [
        { ...iccCart, line_items: [{ id: 'headphones', total: 15_000 }] },
        { ...iccCart, line_items: [{ item: { id: 'other', quantity: 2 }, total: 15_000 }] },
        { ...iccCart, status: 'not_ready_for_payment' },
    ]) {
        const f = iccFixture(); f.setCart(cart);
        await assert.rejects(f.connector.quote(quoteRequest));
    }
});

test('ICC connector maps a backend credential explicitly and never infers captured payment', async () => {
    const f = iccFixture(); const quote = await f.connector.quote(quoteRequest);
    const authorization: PaymentAuthorization = { reference: { providerId: 'vic', id: 'instruction-1' }, credential: { verified: true, secret: 'sensitive' } };
    const order = await f.connector.complete({ ...quoteRequest, quote, authorization, idempotencyKey: 'complete-key' });
    assert.equal(order.id, 'order-1'); assert.equal(order.paymentStatus, 'unknown');
    assert.equal(f.requests.at(-1).headers['Idempotency-Key'], 'complete-key');
    assert.deepEqual(f.requests.at(-1).body, { payment_data: { token: 'merchant-specific-token', provider: 'test-provider' } });
    assert.equal(JSON.stringify(order).includes('sensitive'), false);
});

test('ICC connector catches a changed quote before submitting a credential', async () => {
    const f = iccFixture(); const quote = await f.connector.quote(quoteRequest);
    f.setCart({ ...iccCart, totals: [{ type: 'total', display_text: 'Total', amount: 16_000 }] });
    await assert.rejects(f.connector.complete({ ...quoteRequest, quote, authorization: {
        reference: { providerId: 'test', id: 'id' }, credential: { verified: true },
    } }), /changed/);
    assert.equal(f.requests.some(request => request.operation === 'completeCheckout'), false);
});

test('ICC connector requires authoritative lookup and validates returned merchant binding', async () => {
    const f = iccFixture(); const quote = await f.connector.quote(quoteRequest);
    const context = { ...quoteRequest, quote };
    assert.equal(await f.connector.lookup(context), undefined);
    f.setLookup({ id: 'order', quoteId: quote.id, merchantId: 'another-merchant', totalMinor: quote.totalMinor,
        currency: quote.currency, status: 'completed', paymentStatus: 'unknown' });
    await assert.rejects(f.connector.lookup(context), /does not match/);
});

test('simulation computes prices/tax/shipping, reserves finite inventory and caches one order', async () => {
    const commerce = createSimulatedCommerce({ taxBps: 750, shippingMinor: 250 });
    const quote = await commerce.merchant.quote(quoteRequest);
    assert.equal(quote.totalMinor, 16_375);
    const authorization = await authorize(commerce, quote);
    const request = { ...quoteRequest, quote, authorization, idempotencyKey: 'complete-key' };
    const order = await commerce.merchant.complete(request);
    assert.deepEqual(await commerce.merchant.complete(request), order);
    assert.equal(commerce.catalog().find(item => item.id === 'headphones')?.inventory, 8);
    assert.deepEqual(commerce.stats(), { quotes: 1, authorizations: 1, orders: 1, confirmations: 0 });
    await commerce.payments.confirm!({ ...request, authorization: authorization.reference, order, idempotencyKey: 'confirm-key' });
    assert.equal(commerce.stats().confirmations, 1);
});

test('simulation binds credentials and synthetic authentication to this customer and quote', async () => {
    const commerce = createSimulatedCommerce();
    const quote = await commerce.merchant.quote(quoteRequest);
    await assert.rejects(commerce.payments.authorize({ ...quoteRequest, quote, policy: policy(), authentication: { arbitrary: true } }));
    const authorization = await authorize(commerce, quote);
    await assert.rejects(commerce.merchant.complete({ ...quoteRequest, customerId: 'another-customer', quote, authorization }));
    await assert.rejects(commerce.merchant.complete({ ...quoteRequest, quote, authorization: {
        ...authorization, credential: { simulation: true, token: 'forged' },
    } }));
    assert.equal(commerce.stats().orders, 0);
});

test('simulation rejects a stale price and a second purchase of exhausted inventory', async () => {
    const commerce = createSimulatedCommerce({ catalog: [{ id: 'headphones', title: 'One pair', inventory: 2, unitAmountMinor: 100 }] });
    const quote = await commerce.merchant.quote(quoteRequest); const authorization = await authorize(commerce, quote);
    commerce.setPrice('headphones', 200);
    await assert.rejects(commerce.merchant.complete({ ...quoteRequest, quote, authorization }), /changed/);
    const fresh = await commerce.merchant.refresh({ ...quoteRequest, quote });
    const freshAuthorization = await authorize(commerce, fresh, 'fresh-auth-key');
    await commerce.merchant.complete({ ...quoteRequest, quote: fresh, authorization: freshAuthorization, idempotencyKey: 'fresh-complete' });
    await assert.rejects(commerce.merchant.quote({ ...quoteRequest, purchaseId: 'purchase-2', idempotencyKey: 'quote-2' }), /unavailable/);
});

test('real HTTP merchant/authentication/payment boundary places one order and recovers a lost response', async () => {
    const fixture = await createReferenceMerchant();
    try {
        const quote = await fixture.merchant.quote(quoteRequest);
        const approval = { ...quoteRequest, quote, policy: policy() };
        const authentication = await fixture.authenticate(approval);
        if (authentication.kind !== 'authenticated') throw new Error('Expected synthetic authentication');
        const authorization = await fixture.payments.authorize({ ...approval, authentication: authentication.evidence, idempotencyKey: 'http-auth' });
        const context = { ...quoteRequest, quote, idempotencyKey: 'http-complete' };
        fixture.disconnectNextCompletionResponse();
        await assert.rejects(fixture.merchant.complete({ ...context, authorization }));
        const order = await fixture.merchant.lookup(context);
        assert.equal(order?.status, 'completed');
        assert.equal(fixture.commerce.stats().orders, 1);
        await fixture.payments.confirm!({ ...context, authorization: authorization.reference, order: order!, idempotencyKey: 'http-confirm' });
        assert.equal(fixture.commerce.stats().confirmations, 1);
    } finally { await fixture.close(); }
});


test('ICC payment mapper cannot mutate the dispatched session, key, merchant or expected quote', async () => {
    const f = iccFixture({ toCheckoutPayment(authorization, request) {
        authorization.reference.id = 'mutated-reference';
        request.quote.id = 'another-session'; request.quote.merchantId = 'another-merchant';
        request.quote.totalMinor = 1; request.quote.items[0].quantity = 99;
        request.idempotencyKey = 'another-key'; request.scope = 'another-account';
        return { payment_data: { token: 'opaque', provider: 'test-provider' } };
    } });
    const quote = await f.connector.quote(quoteRequest);
    const authorization = { reference: { providerId: 'test-provider', id: 'original-reference' }, credential: { verified: true } };
    const order = await f.connector.complete({ ...quoteRequest, quote, authorization, idempotencyKey: 'original-key' });
    const dispatched = f.requests.find(request => request.operation === 'completeCheckout');
    assert.equal(dispatched.path, '/icc/v1/checkout_sessions/session-1/complete');
    assert.equal(dispatched.headers['Idempotency-Key'], 'original-key');
    assert.equal(order.quoteId, 'session-1'); assert.equal(order.merchantId, 'merchant-1');
    assert.equal(quote.id, 'session-1'); assert.equal(quote.items[0].quantity, 2);
    assert.equal(authorization.reference.id, 'original-reference');
});

test('ICC quote request is snapshotted while an asynchronous body mapper is running', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const f = iccFixture({ async createRequest(request) {
        await waiting;
        return { items: request.items };
    } });
    const input = structuredClone(quoteRequest);
    const pending = f.connector.quote(input);
    input.idempotencyKey = 'mutated-key'; input.items[0].id = 'another-product';
    release();
    const quote = await pending;
    assert.equal(quote.items[0].id, 'headphones');
    assert.equal(f.requests[0].headers['Idempotency-Key'], 'quote-key');
    assert.equal(f.requests[0].body.items[0].id, 'headphones');
});

test('ICC lookup validates against the original quote even if its callback changes its copy', async () => {
    const f = iccFixture({ async lookupOrder(request) {
        request.quote.id = 'unrelated-quote'; request.quote.totalMinor = 1;
        return { id: 'unrelated-order', quoteId: request.quote.id, merchantId: request.quote.merchantId,
            currency: request.quote.currency, totalMinor: 1, status: 'completed', paymentStatus: 'unknown' };
    } });
    const quote = await f.connector.quote(quoteRequest);
    await assert.rejects(f.connector.lookup({ ...quoteRequest, quote }), /does not match/);
    assert.equal(quote.id, 'session-1'); assert.equal(quote.totalMinor, 15_000);
});

test('ICC refresh retains the original session binding if its caller changes the input while awaiting', async () => {
    const f = iccFixture(); const quote = await f.connector.quote(quoteRequest);
    const pending = f.connector.refresh({ ...quoteRequest, quote });
    quote.id = 'changed-while-reading'; quote.expiresAt = '2099-01-01T00:00:00Z';
    const refreshed = await pending;
    assert.equal(refreshed.id, 'session-1'); assert.notEqual(refreshed.expiresAt, quote.expiresAt);
});
