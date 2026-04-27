// Tails ~/.openclaw/logs/raw-stream.jsonl — the gateway's per-token stream log
// (enabled via OPENCLAW_RAW_STREAM=1). Emits events tagged by sessionId; the
// caller resolves sessionId -> agentId and fans out over SSE.
//
// File format (per line, one JSON object):
//   { "ts": 1776702..., "event": "assistant_thinking_stream",
//     "runId": "...", "sessionId": "<session-uuid>",
//     "evtType": "thinking_start"|"thinking_delta"|"thinking_end",
//     "delta": "...", "content": "..." }
//   { "ts": ..., "event": "assistant_text_stream",
//     "evtType": "text_start"|"text_delta"|"text_end",
//     "delta": "...", "content": "..." }
//
// Rotation: when the file passes ROTATE_BYTES, we rename it to `.1` and
// continue tailing the new empty file. Keeps a single .1 around — simple,
// bounded, and avoids unbounded disk growth on long engagements.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const DEFAULT_PATH = path.join(
  os.homedir(),
  '.openclaw/logs/raw-stream.jsonl'
);
const ROTATE_BYTES = 50 * 1024 * 1024; // 50MB

class RawStreamTail extends EventEmitter {
  constructor(filePath = process.env.OPENCLAW_RAW_STREAM_PATH || DEFAULT_PATH) {
    super();
    this.filePath = filePath;
    this.closed = false;
    this.position = 0;
    this.buffer = '';
    this._pending = false;
    this._watcher = null;
    this._rotateTimer = null;
  }

  start() {
    // Create the file if it doesn't exist yet so fs.watch has something to
    // attach to; the gateway will start appending to it once a turn runs.
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.closeSync(fs.openSync(this.filePath, 'a'));
    } catch (e) {
      this.emit('error', e);
      return this;
    }
    // Start from END of file — we don't want to replay historical tokens.
    try { this.position = fs.statSync(this.filePath).size; } catch { this.position = 0; }
    this._attachWatcher();
    // Poll rotation check every 30s. fs.stat is cheap.
    this._rotateTimer = setInterval(() => this._maybeRotate(), 30_000);
    return this;
  }

  _attachWatcher() {
    try {
      this._watcher = fs.watch(this.filePath, { persistent: true }, () => {
        this._scheduleRead();
      });
    } catch (e) {
      // If the file gets deleted (e.g. rotation elsewhere) try again.
      setTimeout(() => !this.closed && this._attachWatcher(), 500);
    }
  }

  _scheduleRead() {
    if (this._pending || this.closed) return;
    this._pending = true;
    setImmediate(() => {
      this._pending = false;
      this._readNewBytes();
    });
  }

  _readNewBytes() {
    if (this.closed) return;
    fs.stat(this.filePath, (err, st) => {
      if (err || this.closed) return;
      // File truncated / rotated underneath us — reset to 0.
      if (st.size < this.position) this.position = 0;
      if (st.size === this.position) return;
      const stream = fs.createReadStream(this.filePath, {
        start: this.position,
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
      stream.on('end', () => { this.position += readBytes; });
      stream.on('error', e => this.emit('error', e));
    });
  }

  _handleLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    if (!obj.sessionId && !obj.runId) return;
    // Normalize to a dashboard-friendly event. The kind separates thinking
    // from text so the frontend can style/group them; evtType preserves the
    // fine-grained start/delta/end so we can update vs finalize a live entry.
    const isThinking = obj.event === 'assistant_thinking_stream';
    const isText = obj.event === 'assistant_text_stream';
    if (!isThinking && !isText) return;
    const tsMs = Number(obj.ts);
    const tsDate = Number.isFinite(tsMs) ? new Date(tsMs) : null;
    const ts = tsDate && !Number.isNaN(tsDate.getTime())
      ? tsDate.toISOString()
      : new Date().toISOString();
    this.emit('raw', {
      kind: isThinking ? 'thinking-stream' : 'text-stream',
      ts,
      sessionId: obj.sessionId || null,
      runId: obj.runId,
      evtType: obj.evtType,      // thinking_start|thinking_delta|thinking_end|text_start|...
      delta: typeof obj.delta === 'string' ? obj.delta : '',
      content: typeof obj.content === 'string' ? obj.content : '',
    });
  }

  _maybeRotate() {
    if (this.closed) return;
    fs.stat(this.filePath, (err, st) => {
      if (err || this.closed) return;
      if (st.size < ROTATE_BYTES) return;
      const rotated = this.filePath + '.1';
      try { fs.rmSync(rotated, { force: true }); } catch {}
      try {
        fs.renameSync(this.filePath, rotated);
        fs.closeSync(fs.openSync(this.filePath, 'a'));
        this.position = 0;
        this.buffer = '';
        // Re-attach the watcher to the new inode.
        try { this._watcher?.close(); } catch {}
        this._attachWatcher();
        this.emit('rotated', { rotatedTo: rotated });
      } catch (e) {
        this.emit('error', e);
      }
    });
  }

  close() {
    this.closed = true;
    if (this._watcher) { try { this._watcher.close(); } catch {} }
    if (this._rotateTimer) clearInterval(this._rotateTimer);
  }
}

module.exports = { RawStreamTail };
