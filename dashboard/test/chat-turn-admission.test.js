const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { activeTurnConflict } = require('../lib/chat-turn-admission');
const { clearPlanState, cleanupLooseInvestigationArtifacts, resetMutableAgentStatus } = require('../lib/runtime-reset');

test('active turn admission rejects a second turn for the same agent', () => {
  const startedAt = Date.now() - 50;
  const turns = new Map([['glados', { turnId: 'turn-one', startedAt }]]);
  const conflict = activeTurnConflict(turns, 'glados');
  assert.equal(conflict.code, 'GLADOS_TURN_ALREADY_ACTIVE');
  assert.equal(conflict.turnId, 'turn-one');
  assert.ok(conflict.ageMs >= 50);
  assert.equal(activeTurnConflict(turns, 'webapp-recon'), null);
});

test('investigation reset replaces stale mutable agent status with idle state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-status-reset-'));
  const agentDir = path.join(root, 'glados');
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'AGENT-STATUS.md');
  fs.writeFileSync(file, '# Current Engagement\nOld target\n');

  const result = resetMutableAgentStatus(root);
  assert.deepEqual(result, { reset: 1, errors: [] });
  assert.match(fs.readFileSync(file, 'utf8'), /GLaDOS is idle/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Old target/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('full reset removes loose browser artifacts but preserves durable evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-artifact-reset-'));
  const engagement = path.join(root, 'target-one');
  const evidence = path.join(engagement, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const snapshot = 'page-2026-07-15T22-33-55-791Z.png';
  const consoleLog = 'console-2026-07-15T22-33-36-616Z.log';
  fs.writeFileSync(path.join(root, consoleLog), 'loose root capture');
  fs.writeFileSync(path.join(engagement, snapshot), 'loose engagement capture');
  fs.writeFileSync(path.join(evidence, snapshot), 'durable evidence');
  fs.writeFileSync(path.join(engagement, 'notes.md'), 'preserve');

  const result = cleanupLooseInvestigationArtifacts(root);
  assert.deepEqual(result, { removed: 2, errors: [] });
  assert.equal(fs.existsSync(path.join(root, consoleLog)), false);
  assert.equal(fs.existsSync(path.join(engagement, snapshot)), false);
  assert.equal(fs.readFileSync(path.join(evidence, snapshot), 'utf8'), 'durable evidence');
  assert.equal(fs.readFileSync(path.join(engagement, 'notes.md'), 'utf8'), 'preserve');
});

test('runtime refresh clears only plan workflow tables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-plan-reset-'));
  const dbPath = path.join(root, 'blackboard.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY);
    CREATE TABLE findings (id INTEGER PRIMARY KEY, engagement_id TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, engagement_id TEXT);
    CREATE TABLE plans (id TEXT PRIMARY KEY, engagement_id TEXT, parent_plan_id TEXT);
    CREATE TABLE plan_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT);
    CREATE TABLE replan_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT, finding_id INTEGER);
    INSERT INTO engagements VALUES ('eng-1');
    INSERT INTO findings VALUES (1, 'eng-1');
    INSERT INTO tasks VALUES (1, 'eng-1');
    INSERT INTO plans VALUES ('plan-1', 'eng-1', NULL);
    INSERT INTO plan_approvals (plan_id) VALUES ('plan-1');
    INSERT INTO replan_proposals (engagement_id, finding_id) VALUES ('eng-1', 1);
  `);
  db.close();

  const result = clearPlanState(dbPath);
  assert.deepEqual(result, {
    ok: true,
    tablesCleared: ['plan_approvals', 'replan_proposals', 'plans'],
    rowsDeleted: { plan_approvals: 1, replan_proposals: 1, plans: 1 },
  });

  const verify = new Database(dbPath, { readonly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM engagements').get().n, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM plan_approvals').get().n, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM replan_proposals').get().n, 0);
  verify.close();
});
