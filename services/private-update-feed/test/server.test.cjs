const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHandler, tokenHash } = require('../server.cjs');

function request(port, pathname, { token, range, forwardedHttps = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (forwardedHttps) headers['x-forwarded-proto'] = 'https';
    if (token) headers.authorization = `Bearer ${token}`;
    if (range) headers.range = range;
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

test('feed requires bearer auth and supports updater range requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-feed-'));
  const fixtureCredential = ['glados', 'update', 'fixture', 'long-enough'].join('-');
  fs.mkdirSync(path.join(root, 'macos', 'arm64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'macos', 'arm64', 'GLaDOS.zip'), '0123456789');
  const server = http.createServer(createHandler({
    root,
    tokenHashes: tokenHash(fixtureCredential),
    trustProxyTls: true,
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const plaintext = await request(server.address().port, '/healthz', { forwardedHttps: false });
    assert.equal(plaintext.status, 426);
    const unauthorized = await request(server.address().port, '/glados/macos/arm64/GLaDOS.zip');
    assert.equal(unauthorized.status, 401);
    const partial = await request(server.address().port, '/glados/macos/arm64/GLaDOS.zip', { token: fixtureCredential, range: 'bytes=2-5' });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
    assert.equal(partial.body.toString(), '2345');
    const traversal = await request(server.address().port, '/glados/%2e%2e/package.json', { token: fixtureCredential });
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
