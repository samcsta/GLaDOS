const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const artifactsDir = path.resolve(desktopDir, '..', 'artifacts', 'desktop');
const appDir = path.resolve(process.argv[2] || path.join(artifactsDir, 'win-unpacked'));
const auditPath = path.resolve(process.argv[3] || path.join(artifactsDir, 'native-windows-audit.json'));

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function peMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4096);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < 64 || header.toString('ascii', 0, 2) !== 'MZ') return null;
    const offset = header.readUInt32LE(0x3c);
    if (offset + 6 > read || header.toString('ascii', offset, offset + 4) !== 'PE\0\0') return null;
    return header.readUInt16LE(offset + 4);
  } finally { fs.closeSync(fd); }
}

function main() {
  if (!fs.existsSync(appDir)) throw new Error(`Windows unpacked app not found: ${appDir}`);
  const files = filesUnder(appDir).map(file => ({ file, machine: peMachine(file) }))
    .filter(item => item.machine != null)
    .map(item => ({ path: path.relative(appDir, item.file), machine: `0x${item.machine.toString(16)}` }));
  const failures = files.filter(item => item.machine !== '0x8664');
  const nativeModules = files.filter(item => item.path.endsWith('.node'));
  for (const expected of ['better_sqlite3.node', 'pty.node', 'conpty.node', 'conpty_console_list.node']) {
    if (!nativeModules.some(item => path.basename(item.path).toLowerCase() === expected)) {
      failures.push({ path: expected, reason: 'missing Windows x64 native module' });
    }
  }
  if (!files.some(item => /claude-agent-sdk-win32-x64[\\/]claude\.exe$/i.test(item.path))) {
    failures.push({ path: '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', reason: 'missing SDK launcher' });
  }
  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appDir,
    requiredArchitecture: 'x86_64',
    portableExecutableCount: files.length,
    nativeModuleCount: nativeModules.length,
    passed: failures.length === 0,
    failures,
    files,
  };
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  if (failures.length) throw new Error(`Windows native audit failed; see ${auditPath}`);
  process.stdout.write(`GLADOS_WINDOWS_NATIVE_AUDIT_OK ${files.length} PE files (${nativeModules.length} Node modules)\n`);
}

try { main(); }
catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
