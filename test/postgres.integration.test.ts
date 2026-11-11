import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresAttemptStore, AttemptPersistenceConflictError, postgresAttemptStoreSchema } from '../dist/stores/postgres.js';
import { CommerceClient, completeApprovedCheckout, reconcileCheckout, UnknownOutcomeError } from '../dist/index.js';
import type { CheckoutAttempt } from '../dist/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
const tableName = `icc_attempts_test_${randomBytes(6).toString('hex')}`;
const pool = connectionString ? new Pool({ connectionString, max: 12 }) : undefined;
let store: PostgresAttemptStore;
const attempt = (suffix: string): CheckoutAttempt => ({
    scope: 'merchant', id: `attempt-${suffix}`, sessionId: `session-${suffix}`,
    cartHash: 'a'.repeat(64), paymentHash: 'b'.repeat(64), state: 'submitting',
});
const complete = (a: CheckoutAttempt): CheckoutAttempt => ({ ...a, state: 'completed', result: {
    id: a.sessionId, status: 'completed', currency: 'USD', line_items: [], totals: [],
    fulfillment_options: [], fulfillment_option_id: 'digital', messages: [], links: [],
    buyer: { first_name: 'Test', email: 'test@example.com' },
    order: { id: `order-${a.id}`, checkout_session_id: a.sessionId },
} });

before(async () => {
    if (!pool) return;
    store = new PostgresAttemptStore(pool, { tableName });
    await store.initialize();
});
after(async () => {
    if (!pool) return;
    try { await pool.query(`DROP TABLE IF EXISTS "${tableName}"`); }
    finally { await pool.end(); }
});

test('Postgres table identifiers cannot inject migration SQL', () => {
    assert.throws(() => postgresAttemptStoreSchema({ tableName: 'attempts; DROP TABLE merchants' }), TypeError);
});

test('Postgres concurrent workers claim one durable attempt', { skip: !pool }, async () => {
    const a = attempt('race');
    const workers = Array.from({ length: 12 }, () => new PostgresAttemptStore(pool!, { tableName }));
    const claims = await Promise.all(workers.map(worker => worker.claim(a)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.deepEqual(await store.get(a.scope, a.id), a);
});

test('Postgres session fence survives a new attempt ID and a new store instance', { skip: !pool }, async () => {
    const a = attempt('session-fence');
    assert.equal(await store.claim(a), true);
    const restarted = new PostgresAttemptStore(pool!, { tableName });
    assert.equal(await restarted.claim({ ...a, id: 'fresh-attempt' }), false);
    assert.deepEqual(await restarted.get(a.scope, a.id), a);
});

test('Postgres scopes isolate merchant attempts and sessions', { skip: !pool }, async () => {
    const a = attempt('tenant');
    assert.equal(await store.claim(a), true);
    assert.equal(await store.claim({ ...a, scope: 'another-merchant' }), true);
    assert.equal(await store.get('missing-merchant', a.id), undefined);
});

test('Postgres completion cannot be regressed by a stale unknown save', { skip: !pool }, async () => {
    const a = attempt('monotonic');
    await store.claim(a);
    const completed = complete(a);
    await store.save(completed);
    await store.save({ ...a, state: 'unknown' });
    assert.deepEqual(await store.get(a.scope, a.id), completed);
    const later = complete(a);
    later.result!.order.id = 'a-different-processor-order';
    await store.save(later);
    assert.deepEqual(await store.get(a.scope, a.id), completed);
});

test('Postgres concurrent reconciliation and failure preserve completed result', { skip: !pool }, async () => {
    const a = attempt('reconciliation-race');
    await store.claim(a);
    const completed = complete(a);
    await Promise.all([store.save(completed), ...Array.from({ length: 12 }, () => store.save({ ...a, state: 'unknown' }))]);
    assert.deepEqual(await store.get(a.scope, a.id), completed);
});

test('Postgres cannot overwrite the immutable attempt binding or create through save', { skip: !pool }, async () => {
    const a = attempt('binding');
    await store.claim(a);
    for (const change of [{ sessionId: 'different' }, { cartHash: 'c'.repeat(64) }, { paymentHash: 'c'.repeat(64) }]) {
        await assert.rejects(store.save({ ...a, ...change, state: 'unknown' }), AttemptPersistenceConflictError);
    }
    await assert.rejects(store.save({ ...attempt('unclaimed'), state: 'unknown' }), AttemptPersistenceConflictError);
    assert.deepEqual(await store.get(a.scope, a.id), a);
});

test('Postgres round-trips completed data using a new connection pool', { skip: !pool }, async () => {
    const a = attempt('restart');
    await store.claim(a);
    await store.save(complete(a));
    const otherPool = new Pool({ connectionString });
    try {
        const restarted = new PostgresAttemptStore(otherPool, { tableName });
        assert.deepEqual(await restarted.get(a.scope, a.id), complete(a));
    } finally { await otherPool.end(); }
});

test('Postgres rejects invalid completion without changing persisted state', { skip: !pool }, async () => {
    const a = attempt('invalid-result');
    await store.claim(a);
    const completed = complete(a);
    completed.result!.id = 'unrelated-session';
    await assert.rejects(store.save(completed), /matching completed/);
    assert.deepEqual(await store.get(a.scope, a.id), a);
});

test('Postgres checkout workflow survives response loss and restart without resubmitting', { skip: !pool }, async () => {
    const a = attempt('workflow-response-loss');
    const completed = complete(a).result!;
    completed.totals = [{ type: 'total', display_text: 'Total', amount: 1000 }];
    const cart = { ...completed, status: 'ready_for_payment' };
    let submissions = 0;
    const client = new CommerceClient({ transport: { async send(request) {
        if (request.operation === 'getCheckoutSession') return { status: 200, body: cart };
        submissions++;
        // The provider could have placed an order before its connection was lost.
        throw new Error('Lost completion response');
    } } });
    const options = { client, store, scope: a.scope, attemptId: a.id, sessionId: a.sessionId,
        payment: { payment_data: { provider: 'test', token: 'opaque-test-token' } }, approve: async () => true };
    await assert.rejects(completeApprovedCheckout(options), UnknownOutcomeError);
    const restarted = new PostgresAttemptStore(pool!, { tableName });
    await assert.rejects(completeApprovedCheckout({ ...options, store: restarted }), UnknownOutcomeError);
    await assert.rejects(completeApprovedCheckout({ ...options, store: restarted, attemptId: 'new-after-timeout' }), UnknownOutcomeError);
    assert.equal(submissions, 1);
    await reconcileCheckout(restarted, a.scope, a.id, async () => completed);
    assert.deepEqual(await completeApprovedCheckout({ ...options, store: restarted }), completed);
    assert.equal(submissions, 1);
});
