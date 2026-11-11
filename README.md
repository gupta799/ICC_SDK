# ICC SDK

TypeScript purchasing-agent SDK with ICC checkout integration and a separate Direct VIC payment provider. Build a backend that prepares a purchase, enforces a spending policy, obtains approval and authentication, submits checkout, and recovers uncertain outcomes.

This is a personal project, unaffiliated with Visa and not endorsed, sponsored, or certified by Visa. It is intended for prototypes and sandbox integration development. Visa and other product names belong to their respective owners.

## Run a purchasing agent

Node 22.18 or newer:

```sh
npm ci
npm run demo:agent
```

The executable example exposes four model tools, purchases headphones, repeats the request without creating another order, and recovers a second purchase after its checkout response is lost. It uses an explicit local simulator with synthetic authentication and payment credentials. It contacts no Visa service and submits no real payments.

```ts
import {
  PurchasingAgent, InMemoryPurchaseStore,
  createSimulatedCommerce, createPurchasingTools,
} from '@gupta799/icc-sdk';

const commerce = createSimulatedCommerce();
const agent = new PurchasingAgent({
  merchants: [commerce.merchant],
  payments: commerce.payments,
  store: new InMemoryPurchaseStore(), // use PostgresPurchaseStore across production workers
});
const tools = createPurchasingTools({
  agent,
  scope: 'trusted-account',
  customerId: 'authenticated-customer',
  policy: {
    allowedMerchantIds: [commerce.merchant.id], currency: 'USD',
    maxTotalMinor: 10_000, maxQuantity: 2,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
  approve: async request => approvalUI.confirm(request.quote), // application-owned UI
  authenticate: commerce.authenticate, // synthetic; replace with approved identity integration
});

const prepared = await tools.find(t => t.name === 'prepare_purchase')!.execute({
  purchaseId: 'purchase-42', merchantId: commerce.merchant.id,
  items: [{ id: 'headphones', quantity: 1 }],
});
// A model may request execution; it cannot supply approval, policy, identity or credentials.
const completed = await tools.find(t => t.name === 'execute_purchase')!.execute({ purchaseId: 'purchase-42' });
```

`approvalUI` belongs to your application. The complete runnable example is [examples/agent.ts](examples/agent.ts). The package name remains `@gupta799/icc-sdk`; it has not been published to npm. Run `npm pack` and install the resulting tarball into your backend.

## What the agent SDK does

- Validates trusted merchant, customer, currency, per-purchase budget, quantities and expiry.
- Separates quote preparation, application approval, provider authentication, credential issuance, merchant submission and provider confirmation.
- Revalidates the quote around approval/authentication and before checkout.
- Uses atomic, durable purchase/quote reservations and versioned execution claims across workers.
- Preserves unknown outcomes without automatically retrying credential issuance or checkout.
- Keeps credentials and authentication evidence outside durable records and model-facing tool results.
- Reconciles through authoritative merchant/PSP lookup; preserves the first order identity and monotonically enriches payment status.
- Tracks confirmation separately: an existing order remains completed even if its confirmation response is lost.

The first supported purchase mode obtains fresh application approval for each purchase. Policies are per purchase; this is not an aggregate budget ledger or recurring autonomous-spend service. The merchant server must enforce the approved quote atomically. Local revalidation cannot eliminate a server change after the final read.

## Choose the integrations

| Component | Included | Application supplies |
| --- | --- | --- |
| Agent orchestration | `PurchasingAgent`, strict policy checks, state machine and recovery | Authenticated customer/tenant, approval experience and approved authentication service |
| Agent tools | `prepare_purchase`, `execute_purchase`, `get_purchase`, `reconcile_purchase` descriptors | Function-calling/MCP host and tool routing; no model API key is needed for the local demo |
| Merchant checkout | `ICCMerchantConnector` for outbound ACP checkout; connector interface | ICC-enabled account, configured official client, supported credential mapping and authoritative order lookup |
| Visa payment provider | `VicClient`, `VicMtlsTransport`, `VicPaymentProvider` | Onboarding identifiers, enrolled token, certificates, fresh request signatures, request mappers and approved JWE/JWS verification/decryption |
| Durable state | `PostgresPurchaseStore` and schema | Shared pool, database migration, access controls and operations |
| Local development | `createSimulatedCommerce` with catalog, prices, inventory and single-use synthetic credentials | Nothing external; explicitly simulated |

A Direct VIC credential is not automatically an ICC checkout token. The merchant connector's payment mapper must match the receiving merchant/PSP's approved credential format. The provider and merchant connector are separate responsibilities, not interchangeable payment calls.

Start with the [agent integration guide](docs/agents.md), [safe model tools](docs/agent-tools.md), [Direct VIC setup](docs/direct-vic.md), and [durable purchase storage](docs/purchase-storage.md).

## Existing ICC APIs remain available

The existing `CommerceClient`, `OfficialClientTransport`, `completeApprovedCheckout`, and lower-level checkout/catalog helpers remain available. The captured contract has 37 ICC operations: agent and merchant registries/keys, ACP and UCP checkout, catalog operations, enrollment, purchase instructions, credentials and confirmations. Direct VIC has four separately handwritten v2 operations. This is not a claim of complete Visa ecosystem coverage.

See [official ICC transport](docs/official-client.md), [legacy checkout integration](docs/integration.md), [legacy attempt storage](docs/postgres.md), and [contract provenance](CONTRACT.md).

## Verification and live access

```sh
TEST_DATABASE_URL=postgresql://... npm run verify
npm pack
```

The full development test suite also requires Python 3 and OpenSSL; TLS tests generate temporary certificates outside the repository. Use a disposable database. Without `TEST_DATABASE_URL`, database tests are explicitly skipped. Tests cover real PostgreSQL concurrency/restart recovery, actual HTTP purchase/response-loss boundaries, local mutual TLS with client certificate authentication, official CyberSource compatibility, tool isolation, credential projection and packed-package installation/types. `npm run demo` retains the older checkout-only example; `npm run demo:agent` runs the agent workflow.

No authenticated Visa sandbox request has been executed. Local TLS tests verify our transport against a local server, not Visa acceptance or cryptographic interoperability. Approved authentication/signing/JWE/JWS integration, participant entitlements, actual merchant credential compatibility and sandbox lifecycle verification are still required before live payments. The official CyberSource release also has an unresolved detached request-encryption failure path documented in its integration guide.

The SDK implements no inbound merchant ACP/UCP HTTP server, TAP verification, issuer authorization interface, capture/refund/settlement engine, universal storefront access or product-search service. Use supported merchant connections and your existing discovery and payment systems.

Licensing remains `UNLICENSED` pending the owner's choice. No registry publication or Visa certification is implied.

## Contract regeneration

Download the public source referenced in `CONTRACT.md`, then run `python3 generate.py --spec /path/to/cybs_merged.json`. Generation records the input hash and actual operation/path counts. Review its origin and contract changes before adoption. Direct VIC code is maintained separately and is not produced by this generator.
