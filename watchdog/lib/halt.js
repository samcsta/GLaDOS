const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { db } = require('./db');

const GLADOS_RUNTIME_DIR = path.resolve(
  process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados')
);
const HALTS_DIR = path.join(GLADOS_RUNTIME_DIR, 'halts');

function safeAgentId(agentId) {
  const id = String(agentId || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`invalid agent id: ${agentId}`);
  return id;
}

function ensureHaltsDir() {
  fs.mkdirSync(HALTS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(HALTS_DIR, 0o700);
  return HALTS_DIR;
}

function haltPath(agentId) {
  return path.join(HALTS_DIR, `${safeAgentId(agentId)}.json`);
}

function readMarker(agentId) {
  const file = haltPath(agentId);
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...marker, path: file };
  } catch {
    return null;
  }
}

function writeMarker(agentId, marker) {
  ensureHaltsDir();
  const file = haltPath(agentId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

async function agentHalt(agentId, reason, { initiator = 'operator' } = {}) {
  const id = safeAgentId(agentId);
  const marker = {
    version: 1,
    agentId: id,
    reason: String(reason || 'halted by operator').slice(0, 500),
    initiator: String(initiator || 'operator').slice(0, 100),
    haltedAt: new Date().toISOString(),
    haltedAtMs: Date.now(),
  };
  const file = writeMarker(id, marker);
  db.prepare(`INSERT INTO halt_log (agent_id, reason, initiator, action, at) VALUES (?, ?, ?, 'halt', ?)`)
    .run(id, marker.reason, marker.initiator, marker.haltedAtMs);
  return { ok: true, agentId: id, haltActive: true, marker: { ...marker, path: file } };
}

async function agentResume(agentId, { initiator = 'operator' } = {}) {
  const id = safeAgentId(agentId);
  const file = haltPath(id);
  const wasHalted = fs.existsSync(file);
  try { fs.rmSync(file, { force: true }); } catch {}
  db.prepare(`INSERT INTO halt_log (agent_id, initiator, action, at) VALUES (?, ?, 'resume', ?)`)
    .run(id, String(initiator || 'operator').slice(0, 100), Date.now());
  return { ok: true, agentId: id, haltActive: false, wasHalted };
}

function agentStatus(agentId) {
  const id = safeAgentId(agentId);
  const marker = readMarker(id);
  const lastAction = db.prepare(`SELECT * FROM halt_log WHERE agent_id = ? ORDER BY at DESC LIMIT 1`).get(id);
  return { agentId: id, haltActive: !!marker, marker, lastAction };
}

function listHaltedAgents() {
  ensureHaltsDir();
  return fs.readdirSync(HALTS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => readMarker(name.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => Number(b.haltedAtMs || 0) - Number(a.haltedAtMs || 0));
}

module.exports = {
  GLADOS_RUNTIME_DIR,
  HALTS_DIR,
  haltPath,
  agentHalt,
  agentResume,
  agentStatus,
  listHaltedAgents,
};
