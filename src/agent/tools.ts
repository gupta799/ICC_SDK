import {
    PurchaseConflictError, PurchaseNotFoundError, PurchasePolicyError,
    type ConsumerAuthenticator, type ExecutePurchase, type PreparePurchase,
    type PurchaseContext, type PurchasePolicy, type PurchaseView,
} from './types.js';

/** Structural interface also usable by applications wrapping PurchasingAgent. */
export interface PurchasingAgentToolTarget {
    prepare(input: PreparePurchase): Promise<PurchaseView>;
    execute(input: ExecutePurchase): Promise<PurchaseView>;
    get(context: PurchaseContext): Promise<PurchaseView | undefined>;
    reconcile(context: PurchaseContext): Promise<PurchaseView>;
}
export interface PurchasingToolsOptions {
    agent: PurchasingAgentToolTarget;
    /** All three values come from the authenticated backend, never the model. */
    scope: string;
    customerId: string;
    policy: PurchasePolicy;
    approve: ExecutePurchase['approve'];
    authenticate: ConsumerAuthenticator;
}
/** Only price/order data is model-visible; challenge IDs and provider references stay in the backend. */
export type PurchasingToolView = Pick<PurchaseView, 'purchaseId' | 'status' | 'quote' | 'order' | 'confirmation'>;
export type PurchasingToolResult =
    | { ok: true; purchase: PurchasingToolView }
    | { ok: false; error: { code: 'INVALID_ARGUMENTS' | 'POLICY_REJECTED' | 'PURCHASE_CONFLICT' | 'PURCHASE_NOT_FOUND' | 'PURCHASE_FAILED' } };
export interface PurchasingTool {
    name: 'prepare_purchase' | 'execute_purchase' | 'get_purchase' | 'reconcile_purchase';
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
    execute(arguments_: unknown, options?: { signal?: AbortSignal }): Promise<PurchasingToolResult>;
}

class InvalidToolArguments extends Error {}
const states = new Set(['prepared', 'approving', 'authentication_required', 'authorizing', 'submitting', 'unknown', 'completed', 'declined', 'failed']);
const confirmations = new Set(['not_required', 'pending', 'sending', 'confirmed', 'unknown']);
const identifierSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const purchaseIdSchema = {
    type: 'object', additionalProperties: false, required: ['purchaseId'],
    properties: { purchaseId: identifierSchema },
};
const prepareSchema = {
    type: 'object', additionalProperties: false, required: ['purchaseId', 'merchantId', 'items'],
    properties: {
        purchaseId: identifierSchema,
        merchantId: identifierSchema,
        items: {
            type: 'array', minItems: 1, maxItems: 100,
            items: {
                type: 'object', additionalProperties: false, required: ['id', 'quantity'],
                properties: { id: identifierSchema, quantity: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
            },
        },
    },
};

function object(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.getOwnPropertySymbols(value).length)
        throw new InvalidToolArguments();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some(key => !allowed.includes(key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)
        || required.some(key => !Object.hasOwn(descriptors, key)))
        throw new InvalidToolArguments();
    return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 200): string {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new InvalidToolArguments();
    return value;
}
function amount(value: unknown, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new InvalidToolArguments();
    return value;
}
function purchaseId(value: unknown): string { return text(object(value, ['purchaseId']).purchaseId); }
function projectView(value: PurchaseView): PurchasingToolView {
    // Reconstruct nested DTOs: unknown extension fields must not reach the model.
    if (!states.has(value.status) || !confirmations.has(value.confirmation)) throw new Error('Invalid purchase view');
    const quote = value.quote;
    if (!Array.isArray(quote.items) || quote.items.length > 100) throw new Error('Invalid quote');
    const output: PurchasingToolView = {
        purchaseId: text(value.purchaseId, 256), status: value.status, confirmation: value.confirmation,
        quote: {
            id: text(quote.id, 256), merchantId: text(quote.merchantId, 256), currency: text(quote.currency, 3),
            totalMinor: amount(quote.totalMinor), expiresAt: text(quote.expiresAt), revision: text(quote.revision, 512),
            items: quote.items.map(item => ({ id: text(item.id, 256), quantity: amount(item.quantity, 1), totalMinor: amount(item.totalMinor),
                ...(item.title === undefined ? {} : { title: text(item.title, 1000) }) })),
        },
    };
    if (value.order) {
        const order = value.order;
        if (order.status !== 'completed' || !['unknown', 'authorized', 'captured'].includes(order.paymentStatus)) throw new Error('Invalid order');
        output.order = { id: text(order.id, 256), quoteId: text(order.quoteId, 256), merchantId: text(order.merchantId, 256),
            currency: text(order.currency, 3), totalMinor: amount(order.totalMinor), status: 'completed', paymentStatus: order.paymentStatus };
    }
    return output;
}
function failure(error: unknown): PurchasingToolResult {
    // Never serialize arbitrary exceptions, provider messages, stacks, bodies or causes.
    try {
        const code = error instanceof InvalidToolArguments ? 'INVALID_ARGUMENTS'
        : error instanceof PurchasePolicyError ? 'POLICY_REJECTED'
        : error instanceof PurchaseConflictError ? 'PURCHASE_CONFLICT'
        : error instanceof PurchaseNotFoundError ? 'PURCHASE_NOT_FOUND'
        : 'PURCHASE_FAILED';
        return { ok: false, error: { code } };
    } catch { return { ok: false, error: { code: 'PURCHASE_FAILED' } }; }
}

/**
 * Framework-neutral descriptors for tool/function-calling hosts. This does not start an MCP server.
 * The host may let a model request execution; approval and authentication are always backend callbacks.
 */
export function createPurchasingTools(options: PurchasingToolsOptions): readonly PurchasingTool[] {
    const scope = text(options.scope, 1000);
    const customerId = text(options.customerId, 1000);
    const policy = structuredClone(options.policy);
    const { agent, approve, authenticate } = options;
    if (typeof approve !== 'function' || typeof authenticate !== 'function')
        throw new TypeError('Trusted approval and authentication callbacks are required');
    const guarded = (run: (arguments_: unknown, signal?: AbortSignal) => Promise<PurchaseView | undefined>) =>
        async (arguments_: unknown, execution?: { signal?: AbortSignal }): Promise<PurchasingToolResult> => {
            try {
                execution?.signal?.throwIfAborted();
                const view = await run(arguments_, execution?.signal);
                if (!view) throw new PurchaseNotFoundError();
                return { ok: true, purchase: projectView(view) };
            } catch (error) { return failure(error); }
        };
    return [
        {
            name: 'prepare_purchase',
            description: 'Prepare a merchant quote under the customer policy. Does not submit payment or approve the purchase.',
            inputSchema: structuredClone(prepareSchema),
            execute: guarded(async (arguments_, signal) => {
                const input = object(arguments_, ['purchaseId', 'merchantId', 'items']);
                if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new InvalidToolArguments();
                const items = input.items.map(item => {
                    const entry = object(item, ['id', 'quantity']);
                    return { id: text(entry.id), quantity: amount(entry.quantity, 1) };
                });
                return agent.prepare({ scope, customerId, purchaseId: text(input.purchaseId), merchantId: text(input.merchantId),
                    items, policy: structuredClone(policy), signal });
            }),
        },
        {
            name: 'execute_purchase',
            description: 'Request execution of a prepared purchase. The application must obtain customer approval and approved payment authentication.',
            inputSchema: structuredClone(purchaseIdSchema),
            execute: guarded((arguments_, signal) => agent.execute({ scope, customerId, purchaseId: purchaseId(arguments_), approve, authenticate, signal })),
        },
        {
            name: 'get_purchase',
            description: 'Read this customer purchase status and normalized quote/order data. Does not execute payment.',
            inputSchema: structuredClone(purchaseIdSchema),
            execute: guarded((arguments_, signal) => agent.get({ scope, customerId, purchaseId: purchaseId(arguments_), signal })),
        },
        {
            name: 'reconcile_purchase',
            description: 'Look up an uncertain purchase through authoritative merchant records. Does not resubmit a payment.',
            inputSchema: structuredClone(purchaseIdSchema),
            execute: guarded((arguments_, signal) => agent.reconcile({ scope, customerId, purchaseId: purchaseId(arguments_), signal })),
        },
    ];
}
