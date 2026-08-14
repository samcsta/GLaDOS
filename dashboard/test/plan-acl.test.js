const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const makePlanRouter = require('../routes/plans');
const { extractTargetHosts, buildAclFromPlan, endInvestigationForPlan, endInvestigationForEngagement } = makePlanRouter;

test('plan ACL normalizes URL ports away and does not create IP wildcards', () => {
  const plan = {
    engagement_id: 'eng-1',
    recon_summary: { target: 'http://136.116.95.87:54798/' },
    agent_chain: ['webapp-vuln'],
  };
  assert.deepEqual(extractTargetHosts(plan), ['136.116.95.87']);
  assert.deepEqual(buildAclFromPlan(plan).agents['webapp-vuln'].allow, ['136.116.95.87']);
});

test('plan ACL includes the exact host and wildcard for domain targets', () => {
  const plan = {
    engagement_id: 'eng-2',
    recon_summary: { target: 'https://app.example.test:8443/' },
    agent_chain: ['webapp-vuln'],
  };
  assert.deepEqual(buildAclFromPlan(plan).agents['webapp-vuln'].allow, ['app.example.test', '*.app.example.test']);
});

test('operator end-investigation decision cancels work and does not start reporting', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, status TEXT, completed_at TEXT);
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id TEXT,
      status TEXT,
      updated_at TEXT
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      engagement_id TEXT,
      state TEXT,
      rejected_at TEXT
    );
    CREATE TABLE plan_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT,
      decision TEXT,
      operator TEXT,
      reason TEXT
    );
  `);
  db.prepare("INSERT INTO engagements (id, status) VALUES ('eng-1', 'active')").run();
  db.prepare("INSERT INTO plans (id, engagement_id, state) VALUES ('plan-1', 'eng-1', 'pending_approval')").run();
  db.prepare("INSERT INTO tasks (engagement_id, status) VALUES ('eng-1', 'pending')").run();
  db.prepare("INSERT INTO tasks (engagement_id, status) VALUES ('eng-1', 'completed')").run();

  const result = endInvestigationForPlan(db, {
    planId: 'plan-1',
    operator: 'operator',
    reason: 'stop here',
  });

  assert.equal(result.decision, 'end_investigation');
  assert.equal(result.engagement_status, 'cancelled');
  assert.equal(result.tasks_cancelled, 1);
  assert.equal(result.reports_started, false);
  assert.equal(db.prepare("SELECT state FROM plans WHERE id='plan-1'").get().state, 'rejected');
  assert.equal(db.prepare("SELECT status FROM engagements WHERE id='eng-1'").get().status, 'cancelled');
  assert.deepEqual(db.prepare("SELECT status FROM tasks ORDER BY id").all().map(row => row.status), ['cancelled', 'completed']);
  assert.equal(db.prepare("SELECT decision FROM plan_approvals WHERE plan_id='plan-1'").get().decision, 'end_investigation');
  db.close();
});

test('overview can end an engagement even before a plan exists', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, status TEXT, completed_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, engagement_id TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE plans (id TEXT PRIMARY KEY, engagement_id TEXT, state TEXT, rejected_at TEXT, created_at TEXT);
    CREATE TABLE plan_approvals (id INTEGER PRIMARY KEY, plan_id TEXT, decision TEXT, operator TEXT, reason TEXT);
    INSERT INTO engagements (id, status) VALUES ('eng-no-plan', 'active');
    INSERT INTO tasks (id, engagement_id, status) VALUES (1, 'eng-no-plan', 'running');
  `);
  const result = endInvestigationForEngagement(db, {
    engagementId: 'eng-no-plan',
    reason: 'operator ended from Overview',
  });
  assert.equal(result.engagement_status, 'cancelled');
  assert.equal(result.tasks_cancelled, 1);
  assert.deepEqual(result.plans_ended, []);
  assert.equal(db.prepare("SELECT status FROM engagements WHERE id='eng-no-plan'").get().status, 'cancelled');
  db.close();
});

test('plan approval invokes the automatic execution handoff for all and selected vectors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-plan-route-'));
  const dbPath = path.join(root, 'blackboard.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, engagement_id TEXT, state TEXT, plan_json TEXT,
      approved_at TEXT, rejected_at TEXT, completed_at TEXT, version INTEGER,
      parent_plan_id TEXT, replan_reason TEXT, recon_summary TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE plan_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, decision TEXT,
      approved_vectors TEXT, operator TEXT, reason TEXT, modifications TEXT,
      notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const insert = db.prepare("INSERT INTO plans (id, engagement_id, state, plan_json, version) VALUES (?, 'eng-1', 'pending_approval', ?, 1)");
  insert.run('plan-all', JSON.stringify({ engagement_id: 'eng-1', proposed_vectors: [], agent_chain: [] }));
  insert.run('plan-selected', JSON.stringify({ engagement_id: 'eng-1', proposed_vectors: [], agent_chain: [] }));
  db.close();

  const handedOff = [];
  const app = express();
  app.use(express.json());
  app.use('/api/plans', makePlanRouter(() => {}, {
    dbPath,
    getSessionId: () => 'session-a',
    onApproved: payload => {
      handedOff.push(payload);
      return { executionQueued: true };
    },
  }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const approveAll = await fetch(`${base}/api/plans/plan-all/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writeAcl: false }),
    }).then(response => response.json());
    const approveSelected = await fetch(`${base}/api/plans/plan-selected/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writeAcl: false, vectors: ['CWE-89'] }),
    }).then(response => response.json());
    assert.equal(approveAll.execution_queued, true);
    assert.equal(approveSelected.execution_queued, true);
    assert.deepEqual(handedOff.map(row => ({ id: row.id, decision: row.decision, vectors: row.vectors })), [
      { id: 'plan-all', decision: 'approve_all', vectors: null },
      { id: 'plan-selected', decision: 'approve_selected', vectors: ['CWE-89'] },
    ]);
    assert.deepEqual(handedOff.map(row => row.sessionId), ['session-a', 'session-a']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
