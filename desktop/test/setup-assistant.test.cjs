const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SetupAssistant, normalizeSecret } = require('../lib/setup-assistant.cjs');

test('LiteLLM keys are normalized, stored in Keychain, and never returned by setup status', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-setup-'));
  const fixtureKey = ['setup', 'fixture', 'credential'].join('-');
  let stored = false;
  const calls = [];
  try {
    const assistant = new SetupAssistant({
      runtimeDir,
      platform: 'darwin',
      account: 'operator',
      spawnSync(command, args) {
        calls.push({ command, args });
        if (args[0] === 'add-generic-password') stored = true;
        return { status: args[0] === 'find-generic-password' ? (stored ? 0 : 44) : 0, stdout: '', stderr: '' };
      },
    });
    const result = assistant.saveLiteLlmKey({ token: ` Bearer "${fixtureKey}" ` });
    assert.equal(result.configured, true);
    assert.equal(result.source, 'macOS Keychain');
    const write = calls.find(call => call.args[0] === 'add-generic-password');
    assert.equal(write.command, '/usr/bin/security');
    assert.equal(write.args.at(-1), fixtureKey);
    assert.equal(JSON.stringify(assistant.status()).includes(fixtureKey), false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('optional local profiles use an atomic owner-only file and may reuse Ford credentials', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-setup-'));
  const fixturePassword = ['local', 'fixture', 'password'].join('-');
  try {
    const assistant = new SetupAssistant({ runtimeDir, platform: 'linux', env: {} });
    const status = assistant.saveLocalSecrets({
      fordUsername: 'operator@example.test',
      fordPassword: fixturePassword,
      useFordForDradis: true,
    });
    assert.deepEqual(status.profiles, ['dradis', 'ford-sso']);
    assert.equal(fs.statSync(assistant.localAuthFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(assistant.localAuthFile)).mode & 0o777, 0o700);
    const saved = JSON.parse(fs.readFileSync(assistant.localAuthFile, 'utf8'));
    assert.equal(saved.profiles['ford-sso'].password, fixturePassword);
    assert.equal(saved.profiles.dradis.password, fixturePassword);
    assert.equal(JSON.stringify(status).includes(fixturePassword), false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('setup input rejects empty and control-character secrets', () => {
  assert.equal(normalizeSecret(' Bearer abc-123 '), 'abc-123');
  assert.throws(() => normalizeSecret('  '), /required/);
  assert.throws(() => normalizeSecret('abc\ndef'), /control characters/);
});
