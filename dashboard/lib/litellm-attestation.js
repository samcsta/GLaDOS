const crypto = require('node:crypto');
const { loadLlmAuthToken } = require('./secrets/llm-secrets');
const { bareModelAlias } = require('../../scripts/lib/model-aliases');

const DEFAULT_BASE_URL = 'https://llmapi.redteamstuff.com';

function gatewayBaseUrl(env = process.env) {
  const configured = String(env.GLADOS_LITELLM_UPSTREAM_BASE_URL || env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL);
  const loopbackRelay = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(configured)
    && !env.GLADOS_LITELLM_UPSTREAM_BASE_URL;
  return String(loopbackRelay ? DEFAULT_BASE_URL : configured).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function spendRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'results', 'spend_logs', 'logs']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function gatewayEvidence(row, requestId) {
  const modelId = row?.model_id || row?.litellm_model_id || row?.x_litellm_model_id || row?.metadata?.model_id;
  const billedModel = row?.model || row?.model_name || row?.deployment_model || row?.metadata?.model;
  const providerModel = row?.provider_model || row?.provider_model_name || row?.response_model || null;
  const observedRequestId = row?.request_id || row?.litellm_call_id || row?.call_id;
  if (!modelId || !billedModel || observedRequestId !== requestId) return null;
  const billedModelName = bareModelAlias(billedModel, { fallback: String(billedModel).trim() });
  if (!billedModelName || /^<[^>]+>$/.test(billedModelName) || /^(?:unknown|synthetic|null|undefined)$/i.test(billedModelName)) return null;
  return {
    actualModel: providerModel ? String(providerModel) : String(modelId),
    billedModelName,
    providerModel: providerModel ? String(providerModel) : null,
    attestationLevel: providerModel ? 'provider' : 'deployment',
    gatewayModelId: String(modelId),
    gatewayCallId: String(observedRequestId),
    costUsd: Number.isFinite(Number(row?.spend ?? row?.cost ?? row?.response_cost))
      ? Number(row.spend ?? row.cost ?? row.response_cost)
      : null,
  };
}

async function fetchLiteLlmAttestation(requestId, options = {}) {
  const gatewayCallId = options.gatewayCallId || requestId;
  if (!gatewayCallId) return { available: false, reason: 'missing-request-id' };
  const env = options.env || process.env;
  const token = options.token || (options.tokenLoader || loadLlmAuthToken)(env);
  if (!token) return { available: false, reason: 'missing-secret' };
  const query = new URLSearchParams({ request_id: gatewayCallId, summarize: 'false' });
  const attempts = Math.max(1, Math.min(12, Number(options.attempts) || 6));
  const delays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : [0, 250, 500, 1000, 2000, 4000];
  let last = { available: false, reason: 'deployment-evidence-unavailable' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delay = Number(delays[Math.min(attempt, delays.length - 1)]) || 0;
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
    try {
      const response = await (options.fetchImpl || global.fetch)(`${gatewayBaseUrl(env)}/spend/logs?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        last = { available: false, reason: 'gateway-error', status: response.status, attempts: attempt + 1 };
        if (response.status === 401 || response.status === 403) return last;
        continue;
      }
      let payload = null;
      try { payload = JSON.parse(await response.text()); } catch {}
      const evidence = spendRows(payload).map(row => gatewayEvidence(row, gatewayCallId)).find(Boolean);
      if (evidence) return { available: true, requestId, gatewayCallId, attempts: attempt + 1, ...evidence };
      last = { available: false, reason: 'deployment-evidence-unavailable', attempts: attempt + 1 };
    } catch (error) {
      last = { available: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable', attempts: attempt + 1 };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

function observationId({ engagementId, requestId, role, workerId, gatewayModelId }) {
  const identity = [engagementId, requestId, role || '', workerId || '', gatewayModelId].join('\0');
  return `model-observation-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

module.exports = { fetchLiteLlmAttestation, gatewayEvidence, observationId, spendRows };
