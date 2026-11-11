# Building a purchasing agent

The SDK gives a TypeScript backend a purchase lifecycle. A model can propose products and request execution while the backend controls customer identity, merchant access, budget, approval, authentication and payment. The local example is functional simulation; live integration requires onboarded providers and merchant systems.

## Workflow and trust boundaries

1. The application authenticates a customer and selects trusted scope, merchant connectors and per-purchase policy.
2. `prepare` obtains a quote for specified product IDs/quantities, validates it, and durably reserves the purchase and quote. No credentials are issued.
3. `execute` claims the prepared purchase atomically. Concurrent calls read its state rather than submitting again.
4. The application approval callback receives detached quote/policy data and must return literal `true`.
5. The authentication callback runs the approved identity/passkey flow. It returns verified evidence, a challenge action, or denial. An authentication challenge can be resumed with a fresh execute call, which obtains approval again.
6. After revalidation the payment provider obtains an ephemeral credential for the approved purchase.
7. The SDK durably records only a non-secret authorization reference, revalidates again, and sends the credential to the merchant connector.
8. The normalized order is validated/persisted, then provider confirmation is separately claimed. Order completion does not prove capture.
9. Unknown outcomes are resolved through authoritative lookup; the SDK never blindly repeats credential issuance or order submission.

Model tools expose a restricted subset of `PurchaseView`; neither authentication evidence nor credentials are included. The backend API may return a challenge identifier so your application can complete its authentication UI, but tool output omits it. Treat catalog text as untrusted display data. Do not embed provider secrets in product titles, reference IDs or other supposedly safe fields.

Quote revisions must bind all merchant fields relevant to approval, including taxes, fulfillment and delivery details. ICC connector revisions include those fields without exposing them in model views. Merchant-side quote enforcement remains essential; repeated reads cannot provide a transactional price lock.

## Local development

Run `npm run demo:agent`. The included `createSimulatedCommerce` owns a finite catalog, computes prices/tax/shipping, issues quote-bound synthetic authentication and single-use payment credentials, decrements inventory, records orders, and supports deliberate response loss. `simulation: true` is explicit. These are local fake transactions, not Visa sandbox responses. The scripted approval callback in the example is for demonstrations; replace it with a real consumer approval experience.

The reference HTTP and mTLS services under `test/fixtures` exist only for integration tests. They are not deployable merchant or authentication services. No live-payment fallback to simulation is performed.

## Configure an ICC merchant connector

Use a dedicated `CommerceClient` whose official API instances belong to the intended merchant/account, as described in `official-client.md`.

```ts
const merchant = new ICCMerchantConnector({
  id: 'trusted-merchant-account',
  client: configuredICCClient,
  quoteLifetimeMs: 120_000,
  merchantName: 'Your merchant',
  merchantUrl: 'https://merchant.example',
  createRequest: request => merchantCartMapper(request),
  toCheckoutPayment: (authorization, request) => merchantPaymentMapper(authorization, request),
  lookupOrder: request => merchantOrders.lookupByCheckoutAndKey(request),
});
```

Those three application adapters are real integration work. The cart mapper supplies any buyer/shipping data needed for a ready checkout. The credential mapper must produce the exact receiving merchant's supported payment data. It must not label raw Direct VIC JWS/JWE as an ICC token without a verified integration contract. Order lookup must use the trusted account, quote ID and checkout idempotency key, and return only a matching normalized order.

ICCMerchantConnector refuses missing item quantities/line totals and non-ready checkouts. If your supported sandbox response differs, obtain approved fixtures and adapt its normalization; do not infer missing financial fields. Its approval expiry is a local bound, not an asserted ICC session lifetime.

## Configure Direct VIC payment

`VicClient` implements `/vacp/v2/credentials-for-instruction`, subsequent credentials, confirmation and cancellation. `VicMtlsTransport` performs HTTPS with configured client certificates and server verification. `VicPaymentProvider` maps the agent purchase into that service, checks amount/currency/merchant/customer/mandate bindings, requires a verification/decryption codec, and returns an ephemeral backend credential with a restart-safe reference.

See `direct-vic.md` for the full hook contract. You must supply onboarded IDs, an already enrolled/tokenized consumer card, approved consumer authentication, fresh participant signatures and the applicable JWE/JWS implementation. The SDK will not fabricate assurance data, signing bytes or certificate settings. The first provider workflow supports `PURCHASE_HITL`; low-level Direct VIC types expose other purchase modes without implementing recurring/standing-instruction orchestration.

## Durable state

```ts
const store = new PostgresPurchaseStore(pool);
// Apply once via the application's reviewed migration process.
await pool.query(postgresPurchaseStoreSchema());
const agent = new PurchasingAgent({ merchants: [merchant], payments: configuredPaymentProvider, store });
```

Every worker for the same account must share a database/table. IDs identify stable provider/merchant account configurations; changing credentials behind the same identifier is not detectable by the SDK. Use a new configured identifier for a genuinely different account and reconcile old purchases through their original configuration. Customer IDs and scopes must come from backend authentication, not the model or arbitrary request body.

`InMemoryPurchaseStore` is for tests/demos. The legacy `PostgresAttemptStore` stores the older checkout helper's records and does not replace the new `PostgresPurchaseStore`.

## Status, confirmation and recovery

`prepared` means quoted and reserved, not approved or paid. `authentication_required` means a trusted interaction is needed. `approving`, `authorizing` and `submitting` indicate claimed stages that may still be in progress. A crash does not automatically expire or unlock them. `failed`/`declined` are terminal for that purchase. `unknown` remains fenced and must be investigated.

`reconcile` never calls authorize or complete again. With a stored authorization reference it asks the merchant/PSP for the order using the same checkout key. No matching order leaves the purchase unresolved; it does not prove that the original request failed. An uncertain authorization lacking a reference cannot be resolved automatically by merchant lookup. Investigate with the provider's authorized operational tools; do not change purchase IDs to force replay of the same quote.

A completed order and its payment status are separate. Only authoritative lookup may monotonically enrich `unknown` to `authorized`/`captured`, preserving order identity, quote and money. Confirmation is also separate:

- `pending`: not yet sent, or provider has proven it deferred before dispatch.
- `sending`: claimed; a crashed/in-flight confirmation must be treated conservatively.
- `confirmed`: provider acknowledged the confirmation.
- `unknown`: an attempted confirmation has uncertain outcome; no automatic resend.
- `not_required`: provider has no confirmation hook.

Direct VIC confirmation schemas and prose disagree about pending status values. The included provider defers before dispatch when issuer/payment status is unknown instead of sending an undocumented value. On a later explicit reconciliation, a trusted PSP lookup can establish authorized/captured status and allow the first confirmation to be sent. A response-loss error after dispatch remains unknown and is never automatically resent.

## What this SDK does not supply

It does not host a model, search the entire web for products, grant access to arbitrary storefronts, implement inbound ACP/UCP merchant servers or TAP, onboard token requestors, issue cards, provide VPP/VTS authentication services, authorize issuer payments, or capture/refund/settle money. Those boundaries remain explicit integration points. Per-purchase budget checks are not a cross-purchase aggregate ledger. Support for a provider interface is not proof of live access, Visa approval or certification.
