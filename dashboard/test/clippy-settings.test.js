const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  secretPath,
  loadClippyToken,
  saveClippyToken,
  removeClippyToken,
  probeClippyConnection,
} = require('../lib/secrets/clippy-mcp');

test('Clippy credential stays owner-only, can be replaced, and can be removed', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-clippy-settings-'));
  const env = { GLADOS_RUNTIME_DIR: runtime };
  try {
    assert.throws(() => saveClippyToken('bad\ntoken', env), /valid Clippy/);
    saveClippyToken('Bearer first-secret', env);
    assert.equal(loadClippyToken(env), 'first-secret');
    assert.equal(fs.statSync(secretPath(env)).mode & 0o077, 0);
    assert.equal(fs.statSync(path.dirname(secretPath(env))).mode & 0o077, 0);
    saveClippyToken('second-secret', env);
    assert.equal(loadClippyToken(env), 'second-secret');
    assert.equal(removeClippyToken(env), true);
    assert.equal(loadClippyToken(env), null);
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
});

test('Clippy connection probe checks the MCP tool catalog without returning a bearer', async () => {
  let authorization = '';
  const result = await probeClippyConnection('Bearer test-secret', {
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return {
        ok: true,
        headers: { get: () => 'text/event-stream' },
        text: async () => 'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search"},{"name":"read"}]}}\r\n\r\n',
      };
    },
  });
  assert.equal(authorization, 'Bearer test-secret');
  assert.deepEqual(result, { connected: true, toolCount: 2 });
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
