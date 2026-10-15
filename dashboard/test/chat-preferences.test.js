const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  effortForAgent,
  operatorInitials,
  preferencesFile,
  readChatPreferences,
  writeChatPreferences,
} = require('../lib/chat-preferences');

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
