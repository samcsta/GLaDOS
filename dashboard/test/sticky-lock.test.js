const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('normal investigate mentions no longer use the sticky target-request lock', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /pendingGladosTargetRequest/);
  assert.doesNotMatch(server, /Ready\. The local ROE, operator context, and local secret profiles/);
});
