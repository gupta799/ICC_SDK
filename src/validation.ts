import contracts from './generated/contracts.json' with { type: 'json' };
import { ValidationError, type Operation } from './types.js';
type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    items?: Schema;
    enum?: unknown[];
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    pattern?: string;
    allOf?: Schema[];
};
function validate(s: Schema, value: unknown, path = '$', issues: string[] = []): string[] {
    if (s.allOf)
        for (const part of s.allOf)
            validate(part, value, path, issues);
    if (s.enum && !s.enum.includes(value))
        issues.push(`${path}: unsupported value`);
    const type = s.type;
    if (type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            issues.push(`${path}: expected object`);
            return issues;
        }
        const v = value as Record<string, unknown>;
        for (const key of s.required ?? [])
            if (v[key] === undefined)
                issues.push(`${path}.${key}: required`);
        for (const [key, sub] of Object.entries(s.properties ?? {}))
            if (v[key] !== undefined)
                validate(sub, v[key], `${path}.${key}`, issues);
    }
    else if (type === 'array') {
        if (!Array.isArray(value)) {
            issues.push(`${path}: expected array`);
            return issues;
        }
        if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? Infinity))
            issues.push(`${path}: invalid array size`);
        if (s.items)
            value.forEach((v, i) => validate(s.items!, v, `${path}[${i}]`, issues));
    }
    else if (type === 'string') {
        if (typeof value !== 'string') {
            issues.push(`${path}: expected string`);
            return issues;
        }
        if (value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? Infinity))
            issues.push(`${path}: invalid length`);
        if (s.pattern) {
            let pattern = s.pattern, flags = '';
            if (pattern.startsWith('(?s)')) {
                pattern = pattern.slice(4);
                flags = 's';
            }
            if (!new RegExp(pattern, flags).test(value))
                issues.push(`${path}: invalid format`);
        }
    }
    else if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity))
            issues.push(`${path}: invalid number`);
    }
    else if (type === 'boolean' && typeof value !== 'boolean')
        issues.push(`${path}: expected boolean`);
    return issues;
}
export function validateRequest(operation: Operation, body: unknown): void {
    const schema = contracts[operation].body;
    if (schema) {
        const errors = validate(schema as Schema, body);
        if (errors.length)
            throw new ValidationError(errors);
    }
    if (operation === 'registerMerchant') {
        const b = body as Record<string, unknown>;
        if (b.paymentPayloadType === 'ENCRYPTED' && !b.encryptionKey)
            throw new ValidationError(['$.encryptionKey: required for ENCRYPTED delivery']);
    }
}
