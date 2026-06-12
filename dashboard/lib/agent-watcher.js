const path = require('node:path');
const { EventEmitter } = require('node:events');
const chokidar = require('chokidar');
const { AGENTS_DIR } = require('./config');
const { JsonlTail } = require('./jsonl-tail');
const { listAgentIds, currentSessionForAgent } = require('./openclaw');

/**
 * Watches every agent's sessions/ directory and exposes a unified event stream.
 * Each JSONL line is re-emitted with its agent id attached.
 *
 * Emits:
 *   "session-started" -> { agentId, sessionId, sessionFile }
 *   "session-ended"   -> { agentId, sessionId }
 *   "event"           -> { agentId, sessionId, ...parsed }
 */
class AgentWatcher extends EventEmitter {
  constructor() {
    super();
    this.tails = new Map(); // sessionFile -> { tail, agentId, sessionId }
    this.sessionState = new Map(); // agentId -> current session snapshot
    this._watcher = null;
  }

  start() {
    const initial = listAgentIds();
    for (const agentId of initial) this._rescanAgent(agentId);

    this._watcher = chokidar.watch(AGENTS_DIR, {
      depth: 3,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    this._watcher.on('add', p => this._onPath(p));
    this._watcher.on('change', p => this._onPath(p));
    this._watcher.on('unlink', p => this._onUnlink(p));
    return this;
  }

  _onPath(p) {
    if (!p.endsWith('.jsonl')) {
      if (p.endsWith('sessions.json')) {
        const agentId = agentIdFromPath(p);
        if (agentId) this._rescanAgent(agentId);
      }
      return;
    }
    const agentId = agentIdFromPath(p);
    if (!agentId) return;
    if (!this.tails.has(p)) this._attachTail(agentId, p);
  }

  _onUnlink(p) {
    if (!p.endsWith('.jsonl')) return;
    const entry = this.tails.get(p);
    if (entry) {
      entry.tail.close();
      this.tails.delete(p);
      this.emit('session-ended', { agentId: entry.agentId, sessionId: entry.sessionId });
    }
  }

  _rescanAgent(agentId) {
    const snap = currentSessionForAgent(agentId);
    if (!snap || !snap.sessionFile) {
      this._detachAgent(agentId);
      return;
    }
    this.sessionState.set(agentId, snap);
    if (!snap.live) {
      this._detachAgent(agentId, snap.sessionFile);
      return;
    }
    if (!this.tails.has(snap.sessionFile)) this._attachTail(agentId, snap.sessionFile);
  }

  _detachAgent(agentId, sessionFile = null) {
    for (const [p, entry] of this.tails.entries()) {
      if (entry.agentId !== agentId) continue;
      if (sessionFile && p !== sessionFile) continue;
      entry.tail.close();
      this.tails.delete(p);
      this.emit('session-ended', { agentId: entry.agentId, sessionId: entry.sessionId });
    }
  }

  _attachTail(agentId, sessionFile) {
    const sessionId = path.basename(sessionFile, '.jsonl');
    const tail = new JsonlTail(sessionFile, { fromEnd: true });
    const entry = { tail, agentId, sessionId };
    this.tails.set(sessionFile, entry);
    tail.on('event', ev => {
      this.emit('event', { agentId, sessionId, ...ev });
    });
    tail.on('missing', () => {
      tail.close();
      this.tails.delete(sessionFile);
      this.emit('session-ended', { agentId, sessionId });
    });
    tail.on('error', () => {});
    tail.start();
    this.emit('session-started', { agentId, sessionId, sessionFile });
  }

  activeAgents() {
    const agents = new Map();
    for (const { agentId, sessionId } of this.tails.values()) {
      const snap = currentSessionForAgent(agentId);
      if (!snap?.live) continue;
      agents.set(agentId, { agentId, sessionId });
    }
    return [...agents.values()];
  }

  stop() {
    for (const { tail } of this.tails.values()) tail.close();
    this.tails.clear();
    if (this._watcher) this._watcher.close();
  }
}

function agentIdFromPath(p) {
  const rel = path.relative(AGENTS_DIR, p);
  if (!rel || rel.startsWith('..')) return null;
  const first = rel.split(path.sep)[0];
  return first || null;
}

module.exports = { AgentWatcher };
