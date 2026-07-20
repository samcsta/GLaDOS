const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const distDir = path.resolve(desktopDir, '..', 'artifacts', 'desktop');
const requested = process.argv[2] ? path.resolve(process.argv[2]) : null;
const requestedExecutable = requested && requested.endsWith('.app')
  ? path.join(requested, 'Contents', 'MacOS', 'GLaDOS')
  : requested;
const candidates = [
  requestedExecutable,
  path.join(distDir, 'mac-arm64', 'GLaDOS.app', 'Contents', 'MacOS', 'GLaDOS'),
  path.join(distDir, 'mac', 'GLaDOS.app', 'Contents', 'MacOS', 'GLaDOS'),
  path.join(distDir, 'mac-universal', 'GLaDOS.app', 'Contents', 'MacOS', 'GLaDOS'),
].filter(Boolean);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function runSmoke(executable, architecture = null, label = architecture || process.arch) {
  const proxyPort = await freePort();
  const command = architecture ? '/usr/bin/arch' : executable;
  const args = architecture ? [`-${architecture}`, executable] : [];
  const child = spawn(command, args, {
    cwd: desktopDir,
    env: {
      ...process.env,
      GLADOS_PACKAGED_SMOKE: '1',
      GLADOS_MITM_LISTEN_PORT: String(proxyPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });

  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged GLaDOS smoke test timed out.'));
    }, 45000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', exitCode => { clearTimeout(timeout); resolve(exitCode); });
  });
  if (code !== 0 || !output.includes('GLADOS_PACKAGED_SMOKE_OK')) {
    throw new Error(`Packaged GLaDOS smoke test failed (exit ${code}).`);
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  if (await portIsOpen(proxyPort)) {
    throw new Error(`Packaged GLaDOS left its proxy listening on ${proxyPort} after shutdown.`);
  }
  process.stdout.write(`GLADOS_PACKAGED_PROXY_STOP_OK ${label} ${proxyPort}\n`);
}

async function main() {
  const executable = candidates.find(fs.existsSync);
  if (!executable) throw new Error('No packaged GLaDOS.app was found. Run npm run pack first.');
  const archs = process.platform === 'darwin'
    ? require('node:child_process').execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/)
    : [process.arch];
  await runSmoke(executable, null, archs.length > 1 ? process.arch : archs[0]);
  if (process.arch === 'arm64' && archs.includes('x86_64') && archs.includes('arm64')) {
    const probe = require('node:child_process').spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']);
    if (probe.status !== 0) throw new Error('Rosetta is required to smoke-test the universal x86_64 slice on Apple Silicon');
    await runSmoke(executable, 'x86_64');
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
