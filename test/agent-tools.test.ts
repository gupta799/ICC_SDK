import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPurchasingTools, type PurchasingAgentToolTarget } from '../dist/agent/tools.js';
import { PurchaseNotFoundError, PurchasePolicyError, type PurchaseView } from '../dist/agent/types.js';

const view: PurchaseView = {
    purchaseId: 'purchase-1', status: 'prepared', confirmation: 'not_required',
    quote: { id: 'quote-1', merchantId: 'shop', currency: 'USD', totalMinor: 1500,
        items: [{ id: 'mug', quantity: 1, totalMinor: 1500 }],
        expiresAt: '2030-01-01T00:00:00.000Z', revision: 'revision-1' },
};
const policy = () => ({ allowedMerchantIds: ['shop'], currency: 'USD', maxTotalMinor: 2000,
    maxQuantity: 2, expiresAt: '2030-01-01T00:00:00.000Z' });
function fixture(overrides: Partial<PurchasingAgentToolTarget> = {}) {
    const seen: { method: string; input: any }[] = [];
    const target: PurchasingAgentToolTarget = {
        async prepare(input) { seen.push({ method: 'prepare', input }); return view; },
        async execute(input) { seen.push({ method: 'execute', input }); return view; },
        async get(input) { seen.push({ method: 'get', input }); return view; },
        async reconcile(input) { seen.push({ method: 'reconcile', input }); return view; },
        ...overrides,
    };
    const boundPolicy = policy();
    const approve = async () => true;
    const authenticate = async () => ({ kind: 'authenticated' as const, evidence: 'trusted-evidence' });
    const tools = createPurchasingTools({ agent: target, scope: 'tenant', customerId: 'alice', policy: boundPolicy,
        approve, authenticate });
    return { seen, target, tools, boundPolicy, approve, authenticate };
}
const prepare = { purchaseId: 'purchase-1', merchantId: 'shop', items: [{ id: 'mug', quantity: 1 }] };

test('agent tool arguments bind backend tenant and customer on every operation', async () => {
    const f = fixture();
    for (const tool of f.tools) assert.equal((await tool.execute(tool.name === 'prepare_purchase' ? prepare : { purchaseId: 'purchase-1' })).ok, true);
    assert.deepEqual(f.seen.map(item => item.method), ['prepare', 'execute', 'get', 'reconcile']);
    for (const { input } of f.seen) {
        assert.equal(input.scope, 'tenant');
        assert.equal(input.customerId, 'alice');
    }
    assert.equal(f.seen[1].input.approve, f.approve);
    assert.equal(f.seen[1].input.authenticate, f.authenticate);
});

test('model cannot supply policy, identity, approval or authentication values', async () => {
    const f = fixture();
    for (const tool of f.tools) {
        for (const forbidden of ['scope', 'customerId', 'policy', 'approve', 'authenticate', 'authentication', 'credential']) {
            const args = tool.name === 'prepare_purchase' ? prepare : { purchaseId: 'purchase-1' };
            const result = await tool.execute({ ...args, [forbidden]: 'model-controlled' });
            assert.deepEqual(result, { ok: false, error: { code: 'INVALID_ARGUMENTS' } });
        }
    }
    assert.equal(f.seen.length, 0);
});

test('tool purchase policy is snapshotted at factory creation and on each call', async () => {
    const f = fixture();
    f.boundPolicy.maxTotalMinor = 999999;
    f.boundPolicy.allowedMerchantIds.push('unapproved');
    await f.tools[0].execute(prepare);
    f.seen[0].input.policy.maxTotalMinor = 500000;
    f.seen[0].input.policy.allowedMerchantIds.push('mutation');
    await f.tools[0].execute(prepare);
    assert.equal(f.seen[1].input.policy.maxTotalMinor, 2000);
    assert.deepEqual(f.seen[1].input.policy.allowedMerchantIds, ['shop']);
});

test('tools reject non-JSON objects, inherited fields and accessor properties without reading them', async () => {
    const f = fixture();
    const inherited = Object.create({ purchaseId: 'purchase-1' });
    let getterRead = false;
    const getter = Object.defineProperty({}, 'purchaseId', { enumerable: true, get() { getterRead = true; return 'purchase-1'; } });
    const symbol = { purchaseId: 'purchase-1', [Symbol('credential')]: 'secret' };
    for (const args of [null, [], inherited, getter, symbol, new Date()])
        assert.deepEqual(await f.tools[2].execute(args), { ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    assert.equal(getterRead, false);
    assert.equal(f.seen.length, 0);
});

test('tool item requests require bounded arrays and positive safe integer quantities', async () => {
    const f = fixture();
    for (const items of [[], Array.from({ length: 101 }, () => ({ id: 'mug', quantity: 1 })),
        [{ id: 'mug', quantity: 0 }], [{ id: 'mug', quantity: 1.5 }],
        [{ id: 'mug', quantity: Infinity }], [{ id: 'mug', quantity: Number.MAX_SAFE_INTEGER + 1 }],
        [{ id: 'mug', quantity: 1, token: 'secret' }]]) {
        assert.deepEqual(await f.tools[0].execute({ ...prepare, items }), { ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    }
    assert.equal(f.seen.length, 0);
});

test('authentication challenges and nested provider extension secrets never become model output', async () => {
    const dirty: any = structuredClone(view);
    dirty.status = 'authentication_required';
    dirty.action = { type: 'passkey', id: 'secret-challenge-id' };
    dirty.reasonCode = 'secret-reason-code';
    dirty.credential = 'secret-credential';
    dirty.authorization = { id: 'secret-authorization' };
    dirty.quote.credential = 'secret-quote-credential';
    dirty.quote.items[0].token = 'secret-item-token';
    dirty.order = { id: 'order-1', quoteId: 'quote-1', merchantId: 'shop', currency: 'USD', totalMinor: 1500,
        status: 'completed', paymentStatus: 'unknown', token: 'secret-order-token' };
    const f = fixture({ async get() { return dirty; } });
    const result = await f.tools[2].execute({ purchaseId: 'purchase-1' });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    if (result.ok) assert.equal(result.purchase.status, 'authentication_required');
});

test('sensitive callback and provider exceptions become static tool errors', async () => {
    const secret = 'sensitive-payment-token';
    const error = Object.assign(new Error(secret), { credential: secret, cause: new Error(secret) });
    const f = fixture({ async execute() { throw error; } });
    const result = await f.tools[1].execute({ purchaseId: 'purchase-1' });
    assert.deepEqual(result, { ok: false, error: { code: 'PURCHASE_FAILED' } });
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test('tool errors do not serialize arbitrary purchase-policy reason strings', async () => {
    const f = fixture({ async prepare() { throw new PurchasePolicyError('sensitive-provider-detail'); } });
    assert.deepEqual(await f.tools[0].execute(prepare), { ok: false, error: { code: 'POLICY_REJECTED' } });
});

test('foreign customer purchase access is consistently returned as not found', async () => {
    const ownedBy = 'bob';
    const f = fixture({
        async execute(input) { if (input.customerId !== ownedBy) throw new PurchaseNotFoundError(); return view; },
        async get(input) { return input.customerId === ownedBy ? view : undefined; },
        async reconcile(input) { if (input.customerId !== ownedBy) throw new PurchaseNotFoundError(); return view; },
    });
    for (const tool of f.tools.slice(1))
        assert.deepEqual(await tool.execute({ purchaseId: 'purchase-1' }), { ok: false, error: { code: 'PURCHASE_NOT_FOUND' } });
});

test('aborted host execution cannot call a purchase tool target', async () => {
    const f = fixture();
    assert.deepEqual(await f.tools[0].execute(prepare, { signal: AbortSignal.abort() }), { ok: false, error: { code: 'PURCHASE_FAILED' } });
    assert.equal(f.seen.length, 0);
});

test('tool descriptors close object schemas and do not expose approval fields', () => {
    const f = fixture();
    for (const tool of f.tools) {
        assert.equal(tool.inputSchema.additionalProperties, false);
        const properties = tool.inputSchema.properties as Record<string, unknown>;
        assert.equal(Object.hasOwn(properties, 'approve'), false);
        assert.equal(Object.hasOwn(properties, 'scope'), false);
        assert.equal(Object.hasOwn(properties, 'customerId'), false);
    }
});

test('tool factory requires trusted authentication and approval integrations', () => {
    const f = fixture();
    assert.throws(() => createPurchasingTools({ agent: f.target, scope: 'tenant', customerId: 'alice',
        policy: policy(), approve: undefined as any, authenticate: f.authenticate }), TypeError);
});


test('tool error handling contains exceptions whose prototype lookup throws', async () => {
    const error = new Proxy({}, { getPrototypeOf() { throw new Error('secret-proxy-error'); } });
    const f = fixture({ async get() { throw error; } });
    assert.deepEqual(await f.tools[2].execute({ purchaseId: 'purchase-1' }), { ok: false, error: { code: 'PURCHASE_FAILED' } });
});
