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
    const unauthorizedLanding = await request(server.address().port, '/');
    assert.equal(unauthorizedLanding.status, 401);
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

test('VPN-only mode serves updates without per-user application credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-feed-vpn-'));
  const installerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-installers-vpn-'));
  fs.mkdirSync(path.join(root, 'macos', 'arm64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'macos', 'arm64', 'latest-mac.yml'), 'version: 1.2.3\n');
  fs.mkdirSync(path.join(installerRoot, 'macos'), { recursive: true });
  fs.writeFileSync(path.join(installerRoot, 'macos', 'GLaDOS-1.2.3-arm64.dmg'), 'signed-dmg');
  fs.mkdirSync(path.join(installerRoot, 'linux'), { recursive: true });
  fs.writeFileSync(path.join(installerRoot, 'linux', 'GLaDOS-1.2.4-x86_64.AppImage'), 'appimage');
  fs.writeFileSync(path.join(installerRoot, 'linux', 'install-glados-linux.sh'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(installerRoot, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(installerRoot, 'windows', 'GLaDOS-1.2.5-x64.exe'), 'signed-windows-installer');
  fs.writeFileSync(path.join(installerRoot, 'windows', 'install-glados-windows.ps1'), 'Write-Host GLaDOS\n');
  const server = http.createServer(createHandler({
    root,
    installerRoot,
    requireAuth: false,
    trustProxyTls: true,
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await request(server.address().port, '/glados/macos/arm64/latest-mac.yml');
    assert.equal(response.status, 200);
    assert.match(response.body.toString(), /version:/);
    const installer = await request(server.address().port, '/installers/macos/GLaDOS-1.2.3-arm64.dmg');
    assert.equal(installer.status, 200);
    assert.equal(installer.headers['content-type'], 'application/x-apple-diskimage');
    assert.equal(installer.body.toString(), 'signed-dmg');
    const landing = await request(server.address().port, '/');
    assert.equal(landing.status, 200);
    assert.match(landing.headers['content-security-policy'], /default-src 'none'/);
    assert.match(landing.body.toString(), /Download GLaDOS/);
    assert.match(landing.body.toString(), /\/installers\/macos\/GLaDOS-1\.2\.3-arm64\.dmg/);
    assert.match(landing.body.toString(), /\/installers\/linux\/GLaDOS-1\.2\.4-x86_64\.AppImage/);
    assert.match(landing.body.toString(), /\/installers\/linux\/install-glados-linux\.sh/);
    assert.match(landing.body.toString(), /Download easy installer/);
    assert.match(landing.body.toString(), /\/installers\/windows\/GLaDOS-1\.2\.5-x64\.exe/);
    assert.match(landing.body.toString(), /\/installers\/windows\/install-glados-windows\.ps1/);
    const setup = await request(server.address().port, '/installers/linux/install-glados-linux.sh');
    assert.equal(setup.status, 200);
    assert.equal(setup.headers['content-type'], 'text/x-shellscript; charset=utf-8');
    assert.equal(setup.headers['cache-control'], 'private, no-cache');
    const windowsSetup = await request(server.address().port, '/installers/windows/install-glados-windows.ps1');
    assert.equal(windowsSetup.status, 200);
    assert.equal(windowsSetup.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(windowsSetup.headers['cache-control'], 'private, no-cache');
    const traversal = await request(server.address().port, '/installers/%2e%2e/server.cjs');
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(installerRoot, { recursive: true, force: true });
  }
});
