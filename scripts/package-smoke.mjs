import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'icc-sdk-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, npm_config_cache: join(temporary, 'npm-cache'),
    npm_config_offline: 'true', npm_config_update_notifier: 'false' },
});

try {
  // Run the same release hook explicitly so TypeScript errors stay visible in CI.
  run(npm, ['run', 'prepack'], root);
  const output = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  const packed = output[0];
  assert.ok(packed.files.some(file => file.path === 'dist/index.js'));
  assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
  assert.ok(packed.files.some(file => file.path === 'dist/generated/contracts.json'));
  assert.ok(packed.files.every(file => !/^(?:test|examples|node_modules|src)\//.test(file.path)),
    'Package must contain its built public API and documentation only');

  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    join(temporary, packed.filename)], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@gupta799/icc-sdk/package.json'), 'utf8'));
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0, 'Runtime remains dependency free');

  writeFileSync(join(consumer, 'index.mjs'), `
import assert from 'node:assert/strict';
import { CommerceClient, InMemoryAttemptStore, PurchasingAgent, InMemoryPurchaseStore, createPurchasingTools, createSimulatedCommerce } from '@gupta799/icc-sdk';
const client = new CommerceClient({ transport: { async send(request) {
  assert.equal(request.path, '/icc/v1/checkout_sessions/session_1');
  return { status: 200, body: { id: 'session_1', status: 'ready_for_payment', currency: 'USD',
    line_items: [], fulfillment_options: [], totals: [], messages: [], links: [] } };
} } });
assert.equal((await client.call('getCheckoutSession', {}, { path: { session_id: 'session_1' } })).data.id, 'session_1');
assert.equal(await new InMemoryAttemptStore().get('merchant', 'attempt'), undefined);

// Exercise the actual packed agent workflow, including uncertain-response recovery.
const simulation = createSimulatedCommerce();
assert.equal(simulation.simulation, true);
const agent = new PurchasingAgent({ merchants: [simulation.merchant], payments: simulation.payments, store: new InMemoryPurchaseStore() });
const tools = createPurchasingTools({ agent, scope: 'consumer-tenant', customerId: 'customer-1',
  policy: { allowedMerchantIds: [simulation.merchant.id], currency: 'USD', maxTotalMinor: 2000,
    maxQuantity: 2, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  approve: async () => true, authenticate: simulation.authenticate });
const tool = name => tools.find(tool => tool.name === name);
const prepared = await tool('prepare_purchase').execute({ purchaseId: 'purchase-1', merchantId: simulation.merchant.id, items: [{ id: 'mug', quantity: 1 }] });
assert.equal(prepared.ok, true);
assert.equal(prepared.purchase.status, 'prepared');
assert.equal(simulation.stats().authorizations, 0);
const completed = await tool('execute_purchase').execute({ purchaseId: 'purchase-1' });
assert.equal(completed.ok, true);
assert.equal(completed.purchase.status, 'completed');
assert.equal(completed.purchase.confirmation, 'confirmed');
assert.equal(JSON.stringify(completed).includes('credential'), false);
assert.equal((await tool('execute_purchase').execute({ purchaseId: 'purchase-1' })).purchase.order.id, completed.purchase.order.id);
assert.equal(simulation.stats().orders, 1);
assert.equal(simulation.stats().authorizations, 1);
await tool('prepare_purchase').execute({ purchaseId: 'purchase-2', merchantId: simulation.merchant.id, items: [{ id: 'mug', quantity: 1 }] });
simulation.loseNextCompletionResponse();
assert.equal((await tool('execute_purchase').execute({ purchaseId: 'purchase-2' })).purchase.status, 'unknown');
assert.equal((await tool('reconcile_purchase').execute({ purchaseId: 'purchase-2' })).purchase.status, 'completed');
assert.equal(simulation.stats().orders, 2);
assert.equal(simulation.stats().authorizations, 2);
assert.equal(simulation.stats().confirmations, 2);
`);
  run(process.execPath, ['index.mjs'], consumer);

  writeFileSync(join(consumer, 'index.mts'), `
import { CommerceClient, InMemoryAttemptStore, PurchasingAgent, InMemoryPurchaseStore, createPurchasingTools, createSimulatedCommerce, type PurchaseContext, type PreparePurchase, type AttemptStore, type Operations } from '@gupta799/icc-sdk';
const store: AttemptStore = new InMemoryAttemptStore();
const body: Operations['createCheckoutSession']['body'] = { items: [{ id: 'sku', quantity: 1 }] };
declare const client: CommerceClient;
client.checkout.acp.create(body);
store.get('merchant', 'attempt');
// @ts-expect-error operation names must remain checked in the packed declarations
client.call('notAnOperation', {});
const simulation = createSimulatedCommerce();
const agent = new PurchasingAgent({ merchants: [simulation.merchant], payments: simulation.payments, store: new InMemoryPurchaseStore() });
const context: PurchaseContext = { scope: 'tenant', customerId: 'customer', purchaseId: 'purchase-1' };
agent.get(context);
const request: PreparePurchase = { ...context, merchantId: simulation.merchant.id, items: [{ id: 'mug', quantity: 1 }],
  policy: { allowedMerchantIds: [simulation.merchant.id], currency: 'USD', maxTotalMinor: 2000, maxQuantity: 2, expiresAt: new Date().toISOString() } };
createPurchasingTools({ agent, ...context, policy: request.policy, approve: async () => true, authenticate: simulation.authenticate });
// @ts-expect-error identity must include the authenticated customer
agent.get({ scope: 'tenant', purchaseId: 'purchase-1' });
// @ts-expect-error policy money must remain minor-unit numbers
agent.prepare({ ...request, policy: { ...request.policy, maxTotalMinor: '2000' } });
`);
  run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit',
    '--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'index.mts'], consumer);
  console.log(`Package verified: ${packed.filename} (${packed.files.length} files); ESM agent purchase/recovery and consumer types passed.`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
