const test = require('node:test');
const assert = require('node:assert/strict');
const { actionRequiresOperator } = require('../../tools/glados-ops-mcp/lib/scope-risk');
const Database = require('better-sqlite3');
const {
  normalizeActionTarget,
  findExplicitOperatorActionApproval,
} = require('../../tools/glados-ops-mcp/lib/operator-action-approval');

test('approved low and medium risk plan actions do not require duplicate approval', () => {
  assert.equal(actionRequiresOperator({
    action: 'POST a reversible self-account marker and restore it',
    riskToTarget: 'medium',
    preApprovedClass: false,
    hasApprovedPlan: true,
  }), false);
  assert.equal(actionRequiresOperator({
    action: 'write a harmless validation canary',
    riskToTarget: 'low',
    preApprovedClass: false,
    hasApprovedPlan: true,
  }), false);
});

test('high risk and unapproved mutating actions still require operator approval', () => {
  assert.equal(actionRequiresOperator({
    action: 'POST a destructive change',
    riskToTarget: 'high',
    preApprovedClass: false,
    hasApprovedPlan: true,
  }), true);
  assert.equal(actionRequiresOperator({
    action: 'POST a profile change',
    riskToTarget: 'medium',
    preApprovedClass: false,
    hasApprovedPlan: false,
  }), true);
});

test('explicit operator action approvals are exact, time bounded capabilities', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE operator_action_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      target_url TEXT NOT NULL,
      method TEXT NOT NULL,
      risk_to_target TEXT NOT NULL,
      operator TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  const now = 1_000_000;
  db.prepare(`INSERT INTO operator_action_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('action_test', 'legacy', 'webapp-recon', normalizeActionTarget('http://example.test/begin/'), 'POST', 'high', 'operator', 'start timer', now, now + 60_000);

  assert.equal(findExplicitOperatorActionApproval(db, {
    agent_id: 'webapp-recon',
    target_url: 'http://example.test/begin',
    method: 'POST',
    risk_to_target: 'high',
  }, now + 1)?.id, 'action_test');
  assert.equal(findExplicitOperatorActionApproval(db, {
    agent_id: 'webapp-vuln',
    target_url: 'http://example.test/begin',
    method: 'POST',
    risk_to_target: 'high',
  }, now + 1), null);
  assert.equal(findExplicitOperatorActionApproval(db, {
    agent_id: 'webapp-recon',
    target_url: 'http://example.test/begin',
    method: 'POST',
    risk_to_target: 'high',
  }, now + 60_001), null);
  db.close();
});
