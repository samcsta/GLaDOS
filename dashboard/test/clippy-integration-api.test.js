const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Clippy connection and dedicated chat work through the dashboard without sharing assessment rosters', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-clippy-api-'));
  const env = { ...process.env, PORT: '0', GLADOS_RUNTIME_DIR: runtimeDir,
    GLADOS_AGENT_WORKSPACES: path.join(runtimeDir, 'workspaces', 'agents'),
    GLADOS_REPORTS_DIR: path.join(runtimeDir, 'reports'), GLADOS_INVESTIGATIONS_DIR: path.join(runtimeDir, 'investigations'),
    BLACKBOARD_DB: path.join(runtimeDir, 'blackboard', 'blackboard.db'), WATCHDOG_DB: path.join(runtimeDir, 'watchdog', 'watchdog.db'),
    GLADOS_CONTROLLER_WORKER: '0', GLADOS_DESKTOP: '0', GLADOS_CLIPPY_MCP: '1', GLADOS_LITELLM_USAGE_DISABLED: '1',
    GLADOS_LITELLM_UPSTREAM_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'isolated-clippy-test-token',
  };
  const child = cp.fork(path.resolve(__dirname, '../server.js'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode == null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Clippy API startup timed out: ${output}`)), 8000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Clippy API exited ${code}: ${output}`)); });
    child.on('message', message => { if (message.type === 'glados-dashboard-ready') { clearTimeout(timer); resolve(message.url); } });
  });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const disconnected = await request('/api/clippy/status');
  assert.equal(disconnected.body.connected, false);
  assert.equal(disconnected.body.agentExists, false);
  assert.equal(disconnected.body.agentAvailable, false);
  assert.equal((await request('/api/agent-packages/clippy-intel')).status, 404);
  assert.equal((await request('/api/clippy/agent/start', 'POST', {})).status, 409);
  assert.equal((await request('/api/clippy/chat-session', 'POST', {})).status, 409);
  const connection = await request('/api/settings/clippy', 'PUT', { token: 'private-fixture-key' });
  assert.equal(connection.status, 200);
  assert.equal(connection.body.restartRecommended, false);
  assert.equal(JSON.stringify(connection.body).includes('private-fixture-key'), false);
  assert.equal((await request('/api/agent-packages/clippy-intel')).status, 404);
  for (const route of ['/api/clippy/agent/start', '/api/clippy/chat-session']) {
    for (const body of [{}, { createAgent: false }, { createAgent: 'true' }]) {
      const declined = await request(route, 'POST', body);
      assert.equal(declined.status, 409);
      assert.equal(declined.body.code, 'agent_consent_required');
    }
  }
  assert.equal((await request('/api/agent-packages/clippy-intel')).status, 404);
  const start = await request('/api/clippy/agent/start', 'POST', { createAgent: true });
  assert.equal(start.status, 200);
  assert.equal(start.body.agentAvailable, true);
  assert.equal(start.body.agentExists, true);
  const { agentId, teamId } = start.body;
  const draftRoster = await request(`/api/agents?session_id=draft&team_id=${encodeURIComponent(teamId)}`);
  assert.deepEqual(draftRoster.body.agents.map(agent => agent.id), [agentId]);
  assert.equal(draftRoster.body.agents[0].name, 'Clippy Agent');
  const assessment = await request('/api/investigation-sessions');
  const inline = await request('/api/clippy/chat-session', 'POST', {});
  assert.equal(inline.status, 200);
  assert.equal(inline.body.session.state, 'archived');
  assert.equal(inline.body.session.metadata.surface, 'clippy');
  assert.equal(inline.body.teamId, teamId);
  const inlineId = inline.body.sessionId;
  assert.equal((await request('/api/investigation-sessions')).body.activeId, assessment.body.activeId);
  assert.equal((await request('/api/clippy/chat-session', 'POST', {})).body.sessionId, inlineId);
  assert.equal((await request(`/api/chat/${agentId}/composer`, 'PATCH', { session_id: inlineId, effort: 'medium' })).status, 200);
  assert.equal((await request(`/api/chat/${agentId}`, 'POST', { session_id: inlineId, message: '' })).status, 400);
  assert.equal((await request('/api/chat/report-writer', 'POST', { session_id: inlineId, message: '' })).status, 403);
  const normalArchived = await request('/api/investigation-sessions', 'POST', { name: 'Archived assessment', activate: false });
  assert.equal((await request('/api/chat/glados/composer', 'PATCH', { session_id: normalArchived.body.session.id, effort: 'medium' })).status, 409);
  assert.equal((await request('/api/investigation-sessions')).body.activeId, assessment.body.activeId);
  assert.equal((await request(`/api/investigation-sessions/${inlineId}/archive`, 'POST', {})).status, 200);
  assert.equal((await request(`/api/chat/${agentId}/composer`, 'PATCH', { session_id: inlineId, effort: 'medium' })).status, 409);
  assert.notEqual((await request('/api/clippy/chat-session', 'POST', {})).body.sessionId, inlineId);
  const session = await request('/api/investigation-sessions', 'POST', { teamId, name: 'Clippy lookup' });
  assert.equal(session.status, 201);
  assert.equal(session.body.session.teamId, teamId);
  const sid = session.body.session.id;
  assert.equal((await request(`/api/chat/${agentId}/composer?session_id=${sid}`)).status, 200);
  assert.equal((await request(`/api/chat/glados/composer?session_id=${sid}`)).status, 403);
  const disconnect = await request('/api/connectors/clippy/disconnect', 'POST', {});
  assert.equal(disconnect.status, 200);
  assert.equal(disconnect.body.connector.configured, false);
  assert.equal((await request('/api/clippy/agent/start', 'POST', {})).status, 409);
  const sessions = await request('/api/investigation-sessions');
  assert.ok(sessions.body.sessions.some(row => row.id === sid));
});
