const test = require('node:test');
const assert = require('node:assert/strict');
const { AssessmentBrowserBridge, validSessionId, validAgentId, browserDescriptor, assertProxyBrowserDashboardEvent } = require('../lib/proxy-browser.cjs');

function descriptor(overrides = {}) {
  return { ok: true, sessionId: 'investigation-alpha', agentId: 'webapp-recon',
    proxyUrl: 'http://127.0.0.1:19001', cdpEndpoint: 'http://127.0.0.1:19002', cdpPort: 19002,
    status: 'running', engine: 'Playwright Chromium', reused: false, ...overrides };
}

test('assessment browser requires bounded session and browser-agent identities before making a request', async () => {
  assert.equal(validSessionId('investigation-alpha'), 'investigation-alpha');
  assert.equal(validAgentId('webapp-recon'), 'webapp-recon');
  const invalid = ['', '   ', null, undefined, 7, 'x\n', 'x\x7f', 'x'.repeat(201)];
  let called = false;
  const bridge = new AssessmentBrowserBridge({ dashboardJson: async () => { called = true; } });
  for (const value of invalid) {
    assert.throws(() => validSessionId(value), /valid investigation session/);
    assert.throws(() => validAgentId(value), /valid browser-enabled agent/);
    await assert.rejects(bridge.open({ sessionId: value, agentId: 'webapp-recon' }), /valid investigation session/);
    await assert.rejects(bridge.open({ sessionId: 'investigation-alpha', agentId: value }), /valid browser-enabled agent/);
  }
  assert.equal(called, false);
});

test('desktop opening accepts only the current trusted dashboard main frame', () => {
  const contents = { mainFrame: { url: 'http://127.0.0.1:58100/' } };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.doesNotThrow(() => assertProxyBrowserDashboardEvent(event, window, 'http://127.0.0.1:58100'));
  assert.throws(() => assertProxyBrowserDashboardEvent({ ...event, senderFrame: { url: contents.mainFrame.url } }, window, 'http://127.0.0.1:58100'), /trusted dashboard/);
  assert.throws(() => assertProxyBrowserDashboardEvent(event, window, 'https://other.test'), /trusted dashboard/);
  assert.throws(() => assertProxyBrowserDashboardEvent({ ...event, sender: {} }, window, 'http://127.0.0.1:58100'), /trusted dashboard/);
  assert.throws(() => assertProxyBrowserDashboardEvent(event, { ...window, isDestroyed: () => true }, 'http://127.0.0.1:58100'), /trusted dashboard/);
  assert.throws(() => assertProxyBrowserDashboardEvent(event, null, 'http://127.0.0.1:58100'), /trusted dashboard/);
});

test('desktop opens the dashboard-managed browser for the chosen session and agent', async () => {
  const requests = [];
  const running = descriptor();
  const bridge = new AssessmentBrowserBridge({ dashboardJson: async (url, options) => {
    requests.push({ url, options });
    return running;
  } });
  assert.equal(await bridge.open({ sessionId: 'investigation-alpha', agentId: 'webapp-recon' }), running);
  assert.deepEqual(requests, [{ url: '/api/proxy/browser/open', options: {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'investigation-alpha', agent_id: 'webapp-recon' }), timeoutMs: 45000,
  } }]);
});

test('desktop rejects a managed browser belonging to a different session or agent', async () => {
  for (const value of [null, descriptor({ sessionId: 'other-session' }), descriptor({ agentId: 'other-agent' })]) {
    const bridge = new AssessmentBrowserBridge({ dashboardJson: async () => value });
    await assert.rejects(bridge.open({ sessionId: 'investigation-alpha', agentId: 'webapp-recon' }), /another session or agent/);
  }
});

test('desktop requires a running browser with dedicated local proxy and CDP endpoints', () => {
  const validate = value => browserDescriptor(value, 'investigation-alpha', 'webapp-recon');
  assert.equal(validate(descriptor()).status, 'running');
  assert.equal(validate(descriptor({ proxyUrl: 'http://[::1]:19001', cdpEndpoint: 'http://[::1]:19002' })).status, 'running');
  for (const value of [descriptor({ status: 'starting' }), descriptor({ ok: false })]) {
    assert.throws(() => validate(value), /not running/);
  }
  const invalid = [undefined, 'not a url', 'http://external.test:19001', 'http://localhost:19001',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'https://127.0.0.1:19001',
    'http://user:pass@127.0.0.1:19001', 'http://127.0.0.1:19001/path',
    'http://127.0.0.1:19001/?query', 'http://127.0.0.1:19001/#hash'];
  for (const url of invalid) {
    assert.throws(() => validate(descriptor({ proxyUrl: url })), /loopback/);
    assert.throws(() => validate(descriptor({ cdpEndpoint: url })), /loopback/);
  }
  for (const port of [null, '19002', 0, 19003]) {
    assert.throws(() => validate(descriptor({ cdpPort: port })), /port does not match/);
  }
});

test('desktop preserves useful managed-browser startup errors', async () => {
  const bridge = new AssessmentBrowserBridge({ dashboardJson: async () => { throw new Error('Enable the Browser connector'); } });
  await assert.rejects(bridge.open({ sessionId: 'investigation-alpha', agentId: 'webapp-recon' }), /Enable the Browser connector/);
});
