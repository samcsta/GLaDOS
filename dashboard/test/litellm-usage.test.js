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
  let observed = null;
  const reportingCredential = ['server', 'only', 'fixture'].join('-');
  const result = await fetchLiteLlmUsage({
    token: reportingCredential,
    now: new Date('2026-07-14T16:00:00Z'),
    fetchImpl: async (url, options) => {
      observed = { url, authorization: options.headers.Authorization };
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    },
  });
  assert.match(observed.url, /\/user\/daily\/activity\?start_date=2026-07-08&end_date=2026-07-14/);
  assert.equal(observed.authorization, ['Bearer', reportingCredential].join(' '));
  assert.equal(JSON.stringify(result).includes(reportingCredential), false);
});

test('returns a sanitized unavailable state when spend-route access is denied', async () => {
  const reportingCredential = ['server', 'only', 'fixture'].join('-');
  const result = await fetchLiteLlmUsage({
    token: reportingCredential,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ detail: 'sensitive gateway detail' }),
    }),
  });
  assert.equal(result.available, false);
  assert.equal(result.status, 403);
  assert.match(result.message, /cannot read/);
  assert.equal(JSON.stringify(result).includes('sensitive gateway detail'), false);
});
