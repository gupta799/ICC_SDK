import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PurchasingAgent, InMemoryPurchaseStore, PurchasePolicyError, PurchaseConflictError, PurchaseNotFoundError,
  type MerchantCheckoutConnector, type MerchantOrder, type PaymentAuthorizationProvider,
  type PurchasePolicy, type PurchaseQuote, type ExecutePurchase,
} from '../dist/index.js';

const secretEvidence = 'AUTHENTICATION_SECRET_TEST';
const secretCredential = 'PAYMENT_CREDENTIAL_SECRET_TEST';
const start = Date.parse('2026-11-11T10:00:00Z');
const principal = { scope: 'tenant-a', customerId: 'customer-a', purchaseId: 'purchase-a' };
const later = (milliseconds: number) => new Date(start + milliseconds).toISOString();
function fixture() {
  let clock = start;
  let quote: PurchaseQuote = {
    id: 'quote-a', merchantId: 'merchant-a', merchantName: 'Fixture shop', currency: 'USD',
    totalMinor: 1000, items: [{ id: 'sku-a', title: 'One mug', quantity: 1, totalMinor: 1000 }],
    expiresAt: later(60_000), revision: 'revision-a',
  };
  const counts = { quotes: 0, refreshes: 0, authorizations: 0, completions: 0, lookups: 0, confirmations: 0 };
  let storedOrder: MerchantOrder | undefined;
  const store = new InMemoryPurchaseStore();
  const merchant: MerchantCheckoutConnector = {
    id: 'merchant-a',
    async quote() { counts.quotes++; return structuredClone(quote); },
    async refresh() { counts.refreshes++; return structuredClone(quote); },
    async complete(request) {
      counts.completions++;
      assert.equal((request.authorization.credential as { token: string }).token, secretCredential);
      storedOrder = {
        id: 'order-a', quoteId: request.quote.id, merchantId: request.quote.merchantId,
        currency: request.quote.currency, totalMinor: request.quote.totalMinor,
        status: 'completed', paymentStatus: 'unknown',
      };
      return structuredClone(storedOrder);
    },
    async lookup() { counts.lookups++; return storedOrder ? structuredClone(storedOrder) : undefined; },
  };
  const payments: PaymentAuthorizationProvider = {
    id: 'payment-a',
    async authorize(request) {
      counts.authorizations++;
      assert.equal((request.authentication as { proof: string }).proof, secretEvidence);
      return { reference: { providerId: 'payment-a', id: 'instruction-a' }, credential: { token: secretCredential } };
    },
    async confirm() { counts.confirmations++; },
  };
  const policy: PurchasePolicy = {
    allowedMerchantIds: ['merchant-a'], currency: 'USD', maxTotalMinor: 1500,
    maxQuantity: 2, expiresAt: later(120_000),
  };
  const options = { merchants: [merchant], payments, store, now: () => clock };
  const agent = new PurchasingAgent(options);
  const prepare = { ...principal, merchantId: 'merchant-a', items: [{ id: 'sku-a', quantity: 1 }], policy };
  const execute: ExecutePurchase = {
    ...principal, approve: async () => true,
    authenticate: async () => ({ kind: 'authenticated', evidence: { proof: secretEvidence } }),
  };
  return { agent, options, merchant, payments, store, policy, prepare, execute, counts,
    changeQuote(change: Partial<PurchaseQuote>) { quote = { ...quote, ...change }; },
    advance(milliseconds: number) { clock += milliseconds; },
    order: () => storedOrder,
  };
}

test('agent applies trusted merchant, currency, budget and quantity policy before payment', async () => {
  for (const change of [
    { allowedMerchantIds: ['another-shop'] }, { currency: 'EUR' }, { maxTotalMinor: 999 }, { maxQuantity: 0 },
  ]) {
    const f = fixture();
    await assert.rejects(f.agent.prepare({ ...f.prepare, policy: { ...f.policy, ...change } }), PurchasePolicyError);
    assert.equal(f.counts.authorizations, 0);
    assert.equal(f.counts.completions, 0);
  }
});

test('agent refuses merchant substitutions and unsafe totals from connector quotes', async () => {
  for (const change of [
    { merchantId: 'another-shop' }, { totalMinor: NaN }, { totalMinor: Number.MAX_SAFE_INTEGER + 1 },
    { totalMinor: -1 }, { totalMinor: 1000.25 },
    { items: [{ id: 'different-sku', quantity: 1, totalMinor: 1000 }] },
  ]) {
    const f = fixture(); f.changeQuote(change);
    await assert.rejects(f.agent.prepare(f.prepare));
    assert.equal(f.counts.authorizations, 0);
  }
});

test('purchase IDs cannot be rebound to another consumer or purchase request', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  for (const change of [
    { customerId: 'another-customer' }, { items: [{ id: 'sku-a', quantity: 2 }] },
    { policy: { ...f.policy, maxTotalMinor: 5000 } },
  ]) {
    await assert.rejects(f.agent.prepare({ ...f.prepare, ...change }), 'customerId' in change ? PurchaseNotFoundError : PurchaseConflictError);
  }
  assert.equal(f.counts.authorizations, 0);
});

test('prepared purchases are inaccessible to a different consumer or tenant', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  for (const change of [{ customerId: 'customer-b' }, { scope: 'tenant-b' }]) {
    assert.equal(await f.agent.get({ ...principal, ...change }), undefined);
    await assert.rejects(f.agent.execute({ ...f.execute, ...change }));
    await assert.rejects(f.agent.reconcile({ ...principal, ...change }));
  }
  assert.equal(f.counts.authorizations, 0);
  assert.equal(f.counts.completions, 0);
});

test('mutating approval arguments cannot increase the stored spending permission', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const view = await f.agent.execute({ ...f.execute, approve: async request => {
    request.policy.maxTotalMinor = 999999;
    request.policy.allowedMerchantIds.push('attacker-shop');
    request.quote.totalMinor = 1;
    request.quote.items[0].quantity = 100;
    return true;
  } });
  assert.equal(view.status, 'completed');
  const persisted = (await f.store.get(principal.scope, principal.purchaseId))!;
  assert.equal(persisted.policy.maxTotalMinor, 1500);
  assert.deepEqual(persisted.policy.allowedMerchantIds, ['merchant-a']);
  assert.equal(persisted.quote.totalMinor, 1000);
  assert.equal(persisted.quote.items[0].quantity, 1);
});

test('truthy application values do not count as user approval', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const result = await f.agent.execute({ ...f.execute, approve: async () => 'yes' as unknown as boolean });
  assert.equal(result.status, 'declined');
  assert.equal(f.counts.authorizations, 0);
  assert.equal(f.counts.completions, 0);
});

test('authentication challenges require fresh approval before a resumed attempt', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const challenged = await f.agent.execute({ ...f.execute,
    authenticate: async () => ({ kind: 'action_required', action: { type: 'passkey', id: 'challenge-a' } }),
  });
  assert.equal(challenged.status, 'authentication_required');
  assert.equal(f.counts.authorizations, 0);
  let approvals = 0;
  const declined = await f.agent.execute({ ...f.execute, approve: async () => { approvals++; return false; } });
  assert.equal(approvals, 1);
  assert.equal(declined.status, 'declined');
  assert.equal(f.counts.authorizations, 0);
});

test('expiring a quote during consumer authentication prevents payment authorization', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  await f.agent.execute({ ...f.execute, authenticate: async () => {
    f.advance(61_000); return { kind: 'authenticated', evidence: { proof: secretEvidence } };
  } });
  assert.equal(f.counts.authorizations, 0);
  assert.equal(f.counts.completions, 0);
});

test('a repriced quote during authentication cannot be submitted under prior approval', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  await f.agent.execute({ ...f.execute, authenticate: async () => {
    f.changeQuote({ totalMinor: 1400, revision: 'repriced' });
    return { kind: 'authenticated', evidence: { proof: secretEvidence } };
  } });
  assert.equal(f.counts.completions, 0);
});

test('authorization connection loss is fenced across calls and a new engine instance', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  f.payments.authorize = async () => { f.counts.authorizations++; throw new Error(secretCredential); };
  const initial = await f.agent.execute(f.execute);
  assert.equal(initial.status, 'unknown');
  await f.agent.execute(f.execute);
  await new PurchasingAgent(f.options).execute(f.execute);
  assert.equal(f.counts.authorizations, 1);
  assert.equal(f.counts.completions, 0);
  assert.equal(JSON.stringify(initial).includes(secretCredential), false);
});

test('lost checkout response is reconciled without authorizing or ordering twice', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const original = f.merchant.complete.bind(f.merchant);
  f.merchant.complete = async request => { await original(request); throw new Error('connection lost after order acceptance'); };
  assert.equal((await f.agent.execute(f.execute)).status, 'unknown');
  await f.agent.execute(f.execute);
  const restarted = new PurchasingAgent(f.options);
  const recovered = await restarted.reconcile(principal);
  assert.equal(recovered.status, 'completed');
  assert.equal((await restarted.execute(f.execute)).status, 'completed');
  assert.equal(f.counts.authorizations, 1);
  assert.equal(f.counts.completions, 1);
});

test('confirmation failure preserves the order and is never retried by repeated execute', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  f.payments.confirm = async () => { f.counts.confirmations++; throw new Error(secretEvidence); };
  const result = await f.agent.execute(f.execute);
  assert.equal(result.status, 'completed');
  assert.equal(result.order?.id, 'order-a');
  assert.equal(result.confirmation, 'unknown');
  await f.agent.execute(f.execute);
  await f.agent.reconcile(principal);
  assert.equal(f.counts.completions, 1);
  assert.equal(f.counts.confirmations, 1);
  assert.equal(JSON.stringify(result).includes(secretEvidence), false);
});

test('provider credentials and authentication evidence never enter durable records or public views', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const result = await f.agent.execute(f.execute);
  const record = await f.store.get(principal.scope, principal.purchaseId);
  const publicView = await f.agent.get(principal);
  for (const value of [result, record, publicView]) {
    const encoded = JSON.stringify(value);
    assert.equal(encoded.includes(secretCredential), false);
    assert.equal(encoded.includes(secretEvidence), false);
    assert.equal(encoded.includes('"credential"'), false);
    assert.equal(encoded.includes('"authentication"'), false);
  }
});

test('provider extension fields cannot smuggle credentials into orders or authorization references', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const authorize = f.payments.authorize.bind(f.payments);
  f.payments.authorize = async request => {
    const result = await authorize(request);
    return { ...result, reference: { ...result.reference, token: secretCredential } };
  };
  const complete = f.merchant.complete.bind(f.merchant);
  f.merchant.complete = async request => ({ ...await complete(request), secretToken: secretCredential });
  const result = await f.agent.execute(f.execute);
  assert.equal(result.status, 'completed');
  assert.equal(JSON.stringify(result).includes(secretCredential), false);
  assert.equal(JSON.stringify(await f.store.get(principal.scope, principal.purchaseId)).includes(secretCredential), false);
});

test('changing configured providers cannot route an existing purchase to another payment account', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const other = new PurchasingAgent({ ...f.options, payments: { ...f.payments, id: 'different-provider' } });
  await assert.rejects(other.execute(f.execute));
  assert.equal(f.counts.authorizations, 0);
});

test('an absent authoritative order does not unlock an uncertain checkout', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  f.merchant.complete = async () => { f.counts.completions++; throw new Error('request outcome unknown'); };
  assert.equal((await f.agent.execute(f.execute)).status, 'unknown');
  assert.equal((await f.agent.reconcile(principal)).status, 'unknown');
  assert.equal((await f.agent.execute(f.execute)).status, 'unknown');
  assert.equal(f.counts.completions, 1);
  assert.equal(f.counts.authorizations, 1);
});

test('an unrelated authoritative order cannot resolve an uncertain purchase', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  f.merchant.complete = async () => { throw new Error('lost checkout response'); };
  await f.agent.execute(f.execute);
  f.merchant.lookup = async () => ({ id: 'unrelated', quoteId: 'different-quote', merchantId: 'merchant-a',
    currency: 'USD', totalMinor: 1000, status: 'completed', paymentStatus: 'captured' });
  await assert.rejects(f.agent.reconcile(principal));
  assert.equal((await f.agent.get(principal))?.status, 'unknown');
});

test('concurrent execute calls reserve one authorization and one merchant submission', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const authorize = f.payments.authorize.bind(f.payments);
  f.payments.authorize = async request => {
    const authorization = await authorize(request);
    entered(); await gate; return authorization;
  };
  const first = f.agent.execute(f.execute);
  await started;
  const competing = await f.agent.execute(f.execute);
  assert.notEqual(competing.status, 'completed');
  release();
  assert.equal((await first).status, 'completed');
  assert.equal(f.counts.authorizations, 1);
  assert.equal(f.counts.completions, 1);
});

test('caller mutation while obtaining a quote cannot alter the prepared request binding', async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const quote = f.merchant.quote.bind(f.merchant);
  f.merchant.quote = async request => { entered(); await gate; return quote(request); };
  const prepared = f.agent.prepare(f.prepare);
  await started;
  f.prepare.policy.maxTotalMinor = 999999;
  f.prepare.items[0].quantity = 999;
  release();
  await prepared;
  const record = (await f.store.get(principal.scope, principal.purchaseId))!;
  assert.equal(record.policy.maxTotalMinor, 1500);
  assert.equal(record.items[0].quantity, 1);
});

test('completion returns the immutable order that won a concurrent persistence race', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const save = f.store.compareAndSet.bind(f.store);
  let intervened = false;
  f.store.compareAndSet = async (record, version) => {
    if (!intervened && record.state === 'completed' && record.order) {
      intervened = true;
      await save({ ...record, order: { ...record.order, id: 'first-reconciled-order' } }, version);
    }
    return save(record, version);
  };
  const result = await f.agent.execute(f.execute);
  assert.equal(result.status, 'completed');
  assert.equal(result.order?.id, 'first-reconciled-order');
  assert.equal((await f.agent.get(principal))?.order?.id, 'first-reconciled-order');
});

test('connector extension fields cannot become model-visible quote metadata', async () => {
  const f = fixture();
  const quote = f.merchant.quote.bind(f.merchant);
  f.merchant.quote = async request => ({ ...await quote(request), secretToken: secretCredential });
  const result = await f.agent.prepare(f.prepare);
  assert.equal(result.status, 'prepared');
  assert.equal(JSON.stringify(result).includes(secretCredential), false);
  assert.equal(JSON.stringify(await f.store.get(principal.scope, principal.purchaseId)).includes(secretCredential), false);
});

test('authentication denial prevents both credential retrieval and merchant submission', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const result = await f.agent.execute({ ...f.execute, authenticate: async () => ({ kind: 'declined' }) });
  assert.equal(result.status, 'declined');
  assert.equal(f.counts.authorizations, 0);
  assert.equal(f.counts.completions, 0);
});

test('a credential reference for another provider cannot be sent to checkout', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  f.payments.authorize = async () => ({ reference: { providerId: 'wrong-provider', id: 'instruction-x' }, credential: { token: secretCredential } });
  const result = await f.agent.execute(f.execute);
  assert.equal(result.status, 'unknown');
  assert.equal(f.counts.completions, 0);
});

test('a mismatched completed amount remains uncertain and does not trigger confirmation', async () => {
  const f = fixture(); await f.agent.prepare(f.prepare);
  const complete = f.merchant.complete.bind(f.merchant);
  f.merchant.complete = async request => ({ ...await complete(request), totalMinor: 2000 });
  assert.equal((await f.agent.execute(f.execute)).status, 'unknown');
  assert.equal((await f.agent.execute(f.execute)).status, 'unknown');
  assert.equal(f.counts.authorizations, 1);
  assert.equal(f.counts.completions, 1);
  assert.equal(f.counts.confirmations, 0);
});
