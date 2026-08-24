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

test('security-review context modes default to automatic prior matching and are mutually exclusive', () => {
  const fsStub = { existsSync: value => value === '/tmp/repo' || value === '/tmp/repo with spaces' };
  assert.deepEqual(slash.parseSecurityReviewArg('/tmp/repo', fsStub), {
    ok: true, mode: 'auto', maxDurationMinutes: null, singleModel: null, reviewProfile: 'expedited', campaign: false,
    target: '/tmp/repo', isLocalPath: true, isUrlOrDomain: false,
  });
  assert.equal(slash.parseSecurityReviewArg('--informed /tmp/repo', fsStub).mode, 'informed');
  assert.equal(slash.parseSecurityReviewArg('/tmp/repo --regression', fsStub).mode, 'regression');
  assert.equal(slash.parseSecurityReviewArg('--blind --informed /tmp/repo', fsStub).ok, false);
  assert.deepEqual(slash.parseSecurityReviewArg('--blind "/tmp/repo with spaces"', fsStub), {
    ok: true, mode: 'blind', maxDurationMinutes: null, singleModel: null, reviewProfile: 'expedited', campaign: false,
    target: '/tmp/repo with spaces', isLocalPath: true, isUrlOrDomain: false,
  });
  const bounded = slash.parseSecurityReviewArg('--blind --time-limit 2h --single-model gpt-5.6-luna "/tmp/repo with spaces"', fsStub);
  assert.equal(bounded.maxDurationMinutes, 120);
  assert.equal(bounded.singleModel, 'gpt-5.6-luna');
  assert.equal(bounded.target, '/tmp/repo with spaces');
  assert.equal(slash.parseSecurityReviewArg('--time-limit 0m /tmp/repo', fsStub).ok, false);
});

test('security-review defaults to expedited and --full selects the comprehensive workflow', () => {
  const fsStub = { existsSync: value => value === '/tmp/repos' };
  const parsed = slash.parseSecurityReviewArg('--expedited --campaign --time-limit 8h "/tmp/repos"', fsStub);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reviewProfile, 'expedited');
  assert.equal(parsed.campaign, true);
  assert.equal(parsed.maxDurationMinutes, 480);
  assert.equal(parsed.target, '/tmp/repos');
  assert.equal(slash.parseSecurityReviewArg('--campaign /tmp/repos', fsStub).campaign, true);
  assert.equal(slash.parseSecurityReviewArg('--full /tmp/repos', fsStub).reviewProfile, 'comprehensive');
  assert.equal(slash.parseSecurityReviewArg('--full --campaign /tmp/repos', fsStub).ok, false);
  assert.equal(slash.parseSecurityReviewArg('--full --expedited /tmp/repos', fsStub).ok, false);
  assert.equal(slash.parseSecurityReviewArg('--expedited --expedited /tmp/repos', fsStub).ok, false);
  assert.equal(slash.parseSecurityReviewArg('--expedited --campaign --campaign /tmp/repos', fsStub).ok, false);
});
