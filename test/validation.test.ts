import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, ValidationError } from '../dist/index.js';
import { validateSchema } from '../dist/validation.js';

test('schema-valued dictionary constraints validate dynamic product variant keys', () => {
  const schema = { type: 'object', additionalProperties: { type: 'string' } };
  assert.deepEqual(validateSchema(schema, { size: 'large' }), []);
  assert.deepEqual(validateSchema(schema, { size: 42 }), ['$.size: expected string']);
});

test('request validation rejects product variant values that violate the contract', () => {
  assert.throws(() => validateRequest('submitProductFeedJson', {
    products: [{ id: 'sku', variant_dict: { size: 42 } }],
  }), (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.ok(error.issues.includes('$.products[0].variant_dict.size: expected string'));
    return true;
  });
});

test('inherited properties do not satisfy required JSON fields', () => {
  const schema = { type: 'object', required: ['requiredField'], properties: { requiredField: { type: 'string' } } };
  assert.deepEqual(validateSchema(schema, Object.create({ requiredField: 'inherited' })), ['$.requiredField: required']);
});

test('an unconstrained metadata dictionary preserves extension fields', () => {
  assert.deepEqual(validateSchema({ type: 'object', additionalProperties: {} }, { extension: { enabled: true } }), []);
});
