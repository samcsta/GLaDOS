const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');

test('openclaw compatibility harness is valid bash', () => {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'openclaw-compat.sh');
  const result = cp.spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
