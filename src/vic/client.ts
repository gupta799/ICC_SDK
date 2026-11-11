import {
    VicApiError, VicResponseError, VicUnknownOutcomeError, VicValidationError,
    type VicCancelRequest, type VicCancelResponse, type VicConfirmationRequest, type VicConfirmationResponse,
    type VicCredentialEnvelope, type VicCredentialsRequest, type VicRetrieveRequest,
    type VicHttpRequest, type VicOperation, type VicTransport,
} from './types.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fail = (issue: string): never => { throw new VicValidationError([issue]); };
function required(value: unknown, path: string): asserts value is Record<string, unknown> {
    if (!record(value)) fail(`${path}: expected object`);
}
function fields(value: Record<string, unknown>, names: string[], path: string) {
    for (const name of names) if (!text(value[name])) fail(`${path}.${name}: required nonempty string`);
}
function list(value: unknown, path: string, maximum = Infinity): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail(`${path}: invalid array size`);
}
function identity(value: unknown): void {
    required(value, '$.client'); fields(value, ['externalAppId', 'externalClientId'], '$.client');
    required(value.agent, '$.client.agent'); fields(value.agent, ['agentId'], '$.client.agent');
    if (value.agent.agentSignature !== undefined) {
        const signature = value.agent.agentSignature;
        required(signature, '$.client.agent.agentSignature'); fields(signature, ['signature'], '$.client.agent.agentSignature');
        const input = signature.signatureInput; required(input, '$.client.agent.agentSignature.signatureInput');
        fields(input, ['keyId', 'nonce'], '$.client.agent.agentSignature.signatureInput');
        if (!['Ed25519', 'RS256', 'ES256'].includes(input.alg as string)
            || !['credential-request', 'confirmation-request'].includes(input.tag as string)
            || !Number.isSafeInteger(input.created) || !Number.isSafeInteger(input.expires)
            || (input.expires as number) <= (input.created as number)) fail('$.client.agent.agentSignature: invalid signature metadata');
    }
    // Participant-dependent signature requirements are enforced by the onboarded service.
}
function app(value: unknown): void {
    required(value, '$.appInstance'); fields(value, ['ipAddress', 'userAgent', 'clientDeviceId', 'applicationName', 'countryCode'], '$.appInstance');
    required(value.deviceData, '$.appInstance.deviceData'); fields(value.deviceData, ['type', 'brand'], '$.appInstance.deviceData');
}
function assurance(value: unknown): void {
    list(value, '$.assuranceData');
    for (const entry of value) {
        required(entry, '$.assuranceData[]'); fields(entry, ['verificationTimestamp'], '$.assuranceData[]');
        if (!['10', '20', '30', '40'].includes(entry.verificationEntity as string)
            || !['02', '04', '21', '22', '23'].includes(entry.verificationMethod as string)
            || !['01', '02', '03', '04', '21'].includes(entry.verificationResults as string)
            || !/^\d+$/.test(entry.verificationTimestamp as string)) fail('$.assuranceData[]: invalid verification record');
    }
}
function amount(value: unknown, path: string): void {
    required(value, path); fields(value, ['transactionAmount', 'transactionCurrencyCode'], path);
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value.transactionAmount as string)
        || !/^[A-Z]{3}$/.test(value.transactionCurrencyCode as string)) fail(`${path}: invalid decimal amount or currency`);
}
function transaction(value: unknown, retrieve: boolean): void {
    required(value, '$.transactionData'); fields(value, ['merchantName', 'merchantUrl', 'transactionReferenceId'], '$.transactionData');
    amount(value.transactionAmount, '$.transactionData.transactionAmount');
    if (retrieve) {
        fields(value, ['encryptedInstruction'], '$.transactionData');
        list(value.mandateReferenceData, '$.transactionData.mandateReferenceData', 1);
    }
}
/** Reject values whose JSON representation could differ from the object that was validated. */
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
    if (depth > 40) fail('$: JSON nesting is too deep');
    if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('$: nonfinite JSON number'); return; }
    if (typeof value !== 'object' || ancestors.has(value)) fail('$: request must contain acyclic JSON values');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('$: expected plain JSON object');
    ancestors.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.get || descriptor.set) fail('$: JSON accessors are not supported');
        assertJson(descriptor.value, ancestors, depth + 1);
    }
    ancestors.delete(value);
}
function validate(operation: VicOperation, body: unknown): asserts body is Record<string, unknown> {
    assertJson(body); required(body, '$'); identity(body.client); fields(body, ['clientReferenceId'], '$');
    if (operation === 'credentialsForInstruction' || operation === 'retrieveCredentials') {
        fields(body, ['tokenId'], '$'); transaction(body.transactionData, operation === 'retrieveCredentials');
    }
    if (operation === 'credentialsForInstruction') {
        app(body.appInstance); assurance(body.assuranceData); list(body.mandates, '$.mandates', 10);
        required(body.consumer, '$.consumer'); fields(body.consumer, ['consumerId', 'countryCode', 'languageCode'], '$.consumer');
        list(body.consumer.consumerIdentities, '$.consumer.consumerIdentities');
        if (!['PURCHASE_HITL', 'PURCHASE_AUTONOMOUS', 'PURCHASE_RECURRING'].includes(body.purchaseType as string)) fail('$.purchaseType: unsupported value');
        for (const mandate of body.mandates) {
            required(mandate, '$.mandates[]'); fields(mandate, ['mandateId', 'effectiveUntilTime'], '$.mandates[]');
            required(mandate.declineThreshold, '$.mandates[].declineThreshold');
            fields(mandate.declineThreshold, ['amount', 'currencyCode'], '$.mandates[].declineThreshold');
            if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(mandate.declineThreshold.amount as string)
                || !/^[A-Z]{3}$/.test(mandate.declineThreshold.currencyCode as string)
                || !/^\d+$/.test(mandate.effectiveUntilTime as string)) fail('$.mandates[]: invalid amount, currency or expiry');
            if (body.purchaseType === 'PURCHASE_RECURRING' && !['WEEKLY', 'MONTHLY', 'YEARLY'].includes(mandate.recurringFrequency as string)) fail('$.mandates[].recurringFrequency: required for recurring purchase');
        }
    }
    if (operation === 'retrieveCredentials' && body.appInstance !== undefined) app(body.appInstance);
    if (operation === 'cancelInstruction') { app(body.appInstance); assurance(body.assuranceData); }
    if (operation === 'confirmInstruction') {
        list(body.confirmationData, '$.confirmationData');
        for (const entry of body.confirmationData) {
            required(entry, '$.confirmationData[]'); fields(entry, ['transactionReferenceId', 'transactionTimestamp'], '$.confirmationData[]');
            amount(entry.transactionAmount, '$.confirmationData[].transactionAmount');
            list(entry.mandateReferenceData, '$.confirmationData[].mandateReferenceData', 1);
            if (!['APPROVED', 'DECLINED', 'CANCELLED'].includes(entry.transactionStatus as string)
                || !/^\d+$/.test(entry.transactionTimestamp as string)) fail('$.confirmationData[]: invalid status or timestamp');
        }
        if (body.instructionCompleted !== undefined && typeof body.instructionCompleted !== 'boolean') fail('$.instructionCompleted: expected boolean');
    }
}

/** Direct VIC v2 client. No retries, inferred authentication, or unverified JWT decoding. */
export class VicClient {
    constructor(private readonly transport: VicTransport) {}
    credentialsForInstruction(body: VicCredentialsRequest, options: { signal?: AbortSignal } = {}): Promise<VicCredentialEnvelope> {
        return this.call('credentialsForInstruction', '/vacp/v2/credentials-for-instruction', body, options.signal) as Promise<VicCredentialEnvelope>;
    }
    retrieveCredentials(instructionId: string, body: VicRetrieveRequest, options: { signal?: AbortSignal } = {}): Promise<VicCredentialEnvelope> {
        return this.call('retrieveCredentials', this.path(instructionId, 'credentials'), body, options.signal) as Promise<VicCredentialEnvelope>;
    }
    confirmInstruction(instructionId: string, body: VicConfirmationRequest, options: { signal?: AbortSignal } = {}): Promise<VicConfirmationResponse> {
        return this.call('confirmInstruction', this.path(instructionId, 'confirmation'), body, options.signal) as Promise<VicConfirmationResponse>;
    }
    cancelInstruction(instructionId: string, body: VicCancelRequest, options: { signal?: AbortSignal } = {}): Promise<VicCancelResponse> {
        return this.call('cancelInstruction', this.path(instructionId, 'cancel'), body, options.signal) as Promise<VicCancelResponse>;
    }
    private path(id: string, action: string): string {
        if (!text(id)) fail('instructionId: required');
        return `/vacp/v2/instructions/${encodeURIComponent(id)}/${action}`;
    }
    private async call(operation: VicOperation, path: string, supplied: unknown, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted(); validate(operation, supplied);
        const body = structuredClone(supplied);
        const request: VicHttpRequest = { operation, method: operation === 'cancelInstruction' ? 'PUT' : 'POST', path, body, signal };
        let response;
        try { response = await this.transport.send(request); }
        catch { throw new VicUnknownOutcomeError(operation); }
        if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) throw new VicUnknownOutcomeError(operation);
        if (response.status < 200 || response.status >= 300) {
            const reason = record(response.body) ? response.body.reason : undefined;
            throw new VicApiError(operation, response.status, typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason) ? reason : undefined);
        }
        if (response.status !== 200 || !record(response.body) || response.body.clientReferenceId !== body.clientReferenceId)
            throw new VicResponseError(operation, response.status);
        const data = response.body;
        if (operation === 'credentialsForInstruction' || operation === 'retrieveCredentials') {
            const payload = data.payload;
            if (!text(data.instructionId) || !record(payload)
                || !['visa', 'mastercard', 'amex', 'discover'].includes(payload.network as string)
                || Number(text(payload.signedPayload)) + Number(text(payload.encryptedSignedPayload)) !== 1)
                throw new VicResponseError(operation, response.status);
            if (operation === 'retrieveCredentials' && path.split('/')[4] !== encodeURIComponent(data.instructionId as string)) throw new VicResponseError(operation, response.status);
        } else if (operation === 'confirmInstruction') {
            if (!['ACTIVE', 'COMPLETED'].includes(data.status as string) || (body.instructionCompleted === true && data.status !== 'COMPLETED')) throw new VicResponseError(operation, response.status);
        } else if (!text(data.instructionId) || path.split('/')[4] !== encodeURIComponent(data.instructionId)) throw new VicResponseError(operation, response.status);
        return data;
    }
}
