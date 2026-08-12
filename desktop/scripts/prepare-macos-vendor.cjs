const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MITMPROXY_VERSION = '12.2.3';
const MITMPROXY_SHA256 = '0a09ee3b82569e8985aff8186e4792618b8e5d0c766098db093d09a87d4b013a';
const MITMPROXY_TEAM_ID = 'S8XHQB96PW';
const MITMPROXY_URL = `https://downloads.mitmproxy.org/${MITMPROXY_VERSION}/mitmproxy-${MITMPROXY_VERSION}-macos-arm64.tar.gz`;

const desktopDir = path.resolve(__dirname, '..');
const vendorDir = path.join(desktopDir, '.vendor');
const archive = path.join(vendorDir, `mitmproxy-${MITMPROXY_VERSION}-macos-arm64.tar.gz`);
const appDir = path.join(vendorDir, 'mitmproxy.app');
const mitmdump = path.join(appDir, 'Contents', 'MacOS', 'mitmdump');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function verifyArchive(file) {
  const actual = sha256(file);
  if (actual !== MITMPROXY_SHA256) {
    throw new Error(`mitmproxy archive checksum mismatch: expected ${MITMPROXY_SHA256}, got ${actual}`);
  }
  const entries = run('/usr/bin/tar', ['-tzf', file]).trim().split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some(name => name.startsWith('/') || name.split('/').includes('..'))) {
    throw new Error('mitmproxy archive contains an unsafe path');
  }
  if (entries.some(name => name !== 'mitmproxy.app' && !name.startsWith('mitmproxy.app/'))) {
    throw new Error('mitmproxy archive contains an unexpected top-level entry');
  }
}

function verifyApp() {
  if (!fs.existsSync(mitmdump)) throw new Error(`bundled mitmdump is missing: ${mitmdump}`);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], { stdio: 'pipe' });
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appDir], { encoding: 'utf8' });
  const signatureText = `${signature.stdout || ''}\n${signature.stderr || ''}`;
  if (signature.status !== 0 || !signatureText.includes(`TeamIdentifier=${MITMPROXY_TEAM_ID}`)) {
    throw new Error(`mitmproxy app is not signed by expected upstream team ${MITMPROXY_TEAM_ID}`);
  }
  const architectures = run('/usr/bin/lipo', ['-archs', mitmdump]).trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== 'arm64') {
    throw new Error(`mitmdump has unexpected architectures: ${architectures.join(', ')}`);
  }
  const version = run(mitmdump, ['--version']);
  if (!version.includes(`Mitmproxy: ${MITMPROXY_VERSION}`)) {
    throw new Error(`mitmdump version check failed: ${version.trim()}`);
  }
}

function prepare() {
  if (process.platform !== 'darwin') {
    process.stdout.write('[prepare-macos-vendor] skipped outside macOS\n');
    return null;
  }
  if (process.arch !== 'arm64') throw new Error('the production macOS vendor bundle must be prepared on Apple Silicon');
  fs.mkdirSync(vendorDir, { recursive: true });

  let appReady = false;
  try {
    verifyApp();
    appReady = true;
  } catch {}
  if (appReady) {
    process.stdout.write(`[prepare-macos-vendor] verified mitmproxy ${MITMPROXY_VERSION} arm64\n`);
    return appDir;
  }

  if (!fs.existsSync(archive) || sha256(archive) !== MITMPROXY_SHA256) {
    const temporary = `${archive}.${process.pid}.download`;
    fs.rmSync(temporary, { force: true });
    try {
      run('/usr/bin/curl', [
        '--fail', '--location', '--proto', '=https', '--tlsv1.2',
        '--output', temporary, MITMPROXY_URL,
      ], { stdio: 'inherit' });
      verifyArchive(temporary);
      fs.renameSync(temporary, archive);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  verifyArchive(archive);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-mitmproxy-stage-'));
  try {
    run('/usr/bin/tar', ['-xzf', archive, '-C', staging]);
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.renameSync(path.join(staging, 'mitmproxy.app'), appDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  verifyApp();
  fs.writeFileSync(path.join(vendorDir, 'mitmproxy.json'), `${JSON.stringify({
    version: MITMPROXY_VERSION,
    url: MITMPROXY_URL,
    sha256: MITMPROXY_SHA256,
    upstreamTeamId: MITMPROXY_TEAM_ID,
  }, null, 2)}\n`);
  process.stdout.write(`[prepare-macos-vendor] prepared mitmproxy ${MITMPROXY_VERSION} arm64\n`);
  return appDir;
}

if (require.main === module) {
  try { prepare(); }
  catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MITMPROXY_SHA256,
  MITMPROXY_TEAM_ID,
  MITMPROXY_URL,
  MITMPROXY_VERSION,
  appDir,
  prepare,
  sha256,
  verifyArchive,
};
