import { createHash } from 'node:crypto';
import type { PurchaseRecord, PurchaseStore, PurchaseState, ConfirmationState } from './types.js';

export class PurchasePersistenceError extends Error {
    constructor(message = 'Purchase persistence rejected an invalid record or transition') {
        super(message);
        this.name = 'PurchasePersistenceError';
    }
}

function reject(path: string): never {
    throw new PurchasePersistenceError(`Invalid purchase storage field: ${path}`);
}
function object(value: unknown, path: string, keys: string[], required: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) reject(path);
    const record = value as Record<string, unknown>;
    if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !keys.includes(key))) reject(path);
    for (const key of Object.keys(record)) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor)) reject(path);
    }
    for (const key of required) if (!Object.hasOwn(record, key) || record[key] === undefined) reject(`${path}.${key}`);
    return record;
}
function text(value: unknown, path: string, maxLength = 4096): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) reject(path);
}
function integer(value: unknown, path: string, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) reject(path);
}
function timestamp(value: unknown, path: string): void {
    text(value, path, 64);
    if (!Number.isFinite(Date.parse(value))) reject(path);
}
function currency(value: unknown, path: string): void {
    if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) reject(path);
}
function items(value: unknown, path: string, quote: boolean): Map<string, number> {
    if (!Array.isArray(value) || value.length === 0) reject(path);
    const ids = new Map<string, number>();
    for (let i = 0; i < value.length; i++) {
        const field = `${path}[${i}]`;
        const item = object(value[i], field, quote ? ['id', 'quantity', 'title', 'totalMinor'] : ['id', 'quantity'],
            quote ? ['id', 'quantity', 'totalMinor'] : ['id', 'quantity']);
        text(item.id, `${field}.id`);
        integer(item.quantity, `${field}.quantity`, 1);
        if (ids.has(item.id)) reject(`${field}.id`);
        ids.set(item.id, item.quantity);
        if (quote) {
            integer(item.totalMinor, `${field}.totalMinor`);
            if (item.title !== undefined) text(item.title, `${field}.title`);
        }
    }
    return ids;
}
const purchaseStates: PurchaseState[] = ['prepared', 'approving', 'authentication_required', 'authorizing', 'submitting', 'unknown', 'completed', 'declined', 'failed'];
const confirmationStates: ConfirmationState[] = ['not_required', 'pending', 'sending', 'confirmed', 'unknown'];

/** Reject unknown fields rather than accidentally persisting authentication or provider payloads. */
export function validatePurchaseRecord(value: unknown): asserts value is PurchaseRecord {
    const fields = ['scope', 'id', 'customerId', 'merchantId', 'requestHash', 'items', 'policy', 'quote',
        'state', 'version', 'paymentProviderId', 'authorization', 'order', 'action', 'reasonCode', 'confirmation'];
    const r = object(value, '$', fields, fields.filter(key => !['authorization', 'order', 'action', 'reasonCode'].includes(key)));
    for (const name of ['scope', 'id', 'customerId', 'merchantId', 'paymentProviderId']) text(r[name], `$.${name}`);
    if (typeof r.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.requestHash)) reject('$.requestHash');
    integer(r.version, '$.version');
    if (!purchaseStates.includes(r.state as PurchaseState)) reject('$.state');
    if (!confirmationStates.includes(r.confirmation as ConfirmationState)) reject('$.confirmation');
    if (r.reasonCode !== undefined && (typeof r.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(r.reasonCode))) reject('$.reasonCode');
    const requested = items(r.items, '$.items', false);
    const p = object(r.policy, '$.policy', ['allowedMerchantIds', 'currency', 'maxTotalMinor', 'maxQuantity', 'expiresAt'],
        ['allowedMerchantIds', 'currency', 'maxTotalMinor', 'maxQuantity', 'expiresAt']);
    if (!Array.isArray(p.allowedMerchantIds) || p.allowedMerchantIds.length === 0) reject('$.policy.allowedMerchantIds');
    for (const merchant of p.allowedMerchantIds) text(merchant, '$.policy.allowedMerchantIds');
    if (!p.allowedMerchantIds.includes(r.merchantId)) reject('$.merchantId');
    currency(p.currency, '$.policy.currency');
    integer(p.maxTotalMinor, '$.policy.maxTotalMinor');
    integer(p.maxQuantity, '$.policy.maxQuantity', 1);
    timestamp(p.expiresAt, '$.policy.expiresAt');
    const q = object(r.quote, '$.quote', ['id', 'merchantId', 'merchantName', 'merchantUrl', 'currency', 'totalMinor', 'items', 'expiresAt', 'revision'],
        ['id', 'merchantId', 'currency', 'totalMinor', 'items', 'expiresAt', 'revision']);
    for (const name of ['id', 'merchantId', 'revision']) text(q[name], `$.quote.${name}`);
    if (q.merchantName !== undefined) text(q.merchantName, '$.quote.merchantName');
    if (q.merchantUrl !== undefined) text(q.merchantUrl, '$.quote.merchantUrl');
    currency(q.currency, '$.quote.currency');
    integer(q.totalMinor, '$.quote.totalMinor');
    timestamp(q.expiresAt, '$.quote.expiresAt');
    if (q.merchantId !== r.merchantId || q.currency !== p.currency || q.totalMinor > p.maxTotalMinor) reject('$.quote');
    const quoted = items(q.items, '$.quote.items', true);
    let quantity = 0;
    for (const [id, count] of requested) {
        if (quoted.get(id) !== count) reject('$.quote.items');
        quantity += count;
    }
    if (quoted.size !== requested.size || !Number.isSafeInteger(quantity) || quantity > p.maxQuantity) reject('$.items');
    if (r.authorization !== undefined) {
        const a = object(r.authorization, '$.authorization', ['providerId', 'id'], ['providerId', 'id']);
        text(a.id, '$.authorization.id');
        text(a.providerId, '$.authorization.providerId');
        if (a.providerId !== r.paymentProviderId || !['submitting', 'unknown', 'completed'].includes(r.state as string)) reject('$.authorization');
    }
    if (r.state === 'submitting' || r.state === 'completed') {
        if (r.authorization === undefined) reject('$.authorization');
    }
    if (r.state === 'authentication_required') {
        const action = object(r.action, '$.action', ['type', 'id'], ['type', 'id']);
        text(action.type, '$.action.type', 128);
        text(action.id, '$.action.id');
    } else if (r.action !== undefined) reject('$.action');
    if (r.state === 'completed') {
        const order = object(r.order, '$.order', ['id', 'quoteId', 'merchantId', 'currency', 'totalMinor', 'status', 'paymentStatus'],
            ['id', 'quoteId', 'merchantId', 'currency', 'totalMinor', 'status', 'paymentStatus']);
        text(order.id, '$.order.id');
        if (order.status !== 'completed' || !['unknown', 'authorized', 'captured'].includes(order.paymentStatus as string)
            || order.quoteId !== q.id || order.merchantId !== q.merchantId || order.currency !== q.currency || order.totalMinor !== q.totalMinor) reject('$.order');
    } else {
        if (r.order !== undefined) reject('$.order');
        if (!['not_required', 'pending'].includes(r.confirmation as string)) reject('$.confirmation');
    }
}

/** Canonical JSON of validated records/fields, independent of object-key insertion order. */
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function purchaseBindingHash(record: PurchaseRecord): string {
    validatePurchaseRecord(record);
    const { scope, id, customerId, merchantId, requestHash, items, policy, quote, paymentProviderId } = record;
    return createHash('sha256').update(canonical({ scope, id, customerId, merchantId, requestHash, items, policy, quote, paymentProviderId })).digest('hex');
}
const transitions: Record<PurchaseState, PurchaseState[]> = {
    prepared: ['approving'], approving: ['authorizing', 'authentication_required', 'declined', 'failed'],
    authentication_required: ['approving'], authorizing: ['submitting', 'unknown', 'failed'],
    submitting: ['completed', 'unknown'], unknown: ['completed'], completed: ['completed'], declined: [], failed: [],
};
const confirmationTransitions: Record<ConfirmationState, ConfirmationState[]> = {
    not_required: ['not_required'], pending: ['pending', 'sending'], sending: ['confirmed', 'unknown', 'pending'], confirmed: ['confirmed'], unknown: ['unknown'],
};

export function validateNewPurchase(record: PurchaseRecord): void {
    validatePurchaseRecord(record);
    if (record.state !== 'prepared' || record.version !== 0 || record.authorization !== undefined
        || record.order !== undefined || record.action !== undefined || record.reasonCode !== undefined)
        throw new PurchasePersistenceError('New purchases must begin prepared at version zero');
}
/** Expected-version disagreement is handled by stores as false, not as a transition. */
export function validatePurchaseTransition(current: PurchaseRecord, next: PurchaseRecord, expectedVersion: number): void {
    validatePurchaseRecord(current);
    validatePurchaseRecord(next);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || next.version !== expectedVersion + 1 || current.version !== expectedVersion)
        throw new PurchasePersistenceError('Purchase versions must advance exactly once');
    if (purchaseBindingHash(current) !== purchaseBindingHash(next))
        throw new PurchasePersistenceError('Purchase binding is immutable');
    if (!transitions[current.state].includes(next.state)) throw new PurchasePersistenceError('Purchase state transition is not allowed');
    if (current.authorization && canonical(current.authorization) !== canonical(next.authorization))
        throw new PurchasePersistenceError('Purchase authorization reference is immutable');
    if (current.order) {
        const { paymentStatus: previousStatus, ...previousOrder } = current.order;
        const { paymentStatus: nextStatus, ...nextOrder } = next.order!;
        const rank = { unknown: 0, authorized: 1, captured: 2 };
        if (canonical(previousOrder) !== canonical(nextOrder) || rank[nextStatus] < rank[previousStatus])
            throw new PurchasePersistenceError('Completed order identity is immutable and payment status cannot regress');
    }
    if (current.state !== 'completed' && next.confirmation !== current.confirmation)
        throw new PurchasePersistenceError('Confirmation state changes require an already completed order');
    if (current.state === 'completed' && !confirmationTransitions[current.confirmation].includes(next.confirmation))
        throw new PurchasePersistenceError('Confirmation transition is not allowed');
}

/** Process-local demo/test implementation. All production workers must share a durable store. */
export class InMemoryPurchaseStore implements PurchaseStore {
    private readonly records = new Map<string, PurchaseRecord>();
    private readonly quotes = new Set<string>();
    private key(scope: string, id: string) { return JSON.stringify([scope, id]); }
    async get(scope: string, id: string): Promise<PurchaseRecord | undefined> {
        const record = this.records.get(this.key(scope, id));
        return record ? structuredClone(record) : undefined;
    }
    async create(record: PurchaseRecord): Promise<boolean> {
        validateNewPurchase(record);
        const copy = structuredClone(record);
        const key = this.key(copy.scope, copy.id);
        const quoteKey = JSON.stringify([copy.scope, copy.merchantId, copy.quote.id]);
        if (this.records.has(key) || this.quotes.has(quoteKey)) return false;
        this.records.set(key, copy);
        this.quotes.add(quoteKey);
        return true;
    }
    async compareAndSet(record: PurchaseRecord, expectedVersion: number): Promise<boolean> {
        validatePurchaseRecord(record);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1)
            throw new PurchasePersistenceError('Purchase versions must advance exactly once');
        const key = this.key(record.scope, record.id);
        const current = this.records.get(key);
        if (!current || current.version !== expectedVersion) return false;
        validatePurchaseTransition(current, record, expectedVersion);
        this.records.set(key, structuredClone(record));
        return true;
    }
}
