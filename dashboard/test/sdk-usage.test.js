const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateSdkResultEvents } = require('../lib/sdk-usage');

test('SDK usage fallback reports terminal turn cost without double-counting model cost', () => {
  const usage = aggregateSdkResultEvents([{ event_json: JSON.stringify({
    costUsd: 3.5,
    modelUsage: {
      'gpt-5.6-sol': { costUSD: 2, inputTokens: 100, outputTokens: 10 },
      'gpt-5.6-terra': { costUSD: 1.5, inputTokens: 50, outputTokens: 5 },
    },
  }) }]);
  assert.equal(usage.totals.costUsd, 3.5);
  assert.equal(usage.totals.completedTurns, 1);
  assert.equal(usage.totals.totalTokens, 165);
  assert.deepEqual(usage.models.map(model => model.name), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(usage.provisional, true);
});

test('SDK usage aggregation includes billable error terminal results', () => {
  const usage = aggregateSdkResultEvents([{ event_json: JSON.stringify({
    sdkType: 'result', costUsd: 1.25, isError: true,
    modelUsage: { 'gpt-5.6-sol': { costUSD: 1.25, inputTokens: 25, outputTokens: 5 } },
  }) }]);
  assert.equal(usage.totals.costUsd, 1.25);
  assert.equal(usage.totals.completedTurns, 1);
  assert.equal(usage.totals.totalTokens, 30);
});

test('SDK usage keeps only the latest cumulative receipt for a resumed session', () => {
  const usage = aggregateSdkResultEvents([
    { event_json: JSON.stringify({ sessionId: 'session-1', costUsd: 1, modelUsage: { terra: { costUSD: 1, inputTokens: 10 } } }) },
    { event_json: JSON.stringify({ sessionId: 'session-1', costUsd: 3, modelUsage: { terra: { costUSD: 3, inputTokens: 30 } } }) },
  ]);
  assert.equal(usage.totals.costUsd, 3);
  assert.equal(usage.totals.completedTurns, 1);
  assert.equal(usage.models[0].inputTokens, 30);
});
