const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAgentPackageStore } = require('../lib/agent-packages');
const { createConnectorStore } = require('../lib/connectors');
const { createAgentTeamStore } = require('../lib/agent-teams');
const {
  loadRegistry, loadPolicy, mountedToolsForAgent, buildAgentSdkOptions,
  buildAgentDefinitions, assembleAgentPrompt, decideToolUse, taskAllowlist,
  testAgentDraft,
} = require('../lib/harness/agent-sdk');
const { planCheckDispatch } = require('glados-watchdog/lib/plan-gate');
const { evaluateToolUse } = require('glados-watchdog/lib/safety-gate');

function fixture(t, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-package-harness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: root, GLADOS_AGENT_WORKSPACES: path.join(root, 'agents'), GLADOS_CLIPPY_MCP: '0', GLADOS_BROWSER_MCP: '0', GLADOS_FULL_ACCESS: '0', ANTHROPIC_AUTH_TOKEN: 'test-token', BLACKBOARD_DB: path.join(root, 'blackboard.db') };
  for (const key of ['GLADOS_BROWSER_MCP_COMMAND', 'GLADOS_BROWSER_MCP_ARGS', 'GLADOS_BROWSER_MCP_ARGS_JSON']) delete env[key];
  const store = createAgentPackageStore({ runtimeDir: root });
  store.create(manifest);
  return { root, env, store };
}

function agent(id, extra = {}) {
  return { id, name: id, description: `Handles ${id} tasks`, instructions: `Perform the ${id} assignment.`, model: 'gpt-6-sol', effort: 'xhigh', tools: ['Read', 'Grep'], connectors: [], deliverables: ['A structured result'], ...extra };
}

function manifest(extra = {}) {
  return { schemaVersion: 1, id: 'my-specialists', name: 'My specialists', version: '1.0.0', agents: [agent('reviewer')], teams: [], resources: [], ...extra };
}

test('package runtime uses immutable revision prompts, model, effort, deliverables and skills', t => {
  const { env, root } = fixture(t, manifest({ agents: [agent('reviewer', { skills: [{ id: 'triage', name: 'Triage', instructions: 'Always distinguish evidence from assumptions.' }] })] }));
  const id = 'pkg-my-specialists--reviewer';
  const row = loadRegistry({ env }).find(row => row.id === id);
  assert.equal(row.packageCapabilities, true);
  assert.ok(row.workspace.startsWith(path.join(root, 'agent-packages', 'workspaces')));
  fs.mkdirSync(path.join(env.GLADOS_AGENT_WORKSPACES, id), { recursive: true });
  fs.writeFileSync(path.join(env.GLADOS_AGENT_WORKSPACES, id, 'agent.json'), JSON.stringify({ tools: ['Bash'], workspace: '/tmp/untrusted' }));
  const assembled = assembleAgentPrompt(id, { env });
  assert.equal(assembled.source, 'package');
  assert.match(assembled.prompt, /Always distinguish evidence from assumptions/);
  const options = buildAgentSdkOptions(id, { env });
  assert.equal(options.model, 'gpt-6-sol');
  assert.equal(options.effort, 'xhigh');
  assert.match(options.systemPrompt, /A structured result/);
  assert.deepEqual(options.gladosMountedTools, ['Read', 'Grep']);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.permissionMode, 'default');
  const mutation = decideToolUse({ agentId: 'glados', toolName: 'Write', input: { file_path: path.join(row.workspace, 'AGENTS.md'), content: 'replace package instructions' }, env });
  assert.equal(mutation.allowed, false);
  assert.match(mutation.reason, /managed in Agents/);
  const definitions = buildAgentDefinitions(loadPolicy(), { env });
  assert.equal(definitions[id].effort, 'xhigh');
  assert.match(definitions[id].prompt, /Always distinguish evidence from assumptions/);
  assert.deepEqual(definitions[id].skills, [], 'package skills are preloaded from their own revision, not ambiguous global SDK names');
});

test('package capabilities cannot mount unselected MCPs, Full Access or arbitrary delegation', t => {
  const { env } = fixture(t, manifest({ agents: [agent('reviewer', { tools: ['Read', 'Bash', 'WebFetch', 'Agent', 'mcp__watchdog__agent_halt', 'mcp__glados-ops__desktop_click'] })] }));
  const id = 'pkg-my-specialists--reviewer';
  assert.deepEqual(mountedToolsForAgent(id, loadPolicy(), { env }), ['Read', 'Bash']);
  assert.equal(decideToolUse({ agentId: id, toolName: 'Agent', input: { subagent_type: 'source-code' }, env }).allowed, false);
  assert.equal(decideToolUse({ agentId: id, toolName: 'mcp__watchdog__agent_halt', input: { agent_id: 'glados' }, env }).allowed, false);
  const review = mountedToolsForAgent(id, loadPolicy(), { env: { ...env, GLADOS_SECURITY_REVIEW: '1' } });
  assert.deepEqual(review, ['Read']);
});

test('package prompts load only canonical instructions and skills selected for that member', t => {
  const { env } = fixture(t, manifest({
    agents: [agent('reviewer', { skills: [{ id: 'selected', instructions: 'SELECTED_SKILL_CONTENT' }] }), agent('other', { skills: [{ id: 'other-role', instructions: 'OTHER_ROLE_SKILL_CONTENT' }] })],
    resources: [{ path: 'skills/unselected/SKILL.md', text: 'UNSELECTED_RESOURCE_SKILL_CONTENT' }],
  }));
  const id = 'pkg-my-specialists--reviewer';
  const row = loadRegistry({ env }).find(row => row.id === id);
  fs.writeFileSync(path.join(row.workspace, 'USER.md'), 'UNDECLARED_USER_PROMPT_CONTENT');
  fs.mkdirSync(path.join(row.workspace, 'skills', 'extra'), { recursive: true });
  fs.writeFileSync(path.join(row.workspace, 'skills', 'extra', 'SKILL.md'), 'UNDECLARED_EXTRA_SKILL_CONTENT');
  const assembled = assembleAgentPrompt(id, { env });
  assert.match(assembled.prompt, /SELECTED_SKILL_CONTENT/);
  for (const marker of ['OTHER_ROLE_SKILL_CONTENT', 'UNSELECTED_RESOURCE_SKILL_CONTENT', 'UNDECLARED_USER_PROMPT_CONTENT', 'UNDECLARED_EXTRA_SKILL_CONTENT']) assert.equal(assembled.prompt.includes(marker), false, marker);
  assert.deepEqual(assembled.skills, ['selected']);
});

test('an unavailable required connector blocks a saved package turn and dispatch', t => {
  const { env } = fixture(t, manifest({ agents: [agent('reviewer', { connectors: ['not-installed'] })] }));
  const id = 'pkg-my-specialists--reviewer';
  assert.throws(() => buildAgentSdkOptions(id, { env }), /requires unavailable connectors: not-installed/);
  const decision = decideToolUse({ agentId: 'glados', toolName: 'Agent', input: { subagent_type: id }, env });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /requires unavailable connectors/);
});

test('selected connectors expose only the individually declared tools and never inherit other connector mounts', t => {
  const { env } = fixture(t, manifest({ agents: [agent('reviewer', { connectors: ['issue-hub'], tools: ['Read', 'mcp__user-issue-hub__read_issue', 'mcp__user-issue-hub__read__history', 'mcp__user-issue-hub__*', 'mcp__watchdog__target_mark'] })] }));
  createConnectorStore({ env }).save({ id: 'issue-hub', name: 'Issue hub', type: 'stdio', command: 'node', args: ['fake-mcp.js'], tools: ['read_issue', 'read__history', 'write_issue'], enabled: true });
  const options = buildAgentSdkOptions('pkg-my-specialists--reviewer', { env });
  assert.deepEqual(options.gladosMountedTools, ['Read', 'mcp__user-issue-hub__read_issue', 'mcp__user-issue-hub__read__history']);
  assert.deepEqual(Object.keys(options.mcpServers), ['user-issue-hub']);
  const denied = decideToolUse({ agentId: 'pkg-my-specialists--reviewer', toolName: 'mcp__user-issue-hub__write_issue', input: { id: '123' }, env });
  assert.equal(denied.allowed, false);
});

test('GLaDOS can invoke an imported team, and only its coordinator can delegate to scoped members', t => {
  const { env } = fixture(t, manifest({ agents: [agent('lead'), agent('analyst')], teams: [{ id: 'crew', name: 'Crew', coordinator: 'lead', members: ['lead', 'analyst'], instructions: 'Combine the member reports.' }] }));
  const teamId = 'pkg-my-specialists--crew';
  const memberId = 'pkg-my-specialists--analyst';
  const topLevel = taskAllowlist(loadPolicy(), { env });
  assert.ok(topLevel.has(teamId));
  assert.equal(topLevel.has(memberId), false);
  assert.equal(decideToolUse({ agentId: 'glados', toolName: 'Agent', input: { subagent_type: teamId }, env }).allowed, true);
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: memberId }, env }).allowed, true);
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: 'source-code' }, env }).allowed, false);
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: memberId, run_in_background: true }, env }).allowed, false);
  const options = buildAgentSdkOptions(teamId, { env });
  assert.ok(options.tools.includes('Agent'));
  assert.ok(options.agents[memberId]);
  assert.equal(options.agents['source-code'], undefined);
  assert.match(options.systemPrompt, /Coordinate this package's team/);
});

test('one GLaDOS query exposes team members and scopes nested SDK hook callers to their configured capabilities', async t => {
  const { env } = fixture(t, manifest({ agents: [agent('lead'), agent('analyst', { tools: ['Read'] })], teams: [{ id: 'crew', name: 'Crew', coordinator: 'lead', members: ['lead', 'analyst'] }] }));
  const teamId = 'pkg-my-specialists--crew';
  const memberId = 'pkg-my-specialists--analyst';
  const options = buildAgentSdkOptions('glados', { env });
  assert.ok(options.agents[teamId]);
  assert.ok(options.agents[memberId], 'the parent SDK query includes definitions used by a delegated team');
  assert.ok(options.agents[teamId].tools.includes('Agent'));
  assert.deepEqual(options.agents[memberId].tools, ['Read']);
  const start = options.hooks.SubagentStart[0].hooks[0];
  const pre = options.hooks.PreToolUse[0].hooks[0];
  const parentDispatch = await pre({ tool_name: 'Agent', tool_input: { subagent_type: teamId }, tool_use_id: 'parent-tool' });
  assert.equal(parentDispatch.hookSpecificOutput.permissionDecision, undefined);
  await start({ agent_id: 'sdk-team', agent_type: teamId });
  const nestedDispatch = await pre({ agent_id: 'sdk-team', tool_name: 'Agent', tool_input: { subagent_type: memberId, name: memberId, model: 'unconfigured-model' }, tool_use_id: 'team-tool' });
  assert.equal(nestedDispatch.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(nestedDispatch.hookSpecificOutput.updatedInput.subagent_type, memberId);
  assert.equal(nestedDispatch.hookSpecificOutput.updatedInput.name, undefined, 'nested SDK members are subagents rather than flat named teammates');
  assert.equal(nestedDispatch.hookSpecificOutput.updatedInput.model, undefined);
  const permission = await options.canUseTool('Agent', { subagent_type: memberId, name: memberId }, { agentID: 'sdk-team' });
  assert.equal(permission.behavior, 'allow');
  assert.equal(permission.updatedInput.name, undefined);
  await start({ agent_id: 'sdk-member', agent_type: memberId });
  const read = await pre({ agent_id: 'sdk-member', tool_name: 'Read', tool_input: { file_path: '/tmp/example.txt' }, tool_use_id: 'member-read' });
  assert.equal(read.hookSpecificOutput.permissionDecision, undefined);
  const shell = await pre({ agent_id: 'sdk-member', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'member-shell' });
  assert.equal(shell.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(shell.hookSpecificOutput.permissionDecisionReason, /not mounted/);
  const outside = await pre({ agent_id: 'sdk-team', tool_name: 'Agent', tool_input: { subagent_type: 'source-code' }, tool_use_id: 'outside' });
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
});

test('a selected custom session team excludes unrelated teams and permits only explicitly assigned built-in specialists', async t => {
  const { env: baseEnv } = fixture(t, manifest({
    agents: [agent('lead'), agent('analyst'), agent('outsider'), agent('other-lead'), agent('other-analyst')],
    teams: [
      { id: 'crew', name: 'Crew', coordinator: 'lead', members: ['lead', 'analyst'] },
      { id: 'other-crew', name: 'Other crew', coordinator: 'other-lead', members: ['other-lead', 'other-analyst'] },
    ],
  }));
  const teamId = 'pkg-my-specialists--crew';
  const env = { ...baseEnv, GLADOS_TEAM_ID: teamId, GLADOS_FULL_ACCESS: '1' };
  const outsiderId = 'pkg-my-specialists--outsider';
  const policy = loadPolicy();
  assert.deepEqual([...taskAllowlist(policy, { env, callerAgentId: teamId })].sort(), ['pkg-my-specialists--analyst', 'pkg-my-specialists--lead']);
  assert.equal(taskAllowlist(policy, { env, callerAgentId: 'glados' }).size, 0);
  assert.deepEqual(mountedToolsForAgent(outsiderId, policy, { env }), []);
  assert.throws(() => buildAgentSdkOptions(outsiderId, { env }), /unavailable in the selected session team/);
  assert.throws(() => buildAgentSdkOptions('glados', { env }), /unavailable in the selected session team/);
  const before = buildAgentSdkOptions(teamId, { env });
  assert.equal(before.permissionMode, 'default', 'selecting a custom team never grants GLaDOS Full Access');
  assert.equal(before.allowDangerouslySkipPermissions, false);
  assert.equal(before.agents['source-code'], undefined);
  assert.equal(before.agents['pkg-my-specialists--other-crew'], undefined);
  assert.equal(before.agents[outsiderId], undefined);
  assert.doesNotMatch(before.systemPrompt, /you cannot call.*built-in/);
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: 'source-code' }, env }).allowed, false);
  const rows = loadRegistry({ env });
  const teamStore = createAgentTeamStore({ env });
  teamStore.save(teamId, ['source-code', 'pkg-my-specialists--other-lead'], { expectedRevision: teamStore.get(teamId, rows).revision, registryRows: rows });
  const after = buildAgentSdkOptions(teamId, { env });
  assert.ok(after.agents['source-code']);
  assert.ok(after.agents['pkg-my-specialists--other-lead'], 'an explicitly assigned specialist is available even if it belongs to another team');
  assert.equal(after.agents['pkg-my-specialists--other-analyst'], undefined, 'assigning a specialist never imports its old teammates');
  assert.equal(after.agents['pkg-my-specialists--other-lead'].tools.includes('Agent'), false);
  assert.equal(after.agents['report-writer'], undefined);
  assert.match(after.systemPrompt, /source-code/);
  assert.match(after.agents['source-code'].criticalSystemReminder_EXPERIMENTAL, /parent Crew/);
  assert.doesNotMatch(after.agents['source-code'].criticalSystemReminder_EXPERIMENTAL, /parent GLaDOS/);
  assert.match(after.appendSubagentSystemPrompt, /parent Crew/);
  assert.match(after.systemPrompt, /Return the combined final result to the operator/);
  const dispatch = await after.canUseTool('Agent', { subagent_type: 'source-code', name: 'source-code' });
  assert.equal(dispatch.behavior, 'allow');
  assert.equal(dispatch.updatedInput.name, undefined);
  assert.equal(decideToolUse({ agentId: 'source-code', toolName: 'Agent', input: { subagent_type: outsiderId }, env }).allowed, false);
});

test('the selected GLaDOS team includes custom specialists only after explicit assignment', t => {
  const { env: baseEnv } = fixture(t, manifest());
  const env = { ...baseEnv, GLADOS_TEAM_ID: 'glados' };
  const id = 'pkg-my-specialists--reviewer';
  const before = buildAgentSdkOptions('glados', { env });
  assert.ok(before.agents['source-code']);
  assert.equal(before.agents[id], undefined);
  assert.doesNotMatch(before.systemPrompt, /pkg-my-specialists--reviewer/);
  assert.equal(decideToolUse({ agentId: 'glados', toolName: 'Agent', input: { subagent_type: id }, env }).allowed, false);
  const rows = loadRegistry({ env });
  const store = createAgentTeamStore({ env });
  store.save('glados', [id], { expectedRevision: store.get('glados', rows).revision, registryRows: rows });
  const after = buildAgentSdkOptions('glados', { env });
  assert.ok(after.agents[id]);
  assert.match(after.systemPrompt, /pkg-my-specialists--reviewer/);
  assert.equal(decideToolUse({ agentId: 'glados', toolName: 'Agent', input: { subagent_type: id }, env }).allowed, true);
});

test('a standalone specialist can run without team assignment and never inherits its former teammates', t => {
  const { env: baseEnv } = fixture(t, manifest({
    agents: [agent('lead'), agent('analyst'), agent('standalone')],
    teams: [{ id: 'crew', name: 'Crew', coordinator: 'lead', members: ['lead', 'analyst'] }],
  }));
  for (const id of ['pkg-my-specialists--standalone', 'pkg-my-specialists--analyst']) {
    const env = { ...baseEnv, GLADOS_TEAM_ID: `agent:${id}`, GLADOS_FULL_ACCESS: '1' };
    const options = buildAgentSdkOptions(id, { env });
    assert.equal(options.model, 'gpt-6-sol');
    assert.deepEqual(options.gladosMountedTools, ['Read', 'Grep']);
    assert.deepEqual(options.agents, {});
    assert.equal(options.permissionMode, 'default');
    assert.equal(options.allowDangerouslySkipPermissions, false);
    assert.equal(taskAllowlist(loadPolicy(), { env, callerAgentId: id }).size, 0);
    assert.match(options.systemPrompt, /Selected specialist session/);
    assert.doesNotMatch(options.systemPrompt, /Selected session team/);
    assert.equal(decideToolUse({ agentId: id, toolName: 'Agent', input: { subagent_type: 'pkg-my-specialists--lead' }, env }).allowed, false);
    assert.deepEqual(mountedToolsForAgent('pkg-my-specialists--lead', loadPolicy(), { env }), []);
    assert.throws(() => buildAgentSdkOptions('pkg-my-specialists--crew', { env }), /unavailable in the selected session team/);
    assert.equal(buildAgentSdkOptions('glados', { env: { ...baseEnv, GLADOS_TEAM_ID: 'glados' } }).agents[id], undefined);
  }
});

test('task tools cannot rewrite the managed team collection to expand their own roster', t => {
  const { root, env: baseEnv } = fixture(t, manifest({ agents: [agent('lead', { tools: ['Write', 'Edit', 'Bash'] })], teams: [{ id: 'crew', name: 'Crew', members: ['lead'], coordinator: 'lead' }] }));
  const id = 'pkg-my-specialists--crew';
  const env = { ...baseEnv, GLADOS_TEAM_ID: id };
  const destination = path.join(root, 'agent-teams', 'collection.json');
  for (const agentId of [id, 'glados']) {
    const agentEnv = agentId === 'glados' ? { ...baseEnv, GLADOS_TEAM_ID: 'glados', GLADOS_FULL_ACCESS: '1' } : env;
    const write = decideToolUse({ agentId, toolName: 'Write', input: { file_path: destination, content: '{"teams":[{"id":"glados","assignedAgentIds":["pkg-my-specialists--lead"]}]}' }, env: agentEnv });
    assert.equal(write.allowed, false);
    assert.match(write.reason, /team memberships are managed in Agents/);
  }
  const shell = decideToolUse({ agentId: id, toolName: 'Bash', input: { command: `node -e "require('fs').writeFileSync('${destination}', '{}')"` }, env });
  assert.equal(shell.allowed, false);
  assert.match(shell.reason, /team assignments are managed in Agents/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(taskAllowlist(loadPolicy(), { env, callerAgentId: id }).has('source-code'), false);
});

test('managed package target operations require the exact scoped identity in an approved plan', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-package-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'blackboard.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE engagements(id TEXT PRIMARY KEY, status TEXT, session_id TEXT, started_at TEXT, scope TEXT);
    CREATE TABLE plans(id TEXT, engagement_id TEXT, state TEXT, approved_at TEXT, plan_json TEXT);`);
  db.prepare('INSERT INTO engagements VALUES(?,?,?,?,?)').run('eng-1', 'active', 'legacy', '2026-01-01', JSON.stringify(['example.test']));
  const id = 'pkg-my-specialists--reviewer';
  const gate = { dbPath, managedPackageAgents: new Set([id]) };
  assert.equal(planCheckDispatch(id, 'eng-1', gate).allowed, false);
  db.prepare('INSERT INTO plans VALUES(?,?,?,?,?)').run('p-1', 'eng-1', 'approved', '2026-01-01', JSON.stringify({ agent_chain: ['reviewer'] }));
  assert.equal(planCheckDispatch(id, 'eng-1', gate).allowed, false);
  db.prepare('UPDATE plans SET plan_json=?').run(JSON.stringify({ agent_chain: [id] }));
  assert.equal(planCheckDispatch(id, 'eng-1', gate).allowed, true);
  assert.equal(planCheckDispatch('pkg-uninstalled--reviewer', 'eng-1', gate).allowed, false);
  const missingAttribution = evaluateToolUse({ agentId: id, toolName: 'Bash', input: { command: 'curl -x $GLADOS_PROXY_URL https://example.test' }, engagementId: 'eng-1', ...gate });
  assert.equal(missingAttribution.allowed, false);
  assert.match(missingAttribution.reason, /X-GLaDOS-Agent/);
  db.close();
});

test('custom connector tools keep plan, declared engagement scope, target, and health gates', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-custom-connector-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'blackboard.db');
  const watchdogDbPath = path.join(root, 'watchdog.db');
  const db = new Database(dbPath);
  const health = new Database(watchdogDbPath);
  t.after(() => { db.close(); health.close(); });
  db.exec(`CREATE TABLE engagements(id TEXT PRIMARY KEY, status TEXT, session_id TEXT, started_at TEXT, scope TEXT);
    CREATE TABLE plans(id TEXT, engagement_id TEXT, state TEXT, approved_at TEXT, plan_json TEXT);`);
  health.exec('CREATE TABLE target_health(target_url TEXT, state TEXT, updated_at TEXT)');
  db.prepare('INSERT INTO engagements VALUES(?,?,?,?,?)').run('eng-1', 'active', 'legacy', '2026-01-01', JSON.stringify(['example.test']));
  const id = 'pkg-custom-tools--inspector';
  const gate = { agentId: id, toolName: 'mcp__user-custom__inspect', engagementId: 'eng-1', dbPath, watchdogDbPath, managedPackageAgents: new Set([id]) };
  assert.equal(evaluateToolUse({ ...gate, input: { url: 'https://example.test' } }).allowed, false);
  db.prepare('INSERT INTO plans VALUES(?,?,?,?,?)').run('plan-1', 'eng-1', 'approved', '2026-01-01', JSON.stringify({ agent_chain: [id] }));
  const withoutTarget = evaluateToolUse({ ...gate, input: { readOnlyHint: true } });
  assert.equal(withoutTarget.allowed, false);
  assert.match(withoutTarget.reason, /no target/);
  const outside = evaluateToolUse({ ...gate, input: { url: 'https://outside.test', readOnlyHint: true }, turnTargets: ['https://outside.test'] });
  assert.equal(outside.allowed, false);
  assert.match(outside.reason, /scope gate/);
  assert.equal(evaluateToolUse({ ...gate, input: { url: 'https://example.test' } }).allowed, true);
  health.prepare('INSERT INTO target_health VALUES(?,?,?)').run('https://example.test', 'paused', '2026-01-01');
  const paused = evaluateToolUse({ ...gate, input: { url: 'https://example.test' } });
  assert.equal(paused.allowed, false);
  assert.match(paused.reason, /health gate/);
});

test('draft testing uses real configured model and effort but never persists or mounts capabilities', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-draft-test-parent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let captured;
  async function* queryImpl(input) {
    captured = input;
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A structured sample response.' }] } };
  }
  const result = await testAgentDraft({
    draft: agent('draft', { instructions: 'Return a structured answer.', connectors: ['clippy'], tools: ['Bash'] }),
    prompt: 'Test this role.', conversation: [{ role: 'user', content: 'Prior test message.' }], queryImpl,
    options: { env: { ...process.env, GLADOS_RUNTIME_DIR: root, ANTHROPIC_AUTH_TOKEN: 'test-token' } },
  });
  assert.equal(result.reply, 'A structured sample response.');
  assert.equal(captured.options.model, 'gpt-6-sol');
  assert.equal(captured.options.effort, 'xhigh');
  assert.deepEqual(captured.options.tools, []);
  assert.deepEqual(captured.options.agents, {});
  assert.deepEqual(captured.options.mcpServers, {});
  assert.equal(captured.options.persistSession, false);
  assert.equal((await captured.options.canUseTool('Bash', {})).behavior, 'deny');
  assert.equal(fs.existsSync(captured.options.cwd), false);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.match(captured.prompt, /Prior test message/);
});

test('draft tests report failure and clean up when the provider returns no successful response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-draft-failure-parent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  async function* failedQuery() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'An incomplete response…' }] } };
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Provider unavailable'] };
  }
  await assert.rejects(testAgentDraft({ draft: agent('draft'), prompt: 'Test this role.', queryImpl: failedQuery, options: { env: { ...process.env, GLADOS_RUNTIME_DIR: root, ANTHROPIC_AUTH_TOKEN: 'test-token' } } }), error => error.status === 502);
  assert.deepEqual(fs.readdirSync(root), []);
});
