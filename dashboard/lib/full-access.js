const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAPABILITIES = Object.freeze([
  'Read and edit files the operator asks GLaDOS to use',
  'Run shell commands without per-command permission prompts',
  'Coordinate isolated browser agents',
  'Capture any connected display and operate the macOS desktop',
  'Perform destructive or external actions when the operator explicitly requests them',
]);

function fullAccessFile(env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  return path.resolve(env.GLADOS_FULL_ACCESS_FILE || path.join(runtimeDir, 'policy', 'full-access.json'));
}

function readFullAccessState(env = process.env) {
  const file = fullAccessFile(env);
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let ownerOnly = null;
  try { ownerOnly = process.platform === 'win32' || (fs.statSync(file).mode & 0o077) === 0; } catch {}
  return {
    enabled: stored?.enabled === true,
    acknowledgedAt: typeof stored?.acknowledgedAt === 'string' ? stored.acknowledgedAt : null,
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : null,
    ownerOnly,
    file,
    capabilities: [...CAPABILITIES],
  };
}

function isFullAccessEnabled(env = process.env) {
  return readFullAccessState(env).enabled;
}

function writeFullAccessState(enabled, { env = process.env } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const file = fullAccessFile(env);
  const prior = readFullAccessState(env);
  const now = new Date().toISOString();
  const next = {
    version: 1,
    enabled,
    acknowledgedAt: enabled ? (prior.acknowledgedAt || now) : null,
    updatedAt: now,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return readFullAccessState(env);
}

module.exports = {
  CAPABILITIES,
  fullAccessFile,
  isFullAccessEnabled,
  readFullAccessState,
  writeFullAccessState,
};
