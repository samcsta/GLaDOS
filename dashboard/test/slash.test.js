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
});

test('help includes new workflow commands and security-review disambiguation', () => {
  const text = slash.helpText();
  assert.match(text, /\/goal <target>/);
  assert.match(text, /\/investigate <target>/);
  assert.match(text, /separate from Claude Code CLI skills/);
});

test('local path detection works for security-review routing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-slash-test-'));
  assert.equal(slash.isExistingLocalPath(dir), true);
  assert.equal(slash.isUrlOrDomain('https://example.com'), true);
  assert.equal(slash.isUrlOrDomain('example.com'), true);
});
