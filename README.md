# ICC SDK

Independent TypeScript developer toolkit for Intelligent Commerce Connect prototypes and sandbox integrations.

This is a personal project. It is not an official Visa product and is not affiliated with, sponsored, endorsed, or certified by Visa. Visa and other product names are trademarks of their respective owners. Version 0.1.0 implements all 37 ICC operations through typed `client.call`, plus merchant, catalog and checkout helpers. This initial package excludes direct VIC v2 and TAP cryptographic verification.

## Run

Node 22.18 or newer:

```sh
npm ci
npm run build
npm test
npm run demo
```

The demo runs locally and submits no payments. `dist` is included in the source archive; runtime has no dependencies. The build requires TypeScript. Types are generated from the public contract described in CONTRACT.md.

## Merchant checkout

```ts
import { CommerceClient, OfficialClientTransport } from '@gupta799/icc-sdk';
// Configure official API instances with dedicated ApiClients, JWT and mandatory
// request/response MLE. Store secrets in your backend's secret manager.
const client = new CommerceClient({
  transport: new OfficialClientTransport({
    createCheckoutSession: configuredACPApi,
    completeCheckout: configuredACPApi,
    registerMerchant: configuredMerchantRegistryApi,
  }),
});
const session = await client.checkout.acp.create({
  items: [{ id: 'sku_blue_mug', quantity: 1 }],
});
// Fetch and confirm authoritative totals before requesting payment approval.
```

Use the official `cybersource-rest-client` package's API classes such as `ACPCheckoutApi`, `UCPCheckoutApi`, `MerchantRegistrationApi`, `ProductFeedApi`, `PurchaseIntentApi`, and `PaymentEventsApi`. Construct each with your sandbox configuration and a dedicated `new CyberSource.ApiClient()` as its second argument. Map every operation you use to its configured API instance. Never share the default singleton client between tenants. Follow current Visa onboarding guidance for the JWT/MLE configuration; this package does not invent credentials, encryption, or certificate settings.

## Other operations

```ts
await client.call('getMerchant', undefined, {path: {merchantId}});
await client.call('updateCheckoutSession', updatedCart, {path: {session_id}});
await client.catalog.status(jobId);
```

`Operations` exports the generated request and response types. Requests are validated before transport. Completion requires a stable caller-generated idempotency key. The same key must be reused after an uncertain completion; do not generate a new key on retry.

Results distinguish `success`, `action_required`, `accepted` and `unverified`. `accepted` catalog jobs still need processing/syndication checks. A credential retrieval returns `unverified` because the published wrapper shape is ambiguous; obtain approved sandbox fixtures before consuming it. `success` describes the API operation, never an issuer authorization guarantee. Responses retain provider data; optional and unexpected response fields are not discarded.

Transport exceptions on writes become `UnknownOutcomeError`. No writes are automatically retried. Reconcile the order or transaction with the authoritative merchant/PSP before retrying. HTTP failures become `ApiError`; sensitive response bodies are not placed in error messages. The optional evidence sink records only operation/status/outcome metadata. Sink delivery is best effort and must be monitored by the application. Durable dispute evidence remains the application's responsibility.

The adapter supports a pre-dispatch AbortSignal check; the official callback client does not expose cancellation of in-flight requests here. Apply network timeouts in the configured official client. Do not use this package as a browser library or expose payment material to an LLM. Authentication, participant approval, merchant entitlement, issuer support, certification, payment capture/refund adapters and live end-to-end testing remain integration work.

## Validation status

Unit tests exercise nested request validation, route differences, idempotency, unknown outcomes, tenant routing, official-client argument mapping, pending states and audit failures. No authenticated Visa sandbox request has been executed. Keep the SDK in sandbox until the supported configurations have passed integration testing.

## Regenerate contracts

Download the public source JSON linked in CONTRACT.md, then run `python3 generate.py --spec /path/to/cybs_merged.json` and rebuild. Review contract differences before updating a deployed SDK.
