const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { upsertBaseline } = require('../../blackboard/lib/baseline-upsert');
const { compactBaselineSummary } = require('../../blackboard/lib/baseline-summary');

test('baseline merges preserve and accurately report completed state', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE baseline_recon (
      engagement_id TEXT PRIMARY KEY,
      summary_json TEXT NOT NULL DEFAULT '{}',
      complete INTEGER NOT NULL DEFAULT 0,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const first = upsertBaseline(db, {
    engagement_id: 'eng-one',
    merge: { webapp: { routes: 4 } },
    complete: true,
  });
  assert.equal(first.complete, true);

  const merged = upsertBaseline(db, {
    engagement_id: 'eng-one',
    merge: { js: { bundles: 2 } },
  });
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.summary, {
    webapp: { routes: 4 },
    js: { bundles: 2 },
  });
  assert.equal(db.prepare('SELECT complete FROM baseline_recon WHERE engagement_id = ?').get('eng-one').complete, 1);
  db.close();
});

test('baseline summaries stay below the reporting tool budget without duplicating the raw payload', () => {
  const source = {
    webapp: Array.from({ length: 200 }, (_, index) => ({
      route: `/admin/route/${index}`,
      response: 'x'.repeat(1200),
      headers: { content_type: 'application/json', index },
    })),
    javascript: { bundles: Array.from({ length: 100 }, (_, index) => `bundle-${index}-${'y'.repeat(600)}`) },
  };
  const result = compactBaselineSummary(source);
  assert.equal(result.truncated, true);
  assert.equal(result.originalBytes > 25000, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result.summary), 'utf8') < 25000, true);
  assert.equal(result.summary.webapp.count, 200);
});
