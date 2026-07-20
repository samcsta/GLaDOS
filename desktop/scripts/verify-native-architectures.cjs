const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const artifactsDir = path.resolve(desktopDir, '..', 'artifacts', 'desktop');
const defaultApp = path.join(artifactsDir, 'mac-arm64', 'GLaDOS.app');
const appPath = path.resolve(process.argv[2] || defaultApp);
const auditPath = path.resolve(process.argv[3] || path.join(artifactsDir, 'native-architecture-audit.json'));
const MACHO_MAGICS = new Set(['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']);

function filesUnder(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(file));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}

function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (fs.readSync(fd, bytes, 0, 4, 0) !== 4) return false;
    return MACHO_MAGICS.has(bytes.toString('hex'));
  } finally { fs.closeSync(fd); }
}

function architectures(file) {
  return execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/).sort();
}

function signatureStatus(file) {
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', file], { encoding: 'utf8' });
  return { valid: result.status === 0, detail: String(result.stderr || result.stdout || '').trim() };
}

function main() {
  if (!fs.existsSync(appPath)) throw new Error(`application not found: ${appPath}`);
  const mainExecutable = path.join(appPath, 'Contents', 'MacOS', 'GLaDOS');
  if (!fs.existsSync(mainExecutable)) throw new Error(`main executable not found: ${mainExecutable}`);
  const appArchitectures = architectures(mainExecutable);
  if (!appArchitectures.length || appArchitectures.some(arch => !['arm64', 'x86_64'].includes(arch))) {
    throw new Error(`unsupported application architecture set: ${appArchitectures.join(', ')}`);
  }
  const nativeFiles = filesUnder(appPath).filter(isMachO).map(file => ({
    path: path.relative(appPath, file),
    architectures: architectures(file),
  }));
  const requiredFor = item => {
    if (/claude-agent-sdk-darwin-arm64\/claude$/.test(item.path)) return ['arm64'];
    if (/claude-agent-sdk-darwin-x64\/claude$/.test(item.path)) return ['x86_64'];
    return appArchitectures;
  };
  for (const item of nativeFiles) item.requiredArchitectures = requiredFor(item);
  const failures = nativeFiles.filter(item => item.requiredArchitectures.some(arch => !item.architectures.includes(arch)));
  const nodeModules = nativeFiles.filter(item => item.path.endsWith('.node'));
  const expectedModules = ['better_sqlite3.node', 'pty.node'];
  for (const expected of expectedModules) {
    if (!nodeModules.some(item => path.basename(item.path) === expected)) {
      failures.push({ path: expected, architectures: [], reason: 'expected native module is missing' });
    }
  }
  const claudeClis = nativeFiles.filter(item => /claude-agent-sdk-darwin-(?:arm64|x64)\/claude$/.test(item.path));
  const expectedCliPackages = appArchitectures.map(arch => `claude-agent-sdk-darwin-${arch === 'x86_64' ? 'x64' : arch}/claude`);
  for (const expected of expectedCliPackages) {
    if (!claudeClis.some(item => item.path.endsWith(expected))) {
      failures.push({ path: `@anthropic-ai/${expected}`, architectures: [], reason: 'expected SDK launcher is missing' });
    }
  }
  for (const item of claudeClis) {
    const packageArch = item.path.includes('darwin-arm64') ? 'arm64' : 'x86_64';
    if (!appArchitectures.includes(packageArch)) {
      failures.push({ path: item.path, architectures: item.architectures, reason: `unexpected ${packageArch} SDK launcher in ${appArchitectures.join('+')} app` });
    }
  }
  const signature = signatureStatus(appPath);
  if (process.env.GLADOS_REQUIRE_SIGNED === '1' && !signature.valid) {
    failures.push({ path: '.', architectures: [], reason: `code signature failed: ${signature.detail}` });
  }
  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appPath,
    requiredArchitectures: appArchitectures,
    nativeFileCount: nativeFiles.length,
    nativeModuleCount: nodeModules.length,
    signature,
    passed: failures.length === 0,
    failures,
    files: nativeFiles,
  };
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  if (failures.length) throw new Error(`native architecture audit failed for ${failures.length} file(s); see ${auditPath}`);
  process.stdout.write(`GLADOS_NATIVE_AUDIT_OK ${nativeFiles.length} Mach-O files (${nodeModules.length} Node modules)\n`);
  process.stdout.write(`GLADOS_NATIVE_AUDIT_REPORT ${auditPath}\n`);
  if (!signature.valid) process.stdout.write('GLADOS_NATIVE_AUDIT_UNSIGNED development artifact is not releasable\n');
}

try { main(); }
catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
