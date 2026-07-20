const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('web validator contract reserves validated for confirmed vulnerabilities', () => {
  const runbook = fs.readFileSync(
    path.resolve(__dirname, '../../templates/agents/default/webapp-validator/RUNBOOK.md'),
    'utf8'
  );
  assert.match(runbook, /`validated` only for a confirmed vulnerability/);
  assert.match(runbook, /`rejected` for a negative\/control result/);
  assert.match(runbook, /Negative\/control findings must never be marked `validated`/);
});
