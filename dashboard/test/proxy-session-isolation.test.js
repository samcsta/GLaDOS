const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SessionProxyManager, sessionProxyConfig } = require('../lib/proxy/session-manager');
const { proxyBackendConfig } = require('../lib/proxy/mitmproxy-runner');
const { proxyHistory, proxyDetail, proxyMetrics, proxyWebsocketHistory, proxyWebsocketDetail, watchProxyEvents } = require('../lib/proxy/native-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-proxy-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return proxyBackendConfig({ GLADOS_RUNTIME_DIR: root });
}

function write(config, rows, file = config.trafficJsonl) {
  fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, rows.map(row => JSON.stringify({ ts: Date.now(), status: 200, ...row })).join('\n') + '\n', { mode: 0o600 });
}

test('each investigation gets distinct safe capture and CA process directories', t => {
  const base = fixture(t);
  const one = sessionProxyConfig('session-one', base);
  const two = sessionProxyConfig('session-two', base);
  assert.notEqual(one.trafficDir, two.trafficDir);
  assert.notEqual(one.mitmproxyConfDir, two.mitmproxyConfDir);
  assert.equal(one.listenHost, '127.0.0.1');
  assert.equal(one.listenPort, null);
  assert.equal(one.websocketJsonl, path.join(one.trafficDir, 'websocket-events.jsonl'));
  const traversal = sessionProxyConfig('../../escape', base);
  assert.equal(path.dirname(traversal.trafficDir), path.join(base.trafficDir, 'sessions'));
  assert.throws(() => sessionProxyConfig(''), /session required/);
});

test('history, detail, metrics and WebSocket paging never return foreign or unassigned records', t => {
  const base = fixture(t);
  const config = sessionProxyConfig('one', base);
  write(config, [
    { id: 1, sessionId: 'one', url: 'https://one.example/old' },
    { id: 2, sessionId: 'two', url: 'https://two.example/private' },
    { id: 3, url: 'https://unassigned.example/private' },
    { id: 4, sessionId: 'one', url: 'https://one.example/new' },
  ]);
  assert.deepEqual(proxyHistory({ config }).map(row => row.id), [1, 4]);
  assert.deepEqual(proxyHistory({ config, limit: 1 }).map(row => row.id), [4]);
  assert.deepEqual(proxyHistory({ config, before: 4, limit: 1 }).map(row => row.id), [1]);
  assert.equal(proxyDetail(2, config), null);
  assert.equal(proxyDetail(3, config), null);
  assert.equal(proxyDetail(1, config).sessionId, 'one');
  assert.equal(proxyMetrics({ config, windowSec: 10 }).agents[0].requests, 2);
  write(config, [
    { type: 'websocket', id: 11, sessionId: 'one', body: 'first' },
    { type: 'websocket', id: 12, sessionId: 'two', body: 'secret' },
    { type: 'websocket', id: 13, sessionId: 'one', body: 'last' },
  ], config.websocketJsonl);
  assert.deepEqual(proxyWebsocketHistory({ config }).map(row => row.id), [11, 13]);
  assert.deepEqual(proxyWebsocketHistory({ config, before: 13, limit: 1 }).map(row => row.id), [11]);
});

test('live proxy events filter the pinned session even while another session writes', async t => {
  const config = sessionProxyConfig('one', fixture(t));
  write(config, []);
  const rows = [];
  const close = watchProxyEvents({ config, onEvent: row => rows.push(row) });
  t.after(close);
  fs.appendFileSync(config.trafficJsonl, [
    { id: 1, sessionId: 'two', url: 'https://two.example/' },
    { id: 2, url: 'https://unassigned.example/' },
    { id: 3, sessionId: 'one', url: 'https://one.example/' },
  ].map(JSON.stringify).join('\n') + '\n');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(rows.map(row => row.id), [3]);
});

test('WebSocket history previews stay within 2 KiB while exact-session detail retains full captured evidence', t => {
  const config = sessionProxyConfig('one', fixture(t));
  const text = '😀'.repeat(3000);
  const binary = Buffer.alloc(4096, 42).toString('base64');
  write(config, [
    { type: 'websocket', id: 1, sessionId: 'one', body: text, bodyLen: 12000, bodyTruncated: false, binary: false, edited: true, dropped: false },
    { type: 'websocket', id: 2, sessionId: 'one', body: binary, bodyLen: 9000, bodyTruncated: true, binary: true, edited: false, dropped: true },
    { type: 'websocket', id: 3, sessionId: 'two', body: 'foreign' },
  ], config.websocketJsonl);
  const rows = proxyWebsocketHistory({ config, summary: true });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(Buffer.byteLength(row.body, 'utf8') <= 2048);
    assert.equal(row.previewTruncated, true);
  }
  assert.equal(rows[0].body.includes('\uFFFD'), false, 'text preview keeps whole UTF-8 code points');
  assert.equal(rows[0].bodyTruncated, false, 'preview truncation is separate from capture truncation');
  assert.equal(rows[0].edited, true);
  assert.equal(rows[1].bodyTruncated, true);
  assert.equal(rows[1].dropped, true);
  assert.equal(rows[1].body.length % 4, 0, 'binary preview keeps whole base64 quartets');
  assert.equal(Buffer.from(rows[1].body, 'base64').toString('base64'), rows[1].body);
  assert.equal(proxyWebsocketDetail(1, config).body, text);
  assert.equal(proxyWebsocketDetail(2, config).body, binary);
  assert.equal(proxyWebsocketDetail(3, config), null);
  assert.equal(proxyWebsocketHistory({ config })[0].body, text, 'full capture remains available on explicit reads');
  const short = proxyWebsocketHistory({ config, summary: true, before: 2, limit: 1 });
  assert.deepEqual(short.map(row => row.id), [1]);
});

test('WebSocket exact detail scans retained archives without mixing session IDs', t => {
  const config = sessionProxyConfig('one', fixture(t));
  write(config, [{ type: 'websocket', id: 9, sessionId: 'two', body: 'other session' }], config.websocketJsonl);
  write(config, [{ type: 'websocket', id: 9, sessionId: 'one', body: 'retained earlier', edited: true }], path.join(config.trafficDir, 'websocket-events-old.jsonl'));
  assert.equal(proxyWebsocketDetail(9, config).body, 'retained earlier');
  assert.equal(proxyWebsocketDetail(9, config).edited, true);
  assert.equal(proxyWebsocketDetail('missing', config), null);
});

test('HTTP history and detail retain actual request and response edit markers', t => {
  const config = sessionProxyConfig('one', fixture(t));
  write(config, [
    { id: 1, sessionId: 'one', requestEdited: true },
    { id: 2, sessionId: 'one', responseEdited: true },
    { id: 3, sessionId: 'one' },
  ]);
  assert.deepEqual(proxyHistory({ config }).map(({ edited, requestEdited, responseEdited }) => [edited, requestEdited, responseEdited]), [
    [true, true, false], [true, false, true], [false, false, false],
  ]);
  assert.equal(proxyDetail(2, config).responseEdited, true);
});

test('session listeners launch once per session, use distinct ports and stop independently', async t => {
  const config = fixture(t);
  const started = [];
  let nextPort = 32100;
  const manager = new SessionProxyManager({ config, prepareCa() {},
    allocatePort: async () => ++nextPort, waitReady: async () => {},
    start(sessionConfig) {
      const child = new EventEmitter();
      child.pid = nextPort;
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      started.push({ config: sessionConfig, child });
      return { child };
    },
  });
  t.after(() => manager.stopAll());
  assert.equal(manager.describe('one').listenPort, null);
  assert.equal(started.length, 0, 'reading metadata must not launch a process');
  const [one, repeated] = await Promise.all([manager.ensure('one'), manager.ensure('one')]);
  const two = await manager.ensure('two');
  assert.equal(started.length, 2);
  assert.equal(one.proxyUrl, repeated.proxyUrl);
  assert.notEqual(one.listenPort, two.listenPort);
  assert.equal(one.health.healthy, true);
  assert.equal(started[0].config.sessionId, 'one');
  await manager.stop('one');
  assert.equal(manager.describe('one').health.processStatus, 'stopped');
  assert.equal(manager.describe('two').health.processStatus, 'running');
});

test('failed session startup retains its unique endpoint and fails closed', async t => {
  const config = fixture(t);
  const manager = new SessionProxyManager({ config, allocatePort: async () => 32101,
    prepareCa() { throw new Error('CA unavailable'); }, start() { throw new Error('must not start'); } });
  const failed = await manager.ensure('one');
  assert.equal(failed.health.healthy, false);
  assert.equal(failed.health.processStatus, 'failed');
  assert.equal(failed.proxyUrl, 'http://127.0.0.1:32101');
  assert.match(failed.health.error, /CA unavailable/);
});

test('the same browser agent in two investigations keeps separate proxy configs and debug ports', t => {
  const base = fixture(t);
  const { writeBrowserMcpConfig } = require('../lib/harness/agent-sdk');
  const runtime = path.dirname(base.trafficDir);
  const env = { GLADOS_RUNTIME_DIR: runtime };
  const firstFile = writeBrowserMcpConfig('webapp-recon', { ...env, GLADOS_SESSION_ID: 'one', GLADOS_PROXY_URL: 'http://127.0.0.1:32101' });
  const secondFile = writeBrowserMcpConfig('webapp-recon', { ...env, GLADOS_SESSION_ID: 'two', GLADOS_PROXY_URL: 'http://127.0.0.1:32102' });
  assert.notEqual(firstFile, secondFile);
  const first = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
  const second = JSON.parse(fs.readFileSync(secondFile, 'utf8'));
  assert.equal(first.browser.launchOptions.proxy.server, 'http://127.0.0.1:32101');
  assert.equal(second.browser.launchOptions.proxy.server, 'http://127.0.0.1:32102');
  assert.equal(first.browser.contextOptions.extraHTTPHeaders['X-GLaDOS-Session'], 'one');
  assert.equal(second.browser.contextOptions.extraHTTPHeaders['X-GLaDOS-Session'], 'two');
  const debugPort = config => config.browser.launchOptions.args.find(value => value.startsWith('--remote-debugging-port='));
  assert.notEqual(debugPort(first), debugPort(second));
  assert.equal(writeBrowserMcpConfig('webapp-recon', { ...env, GLADOS_SESSION_ID: 'one' }), firstFile);
});
