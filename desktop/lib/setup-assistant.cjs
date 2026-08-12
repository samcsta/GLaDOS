const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');

const DEFAULT_GATEWAY_URL = 'https://llmapi.redteamstuff.com';
const DEFAULT_KEYCHAIN_SERVICE = 'glados.llmapi';

function normalizeSecret(value, label = 'secret') {
  let normalized = String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 16_384) throw new Error(`${label} is unexpectedly long`);
  if (/[\r\n\0]/.test(normalized)) throw new Error(`${label} contains unsupported control characters`);
  return normalized;
}

function normalizeUsername(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 320 || /[\r\n\0]/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function writePrivateJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function privateFileStatus(file) {
  if (!fs.existsSync(file)) return { exists: false, ownerOnly: null };
  const stat = fs.statSync(file);
  return { exists: true, ownerOnly: (stat.mode & 0o077) === 0 };
}

class SetupAssistant {
  constructor(options = {}) {
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(os.homedir(), '.glados'));
    this.appRoot = path.resolve(options.appRoot || path.join(__dirname, '..', '..'));
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.account = options.account || os.userInfo().username;
    this.service = options.service || this.env.GLADOS_LLM_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE;
    this.spawnSync = options.spawnSync || cp.spawnSync;
    this.execFile = options.execFile || promisify(cp.execFile);
    this.homeDir = path.resolve(options.homeDir || os.homedir());
    this.llmSecretFile = path.join(this.runtimeDir, 'secrets', 'llmapi.json');
    this.localAuthFile = path.join(this.runtimeDir, 'secrets', 'local-auth.json');
    this.caKeyFile = path.join(this.runtimeDir, 'secrets', 'glados-mitm-ca.key');
    this.caCertFile = path.join(this.runtimeDir, 'secrets', 'glados-mitm-ca.pem');
  }

  gatewayUrl() {
    return String(this.env.ANTHROPIC_BASE_URL || this.env.LLMAPI_BASE_URL || DEFAULT_GATEWAY_URL)
      .trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  }

  keychainConfigured() {
    if (this.platform !== 'darwin') return false;
    const result = this.spawnSync('/usr/bin/security', [
      'find-generic-password', '-a', this.account, '-s', this.service,
    ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    return result.status === 0;
  }

  llmStatus() {
    const fallback = privateFileStatus(this.llmSecretFile);
    const environmentConfigured = Boolean(this.env.ANTHROPIC_AUTH_TOKEN || this.env.LLMAPI_API_KEY);
    const keychainConfigured = this.keychainConfigured();
    const privateFallbackConfigured = fallback.exists && fallback.ownerOnly === true;
    return {
      configured: environmentConfigured || keychainConfigured || privateFallbackConfigured,
      source: environmentConfigured ? 'environment' : keychainConfigured ? 'macOS Keychain' : privateFallbackConfigured ? 'private file' : null,
      fallbackOwnerOnly: fallback.ownerOnly,
      service: this.platform === 'darwin' ? this.service : null,
    };
  }

  localSecretsStatus() {
    const status = privateFileStatus(this.localAuthFile);
    let profiles = [];
    if (status.exists && status.ownerOnly) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.localAuthFile, 'utf8'));
        profiles = Object.keys(parsed?.profiles || {}).filter(Boolean).sort();
      } catch {}
    }
    return { configured: status.exists && status.ownerOnly === true, ownerOnly: status.ownerOnly, profiles };
  }

  caStatus() {
    const key = privateFileStatus(this.caKeyFile);
    const certExists = fs.existsSync(this.caCertFile);
    let fingerprint = null;
    if (certExists) {
      try { fingerprint = new crypto.X509Certificate(fs.readFileSync(this.caCertFile)).fingerprint256; }
      catch {}
    }
    let trusted = false;
    if (certExists && this.platform === 'darwin') {
      const result = this.spawnSync('/usr/bin/security', [
        'verify-cert', '-c', this.caCertFile,
      ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
      trusted = result.status === 0;
    } else if (certExists && this.platform === 'linux') {
      trusted = fs.existsSync('/usr/local/share/ca-certificates/glados-operator-mitm-ca.crt');
    }
    return {
      generated: key.exists && key.ownerOnly === true && certExists && Boolean(fingerprint),
      trusted,
      fingerprint,
      privateKeyOwnerOnly: key.ownerOnly,
    };
  }

  status() {
    const llm = this.llmStatus();
    const localSecrets = this.localSecretsStatus();
    const ca = this.caStatus();
    return {
      platform: this.platform,
      gatewayUrl: this.gatewayUrl(),
      llm,
      localSecrets,
      ca,
      ready: llm.configured && ca.generated && ca.trusted,
    };
  }

  saveLiteLlmKey(input = {}) {
    const token = normalizeSecret(input.token, 'LiteLLM key');
    if (this.platform === 'darwin') {
      const result = this.spawnSync('/usr/bin/security', [
        'add-generic-password', '-U', '-a', this.account, '-s', this.service, '-w', token,
      ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
      if (result.status !== 0) throw new Error(result.stderr?.trim() || 'macOS Keychain did not store the LiteLLM key');
    } else {
      writePrivateJson(this.llmSecretFile, {
        version: 1,
        token,
        updated_at: new Date().toISOString(),
      });
    }
    return this.llmStatus();
  }

  saveLocalSecrets(input = {}) {
    const profiles = {};
    const fordUsernameRaw = String(input.fordUsername || '').trim();
    const fordPasswordRaw = String(input.fordPassword || '');
    if (fordUsernameRaw || fordPasswordRaw) {
      profiles['ford-sso'] = {
        username: normalizeUsername(fordUsernameRaw, 'Ford SSO username'),
        password: normalizeSecret(fordPasswordRaw, 'Ford SSO password'),
        allowed_hosts: ['corp.sts.ford.com', 'www.is.dealerconnection.com'],
        purpose: 'Ford ADFS / Active Directory login for authorized assessments',
      };
    }

    const reuseFord = Boolean(input.useFordForDradis);
    const dradisUsernameRaw = reuseFord ? fordUsernameRaw : String(input.dradisUsername || '').trim();
    const dradisPasswordRaw = reuseFord ? fordPasswordRaw : String(input.dradisPassword || '');
    if (dradisUsernameRaw || dradisPasswordRaw || reuseFord) {
      profiles.dradis = {
        username: normalizeUsername(dradisUsernameRaw, 'Dradis username'),
        password: normalizeSecret(dradisPasswordRaw, 'Dradis password'),
        allowed_hosts: ['dradis.redteamstuff.com', 'dradistab.redteamstuff.com'],
        purpose: 'Dradis prior-report lookup and approved report workflow',
      };
    }
    if (!Object.keys(profiles).length) throw new Error('enter at least one optional local credential profile or skip this step');

    writePrivateJson(this.localAuthFile, {
      version: 1,
      updated_at: new Date().toISOString(),
      profiles,
    });
    return this.localSecretsStatus();
  }

  async runCaAction(action) {
    if (!['generate', 'trust'].includes(action)) throw new Error('unsupported proxy CA setup action');
    const script = path.join(this.appRoot, 'scripts', 'glados-ca.sh');
    if (!fs.existsSync(script)) throw new Error(`proxy CA helper is missing: ${script}`);
    try {
      await this.execFile('/bin/bash', [script, action], {
        cwd: this.appRoot,
        env: {
          ...this.env,
          HOME: this.homeDir,
          GLADOS_RUNTIME_DIR: this.runtimeDir,
          PATH: this.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || '').trim();
      throw new Error(detail || `proxy CA ${action} failed`);
    }
    return this.caStatus();
  }
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  DEFAULT_KEYCHAIN_SERVICE,
  SetupAssistant,
  normalizeSecret,
  writePrivateJson,
};
