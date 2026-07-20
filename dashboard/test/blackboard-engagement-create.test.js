const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createOrReuseEngagement } = require('../../blackboard/lib/engagement-create');

function testDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE engagements (
      id TEXT PRIMARY KEY,
      target_name TEXT NOT NULL,
      scope TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
  return db;
}

test('engagement creation reuses an exact existing engagement', () => {
  const db = testDb();
  const args = { id: 'eng-1', target_name: 'http://example.test', scope: '["http://example.test"]' };
  assert.equal(createOrReuseEngagement(db, args).created, true);
  assert.equal(createOrReuseEngagement(db, args).created, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM engagements').get().count, 1);
  db.close();
});

test('engagement creation rejects a conflicting duplicate id', () => {
  const db = testDb();
  createOrReuseEngagement(db, { id: 'eng-1', target_name: 'http://one.test', scope: '["http://one.test"]' });
  assert.throws(
    () => createOrReuseEngagement(db, { id: 'eng-1', target_name: 'http://two.test', scope: '["http://two.test"]' }),
    /different target or scope/
  );
  db.close();
});
