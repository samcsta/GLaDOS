const crypto = require('node:crypto');
const { loadLlmAuthToken } = require('./secrets/llm-secrets');
const { bareModelAlias } = require('../../scripts/lib/model-aliases');

const DEFAULT_BASE_URL = 'https://llmapi.redteamstuff.com';
const DEFAULT_DAYS = 7;
const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const METRIC_KEYS = [
  'spend', 'promptTokens', 'completionTokens', 'cacheReadTokens',
  'cacheCreationTokens', 'totalTokens', 'requests', 'successfulRequests',
  'failedRequests',
];

let cacheEntry = null;
let pendingRequest = null;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function usageWindow(now = new Date(), days = DEFAULT_DAYS) {
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dates = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - offset);
    dates.push(dateKey(date));
  }
  return { days, dates, startDate: dates[0], endDate: dates.at(-1) };
}

function metricShape(metrics = {}) {
  return {
    spend: number(metrics.spend),
    promptTokens: number(metrics.prompt_tokens),
    completionTokens: number(metrics.completion_tokens),
    cacheReadTokens: number(metrics.cache_read_input_tokens),
    cacheCreationTokens: number(metrics.cache_creation_input_tokens),
    totalTokens: number(metrics.total_tokens),
    requests: number(metrics.api_requests),
    successfulRequests: number(metrics.successful_requests),
    failedRequests: number(metrics.failed_requests),
  };
}

function addMetrics(target, source) {
  for (const key of METRIC_KEYS) target[key] += number(source[key]);
  return target;
}

function normalizedModelName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';
  return bareModelAlias(raw, { fallback: raw });
}

function aggregateDailyActivity(payload, { now = new Date(), days = DEFAULT_DAYS } = {}) {
  const period = usageWindow(now, days);
  const rowsByDate = new Map((payload?.results || []).map(row => [row.date, row]));
  const totals = metricShape();
  const models = new Map();
  const daily = period.dates.map(date => {
    const row = rowsByDate.get(date) || {};
    const metrics = metricShape(row.metrics);
    addMetrics(totals, metrics);
    for (const [rawName, modelRow] of Object.entries(row.breakdown?.models || {})) {
      const name = normalizedModelName(rawName);
      const aggregate = models.get(name) || { name, ...metricShape() };
      addMetrics(aggregate, metricShape(modelRow?.metrics || modelRow));
      models.set(name, aggregate);
    }
    return { date, ...metrics };
  });

  const modelRows = [...models.values()]
    .map(model => ({
      ...model,
      spendShare: totals.spend > 0 ? model.spend / totals.spend : 0,
      tokenShare: totals.totalTokens > 0 ? model.totalTokens / totals.totalTokens : 0,
      requestShare: totals.requests > 0 ? model.requests / totals.requests : 0,
    }))
    .sort((a, b) => b.spend - a.spend || b.totalTokens - a.totalTokens || b.requests - a.requests);

  return {
    available: true,
    source: 'LiteLLM',
    period: { days: period.days, startDate: period.startDate, endDate: period.endDate },
    totals,
    daily,
    models: modelRows,
  };
}

function gatewayBaseUrl(env = process.env) {
  return String(env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

function unavailable(reason, message, extra = {}) {
  return {
    available: false,
    source: 'LiteLLM',
    reason,
    message,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

async function fetchLiteLlmUsage(options = {}) {
  const env = options.env || process.env;
  if (env.GLADOS_LITELLM_USAGE_DISABLED === '1') {
    return unavailable('disabled', 'LiteLLM usage metrics are disabled for this runtime.');
  }
  const token = options.token || (options.tokenLoader || loadLlmAuthToken)(env);
  if (!token) return unavailable('missing-secret', 'No LiteLLM reporting key is available.');

  const now = options.now || new Date();
  const days = options.days || DEFAULT_DAYS;
  const period = usageWindow(now, days);
  const query = new URLSearchParams({ start_date: period.startDate, end_date: period.endDate });
  const url = `${gatewayBaseUrl(env)}/user/daily/activity?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || global.fetch)(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = JSON.parse(await response.text()); } catch {}
    if (!response.ok) {
      const message = response.status === 403
        ? 'The LiteLLM key cannot read /user/daily/activity.'
        : response.status === 401
          ? 'The LiteLLM reporting key was rejected.'
          : `LiteLLM usage request failed with HTTP ${response.status}.`;
      return unavailable('gateway-error', message, { status: response.status });
    }
    const result = aggregateDailyActivity(payload, { now, days });
    result.fetchedAt = new Date().toISOString();
    return result;
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return unavailable(timedOut ? 'timeout' : 'unreachable', timedOut
      ? 'LiteLLM usage request timed out.'
      : 'LiteLLM usage is currently unreachable.');
  } finally {
    clearTimeout(timer);
  }
}

async function getLiteLlmUsage(options = {}) {
  const env = options.env || process.env;
  if (env.GLADOS_LITELLM_USAGE_DISABLED === '1') return fetchLiteLlmUsage(options);
  const nowMs = (options.now || new Date()).getTime();
  const token = options.token || (options.tokenLoader || loadLlmAuthToken)(env);
  const period = usageWindow(options.now || new Date(), options.days || DEFAULT_DAYS);
  const keyHash = token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) : 'missing';
  const cacheKey = `${gatewayBaseUrl(env)}:${period.startDate}:${period.endDate}:${keyHash}`;
  if (!options.force && cacheEntry?.key === cacheKey && cacheEntry.expiresAt > nowMs) return cacheEntry.value;
  if (!options.force && pendingRequest?.key === cacheKey) return pendingRequest.promise;

  const promise = fetchLiteLlmUsage({ ...options, token })
    .then(value => {
      const ttl = value.available
        ? number(env.GLADOS_LITELLM_USAGE_CACHE_MS) || DEFAULT_CACHE_MS
        : 30_000;
      cacheEntry = { key: cacheKey, value, expiresAt: Date.now() + ttl };
      return value;
    })
    .finally(() => {
      if (pendingRequest?.promise === promise) pendingRequest = null;
    });
  pendingRequest = { key: cacheKey, promise };
  return promise;
}

function clearLiteLlmUsageCache() {
  cacheEntry = null;
  pendingRequest = null;
}

module.exports = {
  aggregateDailyActivity,
  clearLiteLlmUsageCache,
  fetchLiteLlmUsage,
  getLiteLlmUsage,
  usageWindow,
};
