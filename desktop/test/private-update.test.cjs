const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateFeedUrl } = require('../lib/private-update.cjs');
const {
  DEFAULT_UPDATE_ORIGIN, WINDOWS_SOURCE_URL, binaryUpdatesSupported, platformFeedPath, resolveUpdateAccess,
} = require('../lib/update-channel.cjs');
const {
  captureRuntimePayload, installRuntimePayload, nativeModuleKey,
  pruneNodePtyWindowsArchitectures, targetArch,
} = require('../scripts/rebuild-resources.cjs');

test('private update configuration requires HTTPS and strips a trailing slash', () => {
  assert.equal(validateFeedUrl('https://updates.example.test/glados/'), 'https://updates.example.test/glados');
  assert.throws(() => validateFeedUrl('http://updates.example.test/glados'), /HTTPS/);
  assert.throws(() => validateFeedUrl('https://token@updates.example.test/glados'), /credentials/);
  assert.throws(() => validateFeedUrl('https://updates.example.test/glados?token=nope'), /query string/);
});

test('maintained binary platforms derive the VPN update feed without user configuration', () => {
  assert.equal(platformFeedPath('darwin', 'arm64'), 'macos/arm64');
  assert.equal(platformFeedPath('linux', 'x64'), 'linux/x64');
  assert.equal(binaryUpdatesSupported('darwin', 'arm64'), true);
  assert.equal(binaryUpdatesSupported('linux', 'x64'), true);
  assert.equal(binaryUpdatesSupported('win32', 'x64'), false);
  assert.equal(WINDOWS_SOURCE_URL, 'https://github.com/samcsta/GLaDOS');
  assert.throws(() => platformFeedPath('win32', 'x64'), /built from source/);
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
  const ubuntuInstaller = fs.readFileSync(path.join(desktopDir, '..', 'scripts', 'install-desktop-app-ubuntu.sh'), 'utf8');
  const linuxInstaller = fs.readFileSync(path.join(desktopDir, '..', 'scripts', 'install-glados-linux-online.sh'), 'utf8');
  const windowsInstaller = fs.readFileSync(path.join(desktopDir, '..', 'scripts', 'install-glados-windows.ps1'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  assert.match(main, /ipcMain\.handle\('desktop:update:apply'/);
  assert.doesNotMatch(main, /NsisUpdater/);
  assert.match(main, /!binaryUpdatesSupported\(\)/);
  assert.doesNotMatch(main, /ipcMain\.handle\('desktop:update:(?:download|install)'/);
  assert.match(main, /beforeDownload\.activeAgents/);
  assert.match(main, /beforeInstall\.activeAgents/);
  assert.match(preload, /applyUpdate\(\)/);
  assert.doesNotMatch(preload, /downloadUpdate\(|installUpdate\(/);
  assert.match(dashboard, /id="update-banner"/);
  assert.match(dashboard, />Update GLaDOS</);
  const dashboardApp = fs.readFileSync(path.join(desktopDir, '..', 'dashboard', 'public', 'app.js'), 'utf8');
  assert.match(dashboardApp, /View source releases/);
  assert.match(dashboardApp, /window\.open\(status\.sourceUrl/);
  assert.match(ubuntuInstaller, /stat -Lc '%d:%i:%s:%Y'/);
  assert.match(ubuntuInstaller, /restarted_after_update/);
  assert.match(linuxInstaller, /debian|ubuntu|kali/i);
  assert.match(linuxInstaller, /fedora/i);
  assert.match(linuxInstaller, /sha512/i);
  assert.match(windowsInstaller, /Windows binaries are not distributed/);
  assert.match(windowsInstaller, /github\.com\/samcsta\/GLaDOS/);
  assert.match(windowsInstaller, /pack:windows/);
  assert.match(windowsInstaller, /PIPX_BIN_DIR/);
  assert.match(windowsInstaller, /mitmdump\.exe was not found after installation/);
  const windowsRelease = fs.readFileSync(path.join(desktopDir, 'scripts', 'release-windows.cjs'), 'utf8');
  assert.match(windowsRelease, /Get-AuthenticodeSignature/);
  assert.match(windowsRelease, /smoke-packaged-dashboard\.cjs/);
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.deepEqual(pkg.build.win.target, ['nsis']);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
});

test('electron-builder architecture enum is passed through to native rebuilds', () => {
  assert.equal(targetArch({ arch: 1 }), 'x64');
  assert.equal(targetArch({ arch: 3 }), 'arm64');
  assert.equal(targetArch({ arch: 'x64' }), 'x64');
});

test('Windows x64 packaging removes ARM64 node-pty conpty helpers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-node-pty-arch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const versionDir = path.join(root, 'third_party', 'conpty', 'fixture-version');
  for (const arch of ['x64', 'arm64']) {
    const dir = path.join(versionDir, `win10-${arch}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'OpenConsole.exe'), arch);
    fs.writeFileSync(path.join(dir, 'conpty.dll'), arch);
  }
  pruneNodePtyWindowsArchitectures(root, 'x64');
  assert.equal(fs.existsSync(path.join(versionDir, 'win10-x64', 'OpenConsole.exe')), true);
  assert.equal(fs.existsSync(path.join(versionDir, 'win10-arm64')), false);
});

test('identical native modules reuse one rebuilt Electron runtime payload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-native-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  for (const directory of [source, target]) {
    const moduleDir = path.join(directory, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(path.join(moduleDir, 'build', 'Release'), { recursive: true });
    fs.mkdirSync(path.join(moduleDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"name":"better-sqlite3","version":"12.11.1"}\n');
  }
  const rebuilt = path.join(source, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  fs.writeFileSync(rebuilt, Buffer.from('electron-native-payload'), { mode: 0o755 });
  assert.equal(nativeModuleKey(source, 'better-sqlite3'), nativeModuleKey(target, 'better-sqlite3'));
  installRuntimePayload(target, 'better-sqlite3', captureRuntimePayload(source, 'better-sqlite3', 'linux'), 'linux');
  const installed = path.join(target, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  assert.equal(fs.readFileSync(installed, 'utf8'), 'electron-native-payload');
  assert.equal(fs.existsSync(path.join(target, 'node_modules', 'better-sqlite3', 'bin')), false);
});
