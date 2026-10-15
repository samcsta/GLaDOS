const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

async function fixture(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-session-team-api-'));
  const env = { ...process.env, PORT: '0', GLADOS_RUNTIME_DIR: runtimeDir,
    GLADOS_AGENT_WORKSPACES: path.join(runtimeDir, 'workspaces', 'agents'),
    GLADOS_REPORTS_DIR: path.join(runtimeDir, 'reports'), GLADOS_INVESTIGATIONS_DIR: path.join(runtimeDir, 'investigations'),
    BLACKBOARD_DB: path.join(runtimeDir, 'blackboard', 'blackboard.db'), WATCHDOG_DB: path.join(runtimeDir, 'watchdog', 'watchdog.db'),
    GLADOS_CONTROLLER_WORKER: '0', GLADOS_DESKTOP: '0', GLADOS_CLIPPY_MCP: '0', GLADOS_LITELLM_USAGE_DISABLED: '1',
    GLADOS_LITELLM_UPSTREAM_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'isolated-team-test-token',
  };
  const child = cp.fork(path.join(__dirname, '..', 'server.js'), [], { cwd: path.resolve(__dirname, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode == null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Isolated server startup timed out: ${output}`)), 8000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated server exited ${code}: ${output}`)); });
    child.on('message', message => { if (message.type === 'glados-dashboard-ready') { clearTimeout(timer); resolve(message.url); } });
  });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(url + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const raw = await response.text(); return { status: response.status, raw, json: raw ? JSON.parse(raw) : null };
  };
  request.runtimeDir = runtimeDir;
  return request;
}

test('session API fixes the selected team and gates draft, chat, composer and resume to its roster', async t => {
  const request = await fixture(t);
  const raw = { schemaVersion: 1, id: 'api-team', version: '1.0.0', name: 'API team', agents: [
    { id: 'member', name: 'API member', instructions: 'Review operator-provided text.', tools: ['Read'] },
    { id: 'unassigned', name: 'Unassigned specialist', instructions: 'Read text.', tools: ['Read'] },
  ], teams: [{ id: 'crew', name: 'API crew', members: ['member'], coordinator: 'member' }] };
  const created = await request('/api/agent-packages', 'POST', { package: raw }); assert.equal(created.status, 201, created.raw);
  const selectedId = 'pkg-api-team--crew';
  const defaultDraft = await request('/api/agents?session_id=draft');
  assert.equal(defaultDraft.json.agents.some(agent => agent.packageId), false);
  const selectedDraft = await request(`/api/agents?session_id=draft&team_id=${selectedId}`);
  assert.equal(selectedDraft.status, 200, selectedDraft.raw);
  assert.deepEqual(selectedDraft.json.agents.map(agent => agent.id), ['pkg-api-team--member', selectedId]);
  const otherComposer = await request(`/api/chat/glados/composer?session_id=draft&team_id=${selectedId}`); assert.equal(otherComposer.status, 403);
  const selectedComposer = await request(`/api/chat/${selectedId}/composer?session_id=draft&team_id=${selectedId}`); assert.equal(selectedComposer.status, 200, selectedComposer.raw);
  const sessionResult = await request('/api/investigation-sessions', 'POST', { teamId: selectedId, name: 'Custom crew session' });
  assert.equal(sessionResult.status, 201, sessionResult.raw); const session = sessionResult.json.session;
  assert.equal(session.teamId, selectedId); assert.equal(session.metadata.teamId, selectedId);
  const changed = await request(`/api/investigation-sessions/${session.id}`, 'PATCH', { teamId: 'glados' }); assert.equal(changed.status, 400);
  const foreign = await request('/api/chat/pkg-api-team--unassigned', 'POST', { session_id: session.id, message: 'Try another specialist.' }); assert.equal(foreign.status, 403);
  const glados = await request('/api/chat/glados', 'POST', { session_id: session.id, message: 'What version is GLaDOS?' }); assert.equal(glados.status, 403);
  const ownEmpty = await request(`/api/chat/${selectedId}`, 'POST', { session_id: session.id, message: '' }); assert.equal(ownEmpty.status, 400);
  const foreignResume = await request('/api/resume/source-code', 'POST', { session_id: session.id }); assert.equal(foreignResume.status, 403);
  const slash = await request('/api/slash/run', 'POST', { session_id: session.id, command: '/help' }); assert.equal(slash.status, 409);
  const removed = await request('/api/agent-packages/api-team/teams/crew', 'DELETE', { expectedRevision: created.json.package.revision }); assert.equal(removed.status, 200, removed.raw);
  const unavailableRoster = await request(`/api/agents?session_id=${session.id}`); assert.equal(unavailableRoster.status, 200); assert.equal(unavailableRoster.json.team.available, false);
  const blockedWrite = await request(`/api/chat/${selectedId}`, 'POST', { session_id: session.id, message: 'Continue.' }); assert.equal(blockedWrite.status, 409); assert.match(blockedWrite.json.error, /history is preserved/);
  const navigation = await request('/api/investigation-sessions'); assert.equal(navigation.json.sessions.find(row => row.id === session.id).teamId, selectedId);
});

test('a custom specialist starts and reopens a direct conversation without a team assignment', async t => {
  const request = await fixture(t);
  const raw = { schemaVersion: 1, id: 'direct-specialist', version: '1.0.0', name: 'Direct specialist', agents: [{ id: 'worker', name: 'Direct worker', instructions: 'Read the operator text.', tools: [], model: 'claude-sonnet-5' }] };
  const created = await request('/api/agent-packages', 'POST', { package: raw }); assert.equal(created.status, 201, created.raw);
  const agentId = 'pkg-direct-specialist--worker';
  const catalog = await request('/api/agent-teams');
  assert.equal(catalog.json.directAgents.find(agent => agent.coordinatorId === agentId).kind, 'agent');
  assert.equal(catalog.json.teams.find(team => team.id === 'glados').memberIds.includes(agentId), false);
  const draft = await request(`/api/agents?session_id=draft&team_id=${encodeURIComponent(`agent:${agentId}`)}`);
  assert.deepEqual(draft.json.agents.map(agent => agent.id), [agentId]);
  const result = await request('/api/investigation-sessions', 'POST', { agentId });
  assert.equal(result.status, 201, result.raw); const session = result.json.session;
  assert.equal(session.kind, 'agent'); assert.equal(session.teamId, `agent:${agentId}`);
  assert.equal(session.metadata.directAgentId, agentId);
  const sent = await request(`/api/chat/${agentId}`, 'POST', { session_id: session.id, message: 'Inspect this isolated test text.' });
  assert.equal(sent.status, 202, sent.raw);
  const stopped = await request(`/api/chat/${agentId}/stop`, 'POST', { session_id: session.id }); assert.equal(stopped.status, 200, stopped.raw);
  const db = new Database(path.join(request.runtimeDir, 'blackboard', 'blackboard.db'), { readonly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dashboard_transcript_events WHERE session_id=? AND agent_id=? AND kind='user-message'").get(session.id, agentId).n, 1); }
  finally { db.close(); }
  const other = await request('/api/investigation-sessions', 'POST', { teamId: 'glados' }); assert.equal(other.status, 201, other.raw);
  const reopened = await request(`/api/investigation-sessions/${session.id}/activate`, 'POST', {});
  assert.equal(reopened.json.session.directAgentId, agentId);
  const roster = await request(`/api/agents?session_id=${session.id}`); assert.deepEqual(roster.json.agents.map(agent => agent.id), [agentId]);
  const foreign = await request('/api/chat/glados', 'POST', { session_id: session.id, message: 'What version is GLaDOS?' }); assert.equal(foreign.status, 403);
  const foreignComposer = await request(`/api/chat/glados/composer?session_id=${session.id}`); assert.equal(foreignComposer.status, 403);
  const disabled = await request('/api/agent-packages/direct-specialist/enabled', 'PATCH', { enabled: false, expectedRevision: created.json.package.revision }); assert.equal(disabled.status, 200, disabled.raw);
  const unavailable = await request('/api/investigation-sessions', 'POST', { agentId }); assert.equal(unavailable.status, 409);
  const retained = await request(`/api/agents?session_id=${session.id}`); assert.equal(retained.json.team.available, false);
  const archivedPackage = await request('/api/agent-packages/direct-specialist', 'DELETE', { expectedRevision: created.json.package.revision }); assert.equal(archivedPackage.status, 200, archivedPackage.raw);
  const historical = await request(`/api/agents?session_id=${session.id}`); assert.equal(historical.json.team.coordinatorId, agentId); assert.equal(historical.json.team.kind, 'agent');
  const deleted = await request(`/api/investigation-sessions/${session.id}`, 'DELETE', {}); assert.equal(deleted.status, 200, deleted.raw);
});
