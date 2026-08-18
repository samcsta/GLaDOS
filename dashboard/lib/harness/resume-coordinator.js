const fs = require('node:fs');
const path = require('node:path');

class ResumeCoordinator {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.paused = new Map();
    this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [storedKey, snapshot] of Object.entries(parsed?.paused || {})) {
        const agentId = snapshot?.agentId || storedKey;
        const sessionId = snapshot?.investigationSessionId || 'legacy';
        if (agentId) this.paused.set(this.key(sessionId, agentId), { ...snapshot, agentId, investigationSessionId: sessionId });
      }
    } catch {}
  }

  key(sessionId, agentId) {
    return `${String(sessionId || 'legacy')}\0${String(agentId || '').trim()}`;
  }

  persist() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ paused: Object.fromEntries(this.paused) }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  capture(agentId, work = {}) {
    const id = String(agentId || '').trim();
    if (!id) return null;
    const snapshot = {
      agentId: id,
      investigationSessionId: work.investigationSessionId || null,
      parentAgentId: work.parentAgentId || 'glados',
      taskPrompt: String(work.taskPrompt || '').trim(),
      taskDescription: String(work.taskDescription || '').trim(),
      operatorPrompt: String(work.operatorPrompt || '').trim(),
      haltedAt: new Date().toISOString(),
    };
    this.paused.set(this.key(snapshot.investigationSessionId, id), snapshot);
    this.persist();
    return snapshot;
  }

  take(agentId, sessionId = 'legacy') {
    const id = String(agentId || '').trim();
    const key = this.key(sessionId, id);
    const snapshot = this.paused.get(key) || null;
    if (snapshot) {
      this.paused.delete(key);
      this.persist();
    }
    return snapshot;
  }

  clear(agentId, sessionId = 'legacy') {
    if (this.paused.delete(this.key(sessionId, agentId))) this.persist();
  }

  clearSession(sessionId = 'legacy') {
    const prefix = `${String(sessionId || 'legacy')}\0`;
    let changed = false;
    for (const key of [...this.paused.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.paused.delete(key);
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }

  clearAll() {
    this.paused.clear();
    this.persist();
  }

  buildContinuationPrompt(snapshot) {
    if (!snapshot?.agentId) throw new Error('paused agent snapshot is required');
    const task = snapshot.taskPrompt || snapshot.taskDescription || 'Continue the interrupted assigned task from the current GLaDOS session context.';
    const operatorContext = snapshot.operatorPrompt || 'Use the current operator conversation and engagement state.';
    return [
      `[Operator action: resume ${snapshot.agentId}]`,
      `The operator explicitly resumed ${snapshot.agentId} after halting it. Re-dispatch exactly ${snapshot.agentId} and continue its interrupted work; do not substitute another specialist.`,
      '',
      'Preserved subagent task:',
      task,
      '',
      'Original operator request:',
      operatorContext,
      '',
      'Re-check the current scope, plan, health, and halt gates before any target-facing tool call. Relay the resumed agent\'s final result back to the operator.',
    ].join('\n');
  }
}

module.exports = { ResumeCoordinator };
