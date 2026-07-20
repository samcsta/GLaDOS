const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UpdateCredentialStore, validateFeedUrl } = require('../lib/private-update.cjs');
const { targetArch } = require('../scripts/rebuild-resources.cjs');

function fakeStorage(backend = 'gnome_libsecret') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: value => Buffer.from(value.toString().replace(/^encrypted:/, ''), 'base64').toString(),
  };
}

test('private update configuration requires HTTPS and strips a trailing slash', () => {
  assert.equal(validateFeedUrl('https://updates.example.test/glados/'), 'https://updates.example.test/glados');
  assert.throws(() => validateFeedUrl('http://updates.example.test/glados'), /HTTPS/);
  assert.throws(() => validateFeedUrl('https://token@updates.example.test/glados'), /credentials/);
  assert.throws(() => validateFeedUrl('https://updates.example.test/glados?token=nope'), /query string/);
});

test('update tokens are encrypted outside the app and never returned by status', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-update-auth-'));
  try {
    const fixtureCredential = ['private', 'red-team', 'fixture', '12345'].join('-');
    const store = new UpdateCredentialStore({ runtimeDir, safeStorage: fakeStorage(), platform: 'darwin', env: {} });
    const saved = store.save({ feedUrl: 'https://updates.example.test/glados', token: fixtureCredential });
    assert.equal(saved.configured, true);
    const raw = fs.readFileSync(store.file, 'utf8');
    assert.equal(raw.includes(fixtureCredential), false);
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.deepEqual(store.load(), {
      feedUrl: 'https://updates.example.test/glados',
      token: fixtureCredential,
      source: 'keychain',
    });
    const status = store.status();
    assert.equal(status.configured, true);
    assert.equal('token' in status, false);
  } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
});

test('Linux refuses plaintext password backends for persisted update tokens', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-update-auth-'));
  try {
    const fixtureCredential = ['private', 'red-team', 'fixture', '12345'].join('-');
    const store = new UpdateCredentialStore({ runtimeDir, safeStorage: fakeStorage('basic_text'), platform: 'linux', env: {} });
    assert.throws(() => store.save({
      feedUrl: 'https://updates.example.test/glados',
      token: fixtureCredential,
    }), /refusing to store/);
  } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
});

test('electron-builder architecture enum is passed through to native rebuilds', () => {
  assert.equal(targetArch({ arch: 1 }), 'x64');
  assert.equal(targetArch({ arch: 3 }), 'arm64');
  assert.equal(targetArch({ arch: 'x64' }), 'x64');
});
