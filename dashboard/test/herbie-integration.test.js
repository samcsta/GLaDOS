const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentPackageStore, normalizeManifest } = require('../lib/agent-packages');
const { loadRegistry, loadPolicy, mountedToolsForAgent, buildAgentSdkOptions, decideToolUse, taskAllowlist } = require('../lib/harness/agent-sdk');

const sourcePath = path.resolve(__dirname, '../../templates/integrated-teams/herbie.glados-agent.json');
const source = () => JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const roles = ['coordinator', 'packet-analysis', 'mechanic', 'pain', 'panic', 'security', 'red-teamer', 'dns-specialist', 'password-auditor', 'planner', 'researcher', 'coder', 'devops', 'reviewer'];
const runtimeId = id => `pkg-herbie--${id}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-herbie-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: root, GLADOS_AGENT_WORKSPACES: path.join(root, 'agents'), GLADOS_CLIPPY_MCP: '0', GLADOS_BROWSER_MCP: '0', GLADOS_FULL_ACCESS: '0', BLACKBOARD_DB: path.join(root, 'blackboard.db'), ANTHROPIC_AUTH_TOKEN: 'test-token' };
  for (const key of ['GLADOS_TEAM_ID', 'GLADOS_SECURITY_REVIEW', 'GLADOS_BROWSER_MCP_COMMAND', 'GLADOS_BROWSER_MCP_ARGS', 'GLADOS_BROWSER_MCP_ARGS_JSON']) delete env[key];
  const store = createAgentPackageStore({ runtimeDir: root });
  const installed = store.installIntegration(source(), { sourcePath });
  return { root, env, store, installed };
}
function enabledFixture(t) {
  const f = fixture(t);
  f.enabled = f.store.setTeamEnabled('herbie', 'herbie-team', true, { expectedRevision: f.installed.revision });
  return f;
}

test('Herbie normalizes all upstream roles, a clear coordinator and the three adapted shared skills', () => {
  const manifest = normalizeManifest(source());
  assert.equal(manifest.id, 'herbie');
  assert.deepEqual(manifest.agents.map(a => a.id), roles);
  assert.deepEqual(manifest.teams.map(t => [t.id, t.coordinator, t.members]), [['herbie-team', 'coordinator', roles]]);
  assert.ok(manifest.agents.every(a => a.model === null && a.effort === 'medium'));
  assert.ok(manifest.agents.every(a => !a.connectors.length && !a.requiredConnectors.length));
  assert.deepEqual(manifest.resources.filter(r => r.path.startsWith('skills/')).map(r => r.path), [
    'skills/evidence-contract/SKILL.md', 'skills/incident-decision-playbook/SKILL.md', 'skills/multi-agent-handoff/SKILL.md',
  ]);
  assert.ok(manifest.agents.every(a => a.skills.some(s => s.id === 'evidence-contract')));
  const provenance = manifest.resources.find(r => r.path === 'references/HERBIE-PROVENANCE.md').text;
  assert.match(provenance, /Savannah \(spapp1\)/);
  assert.match(provenance, /6ccd27318d4467007407e8e1e4e6f3f8abb726a3/);
  assert.equal((provenance.match(/\.kilo\/agent\//g) || []).length, 13);
  assert.equal((provenance.match(/\.kilo\/skills\//g) || []).length, 3);
  assert.match(provenance, /No explicit LICENSE, COPYING or NOTICE/);
  assert.equal(manifest.resources.length, 4, 'only adapted shared skills and provenance, not runtime or case data');
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /21Mustang|27wireshark|28Mustang|harness\/fixtures|__pycache__|redllm\/gpt/);
});

test('Herbie starts disabled and enables into one scoped team with projected skills', t => {
  const { store, installed, env } = fixture(t);
  assert.equal(installed.enabled, false);
  assert.equal(installed.editableIntegration, true);
  assert.equal(store.runtimeEntries().length, 0);
  assert.equal(installed.manifest.teams[0].enabled, false);
  const enabled = store.setTeamEnabled('herbie', 'herbie-team', true, { expectedRevision: installed.revision });
  assert.equal(enabled.enabled, true);
  const entries = loadRegistry({ env }).filter(row => row.packageId === 'herbie');
  assert.equal(entries.length, 15);
  const team = entries.find(row => row.teamCoordinator);
  assert.equal(team.id, runtimeId('herbie-team'));
  assert.deepEqual(team.teamMembers, roles.map(runtimeId));
  assert.ok(entries.filter(row => !row.teamCoordinator).every(row => row.teamInternal));
  assert.match(fs.readFileSync(path.join(team.workspace, 'references/HERBIE-PROVENANCE.md'), 'utf8'), /Savannah/);
  assert.match(fs.readFileSync(team.skills.find(s => s.id === 'evidence-contract').path, 'utf8'), /E-<CASE>-<SOURCE>-<NNN>/);
  assert.ok(entries.every(row => row.editableIntegration));
});

test('Herbie runtime mounts declared native capabilities without MCPs or privileged inheritance', t => {
  const { env } = enabledFixture(t);
  const policy = loadPolicy();
  const manifest = normalizeManifest(source());
  for (const agent of manifest.agents) {
    assert.deepEqual(mountedToolsForAgent(runtimeId(agent.id), policy, { env }), agent.tools, agent.id);
  }
  const options = buildAgentSdkOptions(runtimeId('herbie-team'), { env: { ...env, GLADOS_FULL_ACCESS: '1' } });
  assert.deepEqual(mountedToolsForAgent(runtimeId('herbie-team'), policy, { env }), ['Read', 'Glob', 'Grep', 'Task', 'Agent']);
  // The shared SDK process must load worker tools, but permission checks remain
  // scoped to the actual caller rather than granting the union to its leader.
  assert.ok(options.gladosMountedTools.includes('Bash'));
  assert.equal(decideToolUse({ agentId: runtimeId('herbie-team'), toolName: 'Bash', input: { command: 'pwd' }, env }).allowed, false);
  assert.equal(decideToolUse({ agentId: runtimeId('herbie-team'), toolName: 'Write', input: { file_path: '/tmp/herbie-unrequested.txt', content: 'no' }, env }).allowed, false);
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.deepEqual(options.mcpServers, {});
  assert.ok(options.agents[runtimeId('packet-analysis')]);
  assert.ok(options.agents[runtimeId('pain')]);
  assert.equal(options.agents['source-code'], undefined);
  assert.deepEqual(options.agents[runtimeId('packet-analysis')].tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.equal(options.agents[runtimeId('password-auditor')].tools.includes('Bash'), false);
  assert.equal(options.agents[runtimeId('security')].tools.includes('Edit'), false);
});

test('only the Herbie coordinator can delegate and only to its enabled exact members', t => {
  const { env } = enabledFixture(t);
  const policy = loadPolicy();
  const teamId = runtimeId('herbie-team');
  assert.deepEqual([...taskAllowlist(policy, { env, callerAgentId: teamId })].sort(), roles.map(runtimeId).sort());
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: runtimeId('mechanic') }, env }).allowed, true);
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: 'ad-expert' }, env }).allowed, false);
  assert.equal(decideToolUse({ agentId: runtimeId('packet-analysis'), toolName: 'Agent', input: { subagent_type: runtimeId('mechanic') }, env }).allowed, false);
  assert.equal(decideToolUse({ agentId: teamId, toolName: 'Agent', input: { subagent_type: runtimeId('mechanic'), run_in_background: true }, env }).allowed, false);
  assert.equal(decideToolUse({ agentId: runtimeId('packet-analysis'), toolName: 'mcp__glados-ops__desktop_click', input: {}, env }).allowed, false);
});

test('editable Herbie prompts, models, efforts, role tools and team changes survive toggles and source reseeding', t => {
  const { store, enabled } = enabledFixture(t);
  const edited = structuredClone(enabled.manifest);
  const packet = edited.agents.find(a => a.id === 'packet-analysis');
  packet.instructions = 'My bounded capture analysis instructions.';
  packet.model = 'gpt-6-sol'; packet.effort = 'xhigh';
  packet.tools = ['Read', 'Glob', 'Grep'];
  const team = edited.teams[0]; team.instructions = 'My team routing.';
  team.members = team.members.filter(id => id !== 'devops');
  let saved = store.save('herbie', edited, { expectedRevision: enabled.revision });
  saved = store.setTeamEnabled('herbie', 'herbie-team', false, { expectedRevision: saved.revision });
  saved = store.setTeamEnabled('herbie', 'herbie-team', true, { expectedRevision: saved.revision });
  const upstream = source(); upstream.version = '1.1.0'; upstream.agents.find(a => a.id === 'packet-analysis').instructions = 'Changed upstream default.';
  const reseeded = store.installIntegration(upstream, { sourcePath });
  assert.equal(reseeded.revision, saved.revision);
  assert.equal(reseeded.enabled, true);
  const retained = reseeded.manifest.agents.find(a => a.id === 'packet-analysis');
  assert.equal(retained.instructions, packet.instructions);
  assert.equal(retained.model, 'gpt-6-sol'); assert.equal(retained.effort, 'xhigh');
  assert.deepEqual(retained.tools, packet.tools);
  assert.equal(reseeded.manifest.teams[0].instructions, team.instructions);
  assert.deepEqual(reseeded.manifest.teams[0].members, team.members);
  assert.equal(reseeded.manifest.teams[0].enabled, true);
});

test('Herbie edits cannot escalate role capabilities, add connectors or replace stable identities', t => {
  const { store, enabled } = enabledFixture(t);
  const rejects = (mutate, pattern) => {
    const m = structuredClone(enabled.manifest); mutate(m);
    assert.throws(() => store.save('herbie', m, { expectedRevision: enabled.revision }), pattern);
  };
  rejects(m => m.agents.find(a => a.id === 'pain').tools.push('Bash'), /capabilities/);
  rejects(m => m.agents.find(a => a.id === 'coordinator').tools.push('Agent'), /capabilities/);
  rejects(m => m.agents.find(a => a.id === 'coder').connectors.push('browser'), /capabilities/);
  rejects(m => m.agents.find(a => a.id === 'coder').tools.push('mcp__watchdog__agent_halt'), /capabilities/);
  rejects(m => { m.agents[0].id = 'replacement'; m.teams[0].coordinator = 'replacement'; m.teams[0].members[0] = 'replacement'; }, /identities/);
  rejects(m => { m.teams[0].id = 'replacement'; }, /identities/);
});
