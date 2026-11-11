# ICC SDK

Independent TypeScript merchant toolkit for Intelligent Commerce Connect prototypes and sandbox integrations. Handwritten checkout and catalog workflows sit above the generated API contracts.

This is a personal project, unaffiliated with Visa and not endorsed, sponsored, or certified by Visa. Visa and other product names belong to their respective owners.

## What is implemented

- Approval tied to a detached checkout snapshot, quote revalidation, and readiness checks.
- Durable PostgreSQL completion fences across workers and restarts, scoped idempotency keys, cached completion, and authoritative reconciliation.
- Strict response validation, request validation, explicit pending states, and no automatic mutation retries.
- Catalog ingestion and protocol syndication polling with deadlines, cancellation, and rejection handling.
- An adapter tested against the actual CyberSource Node SDK `0.0.84`, including all 37 operation signatures and its HTTP response handling.
- A dependency-free ESM runtime, TypeScript declarations, package consumer tests, and CI on Node 22.18/24 with PostgreSQL.

ACP has the approved checkout workflow. UCP has typed create/get/update/cancel/complete helpers; its payloads and routes remain distinct. Direct VIC v2 and TAP cryptographic verification are outside this package.

## Build and try it

Node 22.18 or newer:

```sh
npm ci
npm run verify
npm pack
```

`npm run demo` runs a local checkout simulation: repeated completion calls return one recorded order. No payment is submitted. The package is named `@gupta799/icc-sdk`; registry publication is a separate release step. Install a locally packed tarball into your backend to evaluate it.

## Complete an approved checkout

```ts
import {
  completeApprovedCheckout, PostgresAttemptStore,
  postgresAttemptStoreSchema,
} from '@gupta799/icc-sdk';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Apply this once using your application's database migration process.
await pool.query(postgresAttemptStoreSchema());
const store = new PostgresAttemptStore(pool);

const order = await completeApprovedCheckout({
  client, // CommerceClient with configured official JWT/MLE API instances
  store,
  scope: 'merchant-account-1', // trusted, stable backend configuration
  attemptId: 'order-attempt-42', // keep stable for this attempt
  sessionId,
  payment,
  approve: async cart => approvalUI.confirm(cart), // must return literal true
});
```

The workflow validates the session and payment, obtains approval, fetches the session again, and compares purchase fields. It atomically claims the session before submitting completion with a key derived from scope and attempt ID. A completion must match the approved purchase and contain an order identifier before being cached. The checkout server must still enforce the approved totals atomically: a final read cannot prevent subsequent changes on the server.

Every worker for a merchant must share one durable database/table and stable scope. A new attempt ID cannot bypass an existing session claim. Claims have no automatic expiry or release. `InMemoryAttemptStore` is only for demos and tests. Low-level completion helpers require an idempotency key but do not provide the workflow's storage fence.

## Recover an uncertain completion

```ts
import { reconcileCheckout, checkoutIdempotencyKey } from '@gupta799/icc-sdk';

const order = await reconcileCheckout(store, scope, attemptId, async attempt => {
  // Implement this with your authoritative merchant/PSP records and credentials.
  // Match this trusted merchant, session, and derived key; never just a similar total.
  return merchantOrders.findCompletedCheckout({
    merchant: attempt.scope,
    sessionId: attempt.sessionId,
    idempotencyKey: checkoutIdempotencyKey(attempt.scope, attempt.id),
  });
});
```

`undefined` leaves the attempt unresolved. It does not authorize resubmission. Reconciliation validates the response and approved financial/fulfillment fields before saving. Completion is monotonic: a late failure cannot erase a reconciled order, and callers return the persisted winning result. Processor lookup and order-to-checkout mapping remain application-specific.

## Connect and operate

Follow the [official-client guide](docs/official-client.md) to configure dedicated API clients with approved sandbox JWT and required request/response MLE. It describes verified method/HTTP compatibility and a remaining upstream encryption failure issue that must be addressed before production use. Disable upstream payload logging and keep credentials and payment material in the backend.

See [durable storage](docs/postgres.md), [integration and recovery](docs/integration.md), [release verification](docs/RELEASING.md), and [contract provenance](CONTRACT.md).

```ts
await client.checkout.acp.get(sessionId);
await client.checkout.acp.update(sessionId, updatedCart);
await client.checkout.ucp.get(ucpSessionId);
await client.merchant.get(merchantId);
await client.call('getProduct', {}, { path: { product_id: productId } });
await waitForCatalog(client, jobId, { protocols: ['acp'], timeoutMs: 60_000 });
```

All operations remain available through typed `client.call`. Results distinguish `success`, `action_required`, `accepted`, and `unverified`. Credential retrieval remains `unverified` because its published response wrapper is ambiguous. An operation's success or a retrieved credential does not establish issuer approval, capture, or successful order placement.

Strict response validation is the default and retains provider extension fields. `responseValidation: 'none'` is available for investigating sandbox contract discrepancies; approved checkout still validates its required responses. An invalid response after a write can mean the write already took effect. Use authoritative reconciliation before retrying.

## Verification status

Tests include real PostgreSQL persistence/concurrency/recovery, actual official SDK classes with an offline network boundary, local workflow fixtures, and installation/type checking of the packed package. Run database tests with `TEST_DATABASE_URL` pointing at a disposable database; otherwise those tests are explicitly skipped.

No authenticated Visa sandbox request has been executed. Live JWT/MLE, approved response fixtures, participant entitlements, and merchant/PSP lifecycle integration remain release requirements before real payments. This repository's packaging and local integration checks do not establish Visa certification or production readiness. The owner must select a redistribution license before public package distribution; metadata currently says `UNLICENSED`.

## Regenerate contracts

Download the public source referenced in `CONTRACT.md`, then run:

```sh
python3 generate.py --spec /path/to/cybs_merged.json
npm run verify
```

The generator records the exact input hash and actual operation/path counts. Review changes and verify the input's origin before adopting a new contract.
