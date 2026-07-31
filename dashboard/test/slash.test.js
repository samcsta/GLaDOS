const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slash = require('../lib/slash');

test('whitelist parses known commands and rejects unknown ones', () => {
  assert.deepEqual(slash.parseSlashCommand('/halt webapp-vuln'), {
    ok: true,
    cmd: '/halt',
    arg: 'webapp-vuln',
    raw: '/halt webapp-vuln',
  });
  const bad = slash.parseSlashCommand('/rm -rf /');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown/);
  assert.equal(slash.parseSlashCommand('/rps').ok, false);
  assert.equal(slash.parseSlashCommand('/breaker').ok, false);
});

test('help includes new workflow commands and security-review disambiguation', () => {
  const text = slash.helpText();
  assert.match(text, /\/goal <target>/);
  assert.match(text, /\/investigate <target>/);
  assert.doesNotMatch(text, /\/rps|\/breaker|Proxy RPS/i);
  assert.match(text, /separate from Claude Code CLI skills/);
});

test('local path detection works for security-review routing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-slash-test-'));
  assert.equal(slash.isExistingLocalPath(dir), true);
  assert.equal(slash.isUrlOrDomain('https://example.com'), true);
  assert.equal(slash.isUrlOrDomain('example.com'), true);
});

test('security-review context modes default to blind and are mutually exclusive', () => {
  const fsStub = { existsSync: value => value === '/tmp/repo' };
  assert.deepEqual(slash.parseSecurityReviewArg('/tmp/repo', fsStub), {
    ok: true, mode: 'blind', target: '/tmp/repo', isLocalPath: true, isUrlOrDomain: false,
  });
  assert.equal(slash.parseSecurityReviewArg('--informed /tmp/repo', fsStub).mode, 'informed');
  assert.equal(slash.parseSecurityReviewArg('/tmp/repo --regression', fsStub).mode, 'regression');
  assert.equal(slash.parseSecurityReviewArg('--blind --informed /tmp/repo', fsStub).ok, false);
});
