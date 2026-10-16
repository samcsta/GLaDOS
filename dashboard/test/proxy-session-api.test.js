const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionProxyConfig } = require('../lib/proxy/session-manager');
const { proxyBackendConfig } = require('../lib/proxy/mitmproxy-runner');

async function fixture(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-proxy-api-'));
  const env = { ...process.env, PORT: '0', GLADOS_RUNTIME_DIR: root,
    GLADOS_AGENT_WORKSPACES: path.join(root, 'workspaces', 'agents'),
    BLACKBOARD_DB: path.join(root, 'blackboard', 'blackboard.db'), WATCHDOG_DB: path.join(root, 'watchdog', 'watchdog.db'),
    GLADOS_REPORTS_DIR: path.join(root, 'reports'), GLADOS_INVESTIGATIONS_DIR: path.join(root, 'investigations'),
    GLADOS_CONTROLLER_WORKER: '0', GLADOS_DESKTOP: '0', GLADOS_CLIPPY_MCP: '0', GLADOS_LITELLM_USAGE_DISABLED: '1', ...extraEnv };
  const child = cp.fork(path.join(__dirname, '..', 'server.js'), [], {
    cwd: path.resolve(__dirname, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode == null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy fixture failed: ${output}`)), 8000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`proxy fixture exited ${code}: ${output}`)); });
    child.on('message', message => { if (message.type === 'glados-dashboard-ready') { clearTimeout(timer); resolve(message.url); } });
  });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(url + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  return { request, root, base: proxyBackendConfig({ GLADOS_RUNTIME_DIR: root }) };
}

test('proxy APIs require a pinned investigation and never expose another session capture or pending intercept', async t => {
  const { request, base } = await fixture(t);
  for (const route of ['/session', '/history', '/detail?id=1', '/metrics', '/rps', '/stream', '/intercept', '/websockets', '/websocket-detail?id=1', '/ca']) {
    const result = await request(`/api/proxy${route}`);
    assert.equal(result.status, 400, route);
  }
  assert.equal((await request('/api/proxy/history?session_id=missing')).status, 404);
  const one = (await request('/api/investigation-sessions', 'POST', { name: 'one' })).json.session;
  const two = (await request('/api/investigation-sessions', 'POST', { name: 'two' })).json.session;
  const configOne = sessionProxyConfig(one.id, base);
  const configTwo = sessionProxyConfig(two.id, base);
  for (const [config, id, secret] of [[configOne, 1, 'one'], [configTwo, 2, 'two']]) {
    fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.trafficJsonl, JSON.stringify({ id, sessionId: config.sessionId, url: `https://${secret}.example/`, ts: Date.now(), status: 200 }) + '\n', { mode: 0o600 });
    fs.writeFileSync(config.websocketJsonl, JSON.stringify({ id, type: 'websocket', sessionId: config.sessionId, body: secret, ts: Date.now() }) + '\n', { mode: 0o600 });
  }
  assert.deepEqual((await request(`/api/proxy/history?session_id=${one.id}`)).json.map(row => row.id), [1]);
  assert.deepEqual((await request(`/api/proxy/history?session_id=${two.id}`)).json.map(row => row.id), [2]);
  assert.equal((await request(`/api/proxy/detail?session_id=${one.id}&id=2`)).status, 404);
  assert.equal((await request(`/api/proxy/websockets?session_id=${one.id}`)).json[0].body, 'one');
  assert.equal((await request(`/api/proxy/websocket-detail?session_id=${one.id}&id=1`)).json.body, 'one');
  assert.equal((await request(`/api/proxy/websocket-detail?session_id=${one.id}&id=2`)).status, 404);
  assert.equal((await request(`/api/proxy/websocket-detail?session_id=${one.id}`)).status, 400);
  fs.appendFileSync(configOne.websocketJsonl, JSON.stringify({ id: 3, type: 'websocket', sessionId: one.id, body: 'a'.repeat(12000), bodyLen: 12000, bodyTruncated: false, edited: true }) + '\n');
  const summary = (await request(`/api/proxy/websockets?session_id=${one.id}&summary=1&before=4&limit=1`)).json[0];
  assert.equal(summary.body.length, 2048);
  assert.equal(summary.previewTruncated, true);
  assert.equal(summary.bodyTruncated, false);
  assert.equal(summary.edited, true);
  assert.equal((await request(`/api/proxy/websocket-detail?session_id=${one.id}&id=3`)).json.body.length, 12000);
  const meta = await request(`/api/proxy/session?session_id=${one.id}`);
  assert.equal(meta.json.listenPort, null, 'GET must not start a listener');
  assert.equal(meta.json.readOnly, true);
  assert.equal(meta.json.capabilities.sessionIsolation, true);
  assert.equal((await request('/api/proxy/session', 'POST', { session_id: one.id })).status, 409);
  assert.equal((await request('/api/proxy/replay', 'POST', { session_id: one.id, url: 'https://should-not-send.example/' })).status, 409);
  const pendingDir = path.join(configOne.trafficDir, 'intercept', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pendingDir, 'held-one.json'), JSON.stringify({ id: 'held-one', sessionId: one.id, expiresAt: Date.now() + 60000, createdAt: Date.now(), raw: 'GET / HTTP/1.1\r\nHost: one.example\r\n\r\n' }), { mode: 0o600 });
  assert.equal((await request(`/api/proxy/intercept?session_id=${one.id}`)).json.pending.length, 1);
  assert.equal((await request(`/api/proxy/intercept?session_id=${two.id}`)).json.pending.length, 0);
  assert.equal((await request('/api/proxy/intercept/held-one', 'POST', { session_id: two.id, action: 'drop' })).status, 404);
  assert.equal((await request(`/api/proxy/intercept/held-one`, 'POST', { session_id: one.id, action: 'drop' })).status, 409);
});

test('assessment browser inventory is team scoped and opening cannot grant browser tools or impersonate its MCP bridge', async t => {
  const { request } = await fixture(t, { GLADOS_BROWSER_MCP: '1' });
  assert.equal((await request('/api/proxy/browsers')).status, 400);
  const session = (await request('/api/investigation-sessions', 'POST', { name: 'assessment', teamId: 'glados' })).json.session;
  const inventory = await request(`/api/proxy/browsers?session_id=${session.id}`);
  assert.equal(inventory.status, 200);
  assert.equal(inventory.json.sessionId, session.id);
  assert.equal(inventory.json.defaultAgentId, 'webapp-recon');
  assert.ok(inventory.json.agents.some(row => row.id === 'webapp-recon'));
  assert.ok(!inventory.json.agents.some(row => row.id === 'glados'));
  assert.deepEqual(inventory.json.browsers, [], 'listing tools or browsers must not launch Chrome');
  assert.equal((await request('/api/proxy/browser/ensure', 'POST', { session_id: session.id, agent_id: 'webapp-recon' })).status, 403);
  assert.equal((await request('/api/proxy/browser/open', 'POST', { session_id: session.id })).status, 400);
  assert.equal((await request('/api/proxy/browser/open', 'POST', { session_id: session.id, agent_id: 'glados' })).status, 403);
  assert.equal((await request('/api/proxy/browser/open', 'POST', { session_id: session.id, agent_id: 'missing' })).status, 404);
  await request('/api/investigation-sessions', 'POST', { name: 'next', teamId: 'glados' });
  assert.equal((await request('/api/proxy/browser/open', 'POST', { session_id: session.id, agent_id: 'webapp-recon' })).status, 409);
});
