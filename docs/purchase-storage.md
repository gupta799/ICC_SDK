# Agent purchase storage

`InMemoryPurchaseStore` is for local examples and tests. Production workers for a trusted merchant/customer scope must share one durable purchase store. `PostgresPurchaseStore` uses the application's PostgreSQL pool and has no runtime driver dependency. It never closes the pool.

```ts
import { Pool } from 'pg';
import { PostgresPurchaseStore, postgresPurchaseStoreSchema } from '@gupta799/icc-sdk';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Apply once through the application's reviewed migration process.
await pool.query(postgresPurchaseStoreSchema());
const store = new PostgresPurchaseStore(pool);
```

The application owns database authentication, TLS, access controls, backup, monitoring, failover, and migration permissions. `initialize()` is a convenience for local setup; `CREATE TABLE IF NOT EXISTS` does not upgrade or verify a pre-existing table. Configure a trusted search path. Custom table names must be simple lowercase PostgreSQL identifiers.

## Concurrency and immutable purchases

Creation reserves both `(scope, purchase ID)` and `(scope, merchant ID, quote ID)`. A second ID cannot submit the same merchant quote through this store. Both reservations survive restarts and have no automatic expiry. All subsequent state changes use compare-and-set on the expected version. Exactly one worker may advance the same version; a stale writer receives `false` and must re-read rather than repeat the side effect.

The customer, merchant, item selection, policy, full normalized quote, request hash and payment-provider identity are immutable. Authorization references cannot be replaced. Once an order is completed, its identity and financial fields cannot change or regress. Authoritative reconciliation may only enrich payment status from unknown to authorized/captured, or from authorized to captured. Confirmation has separate state: an already completed order can reserve a pending confirmation, then record confirmed or unknown. An explicit `PaymentConfirmationDeferredError` may return sending to pending only when the provider proves no HTTP request was dispatched, for example while issuer outcome remains unknown. An unknown confirmation cannot be automatically sent again.

An unresolved payment operation is never unlocked by deleting or expiring its row. Reconciliation is read-only against authoritative merchant/PSP records and can advance an unknown purchase to its matching completed order, provided the authorization reference was already persisted. If a provider request failed before its reference could be established, do not invent a reference or automatically repeat the request.

These are per-purchase controls. They do not implement a shared aggregate spending budget across purchases. Scope and customer identity must come from trusted backend configuration/session state rather than model-supplied arguments. An independently writable regional database, changed scope, missing shared store, or purchase submitted outside this SDK can bypass these reservations.

## Data boundaries

The store accepts only the documented normalized DTO fields. It rejects extra credential, authentication-evidence, or raw provider-response fields, including nested extras. It stores a normalized quote, per-purchase policy, non-secret provider references, state metadata, and a normalized order. It does not persist the credential returned by the payment provider or the authentication evidence supplied by the consumer-authentication integration.

Normalized fields can still contain business-sensitive identifiers and item descriptions. Apply the application's retention and access policy. Never put a token into a reference field or log SQL parameters. Storage validation cannot infer whether an arbitrary string was incorrectly populated with a secret. Preserve the purchase/quote reservations for as long as the original purchase can be retried; removing a row removes its duplicate-submission protection.

## Verification

The optional integration tests use a disposable PostgreSQL database and create/drop randomly named tables:

```sh
TEST_DATABASE_URL=postgresql://... npm test
```

Database tests are explicitly skipped without that variable. The integration suite covers parallel creation, concurrent execution claims, immutable bindings, tenant isolation, restart recovery, first-order preservation, and separate confirmation state. These database checks do not establish Visa connectivity or payment certification.
