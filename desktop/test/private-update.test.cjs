const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateFeedUrl } = require('../lib/private-update.cjs');
const { DEFAULT_UPDATE_ORIGIN, platformFeedPath, resolveUpdateAccess } = require('../lib/update-channel.cjs');
const { targetArch } = require('../scripts/rebuild-resources.cjs');

test('private update configuration requires HTTPS and strips a trailing slash', () => {
  assert.equal(validateFeedUrl('https://updates.example.test/glados/'), 'https://updates.example.test/glados');
  assert.throws(() => validateFeedUrl('http://updates.example.test/glados'), /HTTPS/);
  assert.throws(() => validateFeedUrl('https://token@updates.example.test/glados'), /credentials/);
  assert.throws(() => validateFeedUrl('https://updates.example.test/glados?token=nope'), /query string/);
});

test('packaged clients derive the VPN update feed without user configuration', () => {
  assert.equal(platformFeedPath('darwin', 'arm64'), 'macos/arm64');
  assert.equal(platformFeedPath('linux', 'x64'), 'linux/x64');
  assert.equal(platformFeedPath('win32', 'x64'), 'windows/x64');
  assert.throws(() => platformFeedPath('darwin', 'x64'), /does not support/);
  assert.deepEqual(resolveUpdateAccess({ env: {}, platform: 'darwin', arch: 'arm64' }), {
    feedUrl: `${DEFAULT_UPDATE_ORIGIN}/macos/arm64`,
    source: 'built-in',
    requestHeaders: {},
  });
});

test('update feed and optional bearer authentication remain operator-overridable', () => {
  const access = resolveUpdateAccess({
    platform: 'linux',
    arch: 'x64',
    env: {
      GLADOS_UPDATE_FEED_ORIGIN: 'https://staging-updates.example.test/glados/',
      GLADOS_UPDATE_BEARER_TOKEN: 'fixture-update-token-12345',
    },
  });
  assert.equal(access.feedUrl, 'https://staging-updates.example.test/glados/linux/x64');
  assert.equal(access.source, 'environment');
  assert.deepEqual(access.requestHeaders, { Authorization: 'Bearer fixture-update-token-12345' });
});

test('packaged update bridge exposes one guarded apply action and a notification banner', () => {
  const desktopDir = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(desktopDir, 'preload.cjs'), 'utf8');
  const dashboard = fs.readFileSync(path.join(desktopDir, '..', 'dashboard', 'public', 'index.html'), 'utf8');
  assert.match(main, /ipcMain\.handle\('desktop:update:apply'/);
  assert.doesNotMatch(main, /ipcMain\.handle\('desktop:update:(?:download|install)'/);
  assert.match(main, /beforeDownload\.activeAgents/);
  assert.match(main, /beforeInstall\.activeAgents/);
  assert.match(preload, /applyUpdate\(\)/);
  assert.doesNotMatch(preload, /downloadUpdate\(|installUpdate\(/);
  assert.match(dashboard, /id="update-banner"/);
  assert.match(dashboard, />Update GLaDOS</);
});

test('electron-builder architecture enum is passed through to native rebuilds', () => {
  assert.equal(targetArch({ arch: 1 }), 'x64');
  assert.equal(targetArch({ arch: 3 }), 'arm64');
  assert.equal(targetArch({ arch: 'x64' }), 'x64');
});
