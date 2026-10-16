const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentPackageStore } = require('../lib/agent-packages');
const { createAgentTeamStore } = require('../lib/agent-teams');
const { loadRegistry, buildAgentSdkOptions, decideToolUse } = require('../lib/harness/agent-sdk');

test('Herbie accepts GLaDOS specialists and custom agents without changing their capabilities or other rosters', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-herbie-roster-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: runtimeDir, GLADOS_AGENT_WORKSPACES: path.join(runtimeDir, 'agents'), GLADOS_BROWSER_MCP: '0', GLADOS_CLIPPY_MCP: '0', GLADOS_FULL_ACCESS: '0', ANTHROPIC_AUTH_TOKEN: 'test-token', BLACKBOARD_DB: path.join(runtimeDir, 'blackboard.db') };
  if (process.platform !== 'win32') {
    const toolDir = path.join(runtimeDir, 'packet tools');
    fs.mkdirSync(toolDir);
    env.GLADOS_TSHARK_PATH = path.join(toolDir, 'tshark');
    fs.writeFileSync(env.GLADOS_TSHARK_PATH, "#!/bin/sh\nprintf '%s\\n' 'TShark (Wireshark) 4.6.0'\n", { mode: 0o700 });
    env.PATH = '/usr/bin:/bin'; // GUI launches may omit the tool's installation directory.
  }
  for (const key of ['GLADOS_TEAM_ID', 'GLADOS_SECURITY_REVIEW', 'GLADOS_BROWSER_MCP_COMMAND', 'GLADOS_BROWSER_MCP_ARGS', 'GLADOS_BROWSER_MCP_ARGS_JSON']) delete env[key];
  const packages = createAgentPackageStore({ runtimeDir });
  const sourcePath = path.resolve(__dirname, '../../templates/integrated-teams/herbie.glados-agent.json');
  const herbie = packages.installIntegration(fs.readFileSync(sourcePath, 'utf8'), { sourcePath });
  packages.setTeamEnabled('herbie', 'herbie-team', true, { expectedRevision: herbie.revision });
  packages.create({ schemaVersion: 1, id: 'local-helper', name: 'Local helper', version: '1.0.0', agents: [{ id: 'analyst', name: 'Local analyst', description: 'Review supplied evidence', instructions: 'Answer the assigned question from supplied evidence.', model: 'gpt-6-sol', tools: ['Read'], connectors: [], deliverables: ['A cited answer'] }], teams: [], resources: [] });
  const teams = createAgentTeamStore({ env });
  const registryRows = loadRegistry({ env });
  const before = teams.get('pkg-herbie--herbie-team', registryRows);
  const gladosBefore = teams.get('glados', registryRows);
  const saved = teams.save(before.id, ['source-code', 'pkg-local-helper--analyst'], { registryRows, expectedRevision: before.revision });
  assert.equal(saved.memberIds.length, 16);
  assert.ok(saved.memberIds.includes('source-code'));
  assert.ok(saved.memberIds.includes('pkg-local-helper--analyst'));
  assert.deepEqual(teams.get('glados', registryRows).memberIds, gladosBefore.memberIds);
  const selectedEnv = { ...env, GLADOS_TEAM_ID: before.id };
  const options = buildAgentSdkOptions(before.id, { env: selectedEnv });
  assert.ok(options.agents['source-code']);
  assert.deepEqual(options.agents['pkg-local-helper--analyst'].tools, ['Read']);
  assert.equal(options.agents['api-expert'], undefined);
  assert.match(options.systemPrompt, /source-code/);
  if (process.platform !== 'win32') {
    assert.equal(options.env.GLADOS_TSHARK_PATH, env.GLADOS_TSHARK_PATH);
    assert.equal(options.env.PATH.split(path.delimiter)[0], path.dirname(env.GLADOS_TSHARK_PATH));
    assert.match(options.systemPrompt, /Herbie offline packet tool: TShark 4\.6\.0/);
  }
  assert.equal(decideToolUse({ agentId: before.id, toolName: 'Agent', input: { subagent_type: 'source-code' }, env: selectedEnv }).allowed, true);
  assert.equal(decideToolUse({ agentId: 'pkg-local-helper--analyst', toolName: 'Bash', input: { command: 'pwd' }, env: selectedEnv }).allowed, false);
});
