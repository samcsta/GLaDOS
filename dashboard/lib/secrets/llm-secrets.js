const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEFAULT_KEYCHAIN_SERVICE = 'glados.llmapi';

function runtimeDir(env = process.env) {
  return path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
}

function llmSecretPath(env = process.env) {
  return path.join(runtimeDir(env), 'secrets', 'llmapi.json');
}

function ownerOnlyModeOk(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (process.platform === 'win32') return true;
  return (stat.mode & 0o077) === 0;
}

function readFallbackSecret(env = process.env) {
  const file = llmSecretPath(env);
  if (!fs.existsSync(file)) return null;
  if (!ownerOnlyModeOk(file)) {
    throw new Error(`${file} must be chmod 600; refusing to read a world/group-readable LLM key`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed?.token || parsed?.apiKey || parsed?.ANTHROPIC_AUTH_TOKEN || null;
}

function readKeychainSecret({ service = DEFAULT_KEYCHAIN_SERVICE, account = os.userInfo().username } = {}) {
  if (process.platform !== 'darwin') return null;
  const result = cp.spawnSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function loadLlmAuthToken(env = process.env) {
  const direct = env.ANTHROPIC_AUTH_TOKEN || env.LLMAPI_API_KEY;
  if (direct) return direct;
  return readKeychainSecret({
    service: env.GLADOS_LLM_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE,
    account: env.GLADOS_LLM_KEYCHAIN_ACCOUNT || os.userInfo().username,
  }) || readFallbackSecret(env);
}

function fallbackSecretStatus(env = process.env) {
  const file = llmSecretPath(env);
  return {
    path: file,
    exists: fs.existsSync(file),
    ownerOnly: fs.existsSync(file) ? ownerOnlyModeOk(file) : null,
  };
}

module.exports = {
  DEFAULT_KEYCHAIN_SERVICE,
  llmSecretPath,
  ownerOnlyModeOk,
  readFallbackSecret,
  readKeychainSecret,
  loadLlmAuthToken,
  fallbackSecretStatus,
};
