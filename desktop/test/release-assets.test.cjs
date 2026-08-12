const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const desktopDir = path.resolve(__dirname, '..');
const root = path.resolve(desktopDir, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const vendor = require('../scripts/prepare-macos-vendor.cjs');

test('macOS release pins and packages the official arm64 mitmproxy runtime', () => {
  assert.equal(vendor.MITMPROXY_VERSION, '12.2.3');
  assert.equal(vendor.MITMPROXY_SHA256, '0a09ee3b82569e8985aff8186e4792618b8e5d0c766098db093d09a87d4b013a');
  assert.equal(vendor.MITMPROXY_TEAM_ID, 'S8XHQB96PW');
  assert.match(vendor.MITMPROXY_URL, /^https:\/\/downloads\.mitmproxy\.org\//);
  assert.ok(pkg.build.mac.extraResources.some(item => item.to === 'vendor/mitmproxy.app'));
  assert.ok(pkg.build.mac.extraResources.some(item => item.to === 'vendor/mitmproxy-LICENSE.txt'));
  assert.ok(fs.existsSync(path.join(root, 'third_party', 'mitmproxy-LICENSE.txt')));
});

test('clean-machine packaged verification cannot fall back to Homebrew mitmdump', () => {
  const main = fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8');
  const verifier = fs.readFileSync(path.join(desktopDir, 'scripts', 'verify-packaged.cjs'), 'utf8');
  assert.match(main, /GLADOS_DESKTOP_RESOURCES: root/);
  assert.match(verifier, /GLADOS_PROXY_REQUIRE_BUNDLED: '1'/);
  assert.match(verifier, /delete cleanEnvironment\.GLADOS_MITMPROXY_BIN/);
  assert.match(verifier, /PATH: '\/usr\/bin:\/bin:\/usr\/sbin:\/sbin'/);
});

test('DMG contains a native uninstaller app instead of a quarantined command script', () => {
  const entries = pkg.build.dmg.contents.filter(item => item.type === 'file').map(item => item.path).filter(Boolean);
  assert.ok(entries.includes('.release-tools/Uninstall GLaDOS.app'));
  assert.equal(entries.some(item => item.endsWith('.command')), false);
  const swift = fs.readFileSync(path.join(desktopDir, 'uninstaller', 'main.swift'), 'utf8');
  assert.match(swift, /checkboxWithTitle/);
  assert.match(swift, /--purge-data/);
  assert.match(swift, /--dry-run/);
  assert.match(swift, /\/Applications/);
});

test('release notarizes and validates the uninstaller independently and from the mounted DMG', () => {
  const release = fs.readFileSync(path.join(desktopDir, 'scripts', 'release-macos.cjs'), 'utf8');
  assert.match(release, /notarize\(\{ appPath: uninstallerApp/);
  assert.match(release, /mountedUninstallerExecutable/);
  assert.match(release, /stapler', 'validate', mountedUninstaller/);
  assert.match(release, /Uninstall GLaDOS\.command/);
});

test('local installer can deploy the exact signed release and refresh app discovery metadata', () => {
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-desktop-app.sh'), 'utf8');
  assert.match(installer, /GLADOS_APP_SOURCE/);
  assert.match(installer, /verify-packaged\.cjs/);
  assert.match(installer, /LSREGISTER.*-u/s);
  assert.match(installer, /LSREGISTER.*-f/s);
  assert.match(installer, /LSREGISTER.*-gc/s);
  assert.match(installer, /MDIMPORT.*-i/s);
  assert.match(installer, /GLaDOS\.app\.replaced-/);
  assert.doesNotMatch(installer, /rm -rf "\$DEST"/);
});
