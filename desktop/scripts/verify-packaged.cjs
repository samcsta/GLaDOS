const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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

function packagedResources(executable) {
  return path.resolve(path.dirname(executable), '..', 'Resources');
}

function verifyBundledMitmproxy(executable) {
  const resources = packagedResources(executable);
  const appBundle = path.join(resources, 'vendor', 'mitmproxy.app');
  const binary = path.join(appBundle, 'Contents', 'MacOS', 'mitmdump');
  const license = path.join(resources, 'vendor', 'mitmproxy-LICENSE.txt');
  if (!fs.existsSync(binary)) throw new Error(`Packaged mitmdump is missing: ${binary}`);
  if (!fs.existsSync(license)) throw new Error(`Packaged mitmproxy license is missing: ${license}`);
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (version.status !== 0 || !String(version.stdout || '').includes('Mitmproxy: 12.2.3')) {
    throw new Error(`Packaged mitmdump version check failed.\n${version.stdout || ''}${version.stderr || ''}`);
  }
  if (process.platform === 'darwin') {
    const architecture = spawnSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' });
    if (architecture.status !== 0 || architecture.stdout.trim() !== 'arm64') {
      throw new Error(`Packaged mitmdump is not arm64-only: ${architecture.stdout || architecture.stderr}`);
    }
    const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], { encoding: 'utf8' });
    if (signature.status !== 0) throw new Error(`Packaged mitmproxy signature check failed.\n${signature.stderr || ''}`);
  }
  process.stdout.write('GLADOS_PACKAGED_MITMPROXY_OK 12.2.3 arm64\n');
}

async function runBlackboardMcpSmoke(executable) {
  const resources = packagedResources(executable);
  const entrypoint = path.join(resources, 'blackboard', 'blackboard-mcp', 'index.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`Packaged Blackboard MCP entrypoint is missing: ${entrypoint}`);
  }

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-blackboard-smoke-'));
  const blackboardDir = path.join(runtimeDir, 'blackboard');
  const blackboardDb = path.join(blackboardDir, 'blackboard.db');
  fs.mkdirSync(blackboardDir, { recursive: true, mode: 0o700 });

  const child = spawn(executable, [entrypoint], {
    cwd: resources,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GLADOS_RUNTIME_DIR: runtimeDir,
      GLADOS_SESSION_ID: 'packaged-blackboard-smoke',
      BLACKBOARD_DB: blackboardDb,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;

  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(new Error(`Packaged Blackboard MCP smoke test timed out.\n${stderr}`));
      }, 15000);

      const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); }
          catch { continue; }
          if (message.id === 1 && message.result) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          }
          if (message.id === 2) {
            if (message.error) {
              finish(new Error(`Packaged Blackboard MCP tools/list failed: ${JSON.stringify(message.error)}`));
              return;
            }
            const toolNames = (message.result?.tools || []).map(tool => tool.name);
            if (!toolNames.includes('blackboard_read') || !toolNames.includes('blackboard_engagement_status')) {
              finish(new Error(`Packaged Blackboard MCP returned an incomplete tool list: ${toolNames.join(', ')}`));
              return;
            }
            finish();
          }
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', finish);
      child.once('exit', code => {
        if (!settled) finish(new Error(`Packaged Blackboard MCP exited before becoming ready (exit ${code}).\n${stderr}`));
      });
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'glados-packaged-smoke', version: '1.0.0' },
        },
      });
    });
    process.stdout.write('GLADOS_PACKAGED_BLACKBOARD_MCP_OK\n');
  } finally {
    child.stdin.end();
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function runGladosOpsMcpSmoke(executable) {
  const resources = packagedResources(executable);
  const entrypoint = path.join(resources, 'tools', 'glados-ops-mcp', 'index.js');
  if (!fs.existsSync(entrypoint)) throw new Error(`Packaged GLaDOS Ops MCP entrypoint is missing: ${entrypoint}`);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-ops-smoke-'));
  const child = spawn(executable, [entrypoint], {
    cwd: resources,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GLADOS_RUNTIME_DIR: runtimeDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(() => finish(new Error(`Packaged GLaDOS Ops MCP smoke test timed out.\n${stderr}`)), 15000);
      const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1 && message.result) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          }
          if (message.id === 2) {
            if (message.error) return finish(new Error(`Packaged GLaDOS Ops MCP tools/list failed: ${JSON.stringify(message.error)}`));
            const toolNames = new Set((message.result?.tools || []).map(tool => tool.name));
            const required = ['desktop_snapshot', 'desktop_list_windows', 'desktop_click', 'desktop_type', 'desktop_key'];
            const missing = required.filter(name => !toolNames.has(name));
            if (missing.length) return finish(new Error(`Packaged GLaDOS Ops MCP is missing Full Access tools: ${missing.join(', ')}`));
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'desktop_snapshot', arguments: {} } });
          }
          if (message.id === 3) {
            if (message.error) return finish(new Error(`Packaged Full Access default-off check failed: ${JSON.stringify(message.error)}`));
            const text = (message.result?.content || []).map(item => item.text || '').join('\n');
            if (message.result?.isError !== true || !/Full Access is disabled/i.test(text)) {
              return finish(new Error(`Packaged desktop_snapshot did not fail closed: ${JSON.stringify(message.result)}`));
            }
            finish();
          }
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', finish);
      child.once('exit', code => {
        if (!settled) finish(new Error(`Packaged GLaDOS Ops MCP exited before becoming ready (exit ${code}).\n${stderr}`));
      });
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'glados-packaged-smoke', version: '1.0.0' } },
      });
    });
    process.stdout.write('GLADOS_PACKAGED_FULL_ACCESS_TOOLS_OK\n');
  } finally {
    child.stdin.end();
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function runSmoke(executable, architecture = null, label = architecture || process.arch) {
  const proxyPort = await freePort();
  const command = architecture ? '/usr/bin/arch' : executable;
  const args = architecture ? [`-${architecture}`, executable] : [];
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.GLADOS_MITMPROXY_BIN;
  const child = spawn(command, args, {
    cwd: desktopDir,
    env: {
      ...cleanEnvironment,
      GLADOS_PACKAGED_SMOKE: '1',
      GLADOS_PROXY_REQUIRE_BUNDLED: '1',
      GLADOS_MITM_LISTEN_PORT: String(proxyPort),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
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
  verifyBundledMitmproxy(executable);
  await runBlackboardMcpSmoke(executable);
  await runGladosOpsMcpSmoke(executable);
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
