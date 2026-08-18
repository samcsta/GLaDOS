const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { secretCandidates, piiCandidates } = require('../lib/security-review/sensitive-data');

test('sensitive-data scanner distinguishes literals, references, and redacts values', () => {
  const key = crypto.randomBytes(32);
  const literal = `canary-${crypto.randomBytes(12).toString('hex')}`;
  const rows = secretCandidates('config.yml', [
    `password: "${literal}"`,
    'api_key: ${API_KEY}',
  ], key);
  assert.equal(rows[0].presence_status, 'CONFIRMED_LITERAL');
  assert.equal(rows[1].presence_status, 'REFERENCE_ONLY');
  assert.equal(JSON.stringify(rows).includes(literal), false);
  assert.equal(rows.every(row => row.value_redacted), true);
});

test('PII scanner keeps examples pattern-only and never retains values', () => {
  const key = crypto.randomBytes(32);
  const rows = piiCandidates('fixture.txt', ['user@example.com', '313-555-1212'], key);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].presence_status, 'PATTERN_ONLY');
  assert.equal(JSON.stringify(rows).includes('user@example.com'), false);
  assert.equal(rows.every(row => row.validation_status === 'UNVERIFIED'), true);
});
