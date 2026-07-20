const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../../dashboard/node_modules/better-sqlite3');
const { createUpdatePreservationSnapshot } = require('../../dashboard/lib/update-preservation');

function makeDb(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE state (value TEXT NOT NULL)');
  db.prepare('INSERT INTO state (value) VALUES (?)').run(value);
  db.close();
}

test('update preservation snapshots databases and user configuration without moving reports', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-update-snapshot-'));
  try {
    const blackboardDb = path.join(runtimeDir, 'blackboard', 'blackboard.db');
    const watchdogDb = path.join(runtimeDir, 'watchdog', 'watchdog.db');
    makeDb(blackboardDb, 'blackboard-ok');
    makeDb(watchdogDb, 'watchdog-ok');
    fs.writeFileSync(path.join(runtimeDir, 'model-overrides.json'), '{"glados":"opus"}\n');
    fs.mkdirSync(path.join(runtimeDir, 'reports'), { recursive: true });
    const report = path.join(runtimeDir, 'reports', 'operator-report.md');
    fs.writeFileSync(report, '# durable report\n');

    const result = await createUpdatePreservationSnapshot({
      runtimeDir,
      blackboardDb,
      watchdogDb,
      targetVersion: '4.1.0',
      now: new Date('2026-07-16T12:00:00.000Z'),
    });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(report, 'utf8'), '# durable report\n');
    assert.equal(fs.readFileSync(path.join(result.snapshotDir, 'config', 'model-overrides.json'), 'utf8'), '{"glados":"opus"}\n');
    for (const [name, value] of [['blackboard.db', 'blackboard-ok'], ['watchdog.db', 'watchdog-ok']]) {
      const db = new Database(path.join(result.snapshotDir, name), { readonly: true });
      assert.equal(db.prepare('SELECT value FROM state').get().value, value);
      db.close();
    }
    assert.equal(result.manifest.protectedInPlace.find(row => row.path === 'reports').exists, true);
    assert.equal(fs.existsSync(path.join(result.snapshotDir, 'config', 'reports')), false);
  } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
});

test('update preservation refuses to run while agents are active', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-update-active-'));
  try {
    await assert.rejects(() => createUpdatePreservationSnapshot({
      runtimeDir,
      activeAgents: 2,
    }), /2 agent\(s\) are active/);
  } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
});
