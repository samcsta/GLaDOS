const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const defaultAppDir = path.join(root, 'artifacts', 'desktop', process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
const appDir = path.resolve(process.argv[2] || defaultAppDir);
const executable = path.resolve(process.argv[3] || path.join(appDir, process.platform === 'win32' ? 'GLaDOS.exe' : 'glados'));
const server = path.join(appDir, 'resources', 'dashboard', 'server.js');

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  for (const file of [executable, server]) {
    if (!fs.existsSync(file)) throw new Error(`packaged smoke input is missing: ${file}`);
  }
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-packaged-smoke-'));
  const port = await availablePort();
  let output = '';
  const child = spawn(executable, [server], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GLADOS_PACKAGED_SMOKE: '1',
      GLADOS_BROWSER_MCP: '0',
      GLADOS_RUNTIME_DIR: runtimeDir,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = chunk => { output = `${output}${chunk}`.slice(-16000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    const deadline = Date.now() + 30_000;
    let health = null;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`packaged dashboard exited with ${child.exitCode}\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
        if (response.ok) health = await response.json();
      } catch {}
      if (health?.ok === true) break;
      await wait(250);
    }
    if (health?.ok !== true) throw new Error(`packaged dashboard did not become healthy\n${output}`);
    process.stdout.write(`GLADOS_PACKAGED_DASHBOARD_SMOKE_OK ${process.platform}/${process.arch}\n`);
  } finally {
    if (child.exitCode == null) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        try { child.kill(); } catch { clearTimeout(timeout); resolve(); }
      });
    }
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
