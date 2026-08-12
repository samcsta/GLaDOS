const { loadLlmAuthToken } = require('./secrets/llm-secrets');
const { bareModelAlias, isBareModelAlias } = require('../../scripts/lib/model-aliases');

const DEFAULT_BASE_URL = 'https://llmapi.redteamstuff.com';
const DEFAULT_TIMEOUT_MS = 5000;

function gatewayBaseUrl(env = process.env, fallback = DEFAULT_BASE_URL) {
  return String(env.ANTHROPIC_BASE_URL || env.LLMAPI_BASE_URL || fallback || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

function unavailable(reason, message, extra = {}) {
  return {
    available: false,
    source: 'LiteLLM',
    models: [],
    reason,
    message,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

function isEmbeddingModel(row, id) {
  const modes = [row?.mode, row?.model_info?.mode, row?.litellm_params?.mode]
    .map(value => String(value || '').toLowerCase());
  return modes.includes('embedding') || /(^|[-_.])embeddings?($|[-_.])/i.test(id);
}

function selectableModelIds(payload) {
  const models = new Set();
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const id = bareModelAlias(row?.id, { fallback: null });
    if (!id || !isBareModelAlias(id) || isEmbeddingModel(row, id)) continue;
    models.add(id);
  }
  return [...models].sort();
}

async function fetchLiteLlmModels(options = {}) {
  const env = options.env || process.env;
  const token = options.token || (options.tokenLoader || loadLlmAuthToken)(env);
  if (!token) return unavailable('missing-secret', 'No LiteLLM key is available for model discovery.');

  const baseUrl = gatewayBaseUrl(env, options.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || global.fetch)(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = JSON.parse(await response.text()); } catch {}
    if (!response.ok) {
      const message = response.status === 401
        ? 'The stored LiteLLM key was not recognized (HTTP 401). Re-enter the current key.'
        : response.status === 403
          ? 'The LiteLLM key reached the gateway but is not authorized to list models (HTTP 403). Check management-route, team, and model permissions.'
          : `LiteLLM model discovery failed with HTTP ${response.status}.`;
      return unavailable('gateway-error', message, { status: response.status });
    }
    return {
      available: true,
      source: 'LiteLLM',
      models: selectableModelIds(payload),
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return unavailable(timedOut ? 'timeout' : 'unreachable', timedOut
      ? 'LiteLLM model discovery timed out.'
      : 'LiteLLM model discovery is currently unreachable.');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchLiteLlmModels,
  gatewayBaseUrl,
  selectableModelIds,
};
