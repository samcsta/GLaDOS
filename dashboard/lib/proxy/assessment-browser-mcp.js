#!/usr/bin/env node

// This process exposes the standard Playwright MCP tools, but owns only a CDP
// connection. The dashboard owns the headed browser and its session profile.
const fs = require('node:fs');

function loopbackEndpoint(value, label = 'Browser manager') {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} needs a loopback HTTP endpoint`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || Number(url.port) < 1 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} needs a loopback HTTP endpoint`);
  }
  return url;
}

function managedIdentity(env = process.env) {
  const sessionId = env.GLADOS_SESSION_ID;
  const agentId = env.GLADOS_BROWSER_AGENT_ID;
  for (const [label, value] of [['session', sessionId], ['agent', agentId]]) {
    if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)
      || (label === 'session' && value === 'legacy')) throw new Error(`A managed browser ${label} is required`);
  }
  const manager = loopbackEndpoint(env.GLADOS_BROWSER_MANAGER_URL);
  const proxy = loopbackEndpoint(env.GLADOS_PROXY_URL, 'Session proxy');
  const token = env.GLADOS_BROWSER_MANAGER_TOKEN;
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Browser manager authentication is required');
  return { sessionId, agentId, manager, proxy, token };
}

function validateDescriptor(description, identity) {
  if (!description || description.sessionId !== identity.sessionId || description.agentId !== identity.agentId) {
    throw new Error('Browser manager returned a different session or agent');
  }
  if (description.status !== 'running') throw new Error('The assessment browser is not running');
  const proxy = loopbackEndpoint(description.proxyUrl, 'Session proxy');
  if (proxy.origin !== identity.proxy.origin) throw new Error('Assessment browser uses a different session proxy');
  const endpoint = loopbackEndpoint(description.cdpEndpoint, 'Browser CDP');
  if (Number(endpoint.port) !== description.cdpPort) throw new Error('Assessment browser CDP port does not match its endpoint');
  return endpoint.origin;
}

function createManagedContextGetter({ env = process.env, fetchImpl = globalThis.fetch,
  chromium, timeoutMs = 45000 } = {}) {
  const identity = managedIdentity(env);
  let attached = null;
  let connecting = null;
  let stopped = false;
  const detach = async browser => { try { await browser?.close(); } catch {} };
  const getContext = async () => {
    if (stopped) throw new Error('Browser MCP connection has closed');
    if (attached?.browser.isConnected()) return attached.context;
    if (connecting) return connecting;
    connecting = (async () => {
      const response = await fetchImpl(new URL('/api/proxy/browser/ensure', identity.manager), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: identity.sessionId, agent_id: identity.agentId }),
      });
      if (!response.ok) throw new Error(`Assessment browser startup failed (HTTP ${response.status})`);
      const endpoint = validateDescriptor(await response.json(), identity);
      const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 15000 });
      const context = browser.contexts()[0];
      if (!context || stopped) {
        await detach(browser);
        throw new Error(stopped ? 'Browser MCP connection has closed' : 'Assessment browser has no operator context');
      }
      attached = { browser, context };
      browser.once('disconnected', () => { if (attached?.browser === browser) attached = null; });
      return context;
    })().finally(() => { connecting = null; });
    return connecting;
  };
  getContext.close = async () => {
    stopped = true;
    try { await connecting; } catch {}
    const previous = attached;
    attached = null;
    // For an attached CDP browser this disconnects Playwright. Never close the
    // context: the operator and subsequent turns must retain the same tabs.
    await detach(previous?.browser);
  };
  return getContext;
}

async function createAssessmentBrowserServer({ env = process.env, config = {},
  fetchImpl, chromium = require('playwright').chromium,
  createConnection = require('@playwright/mcp').createConnection } = {}) {
  const getContext = createManagedContextGetter({ env, fetchImpl, chromium });
  const server = await createConnection({
    ...config,
    browser: { browserName: 'chromium', isolated: false },
    capabilities: config.capabilities || ['core', 'network'],
    saveSession: false,
  }, getContext);
  const onclose = server.onclose;
  server.onclose = () => { onclose?.(); void getContext.close(); };
  return { server, getContext };
}

async function main() {
  const configIndex = process.argv.indexOf('--config');
  const config = configIndex >= 0 ? JSON.parse(fs.readFileSync(process.argv[configIndex + 1], 'utf8')) : {};
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { server, getContext } = await createAssessmentBrowserServer({ config });
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => {});
    await getContext.close();
  };
  process.stdin.on('end', () => { void close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  await server.connect(transport);
}

if (require.main === module) main().catch(error => { process.stderr.write(`Assessment browser MCP: ${error.message}\n`); process.exitCode = 1; });

module.exports = { loopbackEndpoint, managedIdentity, validateDescriptor, createManagedContextGetter, createAssessmentBrowserServer };
