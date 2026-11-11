import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import { createVicTestCertificates } from './fixtures/vic/certificates.ts';
import { VicClient } from '../dist/vic/client.js';
import { VicMtlsTransport } from '../dist/vic/mtls.js';
import { VicApiError, VicResponseError, VicUnknownOutcomeError, VicValidationError,
    type VicCredentialsRequest, type VicTransport, type VicHttpRequest } from '../dist/vic/types.js';
import { VicPaymentProvider, VicCredentialVerificationError, VicProviderBindingError,
    type VicPaymentProviderOptions } from '../dist/agent/providers/vic.js';
import { PaymentConfirmationDeferredError, type AuthorizationRequest, type ConfirmationRequest } from '../dist/agent/types.js';

const now = Date.now();
const clientIdentity = { agent: { agentId: 'test-agent' }, externalClientId: 'test-client', externalAppId: 'test-app' };
const appInstance = { ipAddress: '127.0.0.1', userAgent: 'test', clientDeviceId: 'device', applicationName: 'test', countryCode: 'US', deviceData: { type: 'Laptop', brand: 'Test' } };
const assurance = [{ verificationEntity: '30' as const, verificationMethod: '23' as const, verificationResults: '01' as const, verificationTimestamp: String(Math.floor(now / 1000)) }];
function request(reference = 'authorization-key'): VicCredentialsRequest {
    return { client: structuredClone(clientIdentity), tokenId: 'opaque-test-token-reference',
        consumer: { consumerId: 'customer', countryCode: 'US', languageCode: 'en', consumerIdentities: [{ identityType: 'EMAIL_ADDRESS', identityValue: 'test@example.com' }] },
        mandates: [{ mandateId: 'mandate-1', declineThreshold: { amount: '20.00', currencyCode: 'USD' }, effectiveUntilTime: String(Math.floor((now + 30_000) / 1000)) }],
        appInstance: structuredClone(appInstance), purchaseType: 'PURCHASE_HITL', assuranceData: structuredClone(assurance),
        transactionData: { merchantId: 'visa-merchant', merchantName: 'Test merchant', merchantUrl: 'https://merchant.example',
            transactionReferenceId: reference, transactionAmount: { transactionAmount: '10.00', transactionCurrencyCode: 'USD' } },
        clientReferenceId: reference };
}
const envelope = (reference = 'authorization-key', instructionId = 'instruction/one') => ({
    instructionId, clientReferenceId: reference,
    payload: { network: 'visa', signedPayload: 'offline.signed.fixture', providerExtension: 'retained' },
});
function fixture(status = 200, supplied?: unknown) {
    const seen: VicHttpRequest[] = [];
    const transport: VicTransport = { async send(input) {
        seen.push(input);
        const body = input.body as { clientReferenceId: string };
        const data = input.operation === 'confirmInstruction' ? { status: 'COMPLETED', clientReferenceId: body.clientReferenceId }
            : input.operation === 'cancelInstruction' ? { instructionId: 'instruction/one', clientReferenceId: body.clientReferenceId }
            : envelope(body.clientReferenceId);
        return { status, body: supplied ?? data };
    } };
    return { seen, client: new VicClient(transport) };
}

test('Direct VIC client maps four v2 operations and keeps cancellation distinct from confirmation', async () => {
    const f = fixture(); const body = request();
    const first = await f.client.credentialsForInstruction(body);
    assert.equal(first.payload.providerExtension, 'retained');
    await f.client.retrieveCredentials('instruction/one', { client: clientIdentity, tokenId: body.tokenId,
        transactionData: { ...body.transactionData, encryptedInstruction: 'approved-jwe-fixture', mandateReferenceData: [{ mandateId: 'mandate-1' }] }, clientReferenceId: body.clientReferenceId });
    await f.client.confirmInstruction('instruction/one', { client: clientIdentity, clientReferenceId: 'confirm-key', instructionCompleted: true,
        confirmationData: [{ transactionReferenceId: body.clientReferenceId, transactionStatus: 'APPROVED', transactionTimestamp: String(Math.floor(now / 1000)),
            transactionAmount: body.transactionData.transactionAmount, mandateReferenceData: [{ mandateId: 'mandate-1', status: 'COMPLETED' }] }] });
    const cancelled = await f.client.cancelInstruction('instruction/one', { client: clientIdentity, appInstance, assuranceData: assurance, clientReferenceId: 'cancel-key' });
    assert.equal(cancelled.instructionId, 'instruction/one');
    assert.deepEqual(f.seen.map(input => [input.method, input.path]), [
        ['POST', '/vacp/v2/credentials-for-instruction'], ['POST', '/vacp/v2/instructions/instruction%2Fone/credentials'],
        ['POST', '/vacp/v2/instructions/instruction%2Fone/confirmation'], ['PUT', '/vacp/v2/instructions/instruction%2Fone/cancel'],
    ]);
});

test('Direct VIC request validation rejects invalid JSON, missing assurance and missing retrieval mandate before dispatch', async () => {
    for (const change of [{ assuranceData: [] }, { purchaseType: 'invented' }, { tokenId: '' }, { transactionData: { ...request().transactionData, transactionAmount: { transactionAmount: 10, transactionCurrencyCode: 'USD' } } },
        { extra: BigInt(1) }, { extra: () => 'not-json' }]) {
        const f = fixture();
        await assert.rejects(f.client.credentialsForInstruction({ ...request(), ...change } as any), VicValidationError);
        assert.equal(f.seen.length, 0);
    }
    const f = fixture();
    await assert.rejects(f.client.retrieveCredentials('instruction', { client: clientIdentity, tokenId: 'token', clientReferenceId: 'key', transactionData: { ...request().transactionData, encryptedInstruction: 'jwe', mandateReferenceData: [] } }), VicValidationError);
    assert.equal(f.seen.length, 0);
});

test('Direct VIC correlation, success status and mutually exclusive credential variants are validated', async () => {
    for (const [status, data] of [[202, envelope()], [200, envelope('other-reference')], [200, { ...envelope(), payload: { network: 'visa', signedPayload: 'jws', encryptedSignedPayload: 'jwe' } }],
        [200, { ...envelope(), payload: { network: 'visa' } }]] as const) {
        const f = fixture(status, data);
        await assert.rejects(f.client.credentialsForInstruction(request()), VicResponseError);
        assert.equal(f.seen.length, 1);
    }
});

test('Direct VIC network errors are never retried and sensitive errors are not propagated', async () => {
    let calls = 0;
    const c = new VicClient({ async send() { calls++; throw new Error('secret-token-body'); } });
    await assert.rejects(c.credentialsForInstruction(request()), error => error instanceof VicUnknownOutcomeError && !error.message.includes('secret'));
    assert.equal(calls, 1);
    await assert.rejects(fixture(403, { reason: 'ACCESS_DENIED', detail: 'secret-token-body' }).client.credentialsForInstruction(request()), error => error instanceof VicApiError && error.reason === 'ACCESS_DENIED' && !error.message.includes('secret'));
});

test('Direct VIC pre-aborted requests never dispatch', async () => {
    const f = fixture();
    await assert.rejects(f.client.credentialsForInstruction(request(), { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(f.seen.length, 0);
});

const authorizationRequest = (): AuthorizationRequest => ({ scope: 'merchant-account', purchaseId: 'purchase-1', customerId: 'customer',
    idempotencyKey: 'authorization-key', authentication: { assuranceData: structuredClone(assurance) },
    quote: { id: 'quote-1', merchantId: 'merchant', merchantName: 'Test merchant', merchantUrl: 'https://merchant.example', currency: 'USD', totalMinor: 1000,
        items: [{ id: 'mug', quantity: 1, totalMinor: 1000 }], expiresAt: new Date(now + 60_000).toISOString(), revision: 'revision-1' },
    policy: { allowedMerchantIds: ['merchant'], currency: 'USD', maxTotalMinor: 2000, maxQuantity: 1, expiresAt: new Date(now + 60_000).toISOString() } });
function providerFixture(overrides: Partial<VicPaymentProviderOptions> = {}) {
    const f = fixture(); let decoded = 0;
    const options: VicPaymentProviderOptions = { client: f.client, currencyExponents: { USD: 2, JPY: 0, KWD: 3 }, now: () => now,
        merchantIdentity: () => ({ merchantId: 'visa-merchant', merchantName: 'Test merchant', merchantUrl: 'https://merchant.example' }),
        buildCredentialsRequest: async input => request(input.idempotencyKey),
        verifyAndDecode: async (_envelope, input) => { decoded++; return { credential: { provider: 'visa-test', token: 'verified-test-token' }, transactionReferenceId: input.idempotencyKey, expiresAt: new Date(now + 60_000).toISOString() }; },
        buildConfirmationRequest: async (input, reference) => ({ client: clientIdentity, clientReferenceId: input.idempotencyKey, instructionCompleted: true,
            confirmationData: [{ transactionAmount: request().transactionData.transactionAmount, transactionStatus: 'APPROVED',
                transactionTimestamp: String(Math.floor(now / 1000)), transactionReferenceId: reference.transactionReferenceId,
                mandateReferenceData: [{ mandateId: reference.mandateId, status: 'COMPLETED' }] }] }), ...overrides };
    return { ...f, provider: new VicPaymentProvider(options), decoded: () => decoded };
}

test('VIC payment provider verifies credentials and uses a non-secret restart-safe authorization reference', async () => {
    const f = providerFixture(); const context = authorizationRequest();
    const authorized = await f.provider.authorize(context);
    assert.equal(f.decoded(), 1);
    assert.deepEqual(authorized.credential, { provider: 'visa-test', token: 'verified-test-token' });
    assert.equal(authorized.reference.id.includes('verified-test-token'), false);
    const restarted = providerFixture();
    const confirmation: ConfirmationRequest = { scope: context.scope, purchaseId: context.purchaseId, customerId: context.customerId,
        quote: context.quote, idempotencyKey: 'confirmation-key', authorization: authorized.reference,
        order: { id: 'order-1', quoteId: context.quote.id, merchantId: 'merchant', currency: 'USD', totalMinor: 1000, status: 'completed', paymentStatus: 'authorized' } };
    await restarted.provider.confirm(confirmation);
    assert.equal(restarted.seen[0].path, '/vacp/v2/instructions/instruction%2Fone/confirmation');
    assert.equal((restarted.seen[0].body as any).confirmationData[0].transactionReferenceId, 'authorization-key');
});

test('VIC provider blocks mismatched amount, currency, merchant, consumer, budget and unverified authentication before dispatch', async () => {
    const mismatches = [
        (body: VicCredentialsRequest) => { body.transactionData.transactionAmount.transactionAmount = '10.01'; },
        (body: VicCredentialsRequest) => { body.transactionData.transactionAmount.transactionCurrencyCode = 'EUR'; },
        (body: VicCredentialsRequest) => { body.transactionData.merchantId = 'other'; },
        (body: VicCredentialsRequest) => { body.consumer.consumerId = 'other'; },
        (body: VicCredentialsRequest) => { body.mandates[0].declineThreshold.amount = '30.00'; },
        (body: VicCredentialsRequest) => { body.assuranceData[0].verificationResults = '02'; },
        (body: VicCredentialsRequest) => { body.transactionData.transactionReferenceId = 'different'; },
    ];
    for (const mutate of mismatches) {
        const f = providerFixture({ buildCredentialsRequest: async () => { const body = request(); mutate(body); return body; } });
        await assert.rejects(f.provider.authorize(authorizationRequest()), VicProviderBindingError);
        assert.equal(f.seen.length, 0);
    }
});

test('VIC provider does not trust an expired, unrelated or unverified credential', async () => {
    for (const verifier of [async () => { throw new Error('secret-verifier-detail'); },
        async () => ({ credential: 'opaque', transactionReferenceId: 'unrelated', expiresAt: new Date(now + 60_000).toISOString() }),
        async () => ({ credential: 'opaque', transactionReferenceId: 'authorization-key', expiresAt: new Date(now - 1).toISOString() })]) {
        const f = providerFixture({ verifyAndDecode: verifier });
        await assert.rejects(f.provider.authorize(authorizationRequest()), error => error instanceof VicCredentialVerificationError && !error.message.includes('secret'));
    }
});

test('VIC provider refuses an unconfigured currency exponent or unknown payment outcome', async () => {
    const f = providerFixture(); const input = authorizationRequest(); input.quote.currency = 'EUR';
    await assert.rejects(f.provider.authorize(input), VicProviderBindingError);
    const context = authorizationRequest(); const authorized = await f.provider.authorize(context);
    await assert.rejects(f.provider.confirm({ ...context, authorization: authorized.reference,
        order: { id: 'order', quoteId: 'quote-1', merchantId: 'merchant', currency: 'USD', totalMinor: 1000, status: 'completed', paymentStatus: 'unknown' } }), PaymentConfirmationDeferredError);
    assert.equal(f.seen.length, 1);
});

const certificates = createVicTestCertificates();
async function serverFixture(handler: Parameters<typeof createServer>[1]) {
    const server = createServer({ key: certificates.serverKey, cert: certificates.serverCert, ca: certificates.ca, requestCert: true, rejectUnauthorized: true }, handler);
    server.on('tlsClientError', () => {});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    return { server, origin: `https://127.0.0.1:${address.port}` };
}
async function closeServer(server: Server) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
const transportOptions = { cert: certificates.clientCert, key: certificates.clientKey, ca: certificates.ca };

test('VIC mutual-TLS transport authenticates client certificate and exchanges actual HTTPS JSON', async () => {
    let calls = 0;
    const fixture = await serverFixture(async (req, res) => {
        calls++; assert.equal((req.socket as any).authorized, true); assert.equal(req.url, '/vacp/v2/credentials-for-instruction');
        assert.equal(req.headers.authorization, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.tokenId, request().tokenId);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(envelope(body.clientReferenceId)));
    });
    const transport = new VicMtlsTransport({ ...transportOptions, baseUrl: fixture.origin, basicAuth: { username: 'test-user', password: 'test-password' } });
    try { assert.equal((await new VicClient(transport).credentialsForInstruction(request())).instructionId, 'instruction/one'); assert.equal(calls, 1); }
    finally { transport.close(); await closeServer(fixture.server); }
});

test('VIC mutual-TLS transport refuses untrusted server certificates', async () => {
    let calls = 0; const fixture = await serverFixture((_req, res) => { calls++; res.end('{}'); });
    const transport = new VicMtlsTransport({ cert: transportOptions.cert, key: transportOptions.key, baseUrl: fixture.origin });
    try { await assert.rejects(new VicClient(transport).credentialsForInstruction(request()), VicUnknownOutcomeError); assert.equal(calls, 0); }
    finally { transport.close(); await closeServer(fixture.server); }
});

test('VIC transport bounds callback wait and response size without retrying', async () => {
    for (const mode of ['hang', 'large']) {
        let calls = 0;
        const fixture = await serverFixture((_req, res) => { calls++; if (mode === 'large') res.end(JSON.stringify({ payload: 'x'.repeat(20_000) })); });
        const transport = new VicMtlsTransport({ ...transportOptions, baseUrl: fixture.origin, timeoutMs: 100, maxBodyBytes: 5000 });
        try { await assert.rejects(new VicClient(transport).credentialsForInstruction(request()), VicUnknownOutcomeError); assert.equal(calls, 1); }
        finally { transport.close(); await closeServer(fixture.server); }
    }
    assert.throws(() => new VicMtlsTransport({ ...transportOptions, baseUrl: 'http://127.0.0.1' }), VicValidationError);
    assert.throws(() => new VicMtlsTransport({ ...transportOptions, timeoutMs: NaN }), VicValidationError);
});

test('VIC provider binds against retained context even when a request builder mutates its input', async () => {
    const f = providerFixture({ buildCredentialsRequest: async input => {
        input.quote.totalMinor = 9999;
        const body = request(); body.transactionData.transactionAmount.transactionAmount = '99.99';
        return body;
    } });
    await assert.rejects(f.provider.authorize(authorizationRequest()), VicProviderBindingError);
    assert.equal(f.seen.length, 0);
});

test('VIC provider rechecks purchase expiry after authentication request preparation and credential verification', async () => {
    let clock = now;
    const f = providerFixture({ now: () => clock, buildCredentialsRequest: async () => { clock = now + 120_000; return request(); } });
    await assert.rejects(f.provider.authorize(authorizationRequest()), VicProviderBindingError);
    assert.equal(f.seen.length, 0);
    clock = now;
    const after = providerFixture({ now: () => clock, verifyAndDecode: async (_body, input) => {
        clock = now + 120_000;
        return { credential: 'opaque', transactionReferenceId: input.idempotencyKey, expiresAt: new Date(now + 240_000).toISOString() };
    } });
    await assert.rejects(after.provider.authorize(authorizationRequest()), VicCredentialVerificationError);
    assert.equal(after.seen.length, 1);
});
