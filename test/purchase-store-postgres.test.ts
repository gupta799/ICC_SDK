import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresPurchaseStore, postgresPurchaseStoreSchema } from '../dist/stores/postgres-purchases.js';
import { PurchasePersistenceError } from '../dist/agent/stores.js';
import type { PurchaseRecord } from '../src/agent/types.ts';

const connectionString = process.env.TEST_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 12 }) : undefined;
const tableName = `icc_purchases_test_${randomBytes(6).toString('hex')}`;
let store: PostgresPurchaseStore;
function purchase(suffix: string): PurchaseRecord {
    return { scope: 'tenant', id: `purchase-${suffix}`, customerId: 'customer', merchantId: 'merchant',
        requestHash: 'a'.repeat(64), items: [{ id: 'mug', quantity: 1 }],
        policy: { allowedMerchantIds: ['merchant'], currency: 'USD', maxTotalMinor: 2000, maxQuantity: 2, expiresAt: '2099-01-01T00:00:00.000Z' },
        quote: { id: `quote-${suffix}`, merchantId: 'merchant', currency: 'USD', totalMinor: 1500,
            items: [{ id: 'mug', quantity: 1, title: 'Mug', totalMinor: 1500 }], expiresAt: '2099-01-01T00:00:00.000Z', revision: 'version-1' },
        state: 'prepared', version: 0, paymentProviderId: 'payment-provider', confirmation: 'pending' };
}
async function submitting(record: PurchaseRecord): Promise<PurchaseRecord> {
    await store.create(record);
    const approving = { ...record, state: 'approving' as const, version: 1 }; await store.compareAndSet(approving, 0);
    const authorizing = { ...approving, state: 'authorizing' as const, version: 2 }; await store.compareAndSet(authorizing, 1);
    const active = { ...authorizing, state: 'submitting' as const, version: 3,
        authorization: { providerId: record.paymentProviderId, id: 'instruction-reference' } };
    await store.compareAndSet(active, 2);
    return active;
}
function completed(record: PurchaseRecord): PurchaseRecord {
    return { ...record, state: 'completed', version: record.version + 1,
        order: { id: `order-${record.id}`, quoteId: record.quote.id, merchantId: record.merchantId,
            currency: record.quote.currency, totalMinor: record.quote.totalMinor, status: 'completed', paymentStatus: 'unknown' } };
}
before(async () => {
    if (!pool) return;
    store = new PostgresPurchaseStore(pool, { tableName }); await store.initialize();
});
after(async () => {
    if (!pool) return;
    try { await pool.query(`DROP TABLE IF EXISTS "${tableName}"`); } finally { await pool.end(); }
});

test('Postgres purchase table names cannot inject SQL', () => {
    assert.throws(() => postgresPurchaseStoreSchema({ tableName: 'purchases;drop table merchants' }), TypeError);
});

test('Postgres purchase creators across workers reserve one durable purchase and quote', { skip: !pool }, async () => {
    const record = purchase('race');
    const workers = Array.from({ length: 12 }, () => new PostgresPurchaseStore(pool!, { tableName }));
    const outcomes = await Promise.all(workers.map(worker => worker.create(record)));
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.deepEqual(await store.get(record.scope, record.id), record);
    assert.equal(await workers[0].create({ ...record, id: 'another-purchase' }), false);
});

test('Postgres purchase CAS permits one worker to claim execution', { skip: !pool }, async () => {
    const record = purchase('execute-race'); await store.create(record);
    const next = { ...record, state: 'approving' as const, version: 1 };
    const workers = Array.from({ length: 12 }, () => new PostgresPurchaseStore(pool!, { tableName }));
    const outcomes = await Promise.all(workers.map(worker => worker.compareAndSet(next, 0)));
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal((await store.get(record.scope, record.id))?.state, 'approving');
});

test('Postgres purchase namespace isolates trusted tenants', { skip: !pool }, async () => {
    const record = purchase('tenant'); assert.equal(await store.create(record), true);
    assert.equal(await store.create({ ...record, scope: 'other-tenant' }), true);
    assert.equal(await store.get('missing-tenant', record.id), undefined);
});

test('Postgres purchase immutable bindings cannot be changed', { skip: !pool }, async () => {
    const record = purchase('binding'); await store.create(record);
    for (const change of [{ customerId: 'other' }, { paymentProviderId: 'other-provider' }, { requestHash: 'b'.repeat(64) },
        { quote: { ...record.quote, revision: 'different' } }, { policy: { ...record.policy, maxTotalMinor: 3000 } }]) {
        await assert.rejects(store.compareAndSet({ ...record, ...change, state: 'approving', version: 1 }, 0), PurchasePersistenceError);
    }
    assert.deepEqual(await store.get(record.scope, record.id), record);
});

test('Postgres purchase restart recovery retains unknown reservation and reconciles one order', { skip: !pool }, async () => {
    const active = await submitting(purchase('restart'));
    const unknown = { ...active, state: 'unknown' as const, version: 4 }; await store.compareAndSet(unknown, 3);
    const restartedPool = new Pool({ connectionString });
    try {
        const restarted = new PostgresPurchaseStore(restartedPool, { tableName });
        assert.deepEqual(await restarted.get(active.scope, active.id), unknown);
        assert.equal(await restarted.create({ ...purchase('restart'), id: 'new-after-timeout' }), false);
        const done = completed(unknown); assert.equal(await restarted.compareAndSet(done, 4), true);
        assert.equal(await store.compareAndSet({ ...active, state: 'unknown', version: 4 }, 3), false);
        assert.deepEqual(await store.get(active.scope, active.id), done);
    } finally { await restartedPool.end(); }
});

test('Postgres purchase cannot replace a completed order or resend unknown confirmation', { skip: !pool }, async () => {
    const active = await submitting(purchase('completion'));
    const done = completed(active); await store.compareAndSet(done, 3);
    await assert.rejects(store.compareAndSet({ ...done, version: 5, order: { ...done.order!, id: 'different-order' } }, 4), PurchasePersistenceError);
    const sending = { ...done, confirmation: 'sending' as const, version: 5 }; await store.compareAndSet(sending, 4);
    const unknown = { ...sending, confirmation: 'unknown' as const, version: 6 }; await store.compareAndSet(unknown, 5);
    await assert.rejects(store.compareAndSet({ ...unknown, confirmation: 'sending', version: 7 }, 6), PurchasePersistenceError);
    assert.deepEqual(await store.get(active.scope, active.id), unknown);
});

test('Postgres purchase rejects raw provider data before it reaches the database', { skip: !pool }, async () => {
    const record = purchase('private');
    await assert.rejects(store.create({ ...record, credential: 'opaque-secret' } as PurchaseRecord), PurchasePersistenceError);
    await assert.rejects(store.create({ ...record, quote: { ...record.quote, rawResponse: { token: 'opaque-secret' } } } as PurchaseRecord), PurchasePersistenceError);
    assert.equal(await store.get(record.scope, record.id), undefined);
});

test('Postgres purchasing agent recovers a lost order response after restart without reauthorizing', { skip: !pool }, async () => {
    const { PurchasingAgent, PurchaseConflictError } = await import('../dist/index.js');
    const initial = purchase('agent-restart');
    const counts = { authorized: 0, submitted: 0, confirmed: 0 };
    let merchantOrder: import('../src/agent/types.ts').MerchantOrder | undefined;
    const merchant: import('../src/agent/types.ts').MerchantCheckoutConnector = {
        id: initial.merchantId,
        async quote() { return structuredClone(initial.quote); },
        async refresh() { return structuredClone(initial.quote); },
        async complete() {
            counts.submitted++;
            merchantOrder = completed({ ...initial, authorization: { providerId: initial.paymentProviderId, id: 'instruction' } }).order!;
            throw new Error('Connection lost after merchant placed the order');
        },
        async lookup() { return merchantOrder ? structuredClone(merchantOrder) : undefined; },
    };
    const payments: import('../src/agent/types.ts').PaymentAuthorizationProvider = {
        id: initial.paymentProviderId,
        async authorize() { counts.authorized++; return { reference: { providerId: initial.paymentProviderId, id: 'instruction' }, credential: { token: 'PRIVATE_CREDENTIAL' } }; },
        async confirm() { counts.confirmed++; },
    };
    const context = { scope: initial.scope, purchaseId: initial.id, customerId: initial.customerId };
    const execute = { ...context, approve: async () => true,
        authenticate: async () => ({ kind: 'authenticated' as const, evidence: { proof: 'PRIVATE_AUTHENTICATION' } }) };
    const agent = new PurchasingAgent({ merchants: [merchant], payments, store });
    await agent.prepare({ ...context, merchantId: initial.merchantId, items: initial.items, policy: initial.policy });
    assert.equal((await agent.execute(execute)).status, 'unknown');
    const restartedPool = new Pool({ connectionString });
    try {
        const restarted = new PurchasingAgent({ merchants: [merchant], payments, store: new PostgresPurchaseStore(restartedPool, { tableName }) });
        assert.equal((await restarted.execute(execute)).status, 'unknown');
        await assert.rejects(restarted.prepare({ ...context, purchaseId: 'fresh-agent-attempt', merchantId: initial.merchantId,
            items: initial.items, policy: initial.policy }), PurchaseConflictError);
        const recovered = await restarted.reconcile(context);
        assert.equal(recovered.status, 'completed');
        assert.equal(recovered.confirmation, 'confirmed');
        assert.equal((await restarted.execute(execute)).order?.id, merchantOrder!.id);
        assert.deepEqual(counts, { authorized: 1, submitted: 1, confirmed: 1 });
        const { rows } = await restartedPool.query(`SELECT data FROM "${tableName}" WHERE scope = $1 AND purchase_id = $2`, [context.scope, context.purchaseId]);
        const persisted = JSON.stringify(rows[0]);
        assert.equal(persisted.includes('PRIVATE_CREDENTIAL'), false);
        assert.equal(persisted.includes('PRIVATE_AUTHENTICATION'), false);
    } finally { await restartedPool.end(); }
});

test('Postgres purchasing agent retains completed order when confirmation response is uncertain', { skip: !pool }, async () => {
    const { PurchasingAgent } = await import('../dist/index.js');
    const initial = purchase('agent-confirmation');
    const counts = { authorized: 0, submitted: 0, confirmed: 0 };
    const merchant: import('../src/agent/types.ts').MerchantCheckoutConnector = {
        id: initial.merchantId,
        async quote() { return structuredClone(initial.quote); },
        async refresh() { return structuredClone(initial.quote); },
        async complete() { counts.submitted++; return completed(initial).order!; },
        async lookup() { return completed(initial).order!; },
    };
    const payments: import('../src/agent/types.ts').PaymentAuthorizationProvider = {
        id: initial.paymentProviderId,
        async authorize() { counts.authorized++; return { reference: { providerId: initial.paymentProviderId, id: 'instruction' }, credential: { token: 'PRIVATE_CREDENTIAL' } }; },
        async confirm() { counts.confirmed++; throw new Error('Confirmation response lost'); },
    };
    const context = { scope: initial.scope, purchaseId: initial.id, customerId: initial.customerId };
    const execute = { ...context, approve: async () => true,
        authenticate: async () => ({ kind: 'authenticated' as const, evidence: { proof: 'PRIVATE_AUTHENTICATION' } }) };
    const agent = new PurchasingAgent({ merchants: [merchant], payments, store });
    await agent.prepare({ ...context, merchantId: initial.merchantId, items: initial.items, policy: initial.policy });
    const result = await agent.execute(execute);
    assert.equal(result.status, 'completed');
    assert.equal(result.confirmation, 'unknown');
    const restarted = new PurchasingAgent({ merchants: [merchant], payments, store: new PostgresPurchaseStore(pool!, { tableName }) });
    assert.equal((await restarted.execute(execute)).confirmation, 'unknown');
    assert.equal((await restarted.reconcile(context)).confirmation, 'unknown');
    assert.deepEqual(counts, { authorized: 1, submitted: 1, confirmed: 1 });
});

test('Postgres purchase enrichment preserves order identity and forbids payment-status downgrade', { skip: !pool }, async () => {
    const active = await submitting(purchase('enrichment'));
    const done = completed(active); await store.compareAndSet(done, 3);
    const captured = { ...done, version: 5, order: { ...done.order!, paymentStatus: 'captured' as const } };
    assert.equal(await store.compareAndSet(captured, 4), true);
    await assert.rejects(store.compareAndSet({ ...captured, version: 6, order: { ...captured.order, paymentStatus: 'unknown' } }, 5), PurchasePersistenceError);
    await assert.rejects(store.compareAndSet({ ...captured, version: 6, order: { ...captured.order, id: 'different' } }, 5), PurchasePersistenceError);
    const sending = { ...captured, version: 6, confirmation: 'sending' as const }; await store.compareAndSet(sending, 5);
    const deferred = { ...sending, version: 7, confirmation: 'pending' as const }; assert.equal(await store.compareAndSet(deferred, 6), true);
    assert.deepEqual(await store.get(captured.scope, captured.id), deferred);
});
