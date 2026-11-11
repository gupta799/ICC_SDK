import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommerceClient, waitForCatalog, FeedFailedError, ResponseValidationError,
} from '../dist/index.js';
import type { Response } from '../dist/index.js';

function catalogFixture(body: unknown) {
  let calls = 0;
  const client = new CommerceClient({ transport: { async send() {
    calls++;
    return { status: 200, body };
  } } });
  return { client, calls: () => calls };
}

test('catalog rejects invalid timer options before making any request', async () => {
  for (const option of ['timeoutMs', 'intervalMs']) {
    for (const value of [NaN, Infinity, -1, 0, 0.5, 2_147_483_648]) {
      const f = catalogFixture({ status: 'COMPLETED' });
      await assert.rejects(waitForCatalog(f.client, 'job', {
        protocols: [], [option]: value,
      }), RangeError);
      assert.equal(f.calls(), 0);
    }
  }
});

test('catalog rejects missing job or protocol names before making any request', async () => {
  const f = catalogFixture({ status: 'COMPLETED' });
  await assert.rejects(waitForCatalog(f.client, '', { protocols: [] }), TypeError);
  await assert.rejects(waitForCatalog(f.client, 'job', { protocols: [''] }), TypeError);
  assert.equal(f.calls(), 0);
});

test('rejected records terminate polling before protocol syndication completes', async () => {
  const f = catalogFixture({
    status: 'PROCESSING', processing: { failureCount: 1 },
    syndication: { acp: { status: 'PENDING' } },
  });
  await assert.rejects(waitForCatalog(f.client, 'job', { protocols: ['acp'] }), FeedFailedError);
  assert.equal(f.calls(), 1);
});

test('failed requested syndication identifies the protocol and phase', async () => {
  const f = catalogFixture({ status: 'COMPLETED', syndication: { ucp: { status: 'FAILED' } } });
  await assert.rejects(waitForCatalog(f.client, 'job', { protocols: ['ucp'] }), (error: unknown) => {
    assert.ok(error instanceof FeedFailedError);
    assert.equal(error.phase, 'syndication');
    assert.equal(error.protocol, 'ucp');
    return true;
  });
});

test('catalog rejects malformed states, wrong job IDs and invalid counters', async () => {
  for (const body of [
    null, {}, { status: 'DONE' }, { status: 'COMPLETED', jobId: 'other' },
    { status: 'COMPLETED', processing: { failureCount: -1 } },
    { status: 'COMPLETED', processing: { failureCount: 0.5 } },
    { status: 'COMPLETED', syndication: { acp: { status: 'COMPLETE' } } },
    { status: 'COMPLETED', syndication: { acp: null } },
  ]) {
    const f = catalogFixture(body);
    await assert.rejects(waitForCatalog(f.client, 'job', { protocols: ['acp'] }), ResponseValidationError);
    assert.equal(f.calls(), 1);
  }
});

test('polling deadline covers a transport that ignores AbortSignal', async () => {
  const client = new CommerceClient({ transport: { send: () => new Promise<Response>(() => {}) } });
  await assert.rejects(waitForCatalog(client, 'job', { protocols: [], timeoutMs: 10 }), { name: 'TimeoutError' });
});

test('caller cancellation stops waiting even when transport cannot cancel', async () => {
  const controller = new AbortController();
  const client = new CommerceClient({ transport: { send: () => new Promise<Response>(() => {}) } });
  const pending = waitForCatalog(client, 'job', { protocols: [], signal: controller.signal });
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(pending, /caller cancelled/);
});

test('requested protocol readiness cannot be weakened by caller mutation', async () => {
  const protocols = ['acp'];
  let calls = 0;
  const client = new CommerceClient({ transport: { async send() {
    protocols.length = 0;
    calls++;
    return { status: 200, body: { status: 'COMPLETED', syndication: {
      acp: { status: calls === 1 ? 'PENDING' : 'SUCCESS' },
    } } };
  } } });
  await waitForCatalog(client, 'job', { protocols, intervalMs: 1 });
  assert.equal(calls, 2);
});

test('missing requested protocol remains pending until deadline', async () => {
  const f = catalogFixture({ status: 'COMPLETED' });
  await assert.rejects(waitForCatalog(f.client, 'job', {
    protocols: ['acp'], timeoutMs: 10, intervalMs: 1,
  }), { name: 'TimeoutError' });
  assert.ok(f.calls() >= 1);
});
