const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  defaultTeamPreference,
  effortForAgent,
  operatorInitials,
  preferencesFile,
  readChatPreferences,
  writeChatPreferences,
} = require('../lib/chat-preferences');

test('default team preference persists alongside identity, reasoning and compaction settings', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-default-team-prefs-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const env = { GLADOS_RUNTIME_DIR: runtimeDir };
  assert.equal(readChatPreferences(env).defaultTeamId, 'glados');
  writeChatPreferences({ operatorName: 'Operator', agentId: 'glados', effort: 'xhigh', autoCompact: false }, env);
  const teamId = 'pkg-herbie--herbie-team';
  writeChatPreferences({ defaultTeamId: teamId }, env);
  const saved = readChatPreferences(env);
  assert.equal(saved.defaultTeamId, teamId);
  assert.equal(saved.operatorName, 'Operator');
  assert.equal(saved.efforts.glados, 'xhigh');
  assert.equal(saved.autoCompact, false);
  writeChatPreferences({ operatorName: 'Changed operator' }, env);
  assert.equal(readChatPreferences(env).defaultTeamId, teamId);
  for (const value of ['', null, 1, [], {}, '../glados', 'agent:pkg-herbie--coordinator', ' glados']) {
    assert.throws(() => writeChatPreferences({ defaultTeamId: value }, env), /valid agentic team/);
  }
  assert.equal(readChatPreferences(env).defaultTeamId, teamId);
});

test('unavailable defaults fall back without replacing the saved installed team selection', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-default-team-fallback-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const env = { GLADOS_RUNTIME_DIR: runtimeDir };
  const id = 'pkg-herbie--herbie-team';
  const main = { id: 'glados', name: 'GLaDOS', available: true, kind: 'team' };
  const herbie = { id, name: 'Herbie', available: true, kind: 'team' };
  writeChatPreferences({ defaultTeamId: id }, env);
  assert.deepEqual(defaultTeamPreference([main, herbie], env), {
    defaultTeamId: id, effectiveTeamId: id, fallback: false,
    teams: [{ id: 'glados', name: 'GLaDOS', available: true }, { id, name: 'Herbie', available: true }],
  });
  for (const teams of [[main], [main, { ...herbie, available: false }]]) {
    const result = defaultTeamPreference(teams, env);
    assert.equal(result.defaultTeamId, id);
    assert.equal(result.effectiveTeamId, 'glados');
    assert.equal(result.fallback, true);
    assert.equal(result.teams.length, 1);
  }
  const result = defaultTeamPreference([main, herbie, { id: 'agent:pkg-herbie--coordinator', kind: 'agent', available: true }], env);
  assert.equal(result.teams.length, 2);
  assert.equal(result.effectiveTeamId, id);
  assert.equal(readChatPreferences(env).defaultTeamId, id);
});

test('chat reasoning preferences are owner-only, validated, and default to auto compaction', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-chat-prefs-'));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: runtimeDir };
  assert.equal(effortForAgent('glados', env), 'high');
  assert.equal(readChatPreferences(env).autoCompact, true);
  assert.throws(() => writeChatPreferences({ agentId: 'glados', effort: 'unlimited' }, env), /effort must be one of/);
  const saved = writeChatPreferences({ agentId: 'glados', effort: 'xhigh' }, env);
  assert.equal(saved.efforts.glados, 'xhigh');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(preferencesFile(env)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(preferencesFile(env))).mode & 0o777, 0o700);
  }
});

test('operator chat identity persists a normalized name and derives initials', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-chat-profile-'));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: runtimeDir };
  const saved = writeChatPreferences({ operatorName: '  Sam   Costa  ' }, env);
  assert.equal(saved.operatorName, 'Sam Costa');
  assert.equal(operatorInitials(saved.operatorName), 'SC');
  assert.equal(operatorInitials('Prince'), 'PR');
  assert.equal(operatorInitials(''), 'You');
});

test('scoped package agent preferences retain package effort defaults and long stable identities', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-package-chat-prefs-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const env = { GLADOS_RUNTIME_DIR: runtimeDir };
  const agentId = `pkg-${'a'.repeat(64)}--${'b'.repeat(64)}`;
  assert.equal(effortForAgent(agentId, env, 'minimal'), 'minimal');
  const saved = writeChatPreferences({ agentId, effort: 'none' }, env);
  assert.equal(saved.efforts[agentId], 'none');
  assert.equal(effortForAgent(agentId, env, 'xhigh'), 'none');
  assert.throws(() => writeChatPreferences({ agentId: 'glados', effort: 'none' }, env), /effort must be/);
  assert.throws(() => writeChatPreferences({ agentId: '../outside', effort: 'high' }, env), /valid agentId/);
  const firstRevision = 'a'.repeat(64);
  const editedRevision = 'b'.repeat(64);
  writeChatPreferences({ agentId, effort: 'minimal', packageRevision: firstRevision }, env);
  assert.equal(effortForAgent(agentId, env, 'high', firstRevision), 'minimal');
  assert.equal(effortForAgent(agentId, env, 'xhigh', editedRevision), 'xhigh');
});
