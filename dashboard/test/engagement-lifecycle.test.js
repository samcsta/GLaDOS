const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { updateEngagement } = require('../../blackboard/lib/engagement-lifecycle');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (
      id TEXT PRIMARY KEY,
      target_name TEXT NOT NULL,
      scope TEXT,
      status TEXT DEFAULT 'active',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id TEXT NOT NULL,
      assigned_to TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    );
  `);
  return db;
}

test('engagement completion rejects nonterminal audit tasks', () => {
  const db = testDb();
  db.prepare('INSERT INTO engagements (id, target_name) VALUES (?, ?)').run('eng-1', 'target');
  db.prepare('INSERT INTO tasks (engagement_id, assigned_to) VALUES (?, ?)').run('eng-1', 'report-writer');
  assert.throws(
    () => updateEngagement(db, { engagementId: 'eng-1', status: 'complete' }),
    /#1:report-writer:pending/
  );
  assert.equal(db.prepare('SELECT status FROM engagements WHERE id = ?').get('eng-1').status, 'active');
  db.close();
});

test('engagement completion records completion only after every task is terminal', () => {
  const db = testDb();
  db.prepare('INSERT INTO engagements (id, target_name) VALUES (?, ?)').run('eng-2', 'target');
  db.prepare('INSERT INTO tasks (engagement_id, assigned_to, status) VALUES (?, ?, ?)')
    .run('eng-2', 'report-writer', 'completed');
  const completed = updateEngagement(db, { engagementId: 'eng-2', status: 'complete' });
  assert.equal(completed.status, 'complete');
  assert.ok(completed.completed_at);

  const reopened = updateEngagement(db, { engagementId: 'eng-2', status: 'active' });
  assert.equal(reopened.status, 'active');
  assert.equal(reopened.completed_at, null);
  db.close();
});
