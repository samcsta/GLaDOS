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

function haltDb() {
  try { db.exec("ALTER TABLE halt_log ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy'"); } catch {}
  return db;
}

function ensureHaltsDir() {
  fs.mkdirSync(HALTS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(HALTS_DIR, 0o700);
  return HALTS_DIR;
}

function safeSessionId(sessionId) {
  const id = String(sessionId || 'legacy').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`invalid session id: ${sessionId}`);
  return id;
}

function haltPath(agentId, sessionId = process.env.GLADOS_SESSION_ID || 'legacy') {
  return path.join(HALTS_DIR, safeSessionId(sessionId), `${safeAgentId(agentId)}.json`);
}

function readMarker(agentId, sessionId) {
  const file = haltPath(agentId, sessionId);
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...marker, path: file };
  } catch {
    return null;
  }
}

function writeMarker(agentId, marker, sessionId) {
  ensureHaltsDir();
  const file = haltPath(agentId, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

async function agentHalt(agentId, reason, { initiator = 'operator', sessionId = process.env.GLADOS_SESSION_ID || 'legacy' } = {}) {
  const id = safeAgentId(agentId);
  const marker = {
    version: 1,
    agentId: id,
    reason: String(reason || 'halted by operator').slice(0, 500),
    initiator: String(initiator || 'operator').slice(0, 100),
    haltedAt: new Date().toISOString(),
    haltedAtMs: Date.now(),
    sessionId: safeSessionId(sessionId),
  };
  const file = writeMarker(id, marker, marker.sessionId);
  haltDb().prepare(`INSERT INTO halt_log (agent_id, session_id, reason, initiator, action, at) VALUES (?, ?, ?, ?, 'halt', ?)`)
    .run(id, marker.sessionId, marker.reason, marker.initiator, marker.haltedAtMs);
  return { ok: true, agentId: id, haltActive: true, marker: { ...marker, path: file } };
}

async function agentResume(agentId, { initiator = 'operator', sessionId = process.env.GLADOS_SESSION_ID || 'legacy' } = {}) {
  const id = safeAgentId(agentId);
  const normalizedSessionId = safeSessionId(sessionId);
  const file = haltPath(id, normalizedSessionId);
  const wasHalted = fs.existsSync(file);
  try { fs.rmSync(file, { force: true }); } catch {}
  haltDb().prepare(`INSERT INTO halt_log (agent_id, session_id, initiator, action, at) VALUES (?, ?, ?, 'resume', ?)`)
    .run(id, normalizedSessionId, String(initiator || 'operator').slice(0, 100), Date.now());
  return { ok: true, agentId: id, haltActive: false, wasHalted };
}

function agentStatus(agentId, { sessionId = process.env.GLADOS_SESSION_ID || 'legacy' } = {}) {
  const id = safeAgentId(agentId);
  const normalizedSessionId = safeSessionId(sessionId);
  const marker = readMarker(id, normalizedSessionId);
  const lastAction = haltDb().prepare(`SELECT * FROM halt_log WHERE agent_id = ? AND session_id=? ORDER BY at DESC LIMIT 1`).get(id, normalizedSessionId);
  return { agentId: id, haltActive: !!marker, marker, lastAction };
}

function listHaltedAgents({ sessionId = process.env.GLADOS_SESSION_ID || 'legacy' } = {}) {
  ensureHaltsDir();
  const normalizedSessionId = safeSessionId(sessionId);
  const dir = path.join(HALTS_DIR, normalizedSessionId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names
    .filter(name => name.endsWith('.json'))
    .map(name => readMarker(name.slice(0, -5), normalizedSessionId))
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
