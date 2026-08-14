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
  assert.equal(fs.statSync(preferencesFile(env)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(preferencesFile(env))).mode & 0o777, 0o700);
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
