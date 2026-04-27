const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { PORT, BLACKBOARD_DB } = require('./lib/config');
const { AgentWatcher } = require('./lib/agent-watcher');
const { loadAgentRegistry, listAgentIds, currentSessionForAgent, sendMessageToAgent } = require('./lib/openclaw');
const reports = require('./lib/reports');
const agentDetails = require('./lib/agent-details');
const { JsonlTail } = require('./lib/jsonl-tail');
const { RawStreamTail } = require('./lib/raw-stream-tail');
const watchdogHealth = require('glados-watchdog/lib/health');
const watchdogHalt = require('glados-watchdog/lib/halt');
const { CircuitBreaker, getBurpRps } = require('glados-watchdog/lib/breaker');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

try {
  require('../scripts/lib/glados-local').ensureBlackboardDb({ blackboardDb: BLACKBOARD_DB });
} catch (e) {
  console.warn('[startup] could not initialize blackboard db:', e.message);
}

const watcher = new AgentWatcher().start();

// Per-agent ring buffer of recent events (for new SSE subscribers to backfill).
const BUFFER_LIMIT = 500;
const buffers = new Map(); // agentId -> array of events (newest last)
const sseClients = new Map(); // agentId -> Set<res>
const lobbyClients = new Set(); // /api/agents SSE subscribers
const activeChatTurns = new Map(); // agentId -> { turnId, startedAt, messagePreview }
const recentChatTurns = new Map(); // agentId -> { turnId, expiresAt } short grace for late raw-stream fs events

function pushBuffer(agentId, ev) {
  let buf = buffers.get(agentId);
  if (!buf) { buf = []; buffers.set(agentId, buf); }
  buf.push(ev);
  if (buf.length > BUFFER_LIMIT) buf.shift();
}

function broadcastTranscript(agentId, ev) {
  const set = sseClients.get(agentId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of set) res.write(payload);
}

function broadcastLobby(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of lobbyClients) res.write(payload);
}

function startChatTurn(agentId, message) {
  const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  activeChatTurns.set(agentId, {
    turnId,
    startedAt,
    messagePreview: String(message || '').slice(0, 160),
  });
  recentChatTurns.delete(agentId);
  broadcastLobby('chat-turn-started', { agentId, turnId, startedAt });
  return turnId;
}

function finishChatTurn(agentId, turnId) {
  const current = activeChatTurns.get(agentId);
  if (!current || current.turnId !== turnId) return;
  activeChatTurns.delete(agentId);
  recentChatTurns.set(agentId, { turnId, expiresAt: Date.now() + 15_000 });
  broadcastLobby('chat-turn-ended', { agentId, turnId });
}

function openclawResultError(result) {
  const payloads = result?.result?.payloads || [];
  const text = payloads.map(p => p?.text || '').join('\n').trim();
  if (/LLM request failed|LLM idle timeout|network connection error/i.test(text)) {
    return text || 'OpenClaw model request failed';
  }
  const stopReason = result?.result?.stopReason;
  const err = result?.result?.error || result?.error;
  if (stopReason === 'error' || err) return err || 'OpenClaw run stopped with error';
  return null;
}

function assessmentAgentIds() {
  const registryIds = loadAgentRegistry().map(a => a.id).filter(Boolean);
  const ids = registryIds.length ? registryIds : listAgentIds();
  // Atlas is the user's general chatbot; a GLaDOS operational reset should not
  // erase that separate conversation unless Atlas itself is selected.
  return [...new Set(ids)].filter(id => id !== 'atlas');
}

function resetAgentSession(agentId, ts = new Date().toISOString().replace(/[:.]/g, '-')) {
  const fs = require('node:fs');
  const os = require('node:os');
  const sessionsIdxPath = path.join(os.homedir(), '.openclaw/agents', agentId, 'sessions/sessions.json');
  const key = `agent:${agentId}:main`;
  const snap = currentSessionForAgent(agentId);
  let idx = null;
  let entry = null;
  let archivedPath = null;
  let removedLockPath = null;
  let removedIndexEntry = false;

  try {
    idx = JSON.parse(fs.readFileSync(sessionsIdxPath, 'utf8'));
    entry = idx?.[key] || null;
  } catch {}

  const sessionFile = snap?.sessionFile || entry?.sessionFile;
  if (sessionFile && fs.existsSync(sessionFile)) {
    archivedPath = `${sessionFile}.archived-${ts}`;
    fs.renameSync(sessionFile, archivedPath);
  }

  const lockPath = sessionFile ? `${sessionFile}.lock` : null;
  if (lockPath && fs.existsSync(lockPath)) {
    fs.rmSync(lockPath, { force: true });
    removedLockPath = lockPath;
  }

  if (idx && idx[key]) {
    delete idx[key];
    fs.writeFileSync(sessionsIdxPath, JSON.stringify(idx, null, 2));
    removedIndexEntry = true;
  }

  buffers.delete(agentId);
  broadcastLobby('session-reset', { agentId, archivedPath, removedIndexEntry });
  return {
    ok: true,
    agentId,
    archivedPath,
    removedLockPath,
    removedIndexEntry,
    hadSession: !!sessionFile || removedIndexEntry,
  };
}

function candidateRawStreamAgent() {
  const active = [...activeChatTurns.keys()];
  if (active.length === 1) return active[0];
  const now = Date.now();
  for (const [agentId, v] of recentChatTurns) {
    if (!v || v.expiresAt < now) recentChatTurns.delete(agentId);
  }
  const recent = [...recentChatTurns.keys()];
  return recent.length === 1 ? recent[0] : null;
}

watcher.on('event', ev => {
  pushBuffer(ev.agentId, ev);
  broadcastTranscript(ev.agentId, ev);
});
watcher.on('session-started', info => {
  broadcastLobby('session-started', info);
});
watcher.on('session-ended', info => {
  broadcastLobby('session-ended', info);
});

// --- Real-time token stream from OpenClaw's raw-stream log ---
// The gateway (when launched with OPENCLAW_RAW_STREAM=1) appends per-token
// thinking/text deltas to ~/.openclaw/logs/raw-stream.jsonl. The file's
// events are keyed by sessionId — we maintain a reverse map sessionId->agentId
// from each agent's sessions.json and fan every delta into the matching
// agent's SSE transcript stream. Frontend coalesces deltas into one live entry
// per turn (see public/app.js 'thinking-stream' / 'text-stream' handling).
const sessionToAgent = new Map(); // sessionId -> agentId
const orphanRawDeltas = new Map(); // sessionId -> [{...raw-stream ev}]
function bufferOrphanRawDelta(ev) {
  const key = ev.sessionId;
  if (!key) return;
  const arr = orphanRawDeltas.get(key) || [];
  arr.push({ ev, ts: Date.now() });
  while (arr.length > 300) arr.shift();
  orphanRawDeltas.set(key, arr);
}
function flushOrphanRawDeltas(sessionId, agentId) {
  const arr = orphanRawDeltas.get(sessionId);
  if (!arr || !agentId) return;
  orphanRawDeltas.delete(sessionId);
  const cutoff = Date.now() - 30_000;
  for (const item of arr) {
    if (item.ts < cutoff) continue;
    broadcastTranscript(agentId, { agentId, ...item.ev });
  }
}
function refreshSessionMap() {
  try {
    const registry = loadAgentRegistry();
    for (const a of registry) {
      const snap = currentSessionForAgent(a.id);
      if (snap && snap.sessionId) {
        sessionToAgent.set(snap.sessionId, a.id);
        flushOrphanRawDeltas(snap.sessionId, a.id);
      }
    }
  } catch {}
}
refreshSessionMap();
setInterval(refreshSessionMap, 5_000);
watcher.on('session-started', info => {
  if (info?.sessionId && info?.agentId) {
    sessionToAgent.set(info.sessionId, info.agentId);
    flushOrphanRawDeltas(info.sessionId, info.agentId);
  }
});

const rawStream = new RawStreamTail().start();
rawStream.on('raw', ev => {
  // Lazy-learn: if a sessionId isn't in our map yet (e.g. brand-new session we
  // haven't scanned), do a one-shot refresh before dropping the event.
  let agentId = ev.sessionId ? sessionToAgent.get(ev.sessionId) : null;
  if (!agentId && ev.sessionId) { refreshSessionMap(); agentId = sessionToAgent.get(ev.sessionId); }
  if (!agentId && !ev.sessionId) {
    agentId = candidateRawStreamAgent();
  }
  if (!agentId) {
    if (ev.sessionId) bufferOrphanRawDelta(ev);
    return;
  }
  const enriched = { agentId, ...ev };
  // DO NOT push to the per-agent ring buffer — the buffer is for backfill
  // on reconnect and a 2000-token-per-turn flood would blow it out instantly.
  // Streaming deltas are live-only; reconnecting clients re-read the final
  // message from the session JSONL (which is the durable source of truth).
  broadcastTranscript(agentId, enriched);
});
rawStream.on('rotated', info => {
  console.log(`[raw-stream] rotated to ${info.rotatedTo}`);
});
rawStream.on('error', e => {
  console.warn('[raw-stream] error:', e.message);
});

// --- REST ---

app.get('/api/agents', (req, res) => {
  const registry = loadAgentRegistry();
  const out = registry.map(a => {
    const snap = currentSessionForAgent(a.id);
    return {
      id: a.id,
      name: a.name,
      model: a.model,
      workspace: a.workspace,
      active: !!(snap && snap.live),
      session: snap,
    };
  });
  res.json({ agents: out });
});

// Lobby event stream — session-started / session-ended.
app.get('/api/agents/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  lobbyClients.add(res);
  const registry = loadAgentRegistry();
  const snapshot = registry
    .map(a => ({ agentId: a.id, session: currentSessionForAgent(a.id) }))
    .filter(r => r.session && r.session.live)
    .map(r => ({ agentId: r.agentId, sessionId: r.session.sessionId }));
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  req.on('close', () => lobbyClients.delete(res));
});

// Per-agent transcript SSE. On connect, backfills recent buffer then streams live.
app.get('/api/agents/:id/transcript', (req, res) => {
  const agentId = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  // Backfill from in-memory ring first.
  const buf = buffers.get(agentId) || [];
  for (const ev of buf) res.write(`data: ${JSON.stringify(ev)}\n\n`);

  // If we haven't tailed any events yet (e.g. agent opened before dashboard started),
  // read the current session file from disk and emit its history before going live.
  if (buf.length === 0) {
    const snap = currentSessionForAgent(agentId);
    if (snap && snap.sessionFile && fs.existsSync(snap.sessionFile)) {
      const backfill = new JsonlTail(snap.sessionFile);
      backfill.on('event', ev => {
        const enriched = { agentId, sessionId: snap.sessionId, ...ev };
        pushBuffer(agentId, enriched);
        res.write(`data: ${JSON.stringify(enriched)}\n\n`);
      });
      backfill.on('missing', () => {
        res.write(`event: transcript-warning\ndata: ${JSON.stringify({ agentId, warning: 'session file is no longer present; waiting for the next live session' })}\n\n`);
      });
      backfill.on('error', e => {
        console.warn(`[transcript:${agentId}] backfill error:`, e.message);
      });
      backfill.start();
      // Close the backfill tail after one pass; live updates arrive via watcher.
      setTimeout(() => backfill.close(), 500);
    }
  }

  let set = sseClients.get(agentId);
  if (!set) { set = new Set(); sseClients.set(agentId, set); }
  set.add(res);
  req.on('close', () => set.delete(res));
});

// GLaDOS chat — POST message; reply arrives via the normal transcript stream.
app.post('/api/chat/glados', async (req, res) => {
  const message = (req.body && req.body.message) || '';
  if (!message.trim()) return res.status(400).json({ error: 'message required' });
  const turnId = startChatTurn('glados', message);
  try {
    const result = await sendMessageToAgent('glados', message);
    const resultError = openclawResultError(result);
    if (resultError) return res.status(502).json({ ok: false, error: resultError, result });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      stderr: e.stderr,
      stdout: e.stdout,
    });
  } finally {
    finishChatTurn('glados', turnId);
  }
});

// Atlas chat — local general-purpose assistant (not red-team). Same plumbing
// as GLaDOS: POST message, reply streams back over the agent's transcript SSE.
app.post('/api/chat/atlas', async (req, res) => {
  const message = (req.body && req.body.message) || '';
  if (!message.trim()) return res.status(400).json({ error: 'message required' });
  const turnId = startChatTurn('atlas', message);
  try {
    const result = await sendMessageToAgent('atlas', message);
    const resultError = openclawResultError(result);
    if (resultError) return res.status(502).json({ ok: false, error: resultError, result });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stderr: e.stderr, stdout: e.stdout });
  } finally {
    finishChatTurn('atlas', turnId);
  }
});

app.get('/api/chat/status/:agent', (req, res) => {
  const turn = activeChatTurns.get(req.params.agent);
  if (!turn) return res.json({ active: false, agentId: req.params.agent });
  res.json({
    active: true,
    agentId: req.params.agent,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    ageMs: Date.now() - turn.startedAt,
    messagePreview: turn.messagePreview,
  });
});

// Atlas image upload — saves a base64-data-URL image to a staging dir and
// returns the absolute path. The frontend then appends that path into the
// user's next message text so Atlas can use `read` (or vision, if the model
// supports it) to inspect it.
const ATLAS_UPLOADS = path.join(require('node:os').tmpdir(), 'atlas-uploads');
try { require('node:fs').mkdirSync(ATLAS_UPLOADS, { recursive: true }); } catch {}
app.use('/api/chat/atlas/uploads', express.json({ limit: '25mb' }));
app.post('/api/chat/atlas/upload', express.json({ limit: '25mb' }), (req, res) => {
  const { dataUrl, filename } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ ok: false, error: 'dataUrl required' });
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'unsupported image format' });
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const base = (filename || 'upload').replace(/[^\w.\-]/g, '_').slice(0, 40);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(ATLAS_UPLOADS, `${stamp}-${base}.${ext}`);
  try {
    require('node:fs').writeFileSync(outPath, Buffer.from(m[3], 'base64'));
    res.json({ ok: true, path: outPath, bytes: Buffer.from(m[3], 'base64').length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Halt controls (wired to watchdog lib) ---
app.post('/api/halt/:id', async (req, res) => {
  try {
    const result = await watchdogHalt.agentHalt(
      req.params.id,
      req.body?.reason || 'dashboard halt',
      { initiator: 'dashboard' }
    );
    broadcastLobby('halt', { agentId: req.params.id, reason: req.body?.reason });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/resume/:id', async (req, res) => {
  try {
    const result = await watchdogHalt.agentResume(req.params.id, { initiator: 'dashboard' });
    broadcastLobby('resume', { agentId: req.params.id });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/halt-all', async (req, res) => {
  try {
    const result = await watchdogHalt.engagementHaltAll(
      req.body?.engagement_id || null,
      req.body?.reason || 'dashboard halt-all',
      { initiator: 'dashboard' }
    );
    broadcastLobby('halt-all', {
      reason: req.body?.reason,
      haltedAgents: result.haltedAgents || [],
    });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// v3.1: companion to /api/halt-all. Clears deny rules for every agent the
// halt-all added, and re-enables the Burp scope.
app.post('/api/resume-all', async (req, res) => {
  try {
    const result = await watchdogHalt.engagementResumeAll({ initiator: 'dashboard' });
    broadcastLobby('resume-all', { resumed: result.resumed || [] });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Target health ---
app.post('/api/targets/probe', async (req, res) => {
  const { target_url } = req.body || {};
  if (!target_url) return res.status(400).json({ ok: false, error: 'target_url required' });
  try {
    const result = await watchdogHealth.probe(target_url);
    broadcastLobby('target-health', result);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/targets', (req, res) => {
  res.json({ targets: watchdogHealth.listHealth() });
});

// --- Burp RPS + gate indicator ---
app.get('/api/burp/rps', async (req, res) => {
  const rps = await getBurpRps({ windowSec: 10 });
  res.json({ rps });
});

// --- Burp extension passthrough (:1338 — GLaDOS Montoya extension) ---
// The dashboard's Proxy tab calls these; the server forwards to the extension
// so the browser never needs to know about :1338 directly. If the extension
// isn't running, these degrade gracefully (503 / empty SSE).
const BURP_EXT_API = process.env.BURP_EXT_API || 'http://127.0.0.1:1338';
app.get('/api/proxy/detail', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const upstream = await fetch(`${BURP_EXT_API}/proxy/detail?id=${encodeURIComponent(id)}`);
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'not found' });
    res.json(await upstream.json());
  } catch {
    res.status(503).json({ error: 'burp extension unreachable at :1338' });
  }
});
app.get('/api/proxy/metrics', async (req, res) => {
  // v3.1 — per-agent proxy metrics passthrough.
  const qs = new URLSearchParams();
  if (req.query.window) qs.set('window', String(req.query.window));
  try {
    const upstream = await fetch(`${BURP_EXT_API}/proxy/metrics?${qs}`);
    if (!upstream.ok) return res.status(upstream.status).json({ agents: [] });
    res.json(await upstream.json());
  } catch {
    res.status(503).json({ error: 'burp extension unreachable at :1338', agents: [] });
  }
});
app.get('/api/proxy/history', async (req, res) => {
  const qs = new URLSearchParams();
  if (req.query.since) qs.set('since', String(req.query.since));
  if (req.query.limit) qs.set('limit', String(req.query.limit));
  try {
    const upstream = await fetch(`${BURP_EXT_API}/proxy/history?${qs}`);
    if (!upstream.ok) return res.status(upstream.status).json([]);
    const rows = await upstream.json();
    res.json(rows);
  } catch {
    res.status(503).json({ error: 'burp extension unreachable at :1338' });
  }
});
// v3.1 — Request replay. Fires an HTTP request through Burp proxy so it lands
// in history with the provided agent tag; returns the response inline.
// Body: { method, url, headers: {..}, body?: string, agentTag?: string, timeoutMs? }
app.post('/api/proxy/replay', async (req, res) => {
  const { method = 'GET', url, headers = {}, body = null, agentTag = 'replay', timeoutMs = 15000 } =
    req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid http(s) url required' });
  // Forbid replay to loopback / localhost — prevents accidentally re-sending
  // dashboard/gateway/ollama traffic through Burp and muddying attribution.
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
      return res.status(400).json({ error: 'refusing replay to loopback' });
    }
  } catch { return res.status(400).json({ error: 'invalid url' }); }

  const undici = (() => { try { return require('undici'); } catch { return null; } })();
  const ProxyAgent = undici?.ProxyAgent;
  const proxyUrl = process.env.GLADOS_REPLAY_PROXY || 'http://127.0.0.1:8080';
  const dispatcher = ProxyAgent
    ? new ProxyAgent({
      uri: proxyUrl,
      // Replay intentionally talks through Burp, which resigns upstream TLS
      // with the local PortSwigger CA. Some operator shells do not export that
      // CA into Node, so tolerate Burp's interception cert for this endpoint.
      requestTls: { rejectUnauthorized: false },
    })
    : undefined;
  const replayFetch = dispatcher && undici?.fetch ? undici.fetch : fetch;

  const outHeaders = { ...headers, 'X-GLaDOS-Agent': agentTag, 'X-GLaDOS-Replay': '1' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000)));
  const started = Date.now();
  try {
    const init = { method: method.toUpperCase(), headers: outHeaders, signal: controller.signal };
    if (body != null && !['GET','HEAD'].includes(init.method)) init.body = body;
    if (dispatcher) init.dispatcher = dispatcher;
    const upstream = await replayFetch(url, init);
    const respHeaders = {};
    upstream.headers.forEach((v, k) => { respHeaders[k] = v; });
    const text = await upstream.text();
    const elapsedMs = Date.now() - started;
    res.json({
      ok: true, status: upstream.status, statusText: upstream.statusText,
      headers: respHeaders, body: text, elapsedMs, proxied: !!dispatcher, agentTag,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, aborted: controller.signal.aborted });
  } finally {
    clearTimeout(t);
  }
});

app.get('/api/proxy/stream', async (req, res) => {
  // Pipe SSE from the extension to the browser. If the upstream drops, we
  // emit a comment line every 20s so EventSource's auto-reconnect has a
  // clean heartbeat to lock onto.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let upstream, aborted = false;
  const controller = new AbortController();
  req.on('close', () => { aborted = true; controller.abort(); });
  try {
    upstream = await fetch(`${BURP_EXT_API}/proxy/stream`, { signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      res.write(`: upstream unreachable\n\n`);
      return res.end();
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    if (!aborted) res.write(`: upstream error\n\n`);
  }
  res.end();
});

// --- Reports ---
app.get('/api/reports/tree', (req, res) => {
  try { res.json(reports.tree()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/reports/file', (req, res) => {
  try { res.json(reports.readFile(String(req.query.path || ''))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/reports/raw', (req, res) => {
  try { reports.sendRaw(String(req.query.path || ''), res); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/reports/file', (req, res) => {
  try { res.json(reports.deleteFile(String(req.query.path || ''))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/reports/file', (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    res.json(reports.writeMarkdown(String(p || ''), String(content || '')));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Serves the standalone Mermaid flow diagram for the About tab iframe.
app.get('/api/flow-diagram', (req, res) => {
  const p = path.resolve(__dirname, '..', 'glados-flow-diagram.html');
  res.sendFile(p, err => { if (err) res.status(404).send('flow diagram not found'); });
});

// Restarts the OpenClaw Gateway service via `openclaw daemon restart`.
app.post('/api/gateway/restart', (req, res) => {
  const { execFile } = require('node:child_process');
  const { OPENCLAW_BIN } = require('./lib/config');
  execFile(OPENCLAW_BIN, ['daemon', 'restart'], { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: err.message, stderr: stderr?.toString() });
    broadcastLobby('gateway-restart', { ok: true });
    res.json({ ok: true, stdout: stdout?.toString(), stderr: stderr?.toString() });
  });
});

// Archives the current session JSONL so the agent's next turn starts fresh.
app.post('/api/agents/:id/reset-session', (req, res) => {
  const agentId = req.params.id;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ids = agentId === 'glados' ? assessmentAgentIds() : [agentId];
    const results = ids.map(id => {
      try { return resetAgentSession(id, ts); }
      catch (e) { return { ok: false, agentId: id, error: e.message }; }
    });
    const failed = results.filter(r => !r.ok);
    if (failed.length) return res.status(500).json({ ok: false, agentId, cascade: agentId === 'glados', results });
    const primary = results.find(r => r.agentId === agentId) || results[0];
    res.json({
      ok: true,
      agentId,
      archivedPath: primary?.archivedPath || null,
      cascade: agentId === 'glados',
      resetCount: results.length,
      results,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Agent details + model update (Settings) ---
app.get('/api/agents/:id/details', (req, res) => {
  const d = agentDetails.agentDetails(req.params.id);
  if (!d) return res.status(404).json({ error: 'agent not found' });
  res.json(d);
});
app.get('/api/models', async (req, res) => {
  res.json({ models: await agentDetails.listKnownModels() });
});
app.post('/api/agents/:id/model', (req, res) => {
  try {
    const result = agentDetails.updateAgentModel(req.params.id, String(req.body?.model || ''));
    broadcastLobby('agent-model-changed', result);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// --- Slash commands metadata for the chat autocomplete ---
app.get('/api/slash-commands', (req, res) => {
  res.json({
    commands: [
      { cmd: '/help', desc: 'List dashboard slash commands' },
      { cmd: '/agents', desc: 'Show live subagents (curl /api/agents)' },
      { cmd: '/halt <agent>', desc: 'Halt a single agent (writes deny rule + burp-gate halt-agent)' },
      { cmd: '/halt-all', desc: 'Engagement-wide halt (Burp scope drop-all + deny-all)' },
      { cmd: '/resume <agent>', desc: 'Resume a halted agent' },
      { cmd: '/probe <url>', desc: 'Run watchdog target_probe against a URL' },
      { cmd: '/breaker', desc: 'Show circuit-breaker status' },
      { cmd: '/clear', desc: 'Clear the current transcript view (local only)' },
    ],
  });
});

app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, activeAgents: watcher.activeAgents().length });
});

// v3.1 — Burp + patch-integrity sentinel written by the tag-injector preload.
// Dashboard polls every 5s and renders a red banner if `healthy` is false.
app.get('/api/health/burp', (req, res) => {
  const p = path.join(require('node:os').homedir(), '.openclaw/logs/tag-injector-health.json');
  try {
    const raw = require('node:fs').readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const stale = Date.now() - data.ts > 180_000; // older than 3× probe interval
    res.json({ ...data, stale });
  } catch (e) {
    res.status(503).json({
      healthy: false,
      error: 'sentinel not available — tag-injector not loaded?',
      hint: 'Check NODE_OPTIONS on the gateway plist; restart gateway.',
    });
  }
});

// v3.1 — Re-apply the openclaw bundle patches from the dashboard (Help tab
// "Re-apply patches" button). Runs tools/patch-openclaw-bundle.sh and returns
// stdout/stderr so the operator can see the result.
app.post('/api/health/burp/reapply-patches', (req, res) => {
  const { execFile } = require('node:child_process');
  const script = path.resolve(__dirname, '..', 'tools/patch-openclaw-bundle.sh');
  execFile('bash', [script], { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: err.message, stdout: stdout?.toString(), stderr: stderr?.toString() });
    broadcastLobby('patches-reapplied', { ok: true });
    res.json({ ok: true, stdout: stdout?.toString(), stderr: stderr?.toString() });
  });
});

// v3.1 Tier 2 — Getting Started "Validate this step" endpoints.
// Each returns { ok: true|false, detail: '...', hint?: '...' }.
app.get('/api/validate/:step', async (req, res) => {
  const { execFile } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const step = req.params.step;

  const run = (cmd, args, timeoutMs = 5000) => new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

  try {
    if (step === 'burp-ca') {
      const r = await run('security', ['find-certificate', '-c', 'PortSwigger CA', '/Library/Keychains/System.keychain']);
      if (r.code === 0 && /PortSwigger/i.test(r.stdout)) return res.json({ ok: true, detail: 'PortSwigger CA trusted in System.keychain' });
      return res.json({ ok: false, detail: 'PortSwigger CA not found in System.keychain', hint: 'Re-run step 1.4 — export CA from Burp and security add-trusted-cert.' });
    }
    if (step === 'burp-proxy') {
      const r = await run('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', 'http://127.0.0.1:8080', '--max-time', '4', 'http://example.com']);
      const code = Number((r.stdout || '').trim());
      if (code >= 200 && code < 600) return res.json({ ok: true, detail: `proxy alive → example.com → ${code}` });
      return res.json({ ok: false, detail: 'curl through 127.0.0.1:8080 failed', hint: 'Launch Burp Pro and confirm Proxy listener on :8080.' });
    }
    if (step === 'burp-ext') {
      try {
        const r = await fetch('http://127.0.0.1:1338/health', { signal: AbortSignal.timeout(3000) });
        if (r.ok) { const j = await r.json().catch(() => ({})); return res.json({ ok: true, detail: `extension healthy: ${JSON.stringify(j).slice(0,200)}` }); }
        return res.json({ ok: false, detail: `extension returned HTTP ${r.status}`, hint: 'Re-install glados-proxy-api jar in Burp Extensions.' });
      } catch (e) { return res.json({ ok: false, detail: 'no response on :1338', hint: 'Burp closed or extension not loaded — see step 1.6.' }); }
    }
    if (step === 'burp-rest') {
      try {
        const r = await fetch('http://127.0.0.1:1337/v0.1/', { signal: AbortSignal.timeout(3000) });
        if (r.status < 500) return res.json({ ok: true, detail: `Burp native REST reachable (HTTP ${r.status})` });
        return res.json({ ok: false, detail: `Burp REST returned ${r.status}`, hint: 'Enable REST API: Settings → Suite → REST API.' });
      } catch (e) { return res.json({ ok: false, detail: 'no response on :1337', hint: 'Enable Burp REST API at :1337 (loopback, no key).' }); }
    }
    if (step === 'dashboard') {
      return res.json({ ok: true, detail: 'dashboard is responding — you just hit it' });
    }
    if (step === 'gateway') {
      // On some workstations the OpenClaw status probe takes >5s while the
      // daemon is healthy, especially right after a restart.
      const r = await run('/usr/local/bin/openclaw', ['daemon', 'status'], 15000);
      if (r.code === 0 && /running/i.test(r.stdout)) return res.json({ ok: true, detail: 'openclaw daemon: running' });
      // Fallback — try homebrew bin path
      const r2 = await run('/opt/homebrew/bin/openclaw', ['daemon', 'status'], 15000);
      if (r2.code === 0 && /running/i.test(r2.stdout)) return res.json({ ok: true, detail: 'openclaw daemon: running' });
      return res.json({ ok: false, detail: 'openclaw daemon not running', hint: 'Run `openclaw daemon start` or click Restart gateway.' });
    }
    if (step === 'patches') {
      const distDir = path.join(os.homedir(), '../../opt/homebrew/lib/node_modules/openclaw/dist');
      const resolved = path.resolve(distDir);
      const scan = (marker) => {
        try {
          const files = fs.readdirSync(resolved).filter(f => f.endsWith('.js'));
          for (const f of files) {
            const txt = fs.readFileSync(path.join(resolved, f), 'utf8');
            if (txt.includes(marker)) return f;
          }
        } catch {}
        return null;
      };
      const alsFile = scan('GLADOS_ALS_PATCH_V1');
      const ssrfV2File = scan('GLADOS_SSRF_ROUTE_V2');
      const ssrfV1File = ssrfV2File ? null : scan('GLADOS_SSRF_ROUTE_V1');
      const ssrfFile = ssrfV2File || ssrfV1File;
      const ssrfVersion = ssrfV2File ? 'v2' : (ssrfV1File ? 'v1' : 'missing');
      const planGateFile = scan('GLADOS_PLAN_GATE_V2') || scan('GLADOS_PLAN_GATE_V1');
      if (alsFile && ssrfFile && planGateFile) {
        return res.json({
          ok: true,
          detail: `ALS marker in ${alsFile}, SSRF ${ssrfVersion} marker in ${ssrfFile}, plan-gate marker in ${planGateFile}`,
          patches: {
            als: { ok: true, file: alsFile },
            ssrf: { ok: true, file: ssrfFile, version: ssrfVersion },
            planGate: { ok: true, file: planGateFile },
          },
        });
      }
      return res.json({
        ok: false,
        detail: `missing markers — ALS:${alsFile ? 'ok' : 'MISSING'} SSRF:${ssrfFile ? ssrfVersion : 'MISSING'} PLAN_GATE:${planGateFile ? 'ok' : 'MISSING'}`,
        hint: 'Re-run `bash tools/patch-openclaw-bundle.sh`, then Restart gateway.',
      });
    }
    if (step === 'watchdog-mcp') {
      const r = await run('/opt/homebrew/bin/openclaw', ['mcp', 'list'], 5000);
      const out = (r.stdout || '') + (r.stderr || '');
      if (/watchdog/i.test(out)) return res.json({ ok: true, detail: 'watchdog MCP registered' });
      return res.json({ ok: false, detail: 'watchdog MCP not listed', hint: 'Check ~/.openclaw/openclaw.json mcpServers block.' });
    }
    if (step === 'tag-injector') {
      const p = path.join(os.homedir(), '.openclaw/logs/tag-injector-health.json');
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const stale = Date.now() - data.ts > 180_000;
        if (data.healthy && !stale) return res.json({ ok: true, detail: `sentinel healthy · age ${((Date.now() - data.ts)/1000).toFixed(0)}s` });
        return res.json({ ok: false, detail: stale ? 'sentinel is stale' : 'sentinel reports unhealthy', hint: 'Restart gateway; see Help tab Re-apply patches.' });
      } catch { return res.json({ ok: false, detail: 'no sentinel found', hint: 'Gateway not running or NODE_OPTIONS missing preload.' }); }
    }
    return res.status(400).json({ ok: false, error: 'unknown validation step: ' + step });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v3.1 — Plan-approval workflow endpoints (see routes/plans.js).
app.use('/api/plans', require('./routes/plans')(broadcastLobby));

// Circuit breaker — polls Burp proxy history; on trip, broadcast to lobby.
const breaker = new CircuitBreaker({
  intervalMs: 5000,
  onTrip: info => broadcastLobby('breaker-trip', info),
}).start();

// v3.1.04252026 (Blocker E) — Replan-proposal watcher.
// Polls blackboard's replan_proposals table every 5s for state='open' rows.
// Broadcasts plan-replan-proposed once per (engagement_id, finding_id) tuple
// (in-memory dedup); operator approves/dismisses via /api/plans/replan-proposals.
// The dashboard Plans tab renders open proposals as cards.
(function startReplanWatcher() {
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const broadcastedKeys = new Set();
  const dbPath = BLACKBOARD_DB;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error('[replan-watcher] could not open blackboard.db:', e.message);
    return;
  }
  setInterval(() => {
    try {
      const rows = db.prepare(
        "SELECT id, engagement_id, finding_id, cwe_id, confidence_score, enables_vectors, current_plan_id, created_at FROM replan_proposals WHERE state = 'open' ORDER BY created_at DESC LIMIT 50"
      ).all();
      for (const r of rows) {
        const key = `${r.engagement_id}:${r.finding_id}:${r.id}`;
        if (broadcastedKeys.has(key)) continue;
        broadcastedKeys.add(key);
        // Cap memory: keep last 500 keys.
        if (broadcastedKeys.size > 500) {
          const arr = [...broadcastedKeys];
          arr.slice(0, arr.length - 500).forEach(k => broadcastedKeys.delete(k));
        }
        let vectors = null;
        try { vectors = JSON.parse(r.enables_vectors); } catch {}
        broadcastLobby('plan-replan-proposed', {
          proposal_id: r.id,
          engagement_id: r.engagement_id,
          finding_id: r.finding_id,
          cwe_id: r.cwe_id,
          confidence_score: r.confidence_score,
          enables_vectors: vectors,
          current_plan_id: r.current_plan_id,
          created_at: r.created_at,
        });
      }
    } catch (e) {
      console.error('[replan-watcher] poll error:', e.message);
    }
  }, 5_000);
})();

// REST surface for the dashboard Plans tab to list / resolve replan proposals.
app.get('/api/replan-proposals', (req, res) => {
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dbPath = BLACKBOARD_DB;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const where = []; const args = [];
    if (req.query.engagement_id) { where.push('engagement_id = ?'); args.push(req.query.engagement_id); }
    where.push("state = ?"); args.push(req.query.state || 'open');
    const rows = db.prepare(
      `SELECT * FROM replan_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`
    ).all(...args).map(r => ({ ...r, enables_vectors: safeJson(r.enables_vectors) }));
    res.json({ proposals: rows });
  } finally { db.close(); }
  function safeJson(s){ try { return s ? JSON.parse(s) : null; } catch { return null; } }
});
app.post('/api/replan-proposals/:id/resolve', express.json(), (req, res) => {
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dbPath = path.resolve(__dirname, '..', 'blackboard', 'blackboard.db');
  const db = new Database(dbPath);
  try {
    const state = req.body?.state || 'dismissed';
    if (!['accepted','dismissed','superseded'].includes(state)) return res.status(400).json({ error: 'bad state' });
    const r = db.prepare(
      "UPDATE replan_proposals SET state = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?"
    ).run(state, req.body?.resolved_by || 'operator', req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'proposal not found' });
    broadcastLobby('plan-replan-resolved', { proposal_id: Number(req.params.id), state });
    res.json({ ok: true, state });
  } finally { db.close(); }
});

// --- Terminal (WebSocket PTY) ---
// Loopback-only; the HTTP server itself binds to 127.0.0.1 below.
const { WebSocketServer } = require('ws');
const { attachTerminal } = require('./lib/terminal');
const http = require('node:http');
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/terminal' });
wss.on('connection', ws => attachTerminal(ws));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GLaDOS Ops Dashboard on http://localhost:${PORT}`);
});

function shutdown() { try { watcher.stop(); breaker.stop(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
