const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fullAccessFile,
  isFullAccessEnabled,
  readFullAccessState,
  writeFullAccessState,
} = require('../lib/full-access');
const { buildAgentSdkOptions, decideToolUse, loadPolicy } = require('../lib/harness/agent-sdk');

function testEnv(runtimeDir) {
  return {
    ...process.env,
    GLADOS_RUNTIME_DIR: runtimeDir,
    GLADOS_AGENT_WORKSPACES: path.join(runtimeDir, 'workspaces', 'agents'),
    ANTHROPIC_AUTH_TOKEN: 'test-token',
  };
}

test('Full Access is disabled by default and stored owner-only after one UI confirmation', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-full-access-'));
  const env = testEnv(runtimeDir);
  assert.equal(readFullAccessState(env).enabled, false);
  assert.equal(isFullAccessEnabled(env), false);
  const enabled = writeFullAccessState(true, { env });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.ownerOnly, true);
  assert.equal(fs.statSync(fullAccessFile(env)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(fullAccessFile(env))).mode & 0o777, 0o700);

  const disabled = writeFullAccessState(false, { env });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.acknowledgedAt, null);
});

test('Full Access changes the GLaDOS SDK mode and unlocks desktop tools only for GLaDOS', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-full-access-sdk-'));
  const env = testEnv(runtimeDir);
  const workspaceRoot = env.GLADOS_AGENT_WORKSPACES;
  const policy = loadPolicy();
  const desktopTool = 'mcp__glados-ops__desktop_snapshot';

  const restricted = buildAgentSdkOptions('glados', { env, workspaceRoot });
  assert.equal(restricted.permissionMode, 'default');
  assert.equal(typeof restricted.canUseTool, 'function');
  assert.equal(restricted.allowDangerouslySkipPermissions, false);
  assert.match(restricted.systemPrompt, /Full Access is disabled/);
  assert.match(decideToolUse({ agentId: 'glados', toolName: desktopTool, policy, workspaceRoot, env }).reason, /requires.*Full Access/i);

  writeFullAccessState(true, { env });
  const elevated = buildAgentSdkOptions('glados', { env, workspaceRoot });
  assert.equal(elevated.permissionMode, 'bypassPermissions');
  assert.equal(elevated.allowDangerouslySkipPermissions, true);
  assert.ok(elevated.allowedTools.includes(desktopTool));
  assert.match(elevated.systemPrompt, /Full Access is ENABLED/);
  assert.equal(decideToolUse({ agentId: 'glados', toolName: desktopTool, policy, workspaceRoot, env }).allowed, true);
  assert.equal(decideToolUse({ agentId: 'webapp-recon', toolName: desktopTool, policy, workspaceRoot, env }).allowed, false);
});
