const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAgentDefinitions, buildAgentSdkOptions, buildAgentDraftSdkOptions, loadRegistry } = require('../lib/harness/agent-sdk');
const { writeChatPreferences } = require('../lib/chat-preferences');
const { createAgentPackageStore } = require('../lib/agent-packages');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reasoning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: root, GLADOS_AGENT_WORKSPACES: path.join(root, 'agents'), GLADOS_BROWSER_MCP: '0', GLADOS_CLIPPY_MCP: '0', GLADOS_SECURITY_REVIEW: '0', GLADOS_FULL_ACCESS: '0', ANTHROPIC_AUTH_TOKEN: 'fixture-token' };
  delete env.GLADOS_TEAM_ID; delete env.GLADOS_CHAT_PREFERENCES_FILE;
  fs.mkdirSync(env.GLADOS_AGENT_WORKSPACES, { recursive: true });
  // Explicit mock aliases avoid depending on the operator's model overrides.
  fs.writeFileSync(path.join(root, 'model-overrides.json'), JSON.stringify({ glados: 'gpt-test-reasoning', 'webapp-recon': 'gpt-test-reasoning', 'api-expert': 'gpt-test-reasoning' }));
  return { root, env, workspaceRoot: env.GLADOS_AGENT_WORKSPACES };
}

test('nested specialists honor their own saved reasoning effort instead of inheriting coordinator effort', t => {
  const { env, workspaceRoot } = fixture(t);
  writeChatPreferences({ agentId: 'glados', effort: 'low' }, env);
  writeChatPreferences({ agentId: 'webapp-recon', effort: 'xhigh' }, env);
  writeChatPreferences({ agentId: 'api-expert', effort: 'medium' }, env);
  const definitions = buildAgentDefinitions(undefined, { env, workspaceRoot });
  assert.equal(definitions['webapp-recon'].effort, 'xhigh');
  assert.equal(definitions['api-expert'].effort, 'medium');
  const root = buildAgentSdkOptions('glados', { env, workspaceRoot });
  assert.equal(root.effort, 'low');
  assert.equal(root.agents['webapp-recon'].effort, 'xhigh');
  assert.equal(root.agents['api-expert'].effort, 'medium');
  assert.equal(buildAgentSdkOptions('webapp-recon', { env, workspaceRoot }).effort, 'xhigh');
  assert.equal(buildAgentSdkOptions('webapp-recon', { env, workspaceRoot, effort: 'low' }).effort, 'low');
});

test('registered built-ins get the documented default when no individual effort is saved', t => {
  const { env, workspaceRoot } = fixture(t);
  const rows = loadRegistry({ env, workspaceRoot });
  assert.ok(rows.length > 20);
  assert.ok(rows.filter(row => !row.packageCapabilities).every(row => row.effort === 'high'));
  const definitions = buildAgentDefinitions(undefined, { env, workspaceRoot });
  assert.ok(Object.keys(definitions).length > 10);
  for (const [agentId, definition] of Object.entries(definitions)) {
    if (!/^deepseek(?:-|$)/i.test(definition.model)) assert.equal(definition.effort, 'high', agentId);
  }
});

test('unsupported provider controls remain omitted while saved preferences stay intact', t => {
  const { root, env, workspaceRoot } = fixture(t);
  fs.writeFileSync(path.join(root, 'model-overrides.json'), JSON.stringify({ 'webapp-recon': 'deepseek-v4' }));
  writeChatPreferences({ agentId: 'webapp-recon', effort: 'xhigh' }, env);
  const definitions = buildAgentDefinitions(undefined, { env, workspaceRoot });
  assert.equal(Object.hasOwn(definitions['webapp-recon'], 'effort'), false);
  assert.equal(Object.hasOwn(buildAgentSdkOptions('webapp-recon', { env, workspaceRoot }), 'effort'), false);
  assert.equal(loadRegistry({ env, workspaceRoot }).find(row => row.id === 'webapp-recon').effort, 'xhigh');
});

test('explicit package none disables extended thinking in direct and draft conversations', t => {
  const { root, env, workspaceRoot } = fixture(t);
  const store = createAgentPackageStore({ runtimeDir: root });
  store.create({ schemaVersion: 1, id: 'reasoning-fixture', version: '1.0.0', name: 'Reasoning fixture', agents: [{ id: 'assistant', name: 'Assistant', instructions: 'Answer briefly.', effort: 'none', model: 'gpt-test-reasoning', tools: [], connectors: [] }] });
  const options = buildAgentSdkOptions('pkg-reasoning-fixture--assistant', { env, workspaceRoot });
  assert.deepEqual(options.thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(options, 'effort'), false);
  const draft = buildAgentDraftSdkOptions({ instructions: 'Answer briefly.', effort: 'none', model: 'gpt-test-reasoning' }, { env });
  assert.deepEqual(draft.thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(draft, 'effort'), false);
  const minimal = buildAgentDraftSdkOptions({ instructions: 'Answer briefly.', effort: 'minimal', model: 'gpt-test-reasoning' }, { env });
  assert.equal(minimal.effort, 'low');
});
