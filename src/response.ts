import contracts from './generated/contracts.json' with { type: 'json' };
import { ResponseValidationError, type Operation } from './types.js';
import { validateSchema, type Schema } from './validation.js';

/** Validate the documented response for this exact HTTP status; retain unknown fields. */
export function validateResponse(operation: Operation, status: number, body: unknown): void {
    const schemas = contracts[operation].responses as Record<string, Schema>;
    const schema = schemas[String(status)];
    if (!schema) {
        throw new ResponseValidationError(operation, status, ['Undocumented successful HTTP status']);
    }
    // Published credential variants remain ambiguous. Do not assert a verified shape.
    if (operation === 'retrievePaymentCredentials') return;
    const issues = validateSchema(schema, body);
    if (issues.length) throw new ResponseValidationError(operation, status, issues);
}
