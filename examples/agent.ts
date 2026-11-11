import assert from 'node:assert/strict';
import { PurchasingAgent, InMemoryPurchaseStore, createSimulatedCommerce, createPurchasingTools } from '../dist/index.js';

console.log('LOCAL SIMULATION: synthetic authentication, credentials and orders; no Visa or real payments.');
const commerce = createSimulatedCommerce();
const store = new InMemoryPurchaseStore();
const agent = new PurchasingAgent({ merchants: [commerce.merchant], payments: commerce.payments, store });

// These values belong to the authenticated backend. A model cannot provide/override them.
const tools = createPurchasingTools({
  agent, scope: 'demo-account', customerId: 'demo-customer',
  policy: { allowedMerchantIds: [commerce.merchant.id], currency: 'USD', maxTotalMinor: 10_000,
    maxQuantity: 2, expiresAt: new Date(Date.now() + 300_000).toISOString() },
  approve: async ({ quote }) => {
    // Scripted demo approval. Real integrations use their own consumer approval UI.
    console.log(`Demo approval: ${quote.currency} ${quote.totalMinor} minor units at ${quote.merchantId}`);
    return true;
  },
  authenticate: commerce.authenticate, // Synthetic proof; replace with approved identity/passkey service.
});
const callTool = async (name: string, arguments_: unknown) => {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error('Unknown tool');
  const result = await tool.execute(arguments_);
  if (!result.ok) throw new Error(`Tool failed: ${result.error.code}`);
  return result.purchase;
};
console.log('Available catalog:', commerce.catalog());
console.log('Available model tools:', tools.map(tool => tool.name));

// These JSON arguments can come from a model/function-calling host.
const first = { purchaseId: 'headphones-1', merchantId: commerce.merchant.id, items: [{ id: 'headphones', quantity: 1 }] };
const quote = await callTool('prepare_purchase', first);
console.log('Prepared quote:', quote.quote);
const completed = await callTool('execute_purchase', { purchaseId: first.purchaseId });
assert.equal(completed.status, 'completed');
console.log('Completed order:', completed.order);
const cached = await callTool('execute_purchase', { purchaseId: first.purchaseId });
assert.equal(cached.order?.id, completed.order?.id);
assert.equal(commerce.stats().orders, 1);

// The merchant accepts an order, then loses its response. Recovery must not resubmit.
const second = { purchaseId: 'mug-1', merchantId: commerce.merchant.id, items: [{ id: 'mug', quantity: 1 }] };
await callTool('prepare_purchase', second);
commerce.loseNextCompletionResponse();
const uncertain = await callTool('execute_purchase', { purchaseId: second.purchaseId });
assert.equal(uncertain.status, 'unknown');
assert.equal((await callTool('execute_purchase', { purchaseId: second.purchaseId })).status, 'unknown');
const recovered = await callTool('reconcile_purchase', { purchaseId: second.purchaseId });
assert.equal(recovered.status, 'completed');
assert.equal(commerce.stats().orders, 2);
assert.equal(commerce.stats().authorizations, 2);
console.log('Recovered order:', recovered.order);
console.log('Final simulation counts:', commerce.stats());
