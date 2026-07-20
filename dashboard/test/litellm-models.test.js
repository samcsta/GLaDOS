const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchLiteLlmModels,
  gatewayBaseUrl,
  selectableModelIds,
} = require('../lib/litellm-models');

test('normalizes the LiteLLM base URL for live model discovery', () => {
  assert.equal(gatewayBaseUrl({ ANTHROPIC_BASE_URL: 'https://gateway.example.test/v1/' }), 'https://gateway.example.test');
  assert.equal(gatewayBaseUrl({ LLMAPI_BASE_URL: 'https://legacy.example.test/' }), 'https://legacy.example.test');
});

test('keeps live chat aliases while removing duplicates and embedding-only models', () => {
  assert.deepEqual(selectableModelIds({ data: [
    { id: 'minimax-m3' },
    { id: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-flash' },
    { id: 'text-embedding-005' },
    { id: 'custom-llmapi-redteamstuff-com/claude-sonnet-5' },
    { id: 'provider/model-that-is-not-a-bare-alias' },
    { id: 'another-model', mode: 'embedding' },
  ] }), ['claude-sonnet-5', 'deepseek-v4-flash', 'minimax-m3']);
});

test('fetches the live catalog with server-side authorization and no credential disclosure', async () => {
  const fixtureCredential = ['model', 'catalog', 'fixture'].join('-');
  let observed = null;
  const result = await fetchLiteLlmModels({
    token: fixtureCredential,
    env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' },
    fetchImpl: async (url, options) => {
      observed = { url, authorization: options.headers.Authorization };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'minimax-m3' }, { id: 'deepseek-v4-flash' }] }),
      };
    },
  });
  assert.equal(observed.url, 'https://gateway.example.test/v1/models');
  assert.equal(observed.authorization, ['Bearer', fixtureCredential].join(' '));
  assert.deepEqual(result.models, ['deepseek-v4-flash', 'minimax-m3']);
  assert.equal(JSON.stringify(result).includes(fixtureCredential), false);
});

test('returns an empty sanitized catalog when LiteLLM rejects discovery', async () => {
  const result = await fetchLiteLlmModels({
    token: ['model', 'catalog', 'fixture'].join('-'),
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ detail: 'sensitive gateway detail' }),
    }),
  });
  assert.equal(result.available, false);
  assert.deepEqual(result.models, []);
  assert.equal(result.status, 403);
  assert.equal(JSON.stringify(result).includes('sensitive gateway detail'), false);
});
