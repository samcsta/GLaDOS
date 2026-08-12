const { loadLlmAuthToken } = require('./secrets/llm-secrets');
const { fetchLiteLlmModels, gatewayBaseUrl, networkErrorCode } = require('./litellm-models');
const { bareModelAlias, DEFAULT_BARE_MODEL } = require('../../scripts/lib/model-aliases');

function messagesFailure(reason, message, extra = {}) {
  return { ok: false, reason, message, status: null, latencyMs: null, ...extra };
}

async function verifyLiteLlm(options = {}) {
  const env = options.env || process.env;
  const token = options.token || (options.tokenLoader || loadLlmAuthToken)(env);
  const model = bareModelAlias(options.model || env.GLADOS_PRIMARY_MODEL || DEFAULT_BARE_MODEL);
  const baseUrl = gatewayBaseUrl(env, options.baseUrl);
  const checkedAt = new Date().toISOString();
  if (!token) {
    const message = 'No stored LiteLLM key was found. Save the key before running verification.';
    return {
      ok: false,
      checkedAt,
      gatewayUrl: baseUrl,
      model,
      models: { ok: false, count: 0, modelAvailable: null, reason: 'missing-secret', message, status: null },
      messages: messagesFailure('missing-secret', message),
    };
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  const catalog = await fetchLiteLlmModels({
    token,
    env,
    baseUrl,
    fetchImpl,
    timeoutMs: options.modelTimeoutMs || 10_000,
  });
  const models = catalog.available
    ? {
        ok: true,
        count: catalog.models.length,
        modelAvailable: catalog.models.includes(model),
        reason: null,
        message: catalog.models.includes(model)
          ? `${catalog.models.length} models are available and ${model} is authorized.`
          : `${catalog.models.length} models are available, but ${model} is missing.`,
        status: 200,
      }
    : {
        ok: false,
        count: 0,
        modelAvailable: null,
        reason: catalog.reason || 'unavailable',
        message: catalog.message || 'LiteLLM model discovery failed.',
        status: catalog.status || null,
        networkCode: catalog.networkCode || null,
      };

  const controller = new AbortController();
  const timeoutMs = options.messageTimeoutMs || 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let messages;
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
      signal: controller.signal,
    });
    await response.text();
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      messages = { ok: true, reason: null, message: `${model} completed a live Anthropic Messages request.`, status: response.status, latencyMs };
    } else if (response.status === 401) {
      messages = messagesFailure('unauthorized', 'The stored LiteLLM key was not recognized by the Anthropic Messages route (HTTP 401).', { status: 401, latencyMs });
    } else if (response.status === 403) {
      messages = messagesFailure('forbidden', `The LiteLLM key cannot use ${model} on the Anthropic Messages route (HTTP 403).`, { status: 403, latencyMs });
    } else {
      messages = messagesFailure('gateway-error', `LiteLLM Anthropic Messages verification failed with HTTP ${response.status}.`, { status: response.status, latencyMs });
    }
  } catch (error) {
    const code = networkErrorCode(error);
    messages = error?.name === 'AbortError'
      ? messagesFailure('timeout', `LiteLLM Anthropic Messages verification timed out after ${timeoutMs}ms.`)
      : messagesFailure('unreachable', `The LiteLLM Anthropic Messages route is unreachable${code ? ` (${code})` : ''}.`, { networkCode: code });
  } finally {
    clearTimeout(timer);
  }

  return {
    ok: models.ok && models.modelAvailable === true && messages.ok,
    checkedAt,
    gatewayUrl: baseUrl,
    model,
    models,
    messages,
  };
}

module.exports = { verifyLiteLlm };
