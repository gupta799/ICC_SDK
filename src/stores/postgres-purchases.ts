import type { PurchaseRecord, PurchaseStore } from '../agent/types.js';
import { purchaseBindingHash, PurchasePersistenceError, validateNewPurchase, validatePurchaseRecord, validatePurchaseTransition } from '../agent/stores.js';
import type { PostgresQueryExecutor } from './postgres.js';

export interface PostgresPurchaseStoreOptions { tableName?: string }
function identifier(options: PostgresPurchaseStoreOptions): string {
    const name = options.tableName ?? 'icc_agent_purchases';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new TypeError('tableName must be a lowercase PostgreSQL identifier of at most 63 characters');
    return `"${name}"`;
}
/** Apply as an application-owned migration. IF NOT EXISTS never upgrades an existing table. */
export function postgresPurchaseStoreSchema(options: PostgresPurchaseStoreOptions = {}): string {
    const table = identifier(options);
    return `CREATE TABLE IF NOT EXISTS ${table} (
    scope text NOT NULL,
    purchase_id text NOT NULL,
    merchant_id text NOT NULL,
    quote_id text NOT NULL,
    binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
    version bigint NOT NULL CHECK (version >= 0),
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, purchase_id),
    UNIQUE (scope, merchant_id, quote_id),
    CHECK (data->>'scope' IS NOT DISTINCT FROM scope),
    CHECK (data->>'id' IS NOT DISTINCT FROM purchase_id),
    CHECK (data->>'merchantId' IS NOT DISTINCT FROM merchant_id),
    CHECK (data->'quote'->>'id' IS NOT DISTINCT FROM quote_id),
    CHECK ((data->>'version')::bigint IS NOT DISTINCT FROM version),
    CHECK (data->>'state' IN ('prepared', 'approving', 'authentication_required', 'authorizing', 'submitting', 'unknown', 'completed', 'declined', 'failed'))
)`;
}

/** Shared durable, credential-free purchase state with atomic optimistic concurrency. */
export class PostgresPurchaseStore implements PurchaseStore {
    private readonly table: string;
    private readonly options: PostgresPurchaseStoreOptions;
    constructor(private readonly database: PostgresQueryExecutor, options: PostgresPurchaseStoreOptions = {}) {
        this.options = { ...options };
        this.table = identifier(options);
    }
    async initialize(): Promise<void> { await this.database.query(postgresPurchaseStoreSchema(this.options)); }
    async get(scope: string, id: string): Promise<PurchaseRecord | undefined> {
        const { rows } = await this.database.query(`SELECT data, binding_hash FROM ${this.table} WHERE scope = $1 AND purchase_id = $2`, [scope, id]);
        if (!rows[0]) return undefined;
        const record = rows[0].data;
        validatePurchaseRecord(record);
        if (purchaseBindingHash(record) !== rows[0].binding_hash) throw new PurchasePersistenceError('Stored purchase binding is invalid');
        return structuredClone(record);
    }
    async create(record: PurchaseRecord): Promise<boolean> {
        validateNewPurchase(record);
        const copy = structuredClone(record);
        const serialized = JSON.stringify(copy);
        const { rows } = await this.database.query(`INSERT INTO ${this.table}
            (scope, purchase_id, merchant_id, quote_id, binding_hash, version, data)
            VALUES ($1, $2, $3, $4, $5, 0, $6::jsonb)
            ON CONFLICT DO NOTHING RETURNING purchase_id`,
            [copy.scope, copy.id, copy.merchantId, copy.quote.id, purchaseBindingHash(copy), serialized]);
        return rows.length === 1;
    }
    async compareAndSet(record: PurchaseRecord, expectedVersion: number): Promise<boolean> {
        validatePurchaseRecord(record);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1)
            throw new PurchasePersistenceError('Purchase versions must advance exactly once');
        const copy = structuredClone(record);
        const current = await this.get(copy.scope, copy.id);
        if (!current || current.version !== expectedVersion) return false;
        validatePurchaseTransition(current, copy, expectedVersion);
        const { rows } = await this.database.query(`UPDATE ${this.table}
            SET data = $1::jsonb, version = $2, updated_at = CURRENT_TIMESTAMP
            WHERE scope = $3 AND purchase_id = $4 AND version = $5 AND binding_hash = $6
            RETURNING purchase_id`,
            [JSON.stringify(copy), copy.version, copy.scope, copy.id, expectedVersion, purchaseBindingHash(copy)]);
        return rows.length === 1;
    }
}
