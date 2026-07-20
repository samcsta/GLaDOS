const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const artifactsDir = path.resolve(desktopDir, '..', 'artifacts', 'desktop');
const appDir = path.resolve(process.argv[2] || path.join(artifactsDir, 'linux-unpacked'));
const auditPath = path.resolve(process.argv[3] || path.join(artifactsDir, 'native-linux-audit.json'));

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function isElf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    return fs.readSync(fd, bytes, 0, 4, 0) === 4 && bytes.toString('hex') === '7f454c46';
  } finally { fs.closeSync(fd); }
}

function main() {
  if (!fs.existsSync(appDir)) throw new Error(`Linux unpacked app not found: ${appDir}`);
  const files = filesUnder(appDir).filter(isElf).map(file => ({
    path: path.relative(appDir, file),
    description: execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' }).trim(),
  }));
  const failures = files.filter(item => !/x86-64|x86_64/i.test(item.description));
  const nodeModules = files.filter(item => item.path.endsWith('.node'));
  for (const expected of ['better_sqlite3.node', 'pty.node']) {
    if (!nodeModules.some(item => path.basename(item.path) === expected)) failures.push({ path: expected, reason: 'missing native module' });
  }
  if (!files.some(item => /claude-agent-sdk-linux-x64(?:-musl)?\/claude$/.test(item.path))) {
    failures.push({ path: '@anthropic-ai/claude-agent-sdk-linux-x64/claude', reason: 'missing SDK launcher' });
  }
  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appDir,
    requiredArchitecture: 'x86_64',
    nativeFileCount: files.length,
    nativeModuleCount: nodeModules.length,
    passed: failures.length === 0,
    failures,
    files,
  };
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  if (failures.length) throw new Error(`Linux native audit failed; see ${auditPath}`);
  process.stdout.write(`GLADOS_LINUX_NATIVE_AUDIT_OK ${files.length} ELF files (${nodeModules.length} Node modules)\n`);
}

try { main(); }
catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
