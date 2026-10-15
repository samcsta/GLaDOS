const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const { InvestigationSessionStore } = require('../lib/investigation-session-store');

test('a session keeps its selected team across reopen, rename, project moves, and activation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-session-teams-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'blackboard.db'); ensureBlackboardDb({ blackboardDb: dbPath });
  let store = new InvestigationSessionStore(dbPath);
  const old = store.getActive(); assert.equal(old.teamId, 'glados');
  const selected = store.create({ name: 'Team session', teamId: 'pkg-my-team--crew', metadata: { note: 'retained' } });
  assert.equal(selected.teamId, 'pkg-my-team--crew'); assert.equal(selected.metadata.teamId, selected.teamId);
  store.rename(selected.id, 'Renamed team session');
  store.moveToProject(selected.id, store.createProject('Team project').id);
  store.activate(old.id); store.activate(selected.id);
  store.close(); store = new InvestigationSessionStore(dbPath);
  assert.equal(store.get(selected.id).teamId, 'pkg-my-team--crew');
  assert.equal(store.get(selected.id).metadata.note, 'retained');
  assert.equal(store.get(old.id).teamId, 'glados');
  const direct = store.create({ teamId: 'agent:pkg-my-team--member', metadata: { directAgentId: 'ignored-spoof' } });
  assert.equal(direct.kind, 'agent'); assert.equal(direct.teamId, 'agent:pkg-my-team--member');
  assert.equal(direct.directAgentId, 'pkg-my-team--member');
  assert.equal(direct.metadata.directAgentId, 'pkg-my-team--member');
  store.close(); store = new InvestigationSessionStore(dbPath);
  assert.equal(store.get(direct.id).directAgentId, 'pkg-my-team--member');
  assert.throws(() => store.create({ teamId: '../escape' }), /invalid session team/);
  store.close();
});

test('session recency changes on a new message, while opening, renaming, or filing a conversation preserves it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-session-recency-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const first = store.create({ name: 'First conversation' });
  const second = store.create({ name: 'Second conversation' });
  const db = new Database(dbPath);
  const insert = db.prepare('INSERT INTO dashboard_transcript_events (session_id, agent_id, kind, text, event_json, ts) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(first.id, 'glados', 'user-message', 'First prompt', '{}', '2026-10-14T10:00:00.000Z');
  insert.run(second.id, 'glados', 'user-message', 'Second prompt', '{}', '2026-10-14T11:00:00.000Z');
  assert.equal(store.get(first.id).lastActivityAt, '2026-10-14T10:00:00.000Z');
  store.activate(first.id);
  store.rename(first.id, 'Renamed conversation');
  store.moveToProject(first.id, store.createProject('Project').id);
  assert.equal(store.get(first.id).lastActivityAt, '2026-10-14T10:00:00.000Z');
  assert.equal(store.list().find(session => session.id === second.id).lastActivityAt, '2026-10-14T11:00:00.000Z');
  insert.run(first.id, 'glados', 'assistant-text', 'Backfilled response', '{}', '2026-10-14T12:00:00.000Z');
  assert.equal(store.get(first.id).lastActivityAt, '2026-10-14T10:00:00.000Z');
  insert.run(first.id, 'glados', 'user-message', 'New prompt', '{}', '2026-10-14T13:00:00.000Z');
  assert.equal(store.get(first.id).lastActivityAt, '2026-10-14T13:00:00.000Z');
  db.close();
  store.close();
});

test('new investigation sessions archive rather than delete prior blackboard data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-sessions-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const first = store.getActive();
  const db = new Database(dbPath);
  db.prepare('INSERT INTO engagements (id, session_id, target_name) VALUES (?, ?, ?)').run('eng-a', first.id, 'example.com');
  db.prepare("INSERT INTO findings (engagement_id, target_url, finding_type, affected_component, title, discovered_by) VALUES ('eng-a', 'https://example.com', 'vulnerability', '/', 'A finding', 'glados')").run();
  db.close();

  assert.equal(store.get(first.id).engagementCount, 1);
  assert.equal(store.getActive().engagementCount, 1);

  const second = store.create({ name: 'Second investigation' });
  assert.notEqual(second.id, first.id);
  assert.equal(store.get(first.id).state, 'archived');
  assert.equal(store.getActive().id, second.id);
  const verify = new Database(dbPath, { readonly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM findings WHERE engagement_id='eng-a'").get().n, 1);
  verify.close();
  store.activate(first.id);
  assert.equal(store.getActive().id, first.id);
  store.close();
});

test('legacy blackboard rows migrate into an imported session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-migration-'));
  const dbPath = path.join(root, 'blackboard.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, target_name TEXT NOT NULL, scope TEXT, status TEXT DEFAULT 'active', started_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
    CREATE TABLE dashboard_transcript_events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, client_event_id TEXT, kind TEXT NOT NULL, text TEXT, event_json TEXT NOT NULL, ts TEXT, created_at TEXT);
    INSERT INTO engagements (id, target_name) VALUES ('old-engagement', 'legacy.example');
    INSERT INTO dashboard_transcript_events (agent_id, kind, text, event_json) VALUES ('glados', 'assistant-text', 'old transcript', '{}');
  `);
  legacy.close();
  ensureBlackboardDb({ blackboardDb: dbPath });
  const migrated = new Database(dbPath, { readonly: true });
  assert.equal(migrated.prepare("SELECT session_id FROM engagements WHERE id='old-engagement'").get().session_id, 'legacy');
  assert.equal(migrated.prepare("SELECT session_id FROM dashboard_transcript_events LIMIT 1").get().session_id, 'legacy');
  assert.equal(migrated.prepare("SELECT engagement_id FROM dashboard_transcript_events LIMIT 1").get().engagement_id, null);
  assert.equal(migrated.prepare("SELECT state FROM investigation_sessions WHERE id='legacy'").get().state, 'active');
  migrated.close();
});

test('unassigned session is named from its first prompt and can be renamed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-naming-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const active = store.getActive();
  const named = store.nameFromFirstPrompt(active.id, 'Investigate the authentication flow for portal.example.com?');
  assert.equal(named.name, 'Investigate the authentication flow for portal.example.com');
  assert.equal(named.metadata.unassigned, undefined);
  assert.equal(store.rename(active.id, 'Portal SSO follow-up').name, 'Portal SSO follow-up');
  store.close();
});

test('deleting the active session creates an unassigned replacement and removes owned rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-delete-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const active = store.getActive();
  const db = new Database(dbPath);
  db.prepare('INSERT INTO engagements (id, session_id, target_name) VALUES (?, ?, ?)').run('delete-eng', active.id, 'delete.example');
  db.prepare("INSERT INTO findings (engagement_id, target_url, finding_type, affected_component, title, discovered_by) VALUES ('delete-eng', 'https://delete.example', 'vulnerability', '/', 'Delete me', 'glados')").run();
  db.prepare("INSERT INTO dashboard_transcript_events (session_id, agent_id, kind, event_json) VALUES (?, 'glados', 'assistant-text', '{}')").run(active.id);
  db.close();
  const result = store.delete(active.id);
  assert.notEqual(result.replacement.id, active.id);
  assert.equal(result.replacement.metadata.unassigned, true);
  assert.equal(store.get(active.id), null);
  const verify = new Database(dbPath, { readonly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM findings WHERE engagement_id='delete-eng'").get().n, 0);
  assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM dashboard_transcript_events WHERE session_id=?').get(active.id).n, 0);
  verify.close();
  store.close();
});

test('deleting a security-review session removes job-linked transcript rows before controller jobs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-security-review-session-delete-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const session = store.create({ name: 'Historical review' });
  const engagementId = 'eng-security-review-delete';
  const goalId = 'goal-security-review-delete';
  const jobId = 'job-security-review-delete';
  store.db.prepare('INSERT INTO engagements (id, session_id, target_name, scope) VALUES (?, ?, ?, ?)')
    .run(engagementId, session.id, '/tmp/repo', '["/tmp/repo"]');
  store.db.prepare("INSERT INTO controller_goals (id,type,target,status,engagement_id) VALUES (?, 'security_review', ?, 'failed', ?)")
    .run(goalId, '/tmp/repo', engagementId);
  store.db.prepare("INSERT INTO controller_jobs (id,goal_id,engagement_id,agent_id,job_type,target,prompt,status) VALUES (?,?,?,'glados','security_review_workflow_v3',?,?,'failed')")
    .run(jobId, goalId, engagementId, '/tmp/repo', 'review');
  store.db.prepare("INSERT INTO dashboard_transcript_events (session_id,agent_id,kind,text,event_json,engagement_id,controller_job_id) VALUES (?,'glados','result','done','{}',?,?)")
    .run(session.id, engagementId, jobId);
  const deleted = store.delete(session.id);
  assert.equal(deleted.rowsDeleted.dashboard_transcript_events, 1);
  assert.equal(deleted.rowsDeleted.controller_jobs, 1);
  assert.equal(store.get(session.id), null);
  store.close();
});

test('deleting archived sessions does not create additional unassigned sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-delete-archived-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const first = store.getActive();
  store.rename(first.id, 'Named session');
  const unassigned = store.createUnassigned();
  const archivedOne = store.create({ name: 'Old one', activate: false });
  const archivedTwo = store.create({ name: 'Old two', activate: false });
  const before = store.list().filter(session => session.metadata.unassigned).length;
  store.delete(archivedOne.id);
  store.delete(archivedTwo.id);
  const after = store.list().filter(session => session.metadata.unassigned).length;
  assert.equal(before, 1);
  assert.equal(after, 1);
  assert.equal(store.getActive().id, unassigned.id);
  store.close();
});

test('deleting active session reuses an existing archived session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-delete-reuse-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const first = store.getActive();
  store.rename(first.id, 'First');
  const second = store.create({ name: 'Second' });
  const countBefore = store.list().length;
  const result = store.delete(second.id);
  assert.equal(result.replacement.id, first.id);
  assert.equal(store.list().length, countBefore - 1);
  store.close();
});

test('startup removes duplicate empty archived unassigned sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-dedupe-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  let store = new InvestigationSessionStore(dbPath);
  const active = store.getActive();
  store.rename(active.id, 'Named');
  store.create({ name: 'Unassigned session', metadata: { unassigned: true }, activate: false });
  store.create({ name: 'Unassigned session', metadata: { unassigned: true }, activate: false });
  store.create({ name: 'Unassigned session', metadata: { unassigned: true }, activate: false });
  store.close();
  store = new InvestigationSessionStore(dbPath);
  assert.equal(store.list().filter(session => session.metadata.unassigned).length, 1);
  store.close();
});

test('projects group sessions and deleting a project safely returns them to Unfiled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-investigation-projects-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const store = new InvestigationSessionStore(dbPath);
  const active = store.getActive();
  const project = store.createProject('Ford reviews');
  store.moveToProject(active.id, project.id);
  let listed = store.list().find(session => session.id === active.id);
  assert.equal(listed.projectId, project.id);
  assert.equal(listed.projectName, 'Ford reviews');
  assert.equal(store.listProjects()[0].sessionCount, 1);
  store.deleteProject(project.id);
  listed = store.list().find(session => session.id === active.id);
  assert.equal(listed.projectId, null);
  assert.equal(store.listProjects().length, 0);
  store.close();
});
