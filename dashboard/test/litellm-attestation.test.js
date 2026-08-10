const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchLiteLlmAttestation,
  gatewayEvidence,
  spendRows,
} = require('../lib/litellm-attestation');

test('LiteLLM attestation requires deployment-level model evidence', () => {
  assert.equal(gatewayEvidence({ request_id: 'req-1', model: 'gpt-5.6-luna' }, 'req-1'), null);
  assert.deepEqual(gatewayEvidence({
    request_id: 'req-1', model: 'custom/gpt-5.6-sol', model_id: 'deployment-42', spend: 1.25,
  }, 'req-1'), {
    actualModel: 'deployment-42',
    billedModelName: 'custom/gpt-5.6-sol',
    gatewayModelId: 'deployment-42',
    costUsd: 1.25,
  });
  assert.equal(gatewayEvidence({
    request_id: 'req-other', model: 'gpt-5.6-sol', model_id: 'deployment-42',
  }, 'req-1'), null);
  assert.deepEqual(spendRows({ data: [{ request_id: 'req-1' }] }), [{ request_id: 'req-1' }]);
});

test('LiteLLM attestation queries an individual request without exposing the reporting key', async () => {
  let seen;
  const result = await fetchLiteLlmAttestation('req-1', {
    env: { ANTHROPIC_BASE_URL: 'https://gateway.test/v1' },
    token: 'reporting-secret',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        async text() {
          return JSON.stringify([{ request_id: 'req-1', model: 'gpt-5.6-terra', model_id: 'deployment-terra', spend: 0.75 }]);
        },
      };
    },
  });
  assert.match(seen.url, /^https:\/\/gateway\.test\/spend\/logs\?/);
  assert.match(seen.url, /request_id=req-1/);
  assert.doesNotMatch(seen.url, /reporting-secret/);
  assert.equal(seen.options.headers.Authorization, 'Bearer reporting-secret');
  assert.deepEqual(result, {
    available: true,
    requestId: 'req-1',
    attempts: 1,
    actualModel: 'deployment-terra',
    billedModelName: 'gpt-5.6-terra',
    gatewayModelId: 'deployment-terra',
    costUsd: 0.75,
  });
});

test('LiteLLM attestation retries until the request-level spend row is available', async () => {
  let calls = 0;
  const result = await fetchLiteLlmAttestation('req-late', {
    token: 'reporting-secret',
    attempts: 3,
    retryDelaysMs: [0, 0, 0],
    fetchImpl: async () => ({
      ok: true,
      async text() {
        calls += 1;
        return calls < 3 ? '[]' : JSON.stringify([{ request_id: 'req-late', model: 'gpt-5.6-sol', model_id: 'deployment-sol', spend: 0.5 }]);
      },
    }),
  });
  assert.equal(calls, 3);
  assert.equal(result.available, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.costUsd, 0.5);
});
