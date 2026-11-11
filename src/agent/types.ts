/** Quantities and all money values are positive/nonnegative safe integers in minor units. */
export interface PurchaseItem { id: string; quantity: number }
export interface QuoteItem extends PurchaseItem { title?: string; totalMinor: number }
/** Normalized, credential-free quote. revision binds fulfillment/tax/address details at the connector. */
export interface PurchaseQuote {
    id: string;
    merchantId: string;
    merchantName?: string;
    merchantUrl?: string;
    currency: string;
    totalMinor: number;
    items: QuoteItem[];
    expiresAt: string;
    revision: string;
}
/** Trusted server configuration; per-purchase limits, not an aggregate spending ledger. */
export interface PurchasePolicy {
    allowedMerchantIds: string[];
    currency: string;
    maxTotalMinor: number;
    maxQuantity: number;
    expiresAt: string;
}
export interface PurchaseContext {
    scope: string;
    purchaseId: string;
    customerId: string;
    signal?: AbortSignal;
}
export interface QuoteRequest extends PurchaseContext {
    items: PurchaseItem[];
    idempotencyKey: string;
}
export interface CheckoutContext extends PurchaseContext {
    quote: PurchaseQuote;
    idempotencyKey: string;
}
/** Only these non-secret provider references may be persisted. */
export interface AuthorizationReference { providerId: string; id: string }
/** Ephemeral backend-only value. Never store, log, or return credential to an agent model. */
export interface PaymentAuthorization {
    reference: AuthorizationReference;
    credential: unknown;
}
export interface AuthenticationAction { type: string; id: string }
export type AuthenticationResult =
    | { kind: 'authenticated'; evidence: unknown }
    | { kind: 'action_required'; action: AuthenticationAction }
    | { kind: 'declined' };
export interface ApprovalRequest extends PurchaseContext { quote: PurchaseQuote; policy: PurchasePolicy }
/** Application integrates its approved identity/passkey service; the SDK does not invent assurance. */
export type ConsumerAuthenticator = (request: ApprovalRequest) => Promise<AuthenticationResult>;
export interface AuthorizationRequest extends ApprovalRequest {
    authentication: unknown;
    idempotencyKey: string;
}
export interface MerchantOrder {
    id: string;
    quoteId: string;
    merchantId: string;
    currency: string;
    totalMinor: number;
    status: 'completed';
    /** Order completion alone does not establish issuer approval or capture. */
    paymentStatus: 'unknown' | 'authorized' | 'captured';
}
export interface ConfirmationRequest extends CheckoutContext {
    authorization: AuthorizationReference;
    order: MerchantOrder;
}
export interface PaymentAuthorizationProvider {
    readonly id: string;
    authorize(request: AuthorizationRequest): Promise<PaymentAuthorization>;
    /** Optional post-purchase confirmation. Throw PaymentConfirmationDeferredError ONLY before dispatch. */
    confirm?(request: ConfirmationRequest): Promise<void>;
}
export interface MerchantCheckoutConnector {
    readonly id: string;
    /** Obtain/create a quote using this stable key. This never submits a payment. */
    quote(request: QuoteRequest): Promise<PurchaseQuote>;
    refresh(request: CheckoutContext): Promise<PurchaseQuote>;
    complete(request: CheckoutContext & { authorization: PaymentAuthorization }): Promise<MerchantOrder>;
    /** Authoritative, read-only merchant/PSP lookup scoped by account, quote and stable key. */
    lookup(request: CheckoutContext): Promise<MerchantOrder | undefined>;
}
export type PurchaseState = 'prepared' | 'approving' | 'authentication_required' | 'authorizing'
    | 'submitting' | 'unknown' | 'completed' | 'declined' | 'failed';
export type ConfirmationState = 'not_required' | 'pending' | 'sending' | 'confirmed' | 'unknown';
/** Durable data only: no authentication evidence, tokens, raw provider payloads or credentials. */
export interface PurchaseRecord {
    scope: string;
    id: string;
    customerId: string;
    merchantId: string;
    requestHash: string;
    items: PurchaseItem[];
    policy: PurchasePolicy;
    quote: PurchaseQuote;
    state: PurchaseState;
    version: number;
    paymentProviderId: string;
    authorization?: AuthorizationReference;
    order?: MerchantOrder;
    action?: AuthenticationAction;
    reasonCode?: string;
    confirmation: ConfirmationState;
}
export interface PurchaseStore {
    get(scope: string, id: string): Promise<PurchaseRecord | undefined>;
    /** Atomically reserve purchase AND (scope, merchant, quote) identifiers; false on either conflict. */
    create(record: PurchaseRecord): Promise<boolean>;
    /** CAS immutable binding, monotonically completed order and version; false on version conflict. */
    compareAndSet(record: PurchaseRecord, expectedVersion: number): Promise<boolean>;
}
/** Safe public result. Credential material and authentication evidence are never included. */
export interface PurchaseView {
    purchaseId: string;
    status: PurchaseState;
    quote: PurchaseQuote;
    order?: MerchantOrder;
    action?: AuthenticationAction;
    reasonCode?: string;
    confirmation: ConfirmationState;
}
export interface PreparePurchase extends PurchaseContext {
    merchantId: string;
    items: PurchaseItem[];
    policy: PurchasePolicy;
}
export interface ExecutePurchase extends PurchaseContext {
    approve: (request: ApprovalRequest) => Promise<boolean>;
    authenticate: ConsumerAuthenticator;
    signal?: AbortSignal;
}
export interface AgentOptions {
    merchants: MerchantCheckoutConnector[];
    payments: PaymentAuthorizationProvider;
    store: PurchaseStore;
    now?: () => number;
}
export class PurchasePolicyError extends Error {
    constructor(public code: string) { super(`Purchase policy rejected: ${code}`); this.name = 'PurchasePolicyError'; }
}
export class PurchaseConflictError extends Error {
    constructor() { super('Purchase identifier or quote is already bound to a different request'); this.name = 'PurchaseConflictError'; }
}
export class PurchaseNotFoundError extends Error {
    constructor() { super('Purchase not found'); this.name = 'PurchaseNotFoundError'; }
}
/** Provider proves no confirmation was sent because authoritative payment status is not available yet. */
export class PaymentConfirmationDeferredError extends Error {
    constructor() { super('Payment confirmation awaits authoritative payment status'); this.name = 'PaymentConfirmationDeferredError'; }
}
