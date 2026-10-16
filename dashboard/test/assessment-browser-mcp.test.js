const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { managedIdentity, validateDescriptor, createManagedContextGetter, createAssessmentBrowserServer } = require('../lib/proxy/assessment-browser-mcp');

function environment(extra = {}) {
  return {
    GLADOS_SESSION_ID: 'investigation-one', GLADOS_BROWSER_AGENT_ID: 'webapp-recon',
    GLADOS_BROWSER_MANAGER_URL: 'http://127.0.0.1:30100',
    GLADOS_BROWSER_MANAGER_TOKEN: 'manager-test-capability', GLADOS_PROXY_URL: 'http://127.0.0.1:30101',
    ...extra,
  };
}

function descriptor(extra = {}) {
  return { sessionId: 'investigation-one', agentId: 'webapp-recon', status: 'running',
    proxyUrl: 'http://127.0.0.1:30101', cdpEndpoint: 'http://127.0.0.1:30102', cdpPort: 30102, ...extra };
}

test('manager capability can only be sent to an explicit loopback endpoint and browser identity must match', () => {
  for (const url of ['https://127.0.0.1:30100', 'http://localhost:30100', 'http://example.com:30100',
    'http://127.0.0.1:30100/other', 'http://user@127.0.0.1:30100', 'http://127.0.0.1:30100?redirect=1']) {
    assert.throws(() => managedIdentity(environment({ GLADOS_BROWSER_MANAGER_URL: url })), /loopback/);
  }
  assert.throws(() => managedIdentity(environment({ GLADOS_SESSION_ID: 'legacy' })), /session/);
  assert.throws(() => managedIdentity(environment({ GLADOS_BROWSER_MANAGER_TOKEN: '' })), /authentication/);
  const identity = managedIdentity(environment());
  for (const changed of [ { sessionId: 'other' }, { agentId: 'webapp-vuln' },
    { proxyUrl: 'http://127.0.0.1:31111' }, { cdpPort: 31112 }, { status: 'stopped' },
    { cdpEndpoint: 'http://example.com:30102' } ]) {
    assert.throws(() => validateDescriptor(descriptor(changed), identity));
  }
  assert.equal(validateDescriptor(descriptor(), identity), 'http://127.0.0.1:30102');
});

test('listing actual Playwright MCP tools never starts or attaches a browser', async t => {
  let starts = 0;
  const { server, getContext } = await createAssessmentBrowserServer({ env: environment(),
    fetchImpl: async () => { starts++; throw new Error('startup unavailable'); },
    chromium: { connectOverCDP() { throw new Error('must not attach'); } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'glados-lazy-browser-test', version: '1.0' });
  t.after(async () => { await client.close(); await server.close(); await getContext.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_tabs', 'browser_network_requests']) {
    assert.ok(tools.some(tool => tool.name === name), `${name} remains the standard Playwright tool`);
  }
  assert.equal(starts, 0);
  const result = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  assert.equal(starts, 1, 'a real tool call starts the manager lookup');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /startup unavailable/);
  await client.listTools();
  assert.equal(starts, 1, 'tool discovery stays available after a failed startup');
});

test('the bridge shares the owned context, deduplicates startup and detaches without closing operator tabs', async () => {
  const calls = [];
  const context = { close() { throw new Error('The operator context must remain open'); } };
  const browsers = [];
  const getter = createManagedContextGetter({ env: environment(),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, json: async () => descriptor() };
    },
    chromium: { async connectOverCDP(endpoint, options) {
      assert.equal(endpoint, descriptor().cdpEndpoint);
      assert.deepEqual(options, { noDefaults: true, timeout: 15000 });
      const browser = new EventEmitter();
      browser.connected = true;
      browser.isConnected = () => browser.connected;
      browser.contexts = () => [context];
      browser.newContext = () => { throw new Error('Must attach to the existing context'); };
      browser.close = async () => { browser.connected = false; browser.emit('disconnected'); };
      browsers.push(browser);
      return browser;
    } },
  });
  const [first, concurrent] = await Promise.all([getter(), getter()]);
  assert.equal(first, context);
  assert.equal(concurrent, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:30100/api/proxy/browser/ensure');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer manager-test-capability');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { session_id: 'investigation-one', agent_id: 'webapp-recon' });
  assert.equal(await getter(), context);
  assert.equal(calls.length, 1);
  await browsers[0].close();
  assert.equal(await getter(), context);
  assert.equal(calls.length, 2);
  await getter.close();
  assert.equal(browsers[1].connected, false);
  await assert.rejects(getter(), /closed/);
});

test('failed or mismatched manager response cannot attach a different browser and remains retryable', async () => {
  let calls = 0;
  let connects = 0;
  const getter = createManagedContextGetter({ env: environment(),
    fetchImpl: async () => ({ ok: true, json: async () => descriptor({ sessionId: ++calls === 1 ? 'wrong' : 'investigation-one' }) }),
    chromium: { connectOverCDP() { connects++; throw new Error('connect attempted'); } },
  });
  await assert.rejects(getter(), /different session/);
  assert.equal(connects, 0);
  await assert.rejects(getter(), /connect attempted/);
  assert.equal(connects, 1);
  await getter.close();
});
