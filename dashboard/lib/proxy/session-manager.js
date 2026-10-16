const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { proxyBackendConfig, startMitmproxy } = require('./mitmproxy-runner');
const { ensureMitmCa } = require('./mitm-ca');
const { proxyHealth, combineProxyRuntimeHealth } = require('./native-store');

function sessionProxyConfig(sessionId, base = proxyBackendConfig()) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || /[\x00-\x1f]/.test(sessionId)) {
    throw new Error('valid investigation session required');
  }
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  const trafficDir = path.join(base.trafficDir, 'sessions', key);
  return {
    ...base,
    sessionId,
    listenHost: '127.0.0.1',
    listenPort: null,
    trafficDir,
    trafficJsonl: path.join(trafficDir, 'proxy-events.jsonl'),
    websocketJsonl: path.join(trafficDir, 'websocket-events.jsonl'),
    mitmproxyConfDir: path.join(base.mitmproxyConfDir, 'sessions', key),
  };
}

function availablePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function listenerReady(record, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const probe = () => {
      if (record.runtime.status === 'failed') return reject(new Error(record.runtime.error));
      const socket = net.connect({ host: record.config.listenHost, port: record.config.listenPort });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) return reject(new Error('session proxy listener did not become ready'));
        setTimeout(probe, 100);
      });
    };
    probe();
  });
}

class SessionProxyManager {
  constructor({ env = process.env, config = proxyBackendConfig(env), start = startMitmproxy,
    prepareCa = () => ensureMitmCa({ env }), allocatePort = availablePort, waitReady = listenerReady } = {}) {
    this.env = env;
    this.base = config;
    this.start = start;
    this.prepareCa = prepareCa;
    this.allocatePort = allocatePort;
    this.waitReady = waitReady;
    this.records = new Map();
  }

  record(sessionId) {
    let record = this.records.get(sessionId);
    if (!record) {
      record = {
        config: sessionProxyConfig(sessionId, this.base),
        runtime: { status: 'stopped', child: null, pid: null, startedAt: null, error: null, stderr: '' },
        starting: null,
      };
      this.records.set(sessionId, record);
    }
    return record;
  }

  describe(sessionId) {
    const { config, runtime } = this.record(sessionId);
    return {
      sessionId,
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      proxyUrl: config.listenPort ? `http://${config.listenHost}:${config.listenPort}` : null,
      health: combineProxyRuntimeHealth(proxyHealth(config), runtime, { supervised: true }),
      capabilities: { httpHistory: true, replay: true, intercept: true, websocketHistory: true, sessionIsolation: true },
    };
  }

  config(sessionId) { return this.record(sessionId).config; }

  async ensure(sessionId) {
    const record = this.record(sessionId);
    if (record.runtime.status === 'running') return this.describe(sessionId);
    if (record.starting) return record.starting;
    record.starting = (async () => {
      try {
        record.config.listenPort = await this.allocatePort(record.config.listenHost);
        this.prepareCa();
        const { child } = this.start(record.config);
        const runtime = record.runtime = {
          status: 'starting', child, pid: child.pid || null, startedAt: new Date().toISOString(), error: null, stderr: '',
        };
        child.stdout?.resume();
        child.stderr?.on('data', chunk => { runtime.stderr = `${runtime.stderr}${chunk}`.slice(-4000); });
        child.once('error', error => { runtime.status = 'failed'; runtime.error = error.message; runtime.pid = null; });
        child.once('exit', (code, signal) => {
          runtime.status = runtime.status === 'stopping' ? 'stopped' : 'failed';
          if (runtime.status === 'failed') runtime.error = `session mitmproxy exited (${signal || code})`;
          runtime.child = null;
          runtime.pid = null;
        });
        await this.waitReady(record);
        if (runtime.status === 'failed') throw new Error(runtime.error);
        runtime.status = 'running';
      } catch (error) {
        record.runtime.status = 'failed';
        record.runtime.error = error.message;
        try { record.runtime.child?.kill('SIGTERM'); } catch {}
      }
      return this.describe(sessionId);
    })().finally(() => { record.starting = null; });
    return record.starting;
  }

  async stop(sessionId, { timeoutMs = 2500 } = {}) {
    const record = this.records.get(sessionId);
    if (!record) return;
    if (record.starting) await record.starting;
    const { runtime } = record;
    const child = runtime.child;
    runtime.status = 'stopping';
    if (!child || child.exitCode != null) { runtime.status = 'stopped'; return; }
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); runtime.status = 'stopped'; runtime.child = null; runtime.pid = null; resolve(); };
      child.once('exit', done);
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(); }, timeoutMs);
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }

  async stopAll(options) { await Promise.all([...this.records.keys()].map(id => this.stop(id, options))); }
}

module.exports = { SessionProxyManager, sessionProxyConfig };
