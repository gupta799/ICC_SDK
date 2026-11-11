import { createHash } from 'node:crypto';
import { PurchasePolicyError, type PurchaseItem, type PurchaseQuote, type PurchasePolicy,
    type PurchaseRecord, type MerchantOrder, type PurchaseView, type PurchaseContext } from './types.js';

const fail = (code: string): never => { throw new PurchasePolicyError(code); };
export function text(value: unknown, code: string, limit = 256): string {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value)) return fail(code);
    return value;
}
function integer(value: unknown, code: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) return fail(code);
    return value as number;
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_OBJECT');
    return value as Record<string, unknown>;
}
function timestamp(value: unknown, code: string): string {
    const string = text(value, code, 64);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(string) || !Number.isFinite(Date.parse(string))) return fail(code);
    return string;
}
export function normalizeItems(value: unknown): PurchaseItem[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) return fail('INVALID_ITEMS');
    const ids = new Set<string>();
    return value.map(item => {
        const input = object(item);
        const id = text(input.id, 'INVALID_ITEM_ID');
        if (ids.has(id)) return fail('DUPLICATE_ITEM');
        ids.add(id);
        return { id, quantity: integer(input.quantity, 'INVALID_QUANTITY', 1) };
    }).sort((a, b) => a.id.localeCompare(b.id));
}
export function normalizePolicy(value: unknown): PurchasePolicy {
    const input = object(value);
    if (!Array.isArray(input.allowedMerchantIds) || !input.allowedMerchantIds.length || input.allowedMerchantIds.length > 100)
        return fail('INVALID_MERCHANT_ALLOWLIST');
    const currency = text(input.currency, 'INVALID_CURRENCY', 3);
    if (!/^[A-Z]{3}$/.test(currency)) return fail('INVALID_CURRENCY');
    return {
        allowedMerchantIds: [...new Set(input.allowedMerchantIds.map(id => text(id, 'INVALID_MERCHANT_ID')))].sort(),
        currency, maxTotalMinor: integer(input.maxTotalMinor, 'INVALID_BUDGET'),
        maxQuantity: integer(input.maxQuantity, 'INVALID_MAX_QUANTITY', 1),
        expiresAt: timestamp(input.expiresAt, 'INVALID_POLICY_EXPIRY'),
    };
}
/** Strict projection deliberately removes provider extension fields from persisted/public DTOs. */
export function normalizeQuote(value: unknown): PurchaseQuote {
    const input = object(value);
    const items = normalizeItems(input.items);
    const source = input.items as Record<string, unknown>[];
    const currency = text(input.currency, 'INVALID_CURRENCY', 3);
    if (!/^[A-Z]{3}$/.test(currency)) return fail('INVALID_CURRENCY');
    return {
        id: text(input.id, 'INVALID_QUOTE_ID'), merchantId: text(input.merchantId, 'INVALID_MERCHANT_ID'),
        ...(input.merchantName === undefined ? {} : { merchantName: text(input.merchantName, 'INVALID_MERCHANT_NAME', 512) }),
        ...(input.merchantUrl === undefined ? {} : { merchantUrl: text(input.merchantUrl, 'INVALID_MERCHANT_URL', 2048) }),
        currency, totalMinor: integer(input.totalMinor, 'INVALID_QUOTE_TOTAL'),
        items: items.map(item => {
            const original = source.find(candidate => candidate.id === item.id)!;
            return { ...item, totalMinor: integer(original.totalMinor, 'INVALID_ITEM_TOTAL'),
                ...(original.title === undefined ? {} : { title: text(original.title, 'INVALID_ITEM_TITLE', 512) }) };
        }),
        expiresAt: timestamp(input.expiresAt, 'INVALID_QUOTE_EXPIRY'), revision: text(input.revision, 'INVALID_QUOTE_REVISION', 512),
    };
}
export function stableHash(value: unknown): string {
    function canonical(item: unknown): string {
        if (item === undefined) return 'null';
        if (item === null || typeof item !== 'object') return JSON.stringify(item);
        if (Array.isArray(item)) return '[' + item.map(canonical).join(',') + ']';
        const record = item as Record<string, unknown>;
        return '{' + Object.keys(record).filter(key => record[key] !== undefined).sort()
            .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
    }
    return createHash('sha256').update(canonical(value)).digest('hex');
}
export function purchaseOperationKey(scope: string, purchaseId: string, operation: 'quote' | 'authorize' | 'checkout' | 'confirm'): string {
    return stableHash(['icc-sdk:agent:v1', scope, purchaseId, operation]);
}
export function validateContext(context: PurchaseContext): void {
    text(context.scope, 'INVALID_SCOPE'); text(context.purchaseId, 'INVALID_PURCHASE_ID'); text(context.customerId, 'INVALID_CUSTOMER_ID');
}
export function enforcePolicy(quote: PurchaseQuote, policy: PurchasePolicy, items: PurchaseItem[], merchantId: string, now: number): void {
    if (!Number.isFinite(now)) return fail('INVALID_CLOCK');
    if (quote.merchantId !== merchantId || !policy.allowedMerchantIds.includes(merchantId)) return fail('MERCHANT_NOT_ALLOWED');
    if (quote.currency !== policy.currency) return fail('CURRENCY_NOT_ALLOWED');
    if (quote.totalMinor > policy.maxTotalMinor) return fail('BUDGET_EXCEEDED');
    if (Date.parse(policy.expiresAt) <= now) return fail('POLICY_EXPIRED');
    if (Date.parse(quote.expiresAt) <= now) return fail('QUOTE_EXPIRED');
    const quantity = quote.items.reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isSafeInteger(quantity) || quantity > policy.maxQuantity) return fail('QUANTITY_EXCEEDED');
    if (stableHash(quote.items.map(({ id, quantity }) => ({ id, quantity }))) !== stableHash(items)) return fail('ITEMS_CHANGED');
}
export function normalizeOrder(value: unknown, quote: PurchaseQuote): MerchantOrder {
    const input = object(value);
    if (input.status !== 'completed' || !['unknown', 'authorized', 'captured'].includes(input.paymentStatus as string)) return fail('INVALID_ORDER_STATUS');
    const order: MerchantOrder = {
        id: text(input.id, 'INVALID_ORDER_ID'), quoteId: text(input.quoteId, 'INVALID_QUOTE_ID'),
        merchantId: text(input.merchantId, 'INVALID_MERCHANT_ID'), currency: text(input.currency, 'INVALID_CURRENCY', 3),
        totalMinor: integer(input.totalMinor, 'INVALID_ORDER_TOTAL'), status: 'completed',
        paymentStatus: input.paymentStatus as MerchantOrder['paymentStatus'],
    };
    if (order.quoteId !== quote.id || order.merchantId !== quote.merchantId || order.currency !== quote.currency || order.totalMinor !== quote.totalMinor)
        return fail('ORDER_DOES_NOT_MATCH_QUOTE');
    return order;
}
export function purchaseView(record: PurchaseRecord): PurchaseView {
    return structuredClone({ purchaseId: record.id, status: record.state, quote: record.quote,
        ...(record.order ? { order: record.order } : {}), ...(record.action ? { action: record.action } : {}),
        ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}), confirmation: record.confirmation });
}
