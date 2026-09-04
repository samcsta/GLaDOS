const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const root = path.resolve(desktopDir, '..');
const artifacts = path.join(root, 'artifacts', 'desktop');
const version = require(path.join(desktopDir, 'package.json')).version;

function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function assertAuthenticode(file) {
  const escaped = file.replaceAll("'", "''");
  const script = `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($signature.Status -ne 'Valid') { Write-Error \"Authenticode status: $($signature.Status) $($signature.StatusMessage)\"; exit 1 }`;
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
}

function main() {
  if (process.platform !== 'win32') throw new Error('Windows releases must be built on Windows x64');
  if (process.arch !== 'x64') throw new Error(`Windows releases require x64; detected ${process.arch}`);
  const rootVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (rootVersion !== `v${version}`) throw new Error(`VERSION (${rootVersion}) does not match desktop package (v${version})`);
  if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
    throw new Error('CSC_LINK and CSC_KEY_PASSWORD are required for an Authenticode-signed Windows release');
  }
  run('npm.cmd', ['test', '--prefix', 'desktop']);
  run('npm.cmd', ['test', '--prefix', 'dashboard']);
  run('npm.cmd', ['test', '--prefix', 'services/private-update-feed']);
  run('npm.cmd', ['run', 'dist:windows', '--prefix', 'desktop', '--', '-c.forceCodeSigning=true']);
  run('node.exe', ['desktop/scripts/verify-native-windows.cjs']);
  const installer = path.join(artifacts, `GLaDOS-${version}-x64.exe`);
  const blockmap = `${installer}.blockmap`;
  const metadata = path.join(artifacts, 'latest.yml');
  const appExecutable = path.join(artifacts, 'win-unpacked', 'GLaDOS.exe');
  for (const file of [installer, blockmap, metadata, appExecutable]) {
    if (!fs.existsSync(file)) throw new Error(`missing Windows release output: ${file}`);
  }
  assertAuthenticode(installer);
  assertAuthenticode(appExecutable);
  run('node.exe', ['desktop/scripts/smoke-packaged-dashboard.cjs']);
  process.stdout.write(`GLADOS_WINDOWS_RELEASE_OK ${installer}\n`);
}

try { main(); }
catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
