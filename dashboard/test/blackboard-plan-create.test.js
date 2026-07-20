const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createOrReusePlan } = require('../../blackboard/lib/plan-create');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'pending_approval', plan_json TEXT NOT NULL, recon_summary TEXT,
      parent_plan_id TEXT, replan_reason TEXT
    )
  `);
  return db;
}

const plan = {
  engagement_id: 'eng-1',
  recon_summary: { target: 'http://example.test:8080' },
  proposed_vectors: [{ cwe: 'CWE-79', rationale: 'reflected input', confidence_pre: 0.4, risk_to_target: 'low' }],
  agent_chain: ['webapp-vuln'],
};

test('canonical plan creation is idempotent for an exact retry', () => {
  const db = testDb();
  const first = createOrReusePlan(db, plan);
  const retry = createOrReusePlan(db, plan);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM plans').get().count, 1);
  db.close();
});

test('canonical plan creation validates vectors before persistence', () => {
  const db = testDb();
  assert.throws(() => createOrReusePlan(db, { ...plan, proposed_vectors: [] }), /non-empty array/);
  db.close();
});
