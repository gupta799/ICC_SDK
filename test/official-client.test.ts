import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { OfficialClientTransport, TransportConfigurationError } from '../dist/index.js';

const require = createRequire(import.meta.url);
const CyberSource = require('cybersource-rest-client');
const axios = require('axios');
const contracts = JSON.parse(readFileSync(new URL('../src/generated/contracts.json', import.meta.url), 'utf8'));

// Offline fixtures only: fake HTTP signature credentials and disabled mandatory
// request MLE allow tests to reach the installed SDK's HTTP adapter without Visa
// credentials. Production configurations must use the approved JWT/MLE setup.
const configuration = {
  authenticationType: 'http_signature', merchantID: 'offline-merchant', merchantKeyId: 'offline-key',
  merchantsecretKey: Buffer.from('offline-test-secret').toString('base64'),
  runEnvironment: 'apitest.cybersource.com', logConfiguration: { enableLog: false },
  disableRequestMLEForMandatoryApisGlobally: true,
};
const classes: Record<string, string[]> = {
  EnrollmentApi: ['enrollCard'],
  PurchaseIntentApi: ['initiatePurchaseIntent', 'updatePurchaseIntent', 'cancelPurchaseIntent'],
  PaymentEventsApi: ['retrievePaymentCredentials', 'confirmTransactionEvents'],
  CredentialsApi: ['provisionMppCredentials'],
  AgentRegistrationApi: ['registerAgent', 'getAgent', 'updateAgent', 'listAgentKeys', 'addAgentKey', 'getAgentKey', 'updateAgentKey', 'activateAgentKey'],
  MerchantRegistrationApi: ['registerMerchant', 'getMerchant', 'updateMerchant', 'listMerchantKeys', 'addMerchantKey', 'getMerchantKey', 'updateMerchantKey', 'activateMerchantKey'],
  ACPCheckoutApi: ['createCheckoutSession', 'getCheckoutSession', 'updateCheckoutSession', 'completeCheckout', 'cancelCheckout'],
  UCPCheckoutApi: ['ucpCreateCheckoutSession', 'ucpGetCheckoutSession', 'ucpUpdateCheckoutSession', 'ucpCompleteCheckout', 'ucpCancelCheckout'],
  ProductFeedApi: ['submitProductFeedJson', 'getFeedJobStatus', 'getAllProducts', 'getProduct'],
};
function instance(name = 'ACPCheckoutApi') {
  const apiClient = new CyberSource.ApiClient();
  return { apiClient, api: new CyberSource[name](configuration, apiClient) };
}
function request(operation: string, overrides: Record<string, unknown> = {}): any {
  const contract = contracts[operation];
  return { operation, method: contract.method, path: contract.path.replace(/\{[^}]+\}/g, 'value%2Fencoded'),
    body: contract.body ? { fixture: 'offline' } : undefined, headers: {}, query: {}, ...overrides };
}

test('all 37 operation signatures agree with actual CyberSource 0.0.84 API classes', async () => {
  assert.equal(require('cybersource-rest-client/package.json').version, '0.0.84');
  const seen = new Set();
  for (const [name, operations] of Object.entries(classes)) {
    for (const operation of operations) {
      seen.add(operation);
      const { apiClient, api } = instance(name);
      let dispatched: any[] | undefined;
      apiClient.callApi = (...args: any[]) => {
        dispatched = args;
        args.at(-1)(null, { fixture: 'response' }, { status: 200 });
      };
      const transport = new OfficialClientTransport({ [operation]: api });
      const input = request(operation);
      for (const parameter of contracts[operation].parameters) {
        if (parameter.in === 'header') input.headers[parameter.name] = 'header-value';
        if (parameter.in === 'query') input.query[parameter.name] = 7;
      }
      await transport.send(input);
      assert.ok(dispatched, operation);
      const [path, method, pathValues, query, headers, , body] = dispatched;
      assert.equal(path, contracts[operation].path, operation);
      assert.equal(method, contracts[operation].method, operation);
      for (const parameter of contracts[operation].parameters) {
        if (parameter.in === 'path') assert.equal(pathValues[parameter.name], 'value/encoded', operation);
        if (parameter.in === 'query') assert.equal(query[parameter.name], 7, operation);
        if (parameter.in === 'header') assert.equal(headers[parameter.name], 'header-value', `${operation}.${parameter.name}`);
        if (parameter.in === 'body') assert.deepEqual(body, input.body, operation);
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(contracts).sort());
});

test('actual official HTTP stack retains provider extension fields and response headers', async t => {
  const { apiClient, api } = instance();
  const transport = new OfficialClientTransport({ createCheckoutSession: api });
  const raw = { id: 'session', status: 'ready_for_payment', provider_extension: { retained: true } };
  t.mock.method(axios, 'request', async (config: any) => ({ status: 201, data: raw, headers: { 'request-id': 'trace-42' }, config }));
  const result = await transport.send(request('createCheckoutSession'));
  assert.deepEqual(result.body, raw);
  assert.equal(result.headers?.['request-id'], 'trace-42');
  assert.equal((result as any).req, undefined);
});

test('actual official HTTP error translation retains decrypted error JSON', async t => {
  const { api } = instance();
  const transport = new OfficialClientTransport({ createCheckoutSession: api });
  t.mock.method(axios, 'request', async (config: any) => {
    throw { code: 'ERR_BAD_REQUEST', response: { status: 422, data: { reason: 'INVALID_REQUEST', detail: 'provider detail' }, headers: { 'request-id': 'failure-trace' }, config } };
  });
  const result = await transport.send(request('createCheckoutSession'));
  assert.equal(result.status, 422);
  assert.deepEqual(result.body, { reason: 'INVALID_REQUEST', detail: 'provider detail' });
  assert.equal(result.headers?.['request-id'], 'failure-trace');
});

test('actual official HTTP network failure rejects without exposing credential material', async t => {
  const { api } = instance();
  const transport = new OfficialClientTransport({ createCheckoutSession: api });
  t.mock.method(axios, 'request', async () => { throw new Error('sensitive upstream payload'); });
  await assert.rejects(transport.send(request('createCheckoutSession')), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('sensitive'), false);
    return true;
  });
});

test('missing API configuration and bad methods fail explicitly before dispatch', async () => {
  assert.throws(() => new OfficialClientTransport({ createCheckoutSession: {} }), TransportConfigurationError);
  await assert.rejects(new OfficialClientTransport({}).send(request('createCheckoutSession')), TransportConfigurationError);
  const { api } = instance();
  const transport = new OfficialClientTransport({ createCheckoutSession: api });
  await assert.rejects(transport.send(request('createCheckoutSession', { method: 'DELETE' })), TransportConfigurationError);
  await assert.rejects(transport.send(request('createCheckoutSession', { path: '/unrelated' })), TransportConfigurationError);
});

test('pre-aborted requests do not call the official API', async () => {
  let calls = 0;
  const transport = new OfficialClientTransport({ createCheckoutSession: { createCheckoutSession() { calls++; } } });
  await assert.rejects(transport.send(request('createCheckoutSession', { signal: AbortSignal.abort() })), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('missing callbacks time out once and late callbacks do not change the result', async () => {
  let callback: any;
  const transport = new OfficialClientTransport({ createCheckoutSession: { createCheckoutSession(...args: any[]) { callback = args.at(-1); } } }, { timeoutMs: 5 });
  await assert.rejects(transport.send(request('createCheckoutSession')), /timed out/);
  assert.doesNotThrow(() => callback(null, { id: 'late' }, { status: 200 }));
  assert.throws(() => new OfficialClientTransport({}, { timeoutMs: NaN }), TransportConfigurationError);
});


test('official SDK does not deliver rejected request encryption to its callback', () => {
  // Isolate the upstream unhandled rejection so the test process stays healthy.
  // No node_modules files are modified; the injected rejection models an MLE
  // preparation failure without requiring provider keys or network access.
  const program = `
    const CyberSource = require('cybersource-rest-client');
    const MLE = require('cybersource-rest-client/src/authentication/util/MLEUtility');
    MLE.encryptRequestPayload = () => Promise.reject(new Error('offline-injected-encryption-failure'));
    const api = new CyberSource.ACPCheckoutApi(${JSON.stringify({ ...configuration, disableRequestMLEForMandatoryApisGlobally: false })}, new CyberSource.ApiClient());
    api.createCheckoutSession({items: [{id: 'offline', quantity: 1}]}, {}, () => console.log('CALLBACK_INVOKED'));
  `;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', program], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5_000, env: environment,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /offline-injected-encryption-failure/);
  assert.equal(result.stdout.includes('CALLBACK_INVOKED'), false);
});
