const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const root = path.resolve(desktopDir, '..');
const source = path.join(desktopDir, 'uninstaller', 'main.swift');
const plistTemplate = path.join(desktopDir, 'uninstaller', 'Info.plist');
const icon = path.join(desktopDir, 'build', 'icon.icns');
const outputRoot = path.join(desktopDir, '.release-tools');
const appDir = path.join(outputRoot, 'Uninstall GLaDOS.app');
const executable = path.join(appDir, 'Contents', 'MacOS', 'Uninstall GLaDOS');
const resources = path.join(appDir, 'Contents', 'Resources');
const metadataFile = path.join(outputRoot, 'uninstaller-build.json');

function sha256Parts(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function signingIdentity() {
  const requested = String(process.env.GLADOS_UNINSTALLER_SIGN_IDENTITY || process.env.CSC_NAME || '').trim();
  if (requested) return requested;
  if (process.env.GLADOS_RELEASE_BUILD === '1') {
    throw new Error('release builds require CSC_NAME or GLADOS_UNINSTALLER_SIGN_IDENTITY for the uninstaller app');
  }
  return '-';
}

function validExisting(expected) {
  try {
    const actual = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], { stdio: 'pipe' });
    return fs.existsSync(executable);
  } catch {
    return false;
  }
}

function prepare() {
  if (process.platform !== 'darwin') {
    process.stdout.write('[prepare-uninstaller-app] skipped outside macOS\n');
    return null;
  }
  if (process.arch !== 'arm64') throw new Error('the production uninstaller must be built on Apple Silicon');
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const identity = signingIdentity();
  const expected = {
    schemaVersion: 1,
    version: pkg.version,
    sourceSha256: sha256Parts([source, plistTemplate, icon]),
    signingIdentity: identity,
  };
  if (validExisting(expected)) {
    process.stdout.write(`[prepare-uninstaller-app] verified ${appDir}\n`);
    return appDir;
  }

  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  execFileSync('/usr/bin/xcrun', [
    'swiftc', '-O', '-target', 'arm64-apple-macos12.0',
    '-framework', 'AppKit', source, '-o', executable,
  ], { cwd: root, stdio: 'inherit' });
  fs.chmodSync(executable, 0o755);
  fs.copyFileSync(icon, path.join(resources, 'icon.icns'));
  const plist = fs.readFileSync(plistTemplate, 'utf8').replaceAll('__VERSION__', pkg.version);
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), plist);

  const signArgs = ['--force', '--sign', identity];
  if (identity !== '-') signArgs.push('--timestamp', '--options', 'runtime');
  signArgs.push(appDir);
  execFileSync('/usr/bin/codesign', signArgs, { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], { stdio: 'inherit' });
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appDir], { encoding: 'utf8' });
  const signatureText = `${signature.stdout || ''}\n${signature.stderr || ''}`;
  if (identity !== '-' && !signatureText.includes('Authority=Developer ID Application:')) {
    throw new Error('the uninstaller app was not signed with a Developer ID Application certificate');
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(metadataFile, `${JSON.stringify(expected, null, 2)}\n`);
  process.stdout.write(`[prepare-uninstaller-app] built ${appDir}\n`);
  return appDir;
}

if (require.main === module) {
  try { prepare(); }
  catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { appDir, prepare, signingIdentity };
