const fs = require('node:fs');
const path = require('node:path');
const { GLADOS_RUNTIME_DIR } = require('../config');

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
      return parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    } catch {
      return {};
    }
  }

  _write() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: this.sessions }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  get(agentId) {
    return this.sessions[String(agentId || '')]?.sessionId || null;
  }

  set(agentId, sessionId) {
    if (!agentId || !sessionId) return null;
    this.sessions[String(agentId)] = { sessionId: String(sessionId), updatedAt: new Date().toISOString() };
    this._write();
    return sessionId;
  }

  clear(agentId) {
    delete this.sessions[String(agentId || '')];
    this._write();
  }

  clearAll() {
    this.sessions = {};
    this._write();
  }
}

module.exports = { SdkSessionRegistry };
