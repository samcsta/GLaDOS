const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dashboardDir = path.resolve(__dirname, '..', '..', 'dashboard');
const sdkDir = path.join(dashboardDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

function lipoArchitectures(file) {
  return execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/).sort();
}

function sdkVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8'));
  return pkg.version;
}

function lockedIntegrity(packageName, version) {
  const lock = JSON.parse(fs.readFileSync(path.join(dashboardDir, 'package-lock.json'), 'utf8'));
  const row = lock.packages?.[`node_modules/@anthropic-ai/${packageName}`];
  if (!row || row.version !== version || !row.integrity) {
    throw new Error(`lockfile is missing @anthropic-ai/${packageName}@${version} integrity`);
  }
  return row.integrity;
}

function ensurePackage(packageName, version) {
  const packageDir = path.join(dashboardDir, 'node_modules', '@anthropic-ai', packageName);
  const packageJson = path.join(packageDir, 'package.json');
  try {
    if (fs.existsSync(path.join(packageDir, 'claude')) && JSON.parse(fs.readFileSync(packageJson, 'utf8')).version === version) {
      return packageDir;
    }
  } catch {}

  // Installing a CPU-specific optional package in the dashboard root makes npm
  // re-resolve the entire dependency tree for the host. Fetch and extract only
  // the exact locked package so universal preparation cannot silently upgrade
  // the SDK or any unrelated dependency.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-sdk-package-'));
  try {
    const spec = `@anthropic-ai/${packageName}@${version}`;
    const output = execFileSync('npm', ['pack', spec, '--pack-destination', staging], {
      cwd: dashboardDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!output) throw new Error(`npm pack did not return an archive for ${spec}`);
    const archive = path.join(staging, output);
    const actualIntegrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
    const expectedIntegrity = lockedIntegrity(packageName, version);
    if (actualIntegrity !== expectedIntegrity) throw new Error(`integrity mismatch for ${spec}`);
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging]);
    fs.rmSync(packageDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(packageDir), { recursive: true });
    fs.renameSync(path.join(staging, 'package'), packageDir);
    return packageDir;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform !== 'darwin') throw new Error('universal resource preparation requires macOS');
  const version = sdkVersion();
  const armDir = ensurePackage('claude-agent-sdk-darwin-arm64', version);
  const x64Dir = ensurePackage('claude-agent-sdk-darwin-x64', version);
  const armArchitectures = lipoArchitectures(path.join(armDir, 'claude'));
  const x64Architectures = lipoArchitectures(path.join(x64Dir, 'claude'));
  if (!armArchitectures.includes('arm64')) throw new Error('Claude CLI arm64 package is missing its arm64 slice');
  if (!x64Architectures.includes('x86_64')) throw new Error('Claude CLI x64 package is missing its x86_64 slice');
  process.stdout.write(`[prepare-universal-resources] Claude CLI ${version}: architecture-qualified arm64 + x86_64 helpers verified\n`);
}

if (require.main === module) main();

module.exports = { lipoArchitectures };
