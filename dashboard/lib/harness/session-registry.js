const fs = require('node:fs');
const path = require('node:path');
const { GLADOS_RUNTIME_DIR } = require('../config');

function normalizeCwdScope(value) {
  return value ? path.resolve(String(value)) : null;
}

class SdkSessionRegistry {
  constructor(input = null) {
    this.file = typeof input === 'string'
      ? input
      : path.join(input?.runtimeDir || GLADOS_RUNTIME_DIR, 'sessions', 'agent-sdk-sessions.json');
    this.sessions = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version >= 3 && parsed?.sessions && typeof parsed.sessions === 'object') return parsed.sessions;
      if (parsed?.sessions && typeof parsed.sessions === 'object') return { legacy: parsed.sessions };
      return {};
    } catch {
      return {};
    }
  }

  _write() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 3, sessions: this.sessions }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  get(sessionId, agentId, cwdScope = null) {
    if (arguments.length < 3) { cwdScope = agentId; agentId = sessionId; sessionId = 'legacy'; }
    const session = this.sessions[String(sessionId || 'legacy')] || {};
    const key = String(agentId || '');
    const entry = session[key];
    if (!entry?.sessionId) return null;
    const requestedScope = normalizeCwdScope(cwdScope);
    if (requestedScope && normalizeCwdScope(entry.cwdScope) !== requestedScope) {
      return null;
    }
    return entry.sessionId;
  }

  set(investigationSessionId, agentId, sdkSessionId, cwdScope = null) {
    if (arguments.length < 4) {
      cwdScope = sdkSessionId;
      sdkSessionId = agentId;
      agentId = investigationSessionId;
      investigationSessionId = 'legacy';
    }
    if (!agentId || !sdkSessionId) return null;
    const scope = String(investigationSessionId || 'legacy');
    this.sessions[scope] ||= {};
    this.sessions[scope][String(agentId)] = {
      sessionId: String(sdkSessionId),
      cwdScope: normalizeCwdScope(cwdScope),
      updatedAt: new Date().toISOString(),
    };
    this._write();
    return sdkSessionId;
  }

  clear(sessionId, agentId) {
    if (agentId === undefined) { agentId = sessionId; sessionId = 'legacy'; }
    const scope = String(sessionId || 'legacy');
    delete this.sessions[scope]?.[String(agentId || '')];
    if (this.sessions[scope] && !Object.keys(this.sessions[scope]).length) delete this.sessions[scope];
    this._write();
  }

  clearSession(sessionId) {
    delete this.sessions[String(sessionId || 'legacy')];
    this._write();
  }

  clearAll() {
    this.sessions = {};
    this._write();
  }
}

module.exports = { SdkSessionRegistry };
