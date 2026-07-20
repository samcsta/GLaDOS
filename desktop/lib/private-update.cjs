const fs = require('node:fs');
const path = require('node:path');

const FILE_VERSION = 1;
const AUTH_FILENAME = 'private-update-auth.json';

function validateFeedUrl(value, { allowInsecureLocalhost = false } = {}) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw new Error('update feed must be a valid HTTPS URL'); }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowInsecureLocalhost && parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('update feed must use HTTPS');
  }
  if (parsed.username || parsed.password) throw new Error('update feed URL cannot contain credentials');
  if (parsed.search || parsed.hash) throw new Error('update feed URL cannot contain a query string or fragment');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (token.length < 16) throw new Error('update access token must be at least 16 characters');
  if (token.length > 8192) throw new Error('update access token is too large');
  if (/\p{C}/u.test(token)) throw new Error('update access token contains control characters');
  return token;
}

function atomicOwnerOnlyJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

class UpdateCredentialStore {
  constructor({ runtimeDir, safeStorage, platform = process.platform, env = process.env } = {}) {
    if (!runtimeDir) throw new Error('runtimeDir is required');
    this.file = path.join(path.resolve(runtimeDir), 'electron', AUTH_FILENAME);
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.env = env;
  }

  storageBackend() {
    if (this.platform !== 'linux') return this.platform === 'darwin' ? 'macOS Keychain' : 'OS credential storage';
    try { return this.safeStorage?.getSelectedStorageBackend?.() || 'unknown'; }
    catch { return 'unknown'; }
  }

  assertSecureStorage() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('OS credential encryption is not available; the update token was not saved');
    }
    const backend = this.storageBackend();
    if (this.platform === 'linux' && ['basic_text', 'unknown'].includes(backend)) {
      throw new Error(`refusing to store an update token with Linux password backend ${backend}; install and unlock Secret Service or KWallet`);
    }
    return backend;
  }

  readStored() {
    if (!fs.existsSync(this.file)) return null;
    const record = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (record.version !== FILE_VERSION || !record.encryptedToken || !record.feedUrl) {
      throw new Error('stored update access configuration is invalid');
    }
    return record;
  }

  load() {
    const stored = this.readStored();
    const envFeed = String(this.env.GLADOS_UPDATE_FEED_URL || '').trim();
    const envToken = String(this.env.GLADOS_UPDATE_BEARER_TOKEN || '').trim();
    const feedUrl = validateFeedUrl(envFeed || stored?.feedUrl || '', {
      allowInsecureLocalhost: this.env.GLADOS_UPDATE_ALLOW_INSECURE_LOCALHOST === '1',
    });
    let token;
    let source;
    if (envToken) {
      token = validateToken(envToken);
      source = 'environment';
    } else {
      if (!stored) throw new Error('private update access is not configured');
      this.assertSecureStorage();
      token = validateToken(this.safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64')));
      source = 'keychain';
    }
    return { feedUrl, token, source };
  }

  save({ feedUrl, token }) {
    const normalizedFeed = validateFeedUrl(feedUrl, {
      allowInsecureLocalhost: this.env.GLADOS_UPDATE_ALLOW_INSECURE_LOCALHOST === '1',
    });
    const normalizedToken = validateToken(token);
    const backend = this.assertSecureStorage();
    const encryptedToken = this.safeStorage.encryptString(normalizedToken).toString('base64');
    atomicOwnerOnlyJson(this.file, {
      version: FILE_VERSION,
      feedUrl: normalizedFeed,
      encryptedToken,
      updatedAt: new Date().toISOString(),
    });
    return { configured: true, feedUrl: normalizedFeed, source: 'keychain', storageBackend: backend };
  }

  clear() {
    fs.rmSync(this.file, { force: true });
    return { configured: false };
  }

  status() {
    try {
      const access = this.load();
      return {
        configured: true,
        feedUrl: access.feedUrl,
        source: access.source,
        storageBackend: access.source === 'environment' ? 'environment' : this.storageBackend(),
      };
    } catch (error) {
      let storedFeed = null;
      try { storedFeed = this.readStored()?.feedUrl || null; } catch {}
      return {
        configured: false,
        feedUrl: String(this.env.GLADOS_UPDATE_FEED_URL || '').trim() || storedFeed,
        storageBackend: this.storageBackend(),
        reason: error.message,
      };
    }
  }
}

module.exports = {
  AUTH_FILENAME,
  UpdateCredentialStore,
  atomicOwnerOnlyJson,
  validateFeedUrl,
  validateToken,
};
