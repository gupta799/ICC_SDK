import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PurchasingAgent, InMemoryPurchaseStore, PaymentConfirmationDeferredError, createSimulatedCommerce,
  type PaymentAuthorizationProvider, type MerchantCheckoutConnector } from '../dist/index.js';
import { createReferenceMerchant } from './fixtures/reference-merchant.ts';

const context = { scope: 'integration-tenant', customerId: 'integration-customer', purchaseId: 'http-purchase' };
const policy = (merchantId: string) => ({ allowedMerchantIds: [merchantId], currency: 'USD', maxTotalMinor: 10_000,
  maxQuantity: 2, expiresAt: new Date(Date.now() + 120_000).toISOString() });

test('purchasing agent completes and recovers purchases through a real HTTP merchant/payment boundary', async () => {
  const reference = await createReferenceMerchant();
  try {
    const store = new InMemoryPurchaseStore();
    const options = { merchants: [reference.merchant], payments: reference.payments, store };
    const agent = new PurchasingAgent(options);
    const input = { ...context, merchantId: reference.merchant.id, items: [{ id: 'headphones', quantity: 1 }], policy: policy(reference.merchant.id) };
    await agent.prepare(input);
    const execution = { ...context, approve: async () => true, authenticate: reference.authenticate };
    const completed = await agent.execute(execution);
    assert.equal(completed.status, 'completed'); assert.equal(completed.confirmation, 'confirmed');
    assert.equal((await agent.execute(execution)).order?.id, completed.order?.id);
    const second = { ...input, purchaseId: 'lost-response', items: [{ id: 'mug', quantity: 1 }] };
    await agent.prepare(second);
    reference.disconnectNextCompletionResponse();
    const interrupted = { ...execution, purchaseId: second.purchaseId };
    assert.equal((await agent.execute(interrupted)).status, 'unknown');
    assert.equal((await agent.execute(interrupted)).status, 'unknown');
    const restarted = new PurchasingAgent(options);
    const recovered = await restarted.reconcile({ ...context, purchaseId: second.purchaseId });
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.confirmation, 'confirmed');
    assert.equal(reference.commerce.stats().orders, 2); assert.equal(reference.commerce.stats().authorizations, 2);
    assert.equal(reference.commerce.stats().confirmations, 2);
  } finally { await reference.close(); }
});

test('a deferred undispatched confirmation waits for authoritative payment status without reordering', async () => {
  const commerce = createSimulatedCommerce();
  let verified = false, externalConfirmations = 0;
  const merchant: MerchantCheckoutConnector = { ...commerce.merchant, async lookup(request) {
    const order = await commerce.merchant.lookup(request);
    return order && verified ? { ...order, paymentStatus: 'authorized' } : order;
  } };
  const payments: PaymentAuthorizationProvider = { ...commerce.payments, async confirm(request) {
    if (request.order.paymentStatus === 'unknown') throw new PaymentConfirmationDeferredError();
    externalConfirmations++; await commerce.payments.confirm!(request);
  } };
  const agent = new PurchasingAgent({ merchants: [merchant], payments, store: new InMemoryPurchaseStore() });
  await agent.prepare({ ...context, merchantId: merchant.id, items: [{ id: 'mug', quantity: 1 }], policy: policy(merchant.id) });
  const execute = { ...context, approve: async () => true, authenticate: commerce.authenticate };
  const initial = await agent.execute(execute);
  assert.equal(initial.status, 'completed'); assert.equal(initial.confirmation, 'pending');
  assert.equal(externalConfirmations, 0);
  assert.equal((await agent.reconcile(context)).confirmation, 'pending');
  verified = true;
  const completed = await agent.reconcile(context);
  assert.equal(completed.confirmation, 'confirmed'); assert.equal(completed.order?.paymentStatus, 'authorized');
  await agent.reconcile(context); await agent.execute(execute);
  assert.equal(externalConfirmations, 1); assert.equal(commerce.stats().orders, 1);
  assert.equal(commerce.stats().authorizations, 1);
});

test('confirmation callback cannot mutate the persisted authorization binding', async () => {
  const commerce = createSimulatedCommerce();
  const payments: PaymentAuthorizationProvider = { ...commerce.payments, async confirm(request) {
    await commerce.payments.confirm!(request);
    request.authorization.id = 'callback-mutated-reference';
    request.authorization.providerId = 'another-provider';
  } };
  const store = new InMemoryPurchaseStore();
  const agent = new PurchasingAgent({ merchants: [commerce.merchant], payments, store });
  await agent.prepare({ ...context, merchantId: commerce.merchant.id, items: [{ id: 'mug', quantity: 1 }], policy: policy(commerce.merchant.id) });
  const result = await agent.execute({ ...context, approve: async () => true, authenticate: commerce.authenticate });
  assert.equal(result.status, 'completed'); assert.equal(result.confirmation, 'confirmed');
  const record = (await store.get(context.scope, context.purchaseId))!;
  assert.equal(record.authorization?.providerId, 'simulation-payments');
  assert.notEqual(record.authorization?.id, 'callback-mutated-reference');
});
