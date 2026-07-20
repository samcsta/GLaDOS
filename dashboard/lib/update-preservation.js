const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const CONFIG_FILES = [
  'model-overrides.json',
  'custom-agents.json',
  'operator-context.json',
  'agent-seed-state.json',
  'upstream-agent-status.json',
  path.join('sessions', 'agent-sdk-sessions.json'),
];

function safeSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown';
}

function protectedPathState(runtimeDir, relativePath) {
  const absolute = path.join(runtimeDir, relativePath);
  try {
    const stat = fs.statSync(absolute);
    return { path: relativePath, exists: true, type: stat.isDirectory() ? 'directory' : 'file' };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: relativePath, exists: false };
    throw error;
  }
}

async function backupDatabase(source, destination) {
  if (!fs.existsSync(source)) return false;
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); }
  finally { db.close(); }
  fs.chmodSync(destination, 0o600);
  return true;
}

async function createUpdatePreservationSnapshot({
  runtimeDir,
  blackboardDb,
  watchdogDb,
  activeAgents = 0,
  targetVersion = 'unknown',
  now = new Date(),
}) {
  if (activeAgents > 0) throw new Error(`cannot install an update while ${activeAgents} agent(s) are active`);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const snapshotDir = path.join(runtimeDir, 'backups', 'updates', `${timestamp}-to-${safeSegment(targetVersion)}`);
  const configDir = path.join(snapshotDir, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(snapshotDir, 0o700);
  fs.chmodSync(configDir, 0o700);

  const databases = [];
  for (const [name, source] of [['blackboard.db', blackboardDb], ['watchdog.db', watchdogDb]]) {
    if (await backupDatabase(source, path.join(snapshotDir, name))) databases.push(name);
  }

  const configs = [];
  for (const relative of CONFIG_FILES) {
    const source = path.join(runtimeDir, relative);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(configDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
    configs.push(relative);
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    targetVersion: String(targetVersion || 'unknown'),
    runtimeDir,
    databases,
    configs,
    protectedInPlace: ['reports', 'investigations', path.join('workspaces', 'agents')]
      .map(relative => protectedPathState(runtimeDir, relative)),
    note: 'Protected-in-place paths live outside the application bundle and are not modified by electron-updater.',
  };
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
  return { ok: true, snapshotDir, manifest };
}

module.exports = { CONFIG_FILES, backupDatabase, createUpdatePreservationSnapshot };
