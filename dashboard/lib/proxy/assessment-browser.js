const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { mitmCaPaths, commandPath } = require('./mitm-ca');

function identity(value, name) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) {
    throw new Error(`A valid ${name} is required for the assessment browser`);
  }
  return value;
}

function assessmentBrowserPaths(sessionId, agentId, env = process.env) {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  const dir = path.join(runtimeDir, 'browser-mcp', 'sessions', hash(identity(sessionId, 'investigation session')));
  const agentKey = hash(identity(agentId, 'agent'));
  return { dir, managedDir: path.join(dir, 'managed'), manifest: path.join(dir, 'managed', `${agentKey}.json`),
    profile: path.join(dir, 'profiles', agentKey) };
}

function readAssessmentBrowserManifest(sessionId, agentId, env = process.env) {
  try {
    const file = assessmentBrowserPaths(sessionId, agentId, env).manifest;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && (stat.mode & 0o077))) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.sessionId !== sessionId || value.agentId !== agentId || value.status !== 'running') return null;
    const port = Number(value.cdpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || value.cdpEndpoint !== `http://127.0.0.1:${port}`) return null;
    if (!Number.isInteger(value.managerPid) || value.managerPid < 1) return null;
    try { process.kill(value.managerPid, 0); } catch { return null; }
    return value;
  } catch { return null; }
}

function readBrowserManifest(runtimeDir, sessionId, agentId) {
  return readAssessmentBrowserManifest(sessionId, agentId, { GLADOS_RUNTIME_DIR: runtimeDir });
}

function operatorCaSpki(env = process.env) {
  const file = mitmCaPaths(env).cert;
  let cert;
  try { cert = new crypto.X509Certificate(fs.readFileSync(file)); }
  catch { throw new Error('GLaDOS proxy CA is unavailable. Generate it in Settings → Setup Assistant before opening the browser.'); }
  const now = Date.now();
  if (!cert.ca || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) {
    throw new Error('GLaDOS proxy CA is invalid or expired. Restore or rotate the local CA before opening the browser.');
  }
  return crypto.createHash('sha256').update(cert.publicKey.export({ format: 'der', type: 'spki' })).digest('base64');
}

function ownerDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Every GLaDOS-created profile ancestor is private, including the shared
  // session directories, rather than relying on the caller's umask.
  fs.chmodSync(dir, 0o700);
}

function writeManifest(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}

function executable(file) {
  if (!file) return false;
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

function resolveBrowserExecutable(chromium, env = process.env, platform = process.platform) {
  if (env.GLADOS_BROWSER_EXECUTABLE_PATH) {
    const configured = path.resolve(env.GLADOS_BROWSER_EXECUTABLE_PATH);
    if (!executable(configured)) throw new Error('GLADOS_BROWSER_EXECUTABLE_PATH does not name an executable Chrome or Chromium browser.');
    return configured;
  }
  const home = env.HOME || os.homedir();
  const chrome = platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : platform === 'win32' ? [
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : [commandPath('google-chrome', env, platform), commandPath('google-chrome-stable', env, platform), '/opt/google/chrome/chrome'];
  const installed = chrome.find(executable);
  if (installed) return installed;
  let bundled;
  try { bundled = chromium.executablePath(); } catch {}
  if (executable(bundled)) return bundled;
  throw new Error('Chrome/Chromium is not installed. Install Google Chrome, or install Playwright Chromium with "npx playwright install chromium", then retry Open browser. You can also set GLADOS_BROWSER_EXECUTABLE_PATH.');
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForCdp(endpoint, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) });
      if (response.ok) {
        const value = await response.json();
        if (typeof value.webSocketDebuggerUrl === 'string' && value.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:')) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('The assessment browser did not expose its local MCP connection. Close it and retry Open browser.');
}

function validProxy(description, sessionId) {
  let url;
  try { url = new URL(description?.proxyUrl); } catch {}
  if (description?.sessionId !== sessionId || description?.health?.healthy !== true
    || !url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(description?.health?.error || 'A healthy dedicated session proxy is required before opening the assessment browser.');
  }
  return url.origin;
}

class AssessmentBrowserManager {
  constructor({ env = process.env, sessionProxies, chromium, platform = process.platform,
    allocatePort = availablePort, waitReady = waitForCdp, resolveExecutable = resolveBrowserExecutable,
    launchTimeoutMs = 20000 } = {}) {
    this.env = env;
    this.sessionProxies = sessionProxies;
    this.chromium = chromium;
    this.platform = platform;
    this.allocatePort = allocatePort;
    this.waitReady = waitReady;
    this.resolveExecutable = resolveExecutable;
    this.launchTimeoutMs = launchTimeoutMs;
    this.records = new Map();
    this.opening = new Map();
    this.stopping = new Map();
  }

  key(sessionId, agentId) { return `${identity(sessionId, 'investigation session')}\0${identity(agentId, 'agent')}`; }

  async ensure(sessionId, agentId, { focus = false } = {}) {
    const key = this.key(sessionId, agentId);
    if (this.stopping.has(sessionId)) await this.stopping.get(sessionId);
    let operation = this.opening.get(key);
    if (!operation) {
      operation = this.open(sessionId, agentId).finally(() => this.opening.delete(key));
      this.opening.set(key, operation);
    }
    const description = await operation;
    const record = this.records.get(key);
    if (focus && record) {
      const page = record.context.pages()[0] || await record.context.newPage();
      await page.bringToFront();
    }
    return description;
  }

  async open(sessionId, agentId) {
    const key = this.key(sessionId, agentId);
    const proxyUrl = validProxy(await this.sessionProxies.ensure(sessionId), sessionId);
    const existing = this.records.get(key);
    if (existing && existing.descriptor.proxyUrl === proxyUrl) return { ...existing.descriptor, reused: true };
    if (existing) await existing.context.close();
    const chromium = this.chromium || require('playwright').chromium;
    const executablePath = this.resolveExecutable(chromium, this.env, this.platform);
    const caSpki = operatorCaSpki(this.env);
    const locations = assessmentBrowserPaths(sessionId, agentId, this.env);
    const runtimeDir = path.resolve(this.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
    for (const dir of [path.join(runtimeDir, 'browser-mcp'), path.join(runtimeDir, 'browser-mcp', 'sessions'),
      locations.dir, locations.managedDir, path.dirname(locations.profile), locations.profile]) ownerDirectory(dir);
    const cdpPort = await this.allocatePort();
    if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error('Unable to allocate the browser MCP connection port.');
    const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
    let context;
    try {
      context = await chromium.launchPersistentContext(locations.profile, {
        executablePath, headless: false, chromiumSandbox: true, viewport: null, timeout: this.launchTimeoutMs,
        proxy: { server: proxyUrl, bypass: '<-loopback>' },
        ignoreHTTPSErrors: false,
        extraHTTPHeaders: { 'X-GLaDOS-Agent': agentId, 'X-GLaDOS-Session': sessionId, 'X-GLaDOS-Transport': 'browser-mcp' },
        args: ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`,
          `--ignore-certificate-errors-spki-list=${caSpki}`, '--no-first-run', '--no-default-browser-check'],
      });
      await this.waitReady(cdpEndpoint, 8000);
      const descriptor = { ok: true, sessionId, agentId, proxyUrl, cdpEndpoint, cdpPort,
        status: 'running', engine: 'Playwright Chromium', reused: false };
      const record = { context, descriptor, locations };
      this.records.set(key, record);
      const closed = () => {
        if (this.records.get(key) !== record) return;
        this.records.delete(key);
        try { fs.rmSync(locations.manifest, { force: true }); } catch {}
      };
      context.once('close', closed);
      writeManifest(locations.manifest, { version: 1, ...descriptor, managerPid: process.pid, updatedAt: new Date().toISOString() });
      // Persistent contexts begin with a blank tab. Never navigate a target or
      // restore another process's target tabs merely by opening this browser.
      if (!context.pages().length) await context.newPage();
      return { ...descriptor };
    } catch (error) {
      if (context) { try { await context.close(); } catch {} }
      try { fs.rmSync(locations.manifest, { force: true }); } catch {}
      throw new Error(`Unable to open the shared assessment browser: ${error.message}`);
    }
  }

  describe(sessionId) {
    identity(sessionId, 'investigation session');
    return [...this.records.values()].filter(record => record.descriptor.sessionId === sessionId)
      .map(record => ({ ...record.descriptor }));
  }

  async stopSession(sessionId) {
    identity(sessionId, 'investigation session');
    if (this.stopping.has(sessionId)) return this.stopping.get(sessionId);
    const operation = (async () => {
      await Promise.allSettled([...this.opening].filter(([key]) => key.startsWith(`${sessionId}\0`)).map(([, value]) => value));
      const records = [...this.records.values()].filter(record => record.descriptor.sessionId === sessionId);
      await Promise.allSettled(records.map(async record => {
        try { await record.context.close(); } finally {
          this.records.delete(this.key(sessionId, record.descriptor.agentId));
          try { fs.rmSync(record.locations.manifest, { force: true }); } catch {}
        }
      }));
    })().finally(() => this.stopping.delete(sessionId));
    this.stopping.set(sessionId, operation);
    return operation;
  }

  async stopAll() {
    const ids = new Set([...this.records.values()].map(record => record.descriptor.sessionId));
    for (const key of this.opening.keys()) ids.add(key.split('\0')[0]);
    await Promise.all([...ids].map(id => this.stopSession(id)));
  }
}

module.exports = { AssessmentBrowserManager, assessmentBrowserPaths, readAssessmentBrowserManifest,
  readBrowserManifest, operatorCaSpki, resolveBrowserExecutable };
