const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyLiteLlm } = require('../lib/litellm-setup');

test('setup verification checks both model discovery and a live Anthropic Messages request without returning the key', async () => {
  const fixtureCredential = ['setup', 'verification', 'fixture'].join('-');
  const requests = [];
  const result = await verifyLiteLlm({
    token: fixtureCredential,
    model: 'claude-sonnet-5',
    baseUrl: 'https://gateway.example.test',
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization, body: options.body || null });
      if (url.endsWith('/v1/models')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'claude-sonnet-5' }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.models.modelAvailable, true);
  assert.equal(result.messages.ok, true);
  assert.deepEqual(requests.map(entry => entry.url), [
    'https://gateway.example.test/v1/models',
    'https://gateway.example.test/v1/messages',
  ]);
  assert.equal(requests.every(entry => entry.authorization === `Bearer ${fixtureCredential}`), true);
  assert.equal(JSON.stringify(result).includes(fixtureCredential), false);
});

test('setup verification fails safely when the configured primary model is absent', async () => {
  const result = await verifyLiteLlm({
    token: ['setup', 'verification', 'fixture'].join('-'),
    model: 'claude-sonnet-5',
    fetchImpl: async url => url.endsWith('/v1/models')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'different-model' }] }) }
      : { ok: true, status: 200, text: async () => '{}' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.models.ok, true);
  assert.equal(result.models.modelAvailable, false);
  assert.equal(result.messages.ok, true);
});

test('setup verification does not make network requests without a stored key', async () => {
  let calls = 0;
  const result = await verifyLiteLlm({
    tokenLoader: () => null,
    fetchImpl: async () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.models.reason, 'missing-secret');
  assert.equal(result.messages.reason, 'missing-secret');
  assert.equal(calls, 0);
});
