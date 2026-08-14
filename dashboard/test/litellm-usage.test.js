const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateDailyActivity,
  fetchLiteLlmUsage,
  usageWindow,
} = require('../lib/litellm-usage');

test('aggregates a complete seven-day LiteLLM usage window and merges legacy model aliases', () => {
  const now = new Date('2026-07-14T16:00:00Z');
  const result = aggregateDailyActivity({
    results: [
      {
        date: '2026-07-14',
        metrics: { spend: 3, total_tokens: 300, prompt_tokens: 250, completion_tokens: 50, api_requests: 4, successful_requests: 3, failed_requests: 1 },
        breakdown: { models: {
          'claude-sonnet-5': { metrics: { spend: 2, total_tokens: 200, api_requests: 2, successful_requests: 2 } },
          'custom-llmapi-redteamstuff-com/claude-sonnet-5': { metrics: { spend: 1, total_tokens: 100, api_requests: 2, successful_requests: 1, failed_requests: 1 } },
        } },
      },
      {
        date: '2026-07-12',
        metrics: { spend: 1, total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, api_requests: 1, successful_requests: 1 },
        breakdown: { models: {
          'claude-opus-4-8': { metrics: { spend: 1, total_tokens: 100, api_requests: 1, successful_requests: 1 } },
        } },
      },
    ],
  }, { now });

  assert.deepEqual(usageWindow(now), {
    days: 7,
    dates: ['2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14'],
    startDate: '2026-07-08',
    endDate: '2026-07-14',
  });
  assert.equal(result.daily.length, 7);
  assert.equal(result.daily[0].spend, 0);
  assert.equal(result.totals.spend, 4);
  assert.equal(result.totals.totalTokens, 400);
  assert.equal(result.totals.requests, 5);
  assert.equal(result.models.length, 2);
  const sonnet = result.models.find(model => model.name === 'claude-sonnet-5');
  assert.equal(sonnet.spend, 3);
  assert.equal(sonnet.totalTokens, 300);
  assert.equal(sonnet.requests, 4);
  assert.equal(sonnet.spendShare, 0.75);
});

test('uses the reporting token only in the server-side Authorization header', async () => {
  const observed = [];
  const reportingCredential = ['server', 'only', 'fixture'].join('-');
  const result = await fetchLiteLlmUsage({
    token: reportingCredential,
    now: new Date('2026-07-14T16:00:00Z'),
    fetchImpl: async (url, options) => {
      observed.push({ url, authorization: options.headers.Authorization });
      const payload = url.endsWith('/key/info')
        ? { key: 'fixture-key-id', info: { key_alias: 'fixture-key', max_budget: 250, budget_duration: '24h' } }
        : { results: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    },
  });
  assert.equal(observed.some(row => /\/user\/daily\/activity\?start_date=2026-07-08&end_date=2026-07-14&api_key=fixture-key-id/.test(row.url)), true);
  assert.equal(observed.some(row => row.url.endsWith('/key/info')), true);
  assert.equal(observed.every(row => row.authorization === ['Bearer', reportingCredential].join(' ')), true);
  assert.equal(JSON.stringify(result).includes(reportingCredential), false);
});

test('filters daily activity to the configured virtual key alias', () => {
  const result = aggregateDailyActivity({ results: [{
    date: '2026-07-14',
    metrics: { spend: 99, api_requests: 99 },
    breakdown: { api_keys: {
      one: { metadata: { key_alias: 'other-key' }, metrics: { spend: 90, api_requests: 90 } },
      two: { metadata: { key_alias: 'scosta-glados-prod' }, metrics: { spend: 9, api_requests: 9, total_tokens: 900 } },
    } },
  }] }, { now: new Date('2026-07-14T16:00:00Z'), days: 1, keyAlias: 'scosta-glados-prod' });
  assert.equal(result.scope, 'virtual-key');
  assert.equal(result.keyAlias, 'scosta-glados-prod');
  assert.equal(result.totals.spend, 9);
  assert.equal(result.totals.requests, 9);
  assert.equal(result.totals.totalTokens, 900);
});

test('returns a sanitized unavailable state when spend-route access is denied', async () => {
  const reportingCredential = ['server', 'only', 'fixture'].join('-');
  const result = await fetchLiteLlmUsage({
    token: reportingCredential,
    fetchImpl: async url => url.endsWith('/key/info')
      ? {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ key: 'fixture-key-id', info: { key_alias: 'fixture-key' } }),
        }
      : {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ detail: 'sensitive gateway detail' }),
        },
  });
  assert.equal(result.available, false);
  assert.equal(result.status, 403);
  assert.match(result.message, /cannot read/);
  assert.equal(JSON.stringify(result).includes('sensitive gateway detail'), false);
});
