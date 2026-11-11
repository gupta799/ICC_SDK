import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryPurchaseStore, PurchasePersistenceError, validatePurchaseRecord } from '../dist/agent/stores.js';
import type { PurchaseRecord } from '../src/agent/types.ts';

export function purchase(suffix = 'one'): PurchaseRecord {
    return { scope: 'tenant', id: `purchase-${suffix}`, customerId: 'customer', merchantId: 'merchant',
        requestHash: 'a'.repeat(64), items: [{ id: 'mug', quantity: 1 }],
        policy: { allowedMerchantIds: ['merchant'], currency: 'USD', maxTotalMinor: 2000, maxQuantity: 2, expiresAt: '2099-01-01T00:00:00.000Z' },
        quote: { id: `quote-${suffix}`, merchantId: 'merchant', currency: 'USD', totalMinor: 1500,
            items: [{ id: 'mug', quantity: 1, title: 'Mug', totalMinor: 1500 }], expiresAt: '2099-01-01T00:00:00.000Z', revision: 'version-1' },
        state: 'prepared', version: 0, paymentProviderId: 'payment-provider', confirmation: 'pending' };
}
async function submitting(store: InMemoryPurchaseStore, initial: PurchaseRecord) {
    await store.create(initial);
    const approving = { ...initial, version: 1, state: 'approving' as const };
    assert.equal(await store.compareAndSet(approving, 0), true);
    const authorizing = { ...approving, version: 2, state: 'authorizing' as const };
    assert.equal(await store.compareAndSet(authorizing, 1), true);
    const submitting = { ...authorizing, version: 3, state: 'submitting' as const,
        authorization: { providerId: initial.paymentProviderId, id: 'non-secret-instruction-reference' } };
    assert.equal(await store.compareAndSet(submitting, 2), true);
    return submitting;
}
function completed(current: PurchaseRecord): PurchaseRecord {
    return { ...current, state: 'completed', version: current.version + 1,
        order: { id: 'order', quoteId: current.quote.id, merchantId: current.merchantId,
            currency: current.quote.currency, totalMinor: current.quote.totalMinor, status: 'completed', paymentStatus: 'unknown' } };
}

test('purchase store reserves one purchase and quote across concurrent creators', async () => {
    const store = new InMemoryPurchaseStore();
    const record = purchase();
    const created = await Promise.all(Array.from({ length: 20 }, () => store.create(record)));
    assert.equal(created.filter(Boolean).length, 1);
    assert.equal(await store.create({ ...record, id: 'new-after-timeout' }), false);
    assert.equal(await store.create({ ...record, scope: 'another-tenant' }), true);
});

test('purchase store snapshots records and returns detached copies', async () => {
    const store = new InMemoryPurchaseStore(); const record = purchase();
    await store.create(record);
    record.quote.items[0].title = 'mutated input';
    const saved = (await store.get('tenant', record.id))!;
    saved.quote.items[0].title = 'mutated output';
    assert.equal((await store.get('tenant', record.id))?.quote.items[0].title, 'Mug');
});

test('purchase store CAS lets one concurrent execution reserve the prepared purchase', async () => {
    const store = new InMemoryPurchaseStore(); const record = purchase(); await store.create(record);
    const next = { ...record, state: 'approving' as const, version: 1 };
    const claimed = await Promise.all(Array.from({ length: 20 }, () => store.compareAndSet(next, 0)));
    assert.equal(claimed.filter(Boolean).length, 1);
    assert.equal(await store.compareAndSet({ ...next, state: 'authorizing' }, 0), false);
});

test('purchase store rejects mutable bindings and invalid version advances', async () => {
    const store = new InMemoryPurchaseStore(); const record = purchase(); await store.create(record);
    for (const change of [{ customerId: 'other' }, { requestHash: 'b'.repeat(64) }, { paymentProviderId: 'other' },
        { quote: { ...record.quote, revision: 'different' } }, { policy: { ...record.policy, maxTotalMinor: 3000 } }]) {
        await assert.rejects(store.compareAndSet({ ...record, ...change, state: 'approving', version: 1 }, 0), PurchasePersistenceError);
    }
    await assert.rejects(store.compareAndSet({ ...record, state: 'approving', version: 2 }, 0), PurchasePersistenceError);
    await assert.rejects(store.compareAndSet({ ...record, state: 'authorizing', version: 1 }, 0), PurchasePersistenceError);
});

test('purchase store supports authentication challenge and renewed approval', async () => {
    const store = new InMemoryPurchaseStore(); const record = purchase(); await store.create(record);
    const approving = { ...record, state: 'approving' as const, version: 1 }; await store.compareAndSet(approving, 0);
    const challenge = { ...approving, state: 'authentication_required' as const, version: 2, action: { type: 'passkey', id: 'challenge-reference' } };
    assert.equal(await store.compareAndSet(challenge, 1), true);
    assert.equal(await store.compareAndSet({ ...challenge, action: undefined, state: 'approving', version: 3 }, 2), true);
});

test('unknown purchases can only reconcile to the first completed order', async () => {
    const store = new InMemoryPurchaseStore(); const active = await submitting(store, purchase());
    const unknown = { ...active, state: 'unknown' as const, version: 4 }; await store.compareAndSet(unknown, 3);
    await assert.rejects(store.compareAndSet({ ...unknown, state: 'submitting', version: 5 }, 4), PurchasePersistenceError);
    const done = completed(unknown); assert.equal(await store.compareAndSet(done, 4), true);
    await assert.rejects(store.compareAndSet({ ...done, state: 'unknown', version: 6, order: undefined }, 5), PurchasePersistenceError);
    await assert.rejects(store.compareAndSet({ ...done, version: 6, order: { ...done.order!, id: 'different' } }, 5), PurchasePersistenceError);
});

test('completed purchase confirmations are independently claimed and never implicitly retried', async () => {
    const store = new InMemoryPurchaseStore(); const active = await submitting(store, purchase());
    const done = completed(active); await store.compareAndSet(done, 3);
    const sending = { ...done, confirmation: 'sending' as const, version: 5 }; assert.equal(await store.compareAndSet(sending, 4), true);
    const unknown = { ...sending, confirmation: 'unknown' as const, version: 6 }; assert.equal(await store.compareAndSet(unknown, 5), true);
    await assert.rejects(store.compareAndSet({ ...unknown, confirmation: 'sending', version: 7 }, 6), PurchasePersistenceError);
    await assert.rejects(store.compareAndSet({ ...unknown, confirmation: 'confirmed', version: 7 }, 6), PurchasePersistenceError);
});

test('purchase storage rejects credential, authentication and raw response fields at every persisted boundary', () => {
    for (const poison of [
        (r: any) => { r.credential = 'secret'; },
        (r: any) => { r.quote.payment = { token: 'secret' }; },
        (r: any) => { r.quote.items[0].credential = 'secret'; },
        (r: any) => { r.policy.authentication = 'secret'; },
        (r: any) => { r.state = 'authentication_required'; r.action = { type: 'passkey', id: 'safe-ref', evidence: 'secret' }; },
        (r: any) => { r.state = 'submitting'; r.authorization = { providerId: r.paymentProviderId, id: 'ref', credential: 'secret' }; },
    ]) {
        const record = purchase(); poison(record); assert.throws(() => validatePurchaseRecord(record), PurchasePersistenceError);
    }
});

test('purchase storage enforces matching provider, order and quote identities', async () => {
    const store = new InMemoryPurchaseStore(); const active = await submitting(store, purchase());
    for (const change of [{ totalMinor: 1 }, { quoteId: 'unrelated' }, { merchantId: 'other' }, { currency: 'EUR' }]) {
        const done = completed(active); done.order = { ...done.order!, ...change };
        await assert.rejects(store.compareAndSet(done, 3), PurchasePersistenceError);
    }
    await assert.rejects(store.compareAndSet({ ...active, state: 'unknown', version: 4, authorization: { providerId: 'other', id: 'ref' } }, 3), PurchasePersistenceError);
});

test('completed orders permit only monotonic authoritative payment-status enrichment', async () => {
    const store = new InMemoryPurchaseStore(); const active = await submitting(store, purchase());
    const done = completed(active); await store.compareAndSet(done, 3);
    const authorized = { ...done, version: 5, order: { ...done.order!, paymentStatus: 'authorized' as const } };
    assert.equal(await store.compareAndSet(authorized, 4), true);
    const captured = { ...authorized, version: 6, order: { ...authorized.order, paymentStatus: 'captured' as const } };
    assert.equal(await store.compareAndSet(captured, 5), true);
    await assert.rejects(store.compareAndSet({ ...captured, version: 7, order: { ...captured.order, paymentStatus: 'authorized' } }, 6), PurchasePersistenceError);
    await assert.rejects(store.compareAndSet({ ...captured, version: 7, order: { ...captured.order, id: 'another-order' } }, 6), PurchasePersistenceError);
});

test('a proven undispatched confirmation can return to pending while unknown cannot', async () => {
    const store = new InMemoryPurchaseStore(); const active = await submitting(store, purchase());
    const done = completed(active); await store.compareAndSet(done, 3);
    const sending = { ...done, version: 5, confirmation: 'sending' as const }; await store.compareAndSet(sending, 4);
    const deferred = { ...sending, version: 6, confirmation: 'pending' as const };
    assert.equal(await store.compareAndSet(deferred, 5), true);
    assert.equal((await store.get(done.scope, done.id))?.confirmation, 'pending');
});
