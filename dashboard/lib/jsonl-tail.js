const fs = require('node:fs');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

/**
 * Tail a JSONL session file. Emits one "event" per parsed dashboard-friendly
 * entry. Handles file rotation (new JSONL per session) by being cheap to
 * instantiate — create a new JsonlTail per session file.
 *
 * Emits:
 *   "event" -> { kind, ts, raw, ...fields }
 *     kinds: "session-start" | "thinking" | "assistant-text" | "tool-call" |
 *            "tool-result" | "user-message" | "meta" | "prompt-error"
 *   "end"
 *   "error" -> Error
 */
class JsonlTail extends EventEmitter {
  constructor(filePath, opts = {}) {
    super();
    this.filePath = filePath;
    this.fromEnd = !!opts.fromEnd;
    this.closed = false;
    this.position = 0;
    this.buffer = '';
    this._pending = false;
    this._reading = false;
    this._needsRead = false;
    this._watcher = null;
  }

  start() {
    fs.stat(this.filePath, (err, st) => {
      if (err) {
        if (err.code === 'ENOENT') this.emit('missing', { filePath: this.filePath, error: err });
        else this._emitError(err);
        return;
      }
      this.position = this.fromEnd ? st.size : 0;
      this._readNewBytes(() => {
        try {
          this._watcher = fs.watch(this.filePath, { persistent: true }, () => {
            this._scheduleRead();
          });
          // Catch bytes appended between the initial stat/read and watcher
          // attachment. Subagent prompts often land in exactly that tiny gap.
          this._scheduleRead();
        } catch (e) {
          if (e.code === 'ENOENT') this.emit('missing', { filePath: this.filePath, error: e });
          else this._emitError(e);
        }
      });
    });
    return this;
  }

  _scheduleRead() {
    if (this.closed) return;
    if (this._pending || this._reading) {
      this._needsRead = true;
      return;
    }
    this._pending = true;
    setImmediate(() => {
      this._pending = false;
      this._readNewBytes();
    });
  }

  _readNewBytes(done) {
    if (this.closed) return done?.();
    if (this._reading) {
      this._needsRead = true;
      return done?.();
    }
    this._reading = true;
    fs.stat(this.filePath, (err, st) => {
      if (err || this.closed) {
        this._reading = false;
        return done?.();
      }
      if (st.size < this.position) {
        this.position = 0;
        this.buffer = '';
      }
      const start = this.position;
      if (st.size === start) {
        this._reading = false;
        done?.();
        if (this._needsRead) {
          this._needsRead = false;
          this._scheduleRead();
        }
        return;
      }
      const stream = fs.createReadStream(this.filePath, {
        start,
        end: st.size - 1,
      });
      let readBytes = 0;
      stream.on('data', chunk => {
        readBytes += chunk.length;
        this.buffer += chunk.toString('utf8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this._handleLine(line);
        }
      });
      stream.on('end', () => {
        this.position = Math.max(this.position, start + readBytes);
        this._reading = false;
        done?.();
        if (this._needsRead) {
          this._needsRead = false;
          this._scheduleRead();
        }
      });
      stream.on('error', e => {
        this._reading = false;
        if (e.code === 'ENOENT') this.emit('missing', { filePath: this.filePath, error: e });
        else this._emitError(e);
        done?.();
        if (this._needsRead) {
          this._needsRead = false;
          this._scheduleRead();
        }
      });
    });
  }

  _handleLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch (e) { return; }
    const events = convertToEvents(obj);
    for (const ev of events) this.emit('event', ev);
  }

  close() {
    this.closed = true;
    if (this._watcher) { try { this._watcher.close(); } catch {} }
    this.emit('end');
  }

  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }
}

function convertToEvents(obj) {
  const ts = obj.timestamp || new Date().toISOString();
  const id = obj.id;
  const out = [];

  if (obj.type === 'session') {
    out.push({ kind: 'session-start', ts, id, cwd: obj.cwd, version: obj.version });
    return out;
  }
  if (obj.type === 'model_change') {
    out.push({ kind: 'meta', ts, id, sub: 'model', provider: obj.provider, model: obj.modelId });
    return out;
  }
  if (obj.type === 'thinking_level_change') {
    out.push({ kind: 'meta', ts, id, sub: 'thinking-level', level: obj.thinkingLevel });
    return out;
  }
  // Surface upstream/infrastructure errors so they don't look like infinite
  // streaming in the UI. Most common: "LLM idle timeout (60s): no response
  // from model" — the upstream LLM proxy dropping an open connection because
  // Claude's first token took too long to arrive.
  if (obj.type === 'custom' && obj.customType === 'openclaw:prompt-error') {
    const d = obj.data || {};
    out.push({
      kind: 'prompt-error',
      ts,
      id,
      error: d.error || 'unknown prompt error',
      provider: d.provider,
      model: d.model,
      api: d.api,
      runId: d.runId,
      sessionId: d.sessionId,
    });
    return out;
  }
  if (obj.type !== 'message') return out;

  const m = obj.message || {};
  const role = m.role;

  if (role === 'user') {
    const text = extractText(m.content);
    if (text) out.push({ kind: 'user-message', ts, id, text });
    return out;
  }

  if (role === 'toolResult') {
    const text = extractText(m.content);
    out.push({
      kind: 'tool-result',
      ts,
      id,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      isError: !!m.isError,
      text,
      exitCode: m.details?.exitCode,
      status: m.details?.status,
      durationMs: m.details?.durationMs,
    });
    return out;
  }

  if (role === 'assistant' && m.stopReason === 'error') {
    out.push({
      kind: 'prompt-error',
      ts,
      id,
      error: m.errorMessage || 'assistant stopped with an unknown model error',
      provider: m.provider,
      model: m.model,
      api: m.api,
    });
    return out;
  }

  if (role === 'assistant' && Array.isArray(m.content)) {
    const hasToolCall = m.content.some(c => c && c.type === 'toolCall');
    for (const c of m.content) {
      if (c.type === 'thinking' && c.thinking) {
        out.push({ kind: 'thinking', ts, id, text: c.thinking });
      } else if (c.type === 'text' && c.text) {
        // Assistant messages that also contain tool calls are pre-tool
        // commentary. Rendering them creates the appearance of "two replies"
        // for one turn: a small "I'll check..." bubble before tools, then the
        // actual answer after tool results. Keep tool-call visibility, but
        // only render assistant text once the final no-tool-call message lands.
        if (hasToolCall) continue;
        out.push({ kind: 'assistant-text', ts, id, text: c.text });
      } else if (c.type === 'toolCall') {
        out.push({
          kind: 'tool-call',
          ts,
          id,
          toolCallId: c.id,
          toolName: c.name,
          arguments: c.arguments,
        });
      }
    }
  }
  return out;
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
}

module.exports = { JsonlTail, convertToEvents };
