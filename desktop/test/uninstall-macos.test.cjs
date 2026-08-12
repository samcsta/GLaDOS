const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const uninstaller = path.join(root, 'scripts', 'uninstall-desktop-app.sh');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-uninstall-test-'));
  const home = path.join(base, 'home');
  const installRoot = path.join(base, 'Applications');
  const app = path.join(installRoot, 'GLaDOS.app');
  const runtime = path.join(home, '.glados');
  const metadataLog = path.join(base, 'metadata.log');
  const lsregister = path.join(base, 'lsregister');
  const mdimport = path.join(base, 'mdimport');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'operator-data.txt'), 'preserve me');
  for (const executable of [lsregister, mdimport]) {
    fs.writeFileSync(executable, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$GLADOS_METADATA_LOG"\n', { mode: 0o755 });
  }
  return { base, home, installRoot, app, runtime, metadataLog, lsregister, mdimport };
}

function runUninstaller(paths, args) {
  return spawnSync('bash', [uninstaller, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: paths.home,
      GLADOS_INSTALL_ROOT: paths.installRoot,
      GLADOS_RUNTIME_DIR: paths.runtime,
      GLADOS_UNINSTALL_SKIP_PROCESS_STOP: '1',
      GLADOS_UNINSTALL_SKIP_SECURITY: '1',
      GLADOS_LSREGISTER: paths.lsregister,
      GLADOS_MDIMPORT: paths.mdimport,
      GLADOS_METADATA_LOG: paths.metadataLog,
    },
  });
}

test('default macOS uninstall trashes only the app and preserves operator data', t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  const result = runUninstaller(paths, ['--yes']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(paths.app), false);
  assert.equal(fs.readFileSync(path.join(paths.runtime, 'operator-data.txt'), 'utf8'), 'preserve me');
  const trash = fs.readdirSync(path.join(paths.home, '.Trash'));
  assert.equal(trash.some(name => name.startsWith('GLaDOS.app.uninstalled-')), true);
  assert.match(result.stdout, /Operator data remains at/);
  assert.match(result.stdout, /refreshed Spotlight metadata/);
  const metadata = fs.readFileSync(paths.metadataLog, 'utf8');
  assert.match(metadata, new RegExp(`-u ${paths.app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(metadata, /-u .*GLaDOS\.app\.uninstalled-/);
  assert.match(metadata, /-gc/);
  assert.match(metadata, new RegExp(`-i ${paths.installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('purge mode trashes app and operator data without targeting toolchains', t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  const preferences = path.join(paths.home, 'Library', 'Preferences', 'com.glados.ops.plist');
  fs.mkdirSync(path.dirname(preferences), { recursive: true });
  fs.writeFileSync(preferences, 'test');
  const result = runUninstaller(paths, ['--purge-data', '--yes']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(paths.app), false);
  assert.equal(fs.existsSync(paths.runtime), false);
  assert.equal(fs.existsSync(preferences), false);
  const trash = fs.readdirSync(path.join(paths.home, '.Trash'));
  assert.equal(trash.some(name => name.startsWith('GLaDOS-operator-data.uninstalled-')), true);
  assert.equal(trash.some(name => name.startsWith('com.glados.ops-preferences.plist.uninstalled-')), true);
  assert.match(result.stdout, /preserve Homebrew, Node, mitmproxy, and red-team tools/);
});

test('dry run reports purge scope without changing files', t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  const result = runUninstaller(paths, ['--purge-data', '--dry-run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(paths.app), true);
  assert.equal(fs.existsSync(paths.runtime), true);
  assert.match(result.stdout, /Dry run only; nothing was changed/);
});

test('uninstaller refuses broad installation and runtime targets', t => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  const unsafeInstall = runUninstaller({ ...paths, installRoot: '/' }, ['--yes']);
  assert.notEqual(unsafeInstall.status, 0);
  assert.match(unsafeInstall.stderr, /INSTALL_ROOT/);
  const unsafeRuntime = runUninstaller({ ...paths, runtime: paths.home }, ['--purge-data', '--yes']);
  assert.notEqual(unsafeRuntime.status, 0);
  assert.match(unsafeRuntime.stderr, /unsafe runtime target/);
});
