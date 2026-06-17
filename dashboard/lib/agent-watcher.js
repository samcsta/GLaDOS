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
    this.lifecycle = new Map(); // agentId -> { sessionId, live }
    this._watcher = null;
    this._rescanTimer = null;
  }

  start() {
    this._rescanAll();

    this._watcher = chokidar.watch(AGENTS_DIR, {
      depth: 3,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    this._watcher.on('add', p => this._onPath(p));
    this._watcher.on('change', p => this._onPath(p));
    this._watcher.on('unlink', p => this._onUnlink(p));
    // Chokidar can miss the exact sessions.json transition when OpenClaw
    // creates a subagent and writes the prompt immediately. Polling the small
    // sessions indexes makes live transcript attachment deterministic.
    this._rescanTimer = setInterval(() => this._rescanAll(), 2_000);
    this._rescanTimer.unref?.();
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
    const snap = currentSessionForAgent(agentId);
    if (!snap?.live || snap.sessionFile !== p) return;
    if (!this.tails.has(p)) this._attachTail(agentId, p);
  }

  _onUnlink(p) {
    if (!p.endsWith('.jsonl')) return;
    const entry = this.tails.get(p);
    if (entry) {
      entry.tail.close();
      this.tails.delete(p);
      const snap = currentSessionForAgent(entry.agentId);
      if (isEndedSnapshot(snap, entry.sessionId)) this._emitSessionEnded(entry.agentId, entry.sessionId);
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

  _rescanAll() {
    const agents = listAgentIds();
    for (const agentId of agents) this._rescanAgent(agentId);
  }

  _detachAgent(agentId, sessionFile = null) {
    for (const [p, entry] of this.tails.entries()) {
      if (entry.agentId !== agentId) continue;
      if (sessionFile && p !== sessionFile) continue;
      entry.tail.close();
      this.tails.delete(p);
      const snap = currentSessionForAgent(entry.agentId);
      if (!sessionFile || isEndedSnapshot(snap, entry.sessionId)) {
        this._emitSessionEnded(entry.agentId, entry.sessionId);
      }
    }
  }

  _attachTail(agentId, sessionFile) {
    const sessionId = path.basename(sessionFile, '.jsonl');
    const tail = new JsonlTail(sessionFile, { fromEnd: false });
    const entry = { tail, agentId, sessionId };
    this.tails.set(sessionFile, entry);
    tail.on('event', ev => {
      this.emit('event', { agentId, sessionId, ...ev });
    });
    tail.on('missing', () => {
      tail.close();
      this.tails.delete(sessionFile);
      const snap = currentSessionForAgent(agentId);
      if (isEndedSnapshot(snap, sessionId)) this._emitSessionEnded(agentId, sessionId);
    });
    tail.on('error', () => {});
    tail.start();
    this._emitSessionStarted(agentId, sessionId, sessionFile);
  }

  _emitSessionStarted(agentId, sessionId, sessionFile) {
    const prev = this.lifecycle.get(agentId);
    if (prev?.live && prev.sessionId === sessionId) return;
    this.lifecycle.set(agentId, { sessionId, live: true });
    this.emit('session-started', { agentId, sessionId, sessionFile });
  }

  _emitSessionEnded(agentId, sessionId) {
    const prev = this.lifecycle.get(agentId);
    if (!prev?.live || prev.sessionId !== sessionId) return;
    this.lifecycle.set(agentId, { sessionId, live: false });
    this.emit('session-ended', { agentId, sessionId });
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
    if (this._rescanTimer) clearInterval(this._rescanTimer);
  }
}

function isEndedSnapshot(snap, sessionId) {
  if (!snap || snap.sessionId !== sessionId) return false;
  const endedAt = typeof snap.endedAt === 'number' ? snap.endedAt : 0;
  const startedAt = typeof snap.startedAt === 'number' ? snap.startedAt : 0;
  if (endedAt > 0 && (!startedAt || endedAt >= startedAt)) return true;
  return ['done', 'timeout', 'error', 'aborted'].includes(String(snap.status || '').toLowerCase());
}

function agentIdFromPath(p) {
  const rel = path.relative(AGENTS_DIR, p);
  if (!rel || rel.startsWith('..')) return null;
  const first = rel.split(path.sep)[0];
  return first || null;
}

module.exports = { AgentWatcher };
