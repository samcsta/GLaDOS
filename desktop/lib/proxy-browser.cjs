function validIdentity(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`A valid ${label} is required`);
  }
  return value;
}

function validSessionId(value) { return validIdentity(value, 'investigation session'); }
function validAgentId(value) { return validIdentity(value, 'browser-enabled agent'); }

function loopbackEndpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a dedicated loopback HTTP listener`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be a dedicated loopback HTTP listener`);
  }
  return url;
}

function browserDescriptor(description, sessionId, agentId) {
  if (!description || description.sessionId !== sessionId || description.agentId !== agentId) {
    throw new Error('Assessment browser belongs to another session or agent');
  }
  if (description.ok !== true || description.status !== 'running') throw new Error('The assessment browser is not running');
  loopbackEndpoint(description.proxyUrl, 'Session proxy');
  const endpoint = loopbackEndpoint(description.cdpEndpoint, 'Browser MCP connection');
  if (Number(endpoint.port) !== description.cdpPort) throw new Error('Browser MCP connection port does not match its endpoint');
  return description;
}

function assertProxyBrowserDashboardEvent(event, mainWindow, dashboardOrigin) {
  let origin;
  try { origin = new URL(event.senderFrame?.url).origin; } catch {}
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
    || event.senderFrame !== event.sender.mainFrame || !dashboardOrigin || origin !== dashboardOrigin) {
    throw new Error('Assessment browsers must be opened from the trusted dashboard');
  }
}

// The dashboard owns the headed Playwright browser and Browser MCP attaches to
// that exact context. The desktop shell only forwards trusted operator input.
class AssessmentBrowserBridge {
  constructor({ dashboardJson }) { this.dashboardJson = dashboardJson; }

  async open(input = {}) {
    const sessionId = validSessionId(input?.sessionId);
    const agentId = validAgentId(input?.agentId);
    const description = await this.dashboardJson('/api/proxy/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, agent_id: agentId }),
      timeoutMs: 45000,
    });
    return browserDescriptor(description, sessionId, agentId);
  }
}

module.exports = { AssessmentBrowserBridge, validSessionId, validAgentId, browserDescriptor, assertProxyBrowserDashboardEvent };
