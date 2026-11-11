/** Handwritten Direct VIC v2 boundary types. Confirm participant-specific fields in the sandbox. */
export type VicOperation = 'credentialsForInstruction' | 'retrieveCredentials' | 'confirmInstruction' | 'cancelInstruction';
export interface VicAgentSignature {
    signature: string;
    signatureInput: {
        alg: 'Ed25519' | 'RS256' | 'ES256';
        tag: 'credential-request' | 'confirmation-request';
        keyId: string; nonce: string; created: number; expires: number;
    };
}
export interface VicClientIdentity {
    agent: { agentId: string; agentSignature?: VicAgentSignature };
    externalClientId: string;
    externalAppId: string;
    authorization?: string;
    relationshipId?: string;
}
export interface VicAppInstance {
    ipAddress: string; userAgent: string; clientDeviceId: string; applicationName: string;
    countryCode: string;
    deviceData: { type: string; brand: string; model?: string; manufacturer?: string };
}
export interface VicAssuranceData {
    verificationEntity: '10' | '20' | '30' | '40';
    verificationMethod: '02' | '04' | '21' | '22' | '23';
    verificationResults: '01' | '02' | '03' | '04' | '21';
    verificationTimestamp: string;
    verificationType?: 'CARDHOLDER' | 'DEVICE';
    methodResults?: Record<string, unknown>;
    [extension: string]: unknown;
}
export interface VicMandate {
    mandateId: string;
    declineThreshold: { amount: string; currencyCode: string };
    effectiveUntilTime: string;
    quantity?: string;
    preferredMerchantName?: string;
    recurringFrequency?: 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    [extension: string]: unknown;
}
export interface VicTransactionAmount {
    /** Decimal major units. Never infer the currency exponent from a minor-unit integer. */
    transactionAmount: string;
    transactionCurrencyCode: string;
    subTotal?: string; tax?: string; discount?: string; shippingAndHandling?: string;
}
export interface VicTransactionData {
    merchantName: string; merchantUrl: string; merchantId?: string;
    transactionAmount: VicTransactionAmount;
    transactionReferenceId: string;
    /** JWE generated using the applicable onboarding contract; the SDK never fabricates it. */
    encryptedInstruction?: string;
    mandateReferenceData?: unknown[];
    [extension: string]: unknown;
}
export interface VicCredentialsRequest {
    client: VicClientIdentity;
    tokenId: string;
    consumer: { consumerId: string; countryCode: string; languageCode: string; consumerIdentities: unknown[]; [extension: string]: unknown };
    mandates: VicMandate[];
    appInstance: VicAppInstance;
    purchaseType: 'PURCHASE_HITL' | 'PURCHASE_AUTONOMOUS' | 'PURCHASE_RECURRING';
    assuranceData: VicAssuranceData[];
    transactionData: VicTransactionData;
    clientReferenceId: string;
}
export interface VicRetrieveRequest {
    client: VicClientIdentity; tokenId: string; appInstance?: VicAppInstance;
    transactionData: VicTransactionData & { encryptedInstruction: string; mandateReferenceData: unknown[] };
    clientReferenceId: string;
}
export interface VicConfirmationEntry {
    transactionAmount: VicTransactionAmount;
    transactionStatus: 'APPROVED' | 'DECLINED' | 'CANCELLED';
    mandateReferenceData: unknown[];
    transactionTimestamp: string;
    transactionReferenceId: string;
    encryptedPurchaseData?: string;
    merchantData?: { merchantId?: string; merchantName?: string; merchantUrl?: string };
    [extension: string]: unknown;
}
export interface VicConfirmationRequest {
    client: VicClientIdentity; confirmationData: VicConfirmationEntry[];
    clientReferenceId: string; instructionCompleted?: boolean;
}
export interface VicCancelRequest {
    client: VicClientIdentity; appInstance: VicAppInstance;
    /** Current schema requires this, while prose questions it. Use approved fixtures. */
    assuranceData: VicAssuranceData[];
    clientReferenceId: string;
}
export interface VicCredentialEnvelope {
    instructionId: string; clientReferenceId: string;
    payload: {
        network: 'visa' | 'mastercard' | 'amex' | 'discover';
        signedPayload?: string; encryptedSignedPayload?: string;
        [extension: string]: unknown;
    };
    [extension: string]: unknown;
}
export interface VicConfirmationResponse { status: 'ACTIVE' | 'COMPLETED'; clientReferenceId: string; [extension: string]: unknown }
export interface VicCancelResponse { instructionId: string; clientReferenceId: string; [extension: string]: unknown }
export interface VicHttpRequest { operation: VicOperation; method: 'POST' | 'PUT'; path: string; body: unknown; signal?: AbortSignal }
export interface VicHttpResponse { status: number; body: unknown }
export interface VicTransport { send(request: VicHttpRequest): Promise<VicHttpResponse> }
export class VicValidationError extends Error {
    constructor(public readonly issues: string[]) { super('Invalid Direct VIC request'); this.name = 'VicValidationError'; }
}
export class VicApiError extends Error {
    constructor(public readonly operation: VicOperation, public readonly status: number, public readonly reason?: string) {
        super(`Direct VIC request failed (${status})`); this.name = 'VicApiError';
    }
}
export class VicUnknownOutcomeError extends Error {
    constructor(public readonly operation: VicOperation) { super(`Direct VIC outcome unknown for ${operation}; reconcile before retrying`); this.name = 'VicUnknownOutcomeError'; }
}
export class VicResponseError extends Error {
    constructor(public readonly operation: VicOperation, public readonly status: number) { super(`Invalid Direct VIC response for ${operation} (${status}); operation may have taken effect`); this.name = 'VicResponseError'; }
}
