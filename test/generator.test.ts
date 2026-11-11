import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function generate(spec: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'icc-generator-'));
  try {
    copyFileSync(fileURLToPath(new URL('../generate.py', import.meta.url)), join(directory, 'generate.py'));
    const raw = JSON.stringify(spec, null, 2);
    writeFileSync(join(directory, 'input.json'), raw);
    execFileSync('python3', [join(directory, 'generate.py'), '--spec', join(directory, 'input.json')]);
    return {
      checksum: createHash('sha256').update(raw).digest('hex'),
      contract: readFileSync(join(directory, 'CONTRACT.md'), 'utf8'),
      operations: readFileSync(join(directory, 'src/generated/operations.ts'), 'utf8'),
      schemas: JSON.parse(readFileSync(join(directory, 'src/generated/contracts.json'), 'utf8')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('generator computes provenance and counts from the supplied input', () => {
  const result = generate({ paths: {
    '/icc/v1/example': {
      get: { operationId: 'getExample', responses: { 200: { schema: { type: 'object' } } } },
      post: { operationId: 'createExample', responses: { 201: { schema: { type: 'object' } } } },
    },
    '/acp/v1/old': { get: { operationId: 'oldExample', responses: { 200: {} } } },
  } });
  assert.ok(result.contract.includes(`Input SHA256: ${result.checksum}`));
  assert.ok(result.contract.includes('2 operations across 1 paths'));
  assert.deepEqual(Object.keys(result.schemas), ['getExample', 'createExample']);
  assert.ok(!result.contract.includes('52c1405a8294fe70'));
});

test('generator emits typed dictionaries and union response types', () => {
  const result = generate({ paths: {
    '/icc/v1/example': { get: { operationId: 'getExample', responses: {
      200: { schema: { type: 'object', additionalProperties: {
        oneOf: [{ type: 'string' }, { type: 'integer' }],
      } } },
    } } },
  } });
  assert.ok(result.operations.includes('Record<string, (string | number)>'));
  assert.deepEqual(result.schemas.getExample.responses['200'].additionalProperties,
    { oneOf: [{ type: 'string' }, { type: 'integer' }] });
});
