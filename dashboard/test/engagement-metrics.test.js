const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { engagementMetrics } = require('../../tools/glados-ops-mcp/lib/engagement-metrics');

test('engagement metrics attribute elapsed time, SDK spend, and tokens to the engagement window', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, target_name TEXT, status TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, engagement_id TEXT, status TEXT);
    CREATE TABLE dashboard_transcript_events (id INTEGER PRIMARY KEY, engagement_id TEXT, agent_id TEXT, kind TEXT, event_json TEXT, ts TEXT);
  `);
  db.prepare('INSERT INTO engagements VALUES (?, ?, ?, ?, ?)')
    .run('eng-1', 'https://target.test', 'complete', '2026-07-15 10:00:00', '2026-07-15 11:30:00');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(1, 'eng-1', 'completed');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(2, 'eng-1', 'cancelled');
  const insertEvent = db.prepare('INSERT INTO dashboard_transcript_events (engagement_id, agent_id, kind, event_json, ts) VALUES (?, ?, ?, ?, ?)');
  insertEvent.run('eng-other', 'glados', 'result', JSON.stringify({ costUsd: 9 }), '2026-07-15T10:10:00Z');
  insertEvent.run('eng-1', 'glados', 'result', JSON.stringify({
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
  insertEvent.run('eng-1', 'report-writer', 'result', JSON.stringify({
    costUsd: 0.75,
    usage: { inputTokens: 40, outputTokens: 10 },
    modelUsage: {
      'claude-opus-4-8': { costUsd: 0.75, input_tokens: 40, output_tokens: 10 },
    },
  }), '2026-07-15T11:20:00Z');
  insertEvent.run('eng-other', 'glados', 'result', JSON.stringify({ costUsd: 8 }), '2026-07-15T11:31:00Z');

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

test('engagement metrics prefer settled LiteLLM request costs over SDK estimates', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, target_name TEXT, status TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, engagement_id TEXT, status TEXT);
    CREATE TABLE dashboard_transcript_events (id INTEGER PRIMARY KEY, engagement_id TEXT, agent_id TEXT, kind TEXT, event_json TEXT, ts TEXT);
    CREATE TABLE security_review_model_observations (
      observation_id TEXT PRIMARY KEY, engagement_id TEXT, review_role TEXT, worker_id TEXT,
      requested_model TEXT, actual_model TEXT, billed_model_name TEXT, cost_usd REAL,
      request_id TEXT, source TEXT, observed_at TEXT
    );
    CREATE TABLE security_review_llm_requests (request_id TEXT PRIMARY KEY, engagement_id TEXT, status TEXT);
  `);
  db.prepare('INSERT INTO engagements VALUES (?, ?, ?, ?, ?)').run('eng-2', 'repo', 'complete', '2026-08-10 10:00:00', '2026-08-10 11:00:00');
  db.prepare('INSERT INTO dashboard_transcript_events VALUES (1, ?, ?, ?, ?, ?)').run('eng-2', 'glados', 'result', JSON.stringify({ costUsd: 9 }), '2026-08-10T10:30:00Z');
  db.prepare('INSERT INTO security_review_model_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('obs-1', 'eng-2', 'coordinator', null, 'sol', 'deployment-sol', 'gpt-5.6-sol', 1.25, 'req-1', 'litellm:spend-log', '2026-08-10T10:30:00Z');
  db.prepare('INSERT INTO security_review_llm_requests VALUES (?, ?, ?)').run('req-1', 'eng-2', 'SETTLED');
  const result = engagementMetrics(db, 'eng-2');
  assert.equal(result.metering.costUsd, 1.25);
  assert.equal(result.metering.provisionalSdkCostUsd, 9);
  assert.equal(result.metering.costSettled, true);
  db.close();
});

test('engagement metrics keep only the latest cumulative receipt for a resumed session', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, target_name TEXT, status TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, engagement_id TEXT, status TEXT);
    CREATE TABLE dashboard_transcript_events (id INTEGER PRIMARY KEY, engagement_id TEXT, agent_id TEXT, kind TEXT, event_json TEXT, ts TEXT);
  `);
  db.prepare('INSERT INTO engagements VALUES (?, ?, ?, ?, ?)').run('eng-3', 'repo', 'complete', '2026-08-10 10:00:00', '2026-08-10 11:00:00');
  const insert = db.prepare('INSERT INTO dashboard_transcript_events VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, 'eng-3', 'glados', 'result', JSON.stringify({ sessionId: 'sdk-1', costUsd: 1, modelUsage: { terra: { costUSD: 1, inputTokens: 10 } } }), '2026-08-10T10:20:00Z');
  insert.run(2, 'eng-3', 'glados', 'result', JSON.stringify({ sessionId: 'sdk-1', costUsd: 3, modelUsage: { terra: { costUSD: 3, inputTokens: 30 } } }), '2026-08-10T10:40:00Z');
  const result = engagementMetrics(db, 'eng-3');
  assert.equal(result.metering.resultEvents, 1);
  assert.equal(result.metering.costUsd, 3);
  assert.equal(result.metering.byModel[0].inputTokens, 30);
  db.close();
});
