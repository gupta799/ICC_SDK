import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommerceClient, InMemoryAttemptStore, completeApprovedCheckout, reconcileCheckout,
  checkoutIdempotencyKey, CheckoutNotReadyError, UnknownOutcomeError, ValidationError,
  ResponseValidationError, TransportConfigurationError, validateResponse } from '../dist/index.js';
import { cart, order, payment } from './fixtures.ts';

function fixture(response: unknown = order) {
  const seen: any[] = [];
  const client = new CommerceClient({ transport: { async send(request) {
    seen.push(request);
    return { status: 200, body: request.operation === 'getCheckoutSession' ? structuredClone(cart) : response };
  } } });
  return { seen, client, options: { client, store: new InMemoryAttemptStore(), scope: 'merchant',
    sessionId: 's1', attemptId: 'a1', payment: structuredClone(payment), approve: async () => true } };
}

test('strict response validation rejects malformed read before approval', async () => {
  let approved = false;
  const f = fixture();
  f.options.client = new CommerceClient({ transport: { async send() { return { status: 200, body: { id: 's1' } }; } } });
  await assert.rejects(completeApprovedCheckout({ ...f.options, approve: async () => { approved = true; return true; } }), ResponseValidationError);
  assert.equal(approved, false);
});

test('canceled, completed and unrelated sessions cannot submit payment', async () => {
  for (const change of [{ status: 'canceled' }, { status: 'completed' }, { id: 'other' },
    { totals: [] }, { totals: [...cart.totals, ...cart.totals] }, { totals: [{ ...cart.totals[0], amount: -1 }] }]) {
    const f = fixture(); let approved = false;
    f.options.client = new CommerceClient({ transport: { async send() { return { status: 200, body: { ...cart, ...change } }; } } });
    await assert.rejects(completeApprovedCheckout({ ...f.options, approve: async () => { approved = true; return true; } }), CheckoutNotReadyError);
    assert.equal(approved, false);
  }
});

test('malformed, unrelated and repriced completion responses remain unknown', async () => {
  for (const response of [{ id: 's1', status: 'completed' }, { ...order, id: 'other' }, { ...order, order: {} },
    { ...order, totals: [{ ...order.totals[0], amount: 2000 }] }]) {
    const f = fixture(response);
    await assert.rejects(completeApprovedCheckout(f.options), UnknownOutcomeError);
    await assert.rejects(completeApprovedCheckout(f.options), UnknownOutcomeError);
    assert.equal(f.seen.filter(request => request.operation === 'completeCheckout').length, 1);
    assert.equal((await f.options.store.get('merchant', 'a1'))?.state, 'unknown');
  }
});

test('new attempt IDs cannot bypass a completed session fence', async () => {
  const f = fixture();
  await completeApprovedCheckout(f.options);
  await assert.rejects(completeApprovedCheckout({ ...f.options, attemptId: 'fresh' }), UnknownOutcomeError);
  assert.equal(f.seen.filter(request => request.operation === 'completeCheckout').length, 1);
});

test('invalid payment fails before approval, reads or durable claims', async () => {
  const f = fixture();
  await assert.rejects(completeApprovedCheckout({ ...f.options, payment: { payment_data: { token: '', provider: 'test' } } }), ValidationError);
  assert.equal(f.seen.length, 0);
  assert.equal(await f.options.store.get('merchant', 'a1'), undefined);
});

test('approval sees completion buyer but never receives the payment token', async () => {
  const f = fixture();
  const buyer = { first_name: 'New buyer', email: 'new@example.com' };
  await completeApprovedCheckout({ ...f.options, payment: { ...payment, buyer }, approve: async snapshot => {
    assert.deepEqual(snapshot.buyer, buyer);
    assert.equal(JSON.stringify(snapshot).includes(payment.payment_data.token), false);
    return true;
  } });
});

test('payment is snapshotted before asynchronous approval', async () => {
  const f = fixture();
  await completeApprovedCheckout({ ...f.options, approve: async () => {
    f.options.payment.payment_data.token = 'changed'; return true;
  } });
  const submitted = f.seen.find(request => request.operation === 'completeCheckout');
  assert.equal(submitted.body.payment_data.token, 'opaque');
  assert.equal(submitted.headers['Idempotency-Key'], checkoutIdempotencyKey('merchant', 'a1'));
  assert.notEqual(checkoutIdempotencyKey('another', 'a1'), submitted.headers['Idempotency-Key']);
});

test('completion return values cannot mutate the persisted cache', async () => {
  const f = fixture();
  const first = await completeApprovedCheckout(f.options);
  first.order.id = 'mutated'; first.totals[0].amount = 999;
  const second = await completeApprovedCheckout(f.options);
  assert.equal(second.order.id, 'order-1'); assert.equal(second.totals[0].amount, 1000);
});

test('reconciliation refuses a completed order for different approved totals', async () => {
  const f = fixture({ id: 's1' });
  await assert.rejects(completeApprovedCheckout(f.options), UnknownOutcomeError);
  await assert.rejects(reconcileCheckout(f.options.store, 'merchant', 'a1', async () => ({
    ...order, totals: [{ ...order.totals[0], amount: 5000 }],
  })), /does not match/);
  assert.equal((await f.options.store.get('merchant', 'a1'))?.state, 'unknown');
  assert.equal(await reconcileCheckout(f.options.store, 'merchant', 'a1', async () => undefined), undefined);
});

test('in-memory completion is monotonic against stale failure saves', async () => {
  const f = fixture(); await completeApprovedCheckout(f.options);
  const completed = (await f.options.store.get('merchant', 'a1'))!;
  await f.options.store.save({ ...completed, result: undefined, state: 'unknown' });
  assert.deepEqual(await f.options.store.get('merchant', 'a1'), completed);
});

test('canceling during approval does not claim or submit', async () => {
  const f = fixture(); const controller = new AbortController();
  await assert.rejects(completeApprovedCheckout({ ...f.options, signal: controller.signal,
    approve: async () => { controller.abort(); return true; } }), { name: 'AbortError' });
  assert.equal(await f.options.store.get('merchant', 'a1'), undefined);
  assert.equal(f.seen.length, 1);
});

test('workflow enforces response validation even if low-level client opts out', async () => {
  const f = fixture();
  f.options.client = new CommerceClient({ responseValidation: 'none', transport: { async send() { return { status: 200, body: { id: 's1' } }; } } });
  await assert.rejects(completeApprovedCheckout(f.options), ResponseValidationError);
});

test('undocumented successful statuses and missing fields are explicit response failures', () => {
  assert.throws(() => validateResponse('getCheckoutSession', 204, undefined), ResponseValidationError);
  assert.throws(() => validateResponse('getCheckoutSession', 200, {}), ResponseValidationError);
});

test('client preserves proven configuration failures before write dispatch', async () => {
  const f = new CommerceClient({ transport: { async send() { throw new TransportConfigurationError('Missing configured API'); } } });
  await assert.rejects(f.checkout.acp.create({ items: [{ id: 'sku', quantity: 1 }] }), TransportConfigurationError);
});

test('ambiguous duplicate headers and header injection are rejected before dispatch', async () => {
  const f = fixture();
  for (const headers of [{ 'Idempotency-Key': 'one', 'idempotency-key': 'two' }, { 'Request-Id': 'x\r\nInjected: true' }] as Record<string, string>[]) {
    await assert.rejects(f.client.call('completeCheckout', payment, { path: { session_id: 's1' }, headers }), ValidationError);
  }
  assert.equal(f.seen.length, 0);
});

test('approval requires literal true rather than truthy application data', async () => {
  const f = fixture();
  await assert.rejects(completeApprovedCheckout({ ...f.options,
    approve: async () => 'approved' as unknown as boolean }), { name: 'CheckoutApprovalDeclinedError' });
  assert.equal(await f.options.store.get('merchant', 'a1'), undefined);
  assert.equal(f.seen.filter(request => request.operation === 'completeCheckout').length, 0);
});

test('completion returns the persisted reconciliation winner', async () => {
  const f = fixture();
  const originalSave = f.options.store.save.bind(f.options.store);
  let reconciled = false;
  f.options.store.save = async attempt => {
    if (!reconciled && attempt.state === 'completed') {
      reconciled = true;
      await originalSave({ ...attempt, result: { ...attempt.result!, order: { id: 'reconciled-order' } } });
    }
    await originalSave(attempt);
  };
  const result = await completeApprovedCheckout(f.options);
  assert.equal(result.order.id, 'reconciled-order');
  assert.equal((await completeApprovedCheckout(f.options)).order.id, 'reconciled-order');
});

test('concurrent reconciliation lookups return the first persisted completed order', async () => {
  const f = fixture({ id: 's1' });
  await assert.rejects(completeApprovedCheckout(f.options), UnknownOutcomeError);
  const result = await reconcileCheckout(f.options.store, 'merchant', 'a1', async attempt => {
    await f.options.store.save({ ...attempt, state: 'completed', result: order });
    return { ...order, order: { id: 'later-lookup-order' } };
  });
  assert.equal(result?.order.id, 'order-1');
});
