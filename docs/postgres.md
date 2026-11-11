# Durable checkout attempts with PostgreSQL

All processes serving a merchant scope must use the same PostgreSQL database and table. A per-process map or independently writable regional databases cannot provide a shared completion fence. The application owns connection pooling, TLS, database credentials, backups, failover and monitoring. The SDK never closes the supplied pool and has no runtime dependency on `pg`.

```ts
import { Pool } from 'pg';
import { PostgresAttemptStore, postgresAttemptStoreSchema } from '@gupta799/icc-sdk';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Apply this once through your application's reviewed database migration system.
await pool.query(postgresAttemptStoreSchema());
const store = new PostgresAttemptStore(pool);
```

`store.initialize()` is a convenience for local setup and tests. `CREATE TABLE IF NOT EXISTS` does not upgrade or verify an existing incompatible table. Apply reviewed migrations before deploying schema changes; do not give request-serving database roles DDL permissions. A custom `tableName` must be an unqualified lowercase PostgreSQL identifier; configure the pool's trusted search path for schema selection.

The primary key reserves `(scope, attempt ID)`. A second unique constraint reserves `(scope, session ID)`, so a new attempt ID after a lost response cannot submit the same session again. `claim` performs one atomic insert and returns false for either conflict. A claim has no expiry and is never automatically released. `save` only updates existing attempts with matching session, cart hash and payment hash. A completed row cannot regress to unknown or have its first completion result replaced, including when reconciliation races a late failure handler. A new instance or restarted process reads the existing fence.

Both cart and payment payloads are reduced to hashes before storage. The completed provider response is stored as JSONB and may contain buyer addresses, unknown provider fields, or payment-sensitive material. Restrict table access, encrypt storage and backups, and apply your access and retention policy. Never log query parameters or store payment credentials alongside these rows. Do not delete unresolved rows to unlock retry; reconcile with the merchant or processor. Deleting any row removes its duplicate-prevention fence, so archival/retention must preserve reservations for as long as a checkout can be retried. An absent processor order is not proof of a failed payment while a request is still pending.

The implementation is checked against real PostgreSQL by the optional integration suite:

```sh
TEST_DATABASE_URL=postgresql://... npm test
```

Use a disposable test database whose role may create and drop tables. The suite creates a randomly named table and removes it afterward. Without `TEST_DATABASE_URL`, database tests are explicitly skipped; a normal unit-test pass is not evidence of database integration verification.
