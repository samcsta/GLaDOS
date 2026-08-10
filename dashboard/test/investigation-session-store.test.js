const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const { InvestigationSessionStore } = require('../lib/investigation-session-store');

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
