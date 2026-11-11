import { PaymentConfirmationDeferredError, type AuthorizationRequest, type ConfirmationRequest, type PaymentAuthorization, type PaymentAuthorizationProvider, type PurchaseQuote } from '../types.js';
import { VicClient } from '../../vic/client.js';
import { VicValidationError, type VicConfirmationRequest, type VicCredentialEnvelope, type VicCredentialsRequest } from '../../vic/types.js';

export interface VicMerchantIdentity { merchantId: string; merchantName: string; merchantUrl: string }
export interface VerifiedVicCredential {
    /** Merchant/PSP-compatible credential obtained AFTER decryption and signature verification. */
    credential: unknown;
    transactionReferenceId: string;
    expiresAt: string;
}
export interface VicPaymentProviderOptions {
    client: VicClient;
    id?: string;
    /** Explicit exponents avoid silently treating JPY, KWD, etc. as two-decimal currencies. */
    currencyExponents: Readonly<Record<string, number>>;
    /** Trusted application mapping from connector merchant ID to the onboarded Visa identity. */
    merchantIdentity(quote: PurchaseQuote): VicMerchantIdentity;
    consumerId?(customerId: string): string;
    /** Supply current provider authentication evidence, token reference, mandate and fresh signature. */
    buildCredentialsRequest(request: AuthorizationRequest): Promise<VicCredentialsRequest>;
    /** Must decrypt JWE if present and verify the JWS with approved Visa keys and claim checks.
     * Parsing JWT payloads without verification does NOT satisfy this contract. */
    verifyAndDecode(envelope: VicCredentialEnvelope, request: AuthorizationRequest): Promise<VerifiedVicCredential>;
    /** Supply current confirmation signature and merchant/PSP outcome data. */
    buildConfirmationRequest(request: ConfirmationRequest, reference: VicAuthorizationIdentifiers): Promise<VicConfirmationRequest>;
    now?: () => number;
}
export interface VicAuthorizationIdentifiers {
    instructionId: string;
    transactionReferenceId: string;
    mandateId: string;
}
export class VicProviderBindingError extends Error {
    constructor() { super('Direct VIC request or verified credential does not match the approved purchase'); this.name = 'VicProviderBindingError'; }
}
export class VicCredentialVerificationError extends Error {
    constructor() { super('Direct VIC credential verification failed'); this.name = 'VicCredentialVerificationError'; }
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function minorUnits(decimal: string, exponent: number): bigint {
    if (typeof decimal !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(decimal)) throw new VicProviderBindingError();
    const [whole, suppliedFraction = ''] = decimal.split('.');
    const fraction = suppliedFraction.replace(/0+$/, '');
    if (fraction.length > exponent) throw new VicProviderBindingError();
    return BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
}
function referenceId(reference: VicAuthorizationIdentifiers): string {
    return `vic-v1.${Buffer.from(JSON.stringify(reference)).toString('base64url')}`;
}
function parseReference(value: string): VicAuthorizationIdentifiers {
    let data: unknown;
    try {
        if (!value.startsWith('vic-v1.') || value.length > 10_000) throw new Error();
        data = JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8'));
    } catch { throw new VicProviderBindingError(); }
    if (!isRecord(data) || !nonempty(data.instructionId) || !nonempty(data.transactionReferenceId) || !nonempty(data.mandateId))
        throw new VicProviderBindingError();
    return { instructionId: data.instructionId, transactionReferenceId: data.transactionReferenceId, mandateId: data.mandateId };
}

/** Consumer authentication and JWE/JWS implementations are supplied through explicit trust boundaries.
 * Credentials remain ephemeral. Only a versioned reference of three non-secret identifiers is returned for persistence. */
export class VicPaymentProvider implements PaymentAuthorizationProvider {
    readonly id: string;
    private readonly exponents: Readonly<Record<string, number>>;
    private readonly now: () => number;
    private readonly options: VicPaymentProviderOptions;
    constructor(options: VicPaymentProviderOptions) {
        this.options = { ...options };
        this.id = options.id ?? 'visa-vic';
        if (!nonempty(this.id)) throw new VicValidationError(['id: required']);
        for (const [currency, exponent] of Object.entries(options.currencyExponents)) {
            if (!/^[A-Z]{3}$/.test(currency) || !Number.isInteger(exponent) || exponent < 0 || exponent > 8)
                throw new VicValidationError(['currencyExponents: invalid currency or exponent']);
        }
        for (const name of ['merchantIdentity', 'buildCredentialsRequest', 'verifyAndDecode', 'buildConfirmationRequest'] as const)
            if (typeof options[name] !== 'function') throw new VicValidationError([`${name}: required provider integration`]);
        this.exponents = Object.freeze({ ...options.currencyExponents });
        this.now = options.now ?? Date.now;
    }
    async authorize(request: AuthorizationRequest): Promise<PaymentAuthorization> {
        request.signal?.throwIfAborted();
        const binding = { quote: structuredClone(request.quote), policy: structuredClone(request.policy), customerId: request.customerId, key: request.idempotencyKey };
        const exponent = this.exponents[binding.quote.currency];
        if (exponent === undefined) throw new VicProviderBindingError();
        const merchant = this.options.merchantIdentity(structuredClone(binding.quote));
        const body = await this.options.buildCredentialsRequest(request);
        const transaction = body.transactionData;
        const consumerId = this.options.consumerId?.(binding.customerId) ?? binding.customerId;
        if (body.clientReferenceId !== binding.key || transaction?.transactionReferenceId !== binding.key
            || body.consumer?.consumerId !== consumerId || transaction.merchantId !== merchant.merchantId
            || transaction.merchantName !== merchant.merchantName || transaction.merchantUrl !== merchant.merchantUrl
            || transaction.transactionAmount?.transactionCurrencyCode !== binding.quote.currency
            || minorUnits(transaction.transactionAmount.transactionAmount, exponent) !== BigInt(binding.quote.totalMinor)
            || body.purchaseType !== 'PURCHASE_HITL' || body.mandates?.length !== 1
            || body.mandates[0].declineThreshold.currencyCode !== binding.policy.currency
            || minorUnits(body.mandates[0].declineThreshold.amount, exponent) !== BigInt(binding.policy.maxTotalMinor)
            || Number(body.mandates[0].effectiveUntilTime) * 1000 > Date.parse(binding.policy.expiresAt)
            || Number(body.mandates[0].effectiveUntilTime) * 1000 <= this.now()
            || !body.assuranceData?.some(assurance => assurance.verificationResults === '01')) throw new VicProviderBindingError();
        if (![binding.quote.expiresAt, binding.policy.expiresAt].every(expiry => Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > this.now()))
            throw new VicProviderBindingError();
        request.signal?.throwIfAborted();
        const mandateId = body.mandates[0].mandateId;
        const envelope = await this.options.client.credentialsForInstruction(body, { signal: request.signal });
        const instructionId = envelope.instructionId;
        let decoded: VerifiedVicCredential;
        try { decoded = await this.options.verifyAndDecode(envelope, request); }
        catch { throw new VicCredentialVerificationError(); }
        if (!decoded || decoded.credential === undefined || decoded.credential === null
            || decoded.transactionReferenceId !== binding.key || !Number.isFinite(Date.parse(decoded.expiresAt))
            || Date.parse(decoded.expiresAt) <= this.now()
            || ![binding.quote.expiresAt, binding.policy.expiresAt].every(expiry => Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > this.now())) throw new VicCredentialVerificationError();
        return {
            reference: { providerId: this.id, id: referenceId({ instructionId, transactionReferenceId: binding.key, mandateId }) },
            credential: decoded.credential,
        };
    }
    async confirm(request: ConfirmationRequest): Promise<void> {
        if (request.authorization.providerId !== this.id) throw new VicProviderBindingError();
        const reference = parseReference(request.authorization.id);
        // An order ID alone does not establish issuer authorization or payment capture.
        if (request.order.paymentStatus === 'unknown') throw new PaymentConfirmationDeferredError();
        if (!['authorized', 'captured'].includes(request.order.paymentStatus)) throw new VicProviderBindingError();
        const binding = { quote: structuredClone(request.quote), key: request.idempotencyKey };
        const body = await this.options.buildConfirmationRequest(request, Object.freeze(reference));
        const exponent = this.exponents[binding.quote.currency];
        if (exponent === undefined || body.clientReferenceId !== binding.key || body.confirmationData?.length !== 1)
            throw new VicProviderBindingError();
        const entry = body.confirmationData[0];
        const mandate = entry.mandateReferenceData?.[0];
        if (entry.transactionReferenceId !== reference.transactionReferenceId || entry.transactionStatus !== 'APPROVED'
            || entry.transactionAmount?.transactionCurrencyCode !== binding.quote.currency
            || minorUnits(entry.transactionAmount.transactionAmount, exponent) !== BigInt(binding.quote.totalMinor)
            || entry.mandateReferenceData.length !== 1 || !isRecord(mandate) || mandate.mandateId !== reference.mandateId)
            throw new VicProviderBindingError();
        await this.options.client.confirmInstruction(reference.instructionId, body, { signal: request.signal });
    }
}
