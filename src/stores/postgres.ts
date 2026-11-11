import type { AttemptStore, CheckoutAttempt } from '../workflows/checkout.js';

/** Compatible with a node-postgres Pool or PoolClient. The application owns its lifecycle. */
export interface PostgresQueryExecutor {
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresAttemptStoreOptions {
    /** An unqualified, lowercase PostgreSQL identifier. Defaults to icc_checkout_attempts. */
    tableName?: string;
}

export class AttemptPersistenceConflictError extends Error {
    constructor() {
        super('The attempt was not claimed or its immutable checkout binding differs');
        this.name = 'AttemptPersistenceConflictError';
    }
}

function tableIdentifier(options: PostgresAttemptStoreOptions): string {
    const table = options.tableName ?? 'icc_checkout_attempts';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table))
        throw new TypeError('tableName must be a lowercase PostgreSQL identifier of at most 63 characters');
    return `"${table}"`;
}

/** Run as an application-owned migration, rather than on every request. */
export function postgresAttemptStoreSchema(options: PostgresAttemptStoreOptions = {}): string {
    const table = tableIdentifier(options);
    return `CREATE TABLE IF NOT EXISTS ${table} (
    scope text NOT NULL CHECK (length(scope) > 0),
    attempt_id text NOT NULL CHECK (length(attempt_id) > 0),
    session_id text NOT NULL CHECK (length(session_id) > 0),
    cart_hash text NOT NULL CHECK (cart_hash ~ '^[a-f0-9]{64}$'),
    payment_hash text NOT NULL CHECK (payment_hash ~ '^[a-f0-9]{64}$'),
    state text NOT NULL CHECK (state IN ('submitting', 'unknown', 'completed')),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, attempt_id),
    UNIQUE (scope, session_id),
    CHECK ((state <> 'completed' AND result IS NULL) OR
        (state = 'completed' AND result IS NOT NULL AND
         result->>'id' IS NOT DISTINCT FROM session_id AND
         result->>'status' IS NOT DISTINCT FROM 'completed'))
)`;
}

function validateAttempt(attempt: CheckoutAttempt): void {
    for (const field of ['scope', 'id', 'sessionId'] as const) {
        if (typeof attempt[field] !== 'string' || !attempt[field].trim())
            throw new TypeError(`attempt.${field} is required`);
    }
    for (const field of ['cartHash', 'paymentHash'] as const) {
        if (!/^[a-f0-9]{64}$/.test(attempt[field]))
            throw new TypeError(`attempt.${field} must be a SHA-256 hex digest`);
    }
    if (!['submitting', 'unknown', 'completed'].includes(attempt.state))
        throw new TypeError('Invalid checkout attempt state');
    if (attempt.state === 'completed') {
        if (!attempt.result || attempt.result.id !== attempt.sessionId || attempt.result.status !== 'completed')
            throw new TypeError('A completed attempt requires its matching completed checkout result');
    } else if (attempt.result !== undefined) {
        throw new TypeError('An unresolved attempt cannot contain a completion result');
    }
}

/**
 * A durable completion fence shared by all workers for the same merchant scope.
 * Claims reserve both (scope, attempt ID) and (scope, session ID). There is no
 * expiry or automatic release: a timeout never proves a payment was not made.
 * Save never creates an attempt, changes its binding, or regresses completion.
 */
export class PostgresAttemptStore implements AttemptStore {
    private readonly database: PostgresQueryExecutor;
    private readonly table: string;
    private readonly options: PostgresAttemptStoreOptions;

    constructor(database: PostgresQueryExecutor, options: PostgresAttemptStoreOptions = {}) {
        this.database = database;
        this.options = { ...options };
        this.table = tableIdentifier(options);
    }

    /** Convenience for setup/tests. Production applications should apply a reviewed migration. */
    async initialize(): Promise<void> {
        await this.database.query(postgresAttemptStoreSchema(this.options));
    }

    async get(scope: string, id: string): Promise<CheckoutAttempt | undefined> {
        const { rows } = await this.database.query(
            `SELECT scope, attempt_id, session_id, cart_hash, payment_hash, state, result
             FROM ${this.table} WHERE scope = $1 AND attempt_id = $2`, [scope, id]);
        const row = rows[0];
        if (!row) return undefined;
        const attempt: CheckoutAttempt = {
            scope: row.scope as string,
            id: row.attempt_id as string,
            sessionId: row.session_id as string,
            cartHash: row.cart_hash as string,
            paymentHash: row.payment_hash as string,
            state: row.state as CheckoutAttempt['state'],
            ...(row.result == null ? {} : { result: row.result as CheckoutAttempt['result'] }),
        };
        validateAttempt(attempt);
        return attempt;
    }

    async claim(attempt: CheckoutAttempt): Promise<boolean> {
        validateAttempt(attempt);
        if (attempt.state !== 'submitting')
            throw new TypeError('Only a submitting attempt can be claimed');
        const { rows } = await this.database.query(
            `INSERT INTO ${this.table}
                (scope, attempt_id, session_id, cart_hash, payment_hash, state)
             VALUES ($1, $2, $3, $4, $5, 'submitting')
             ON CONFLICT DO NOTHING RETURNING attempt_id`,
            [attempt.scope, attempt.id, attempt.sessionId, attempt.cartHash, attempt.paymentHash]);
        return rows.length === 1;
    }

    async save(attempt: CheckoutAttempt): Promise<void> {
        validateAttempt(attempt);
        if (attempt.state === 'submitting')
            throw new TypeError('Use claim to persist a submitting attempt');
        // Serialize before awaiting: the caller cannot mutate the value mid-query.
        const result = attempt.result === undefined ? null : JSON.stringify(attempt.result);
        const { rows } = await this.database.query(
            `UPDATE ${this.table}
             SET state = CASE WHEN state = 'completed' THEN state ELSE $6 END,
                 result = CASE WHEN state = 'completed' THEN result ELSE $7::jsonb END,
                 updated_at = CASE WHEN state = 'completed' THEN updated_at ELSE CURRENT_TIMESTAMP END
             WHERE scope = $1 AND attempt_id = $2 AND session_id = $3
               AND cart_hash = $4 AND payment_hash = $5
             RETURNING attempt_id`,
            [attempt.scope, attempt.id, attempt.sessionId, attempt.cartHash, attempt.paymentHash, attempt.state, result]);
        if (rows.length !== 1) throw new AttemptPersistenceConflictError();
    }
}
