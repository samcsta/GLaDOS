const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('a reused specialist cannot inherit another session’s global target ACL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-team-target-scope-'));
  const modulePath = require.resolve('../../watchdog/lib/safety-gate');
  const previousAcl = process.env.GLADOS_FETCH_ACL;
  const cached = require.cache[modulePath];
  try {
    const acl = path.join(root, 'fetch-acl.json');
    process.env.GLADOS_FETCH_ACL = acl;
    fs.writeFileSync(acl, JSON.stringify({ enabled: true, generated: { engagement_id: 'old-engagement' }, agents: {
      'pkg-private--specialist': { allow: ['old-team.example'] },
      'net-recon': { allow: ['old-team.example'] },
    } }));
    const dbPath = path.join(root, 'blackboard.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE engagements (id TEXT, scope TEXT, status TEXT, session_id TEXT, started_at TEXT)');
    db.prepare('INSERT INTO engagements VALUES (?,?,?,?,?)').run('current-engagement', JSON.stringify(['current-team.example']), 'active', 'current-session', '2026-10-14');
    db.prepare('INSERT INTO engagements VALUES (?,?,?,?,?)').run('old-engagement', JSON.stringify(['old-team.example']), 'active', 'old-session', '2026-10-13');
    db.close();
    delete require.cache[modulePath];
    const { targetAllowed } = require(modulePath);
    const strict = { dbPath, sessionId: 'current-session', engagementId: 'current-engagement', requireEngagementScope: true };
    assert.equal(targetAllowed('pkg-private--specialist', 'https://old-team.example', ['old-team.example'], strict).allowed, false);
    assert.equal(targetAllowed('pkg-private--specialist', 'https://current-team.example', [], strict).allowed, true);
    assert.equal(targetAllowed('net-recon', 'https://crt.sh', [], strict).allowed, false);
    assert.equal(targetAllowed('net-recon', 'https://old-team.example', [], { dbPath, sessionId: 'current-session' }).allowed, true);
  } finally {
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
    if (previousAcl === undefined) delete process.env.GLADOS_FETCH_ACL;
    else process.env.GLADOS_FETCH_ACL = previousAcl;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
