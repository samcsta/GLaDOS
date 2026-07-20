const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { engagementMetrics } = require('../../tools/glados-ops-mcp/lib/engagement-metrics');

test('engagement metrics attribute elapsed time, SDK spend, and tokens to the engagement window', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, target_name TEXT, status TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, engagement_id TEXT, status TEXT);
    CREATE TABLE dashboard_transcript_events (id INTEGER PRIMARY KEY, agent_id TEXT, kind TEXT, event_json TEXT, ts TEXT);
  `);
  db.prepare('INSERT INTO engagements VALUES (?, ?, ?, ?, ?)')
    .run('eng-1', 'https://target.test', 'complete', '2026-07-15 10:00:00', '2026-07-15 11:30:00');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(1, 'eng-1', 'completed');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(2, 'eng-1', 'cancelled');
  const insertEvent = db.prepare('INSERT INTO dashboard_transcript_events (agent_id, kind, event_json, ts) VALUES (?, ?, ?, ?)');
  insertEvent.run('glados', 'result', JSON.stringify({ costUsd: 9 }), '2026-07-15T09:59:59Z');
  insertEvent.run('glados', 'result', JSON.stringify({
    costUsd: 1.25,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
    modelUsage: {
      'claude-sonnet-5': {
        costUSD: 1.25,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
      },
    },
  }), '2026-07-15T10:30:00Z');
  insertEvent.run('report-writer', 'result', JSON.stringify({
    costUsd: 0.75,
    usage: { inputTokens: 40, outputTokens: 10 },
    modelUsage: {
      'claude-opus-4-8': { costUsd: 0.75, input_tokens: 40, output_tokens: 10 },
    },
  }), '2026-07-15T11:20:00Z');
  insertEvent.run('glados', 'result', JSON.stringify({ costUsd: 8 }), '2026-07-15T11:31:00Z');

  const result = engagementMetrics(db, 'eng-1', { now: new Date('2026-07-15T12:00:00Z') });
  assert.equal(result.timing.elapsedHuman, '1h 30m 0s');
  assert.equal(result.metering.resultEvents, 2);
  assert.equal(result.metering.costUsd, 2);
  assert.deepEqual(result.metering.tokens, {
    inputTokens: 140,
    outputTokens: 30,
    cacheReadTokens: 30,
    cacheCreationTokens: 10,
    totalTokens: 210,
  });
  assert.equal(result.metering.byAgent[0].agentId, 'glados');
  assert.deepEqual(result.metering.byModel, [
    {
      modelId: 'claude-sonnet-5',
      resultEvents: 1,
      costUsd: 1.25,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      totalTokens: 160,
    },
    {
      modelId: 'claude-opus-4-8',
      resultEvents: 1,
      costUsd: 0.75,
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 50,
    },
  ]);
  assert.deepEqual(result.tasks, { cancelled: 1, completed: 1 });
  db.close();
});
