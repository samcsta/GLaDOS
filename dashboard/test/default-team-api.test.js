const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentPackageStore } = require('../lib/agent-packages');

test('default-team API validates installed teams and applies only to newly created chats without an explicit team', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-default-team-api-'));
  const store = createAgentPackageStore({ runtimeDir });
  const installed = store.create({ schemaVersion: 1, id: 'test-crew', version: '1.0.0', name: 'Test crew',
    agents: [{ id: 'coordinator', name: 'Coordinator', instructions: 'Coordinate the test.', tools: ['Read'] }],
    teams: [{ id: 'crew', name: 'Test crew', members: ['coordinator'], coordinator: 'coordinator' }],
  });
  const teamId = 'pkg-test-crew--crew';
  const env = { ...process.env, PORT: '0', GLADOS_RUNTIME_DIR: runtimeDir,
    GLADOS_AGENT_WORKSPACES: path.join(runtimeDir, 'workspaces', 'agents'),
    GLADOS_REPORTS_DIR: path.join(runtimeDir, 'reports'), GLADOS_INVESTIGATIONS_DIR: path.join(runtimeDir, 'investigations'),
    BLACKBOARD_DB: path.join(runtimeDir, 'blackboard', 'blackboard.db'), WATCHDOG_DB: path.join(runtimeDir, 'watchdog', 'watchdog.db'),
    GLADOS_CONTROLLER_WORKER: '0', GLADOS_DESKTOP: '0', GLADOS_CLIPPY_MCP: '0', GLADOS_LITELLM_USAGE_DISABLED: '1',
    GLADOS_LITELLM_UPSTREAM_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'isolated-default-team-test-token',
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
    const timer = setTimeout(() => reject(new Error(`Default-team API startup timed out: ${output}`)), 8000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Default-team API exited ${code}: ${output}`)); });
    child.on('message', message => { if (message.type === 'glados-dashboard-ready') { clearTimeout(timer); resolve(message.url); } });
  });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const initial = await request('/api/settings/default-team');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.defaultTeamId, 'glados');
  assert.equal(initial.body.effectiveTeamId, 'glados');
  assert.deepEqual(initial.body.teams.map(team => team.id), ['glados', teamId]);
  const before = await request('/api/investigation-sessions');
  const existing = before.body.sessions.find(row => row.id === before.body.activeId);
  assert.equal(existing.teamId, 'glados');
  for (const value of [undefined, '', null, {}, 'glados ', 'agent:pkg-test-crew--coordinator', 'pkg-missing--crew']) {
    const result = await request('/api/settings/default-team', 'PATCH', value === undefined ? {} : { defaultTeamId: value });
    assert.equal(result.status, 400);
  }
  await request('/api/settings/operator-profile', 'PATCH', { name: 'Test Operator' });
  const saved = await request('/api/settings/default-team', 'PATCH', { defaultTeamId: teamId });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.defaultTeamId, teamId);
  assert.equal(saved.body.effectiveTeamId, teamId);
  assert.equal(saved.body.fallback, false);
  assert.equal((await request('/api/settings/operator-profile')).body.name, 'Test Operator');
  const created = await request('/api/investigation-sessions', 'POST', { name: 'Uses selected default' });
  assert.equal(created.status, 201);
  assert.equal(created.body.session.teamId, teamId);
  const explicit = await request('/api/investigation-sessions', 'POST', { name: 'Explicit GLaDOS', teamId: 'glados' });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.session.teamId, 'glados');
  const metadata = await request('/api/investigation-sessions', 'POST', { metadata: { teamId: 'glados' } });
  assert.equal(metadata.status, 201);
  assert.equal(metadata.body.session.teamId, 'glados');
  const direct = await request('/api/investigation-sessions', 'POST', { agentId: 'pkg-test-crew--coordinator' });
  assert.equal(direct.status, 201);
  assert.equal(direct.body.session.teamId, 'agent:pkg-test-crew--coordinator');
  for (const value of ['', null, {}]) {
    assert.equal((await request('/api/investigation-sessions', 'POST', { teamId: value })).status, 400);
  }
  const unchanged = (await request('/api/investigation-sessions')).body.sessions.find(row => row.id === existing.id);
  assert.equal(unchanged.teamId, 'glados');
  const disabled = await request('/api/agent-packages/test-crew/enabled', 'PATCH', { enabled: false, expectedRevision: installed.revision });
  assert.equal(disabled.status, 200);
  const fallback = await request('/api/settings/default-team');
  assert.equal(fallback.body.defaultTeamId, teamId);
  assert.equal(fallback.body.effectiveTeamId, 'glados');
  assert.equal(fallback.body.fallback, true);
  assert.deepEqual(fallback.body.teams.map(team => team.id), ['glados']);
  assert.equal((await request('/api/settings/default-team', 'PATCH', { defaultTeamId: teamId })).status, 400);
  const fallbackChat = await request('/api/investigation-sessions', 'POST', {});
  assert.equal(fallbackChat.status, 201);
  assert.equal(fallbackChat.body.session.teamId, 'glados');
  assert.equal((await request('/api/investigation-sessions', 'POST', { teamId })).status, 409);
  const sessions = (await request('/api/investigation-sessions')).body.sessions;
  assert.equal(sessions.find(row => row.id === created.body.session.id).teamId, teamId);
  await request('/api/agent-packages/test-crew/enabled', 'PATCH', { enabled: true, expectedRevision: installed.revision });
  assert.equal((await request('/api/settings/default-team')).body.effectiveTeamId, teamId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'preferences', 'chat.json'))).defaultTeamId, teamId);
});
