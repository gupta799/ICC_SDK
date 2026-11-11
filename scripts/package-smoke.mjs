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
import { CommerceClient, InMemoryAttemptStore } from '@gupta799/icc-sdk';
const client = new CommerceClient({ transport: { async send(request) {
  assert.equal(request.path, '/icc/v1/checkout_sessions/session_1');
  return { status: 200, body: { id: 'session_1', status: 'ready_for_payment', currency: 'USD',
    line_items: [], fulfillment_options: [], totals: [], messages: [], links: [] } };
} } });
assert.equal((await client.call('getCheckoutSession', {}, { path: { session_id: 'session_1' } })).data.id, 'session_1');
assert.equal(await new InMemoryAttemptStore().get('merchant', 'attempt'), undefined);
`);
  run(process.execPath, ['index.mjs'], consumer);

  writeFileSync(join(consumer, 'index.mts'), `
import { CommerceClient, InMemoryAttemptStore, type AttemptStore, type Operations } from '@gupta799/icc-sdk';
const store: AttemptStore = new InMemoryAttemptStore();
const body: Operations['createCheckoutSession']['body'] = { items: [{ id: 'sku', quantity: 1 }] };
declare const client: CommerceClient;
client.checkout.acp.create(body);
store.get('merchant', 'attempt');
// @ts-expect-error operation names must remain checked in the packed declarations
client.call('notAnOperation', {});
`);
  run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit',
    '--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'index.mts'], consumer);
  console.log(`Package verified: ${packed.filename} (${packed.files.length} files); ESM import and consumer types passed.`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
