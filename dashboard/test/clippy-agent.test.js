const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentPackageStore } = require('../lib/agent-packages');
const { saveClippyToken, removeClippyToken, READ_TOOLS } = require('../lib/secrets/clippy-mcp');
const { enableClippyAgent, clippyAgentInfo, CLIPPY_AGENT_ID, CLIPPY_TEAM_ID, CLIPPY_AGENT_SOURCE_PATH } = require('../lib/clippy-agent');
const { buildAgentSdkOptions, loadRegistry, decideToolUse } = require('../lib/harness/agent-sdk');
const { resolveAgentTeam } = require('../lib/agent-teams');

function fixture(t, { install = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-clippy-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: root, GLADOS_AGENT_WORKSPACES: path.join(root, 'agents'), GLADOS_CLIPPY_MCP: '1', GLADOS_BROWSER_MCP: '0', GLADOS_SECURITY_REVIEW: '0', GLADOS_FULL_ACCESS: '0', ANTHROPIC_AUTH_TOKEN: 'test-token' };
  for (const key of ['GLADOS_TEAM_ID', 'GLADOS_BROWSER_MCP_COMMAND', 'GLADOS_BROWSER_MCP_ARGS', 'GLADOS_BROWSER_MCP_ARGS_JSON']) delete env[key];
  const store = createAgentPackageStore({ runtimeDir: root });
  if (install) store.installIntegration(fs.readFileSync(CLIPPY_AGENT_SOURCE_PATH, 'utf8'), { sourcePath: CLIPPY_AGENT_SOURCE_PATH });
  return { root, env, store };
}

test('Clippy chat activation requires connection and explicit consent before enabling the dedicated integration', t => {
  const { env, store } = fixture(t);
  assert.equal(clippyAgentInfo(store).agentAvailable, false);
  assert.equal(clippyAgentInfo(store).agentExists, true);
  assert.throws(() => enableClippyAgent({ store, env }), /Connect Clippy/);
  saveClippyToken('private-test-key', env);
  const initialBytes = fs.readFileSync(store.indexFile, 'utf8');
  assert.throws(() => enableClippyAgent({ store, env }), error => error.status === 409 && error.code === 'agent_consent_required');
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), initialBytes);
  const result = enableClippyAgent({ store, env, createAgent: true });
  assert.equal(result.agentId, CLIPPY_AGENT_ID);
  assert.equal(result.teamId, CLIPPY_TEAM_ID);
  assert.equal(result.agentAvailable, true);
  const team = resolveAgentTeam(loadRegistry({ env }), { env, teamId: result.teamId });
  assert.deepEqual(team.rosterIds, [CLIPPY_AGENT_ID]);
  assert.deepEqual(team.memberIds, []);
  assert.equal(JSON.stringify(result).includes('private-test-key'), false);
  store.setEntryEnabled(CLIPPY_AGENT_ID, false, { expectedRevision: store.get('clippy-intel').revision });
  assert.equal(clippyAgentInfo(store).agentAvailable, false);
  const disabledBytes = fs.readFileSync(store.indexFile, 'utf8');
  assert.throws(() => enableClippyAgent({ store, env }), error => error.code === 'agent_consent_required');
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), disabledBytes);
  assert.equal(enableClippyAgent({ store, env, createAgent: true }).agentAvailable, true);
  assert.equal(resolveAgentTeam(loadRegistry({ env }), { env, teamId: CLIPPY_TEAM_ID }).available, true);
});

test('Clippy Agent can query allowed knowledge tools without shell, target actions, or delegation', t => {
  const { env, store } = fixture(t);
  saveClippyToken('private-test-key', env);
  enableClippyAgent({ store, env, createAgent: true });
  const turnEnv = { ...env, GLADOS_TEAM_ID: CLIPPY_TEAM_ID };
  const options = buildAgentSdkOptions(CLIPPY_AGENT_ID, { env: turnEnv });
  assert.deepEqual(Object.keys(options.mcpServers), ['clippy']);
  assert.ok(options.gladosMountedTools.length >= 4);
  for (const tool of options.gladosMountedTools) {
    assert.ok(tool.startsWith('mcp__clippy__'));
    assert.ok(READ_TOOLS.has(tool.slice('mcp__clippy__'.length)));
  }
  for (const toolName of ['Bash', 'Task', 'Write', 'mcp__clippy__context_put', 'mcp__clippy__start_session']) {
    assert.equal(decideToolUse({ agentId: CLIPPY_AGENT_ID, toolName, input: {}, env: turnEnv }).allowed, false);
  }
  assert.equal(decideToolUse({ agentId: CLIPPY_AGENT_ID, toolName: 'mcp__clippy__search', input: { query: 'severity' }, env: turnEnv }).allowed, true);
  removeClippyToken(env);
  assert.throws(() => buildAgentSdkOptions(CLIPPY_AGENT_ID, { env: turnEnv }), /requires unavailable connectors: clippy/);
  assert.equal(decideToolUse({ agentId: CLIPPY_AGENT_ID, toolName: 'mcp__clippy__search', input: { query: 'severity' }, env: turnEnv }).allowed, false);
});

test('Clippy operator edits persist across startup seeding and govern the dedicated chat runtime', t => {
  const { env, store, root } = fixture(t);
  const first = store.get('clippy-intel');
  assert.equal(first.editableIntegration, true);
  const draft = structuredClone(first.manifest);
  Object.assign(draft.agents[0], {
    name: 'My Clippy', instructions: 'Compare critical domain leads and explicitly state report coverage uncertainty.',
    model: 'operator-model', effort: 'low', tools: ['mcp__clippy__search', 'mcp__clippy__read'],
    deliverables: ['Ranked domains with source references and report coverage'],
  });
  const edited = store.save(first.id, draft, { expectedRevision: first.revision });
  assert.equal(edited.editableIntegration, true);
  const restarted = createAgentPackageStore({ runtimeDir: root });
  const source = structuredClone(first.manifest); source.version = '9.0.0';
  source.agents[0].instructions = 'Stale source defaults must not replace operator settings.';
  const before = fs.readFileSync(store.indexFile, 'utf8');
  const seeded = restarted.installIntegration(source, { sourcePath: 'clippy-intel.glados-agent.json' });
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), before);
  assert.equal(seeded.revision, edited.revision);
  assert.equal(seeded.staged.length, 0);
  saveClippyToken('private-test-key', env);
  const enabled = enableClippyAgent({ store: restarted, env, createAgent: true });
  assert.equal(enabled.agentName, 'My Clippy');
  const runtime = restarted.runtimeEntries().find(entry => entry.id === CLIPPY_AGENT_ID);
  assert.equal(runtime.instructions, draft.agents[0].instructions);
  assert.equal(runtime.model, 'operator-model'); assert.equal(runtime.effort, 'low');
  assert.deepEqual(runtime.tools, draft.agents[0].tools);
  assert.deepEqual(runtime.deliverables, draft.agents[0].deliverables);
  assert.equal(runtime.editableIntegration, true);
});

test('editing Clippy cannot widen its trusted read-only capability boundary or change its identity', t => {
  const { store } = fixture(t);
  const first = store.get('clippy-intel');
  for (const change of [
    draft => draft.agents[0].tools.push('Bash'),
    draft => draft.agents[0].tools.push('mcp__clippy__context_put'),
    draft => draft.agents[0].connectors.push('browser'),
    draft => { draft.agents[0].id = 'replacement'; },
    draft => draft.teams.push({ id: 'crew', members: ['clippy'] }),
  ]) {
    const draft = structuredClone(first.manifest); change(draft);
    assert.throws(() => store.save(first.id, draft, { expectedRevision: first.revision }), /capabilities are limited|preserve its Clippy Agent identity/);
  }
  assert.equal(store.get(first.id).revision, first.revision);
});

test('default Clippy triage distinguishes checked report evidence from unknown Dradis coverage', t => {
  const { store } = fixture(t);
  const instructions = store.get('clippy-intel').manifest.agents[0].instructions;
  assert.match(instructions, /ranked list with the domain, severity, source evidence, report coverage/);
  assert.match(instructions, /missing report in Clippy does not establish that no Dradis report exists/);
  assert.match(instructions, /state which sources were checked/);
});

test('a Clippy connection alone cannot install an agent and explicit consent creates the trusted default once', t => {
  const { env, store } = fixture(t, { install: false });
  saveClippyToken('private-test-key', env);
  assert.equal(clippyAgentInfo(store).agentExists, false);
  assert.equal(clippyAgentInfo(store).agentAvailable, false);
  for (const createAgent of [undefined, false, 'true']) {
    assert.throws(() => enableClippyAgent({ store, env, createAgent }), error => error.status === 409 && error.code === 'agent_consent_required');
    assert.equal(fs.existsSync(store.indexFile), false);
  }
  const result = enableClippyAgent({ store, env, createAgent: true });
  assert.equal(result.agentExists, true);
  assert.equal(result.agentAvailable, true);
  assert.equal(store.get('clippy-intel').managedSource, path.basename(CLIPPY_AGENT_SOURCE_PATH));
  const bytes = fs.readFileSync(store.indexFile, 'utf8');
  assert.equal(enableClippyAgent({ store, env }).agentAvailable, true);
  assert.equal(enableClippyAgent({ store, env, createAgent: true }).agentAvailable, true);
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), bytes);
});

test('consented reuse and archived restoration preserve the operator agent definition and history', t => {
  const { env, store } = fixture(t);
  saveClippyToken('private-test-key', env);
  const first = store.get('clippy-intel');
  const draft = structuredClone(first.manifest);
  Object.assign(draft.agents[0], { instructions: 'Keep my existing instructions.', model: 'my-model', effort: 'low', tools: ['mcp__clippy__read'], deliverables: ['My deliverable'] });
  const edited = store.save(first.id, draft, { expectedRevision: first.revision });
  enableClippyAgent({ store, env, createAgent: true });
  let current = store.get(first.id);
  assert.equal(current.revision, edited.revision);
  const enabledBytes = fs.readFileSync(store.indexFile, 'utf8');
  assert.equal(enableClippyAgent({ store, env }).agentExists, true);
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), enabledBytes);
  store.remove(first.id, { expectedRevision: current.revision });
  assert.equal(clippyAgentInfo(store).agentExists, false);
  assert.equal(clippyAgentInfo(store).agentAvailable, false);
  const archivedBytes = fs.readFileSync(store.indexFile, 'utf8');
  assert.throws(() => enableClippyAgent({ store, env }), error => error.code === 'agent_consent_required');
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), archivedBytes);
  const restored = enableClippyAgent({ store, env, createAgent: true });
  assert.equal(restored.agentExists, true); assert.equal(restored.agentAvailable, true);
  current = store.get(first.id);
  assert.equal(current.revision, edited.revision);
  assert.equal(current.versions.length, edited.versions.length);
  assert.deepEqual(current.manifest, draft);
});

test('consent never replaces another package or a managed integration with a missing Clippy identity', t => {
  for (const managed of [false, true]) {
    const { env, store } = fixture(t, { install: false });
    saveClippyToken('private-test-key', env);
    const source = JSON.parse(fs.readFileSync(CLIPPY_AGENT_SOURCE_PATH, 'utf8'));
    source.agents[0].id = 'custom-agent';
    const created = managed ? store.installIntegration(source, { sourcePath: CLIPPY_AGENT_SOURCE_PATH }) : store.create(source);
    const bytes = fs.readFileSync(store.indexFile, 'utf8');
    assert.equal(clippyAgentInfo(store).agentExists, false);
    assert.throws(() => enableClippyAgent({ store, env, createAgent: true }), error => error.status === 409 && error.code === 'agent_unavailable');
    assert.equal(fs.readFileSync(store.indexFile, 'utf8'), bytes);
    assert.equal(store.get(created.id).revision, created.revision);
  }
});
