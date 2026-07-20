const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DEFAULT_RECENT_LIMIT = 600;
const DEFAULT_TRANSPORT_FIELD_CHARS = 64 * 1024;

function openTranscriptDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

class DashboardTranscriptStore {
  constructor(dbPath) {
    this.db = openTranscriptDb(dbPath);
    this.insert = this.db.prepare(`
      INSERT INTO dashboard_transcript_events
        (agent_id, client_event_id, kind, text, event_json, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.updateJson = this.db.prepare(`
      UPDATE dashboard_transcript_events SET event_json = ? WHERE id = ?
    `);
    this.listByAgent = this.db.prepare(`
      SELECT id, agent_id, client_event_id, kind, text, event_json, ts
      FROM dashboard_transcript_events
      WHERE agent_id = ?
      ORDER BY id ASC
    `);
    this.listRecentByAgent = this.db.prepare(`
      SELECT id, agent_id, client_event_id, kind,
             substr(text, 1, ?) AS text,
             length(text) AS text_length,
             CASE WHEN length(event_json) <= ? THEN event_json ELSE NULL END AS event_json,
             length(event_json) AS event_json_length,
             ts
      FROM dashboard_transcript_events
      WHERE agent_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    this.deleteByAgent = this.db.prepare(`
      DELETE FROM dashboard_transcript_events WHERE agent_id = ?
    `);
    this.deleteAll = this.db.prepare(`
      DELETE FROM dashboard_transcript_events
    `);
  }

  record(agentId, event) {
    const ev = normalizeEvent(agentId, event);
    const info = this.insert.run(
      agentId,
      ev.id || null,
      ev.kind || 'meta',
      ev.text == null ? null : String(ev.text),
      JSON.stringify(ev),
      normalizeTs(ev.ts)
    );
    const out = {
      ...ev,
      dashboardEventId: info.lastInsertRowid,
      sseId: `dashboard:${info.lastInsertRowid}`,
    };
    this.updateJson.run(JSON.stringify(out), info.lastInsertRowid);
    return out;
  }

  list(agentId) {
    return this.listByAgent.all(agentId).map(row => {
      let ev = null;
      try { ev = JSON.parse(row.event_json); } catch {}
      return normalizeEvent(row.agent_id, {
        ...(ev && typeof ev === 'object' ? ev : {}),
        agentId: row.agent_id,
        kind: ev?.kind || row.kind,
        text: ev?.text ?? row.text,
        ts: ev?.ts || row.ts,
        id: ev?.id || row.client_event_id || `dashboard:${row.id}`,
        dashboardEventId: row.id,
        sseId: `dashboard:${row.id}`,
      });
    });
  }

  // Dashboard reconnects only need a bounded working set. Reading every full
  // event made one large specialist transcript capable of blocking the Node
  // event loop — and therefore every Overview/Plans/Settings/Proxy request.
  listRecent(agentId, options = {}) {
    const limit = Math.max(1, Math.min(5000, Number(options.limit) || DEFAULT_RECENT_LIMIT));
    const maxFieldChars = Math.max(1024, Math.min(1024 * 1024,
      Number(options.maxFieldChars) || DEFAULT_TRANSPORT_FIELD_CHARS));
    return this.listRecentByAgent.all(maxFieldChars, maxFieldChars, agentId, limit)
      .reverse()
      .map(row => {
        let ev = null;
        try { ev = row.event_json ? JSON.parse(row.event_json) : null; } catch {}
        const transportTruncated = Number(row.text_length || 0) > maxFieldChars
          || Number(row.event_json_length || 0) > maxFieldChars;
        return normalizeEvent(row.agent_id, {
          ...(ev && typeof ev === 'object' ? ev : {}),
          agentId: row.agent_id,
          kind: ev?.kind || row.kind,
          text: ev?.text ?? row.text,
          ts: ev?.ts || row.ts,
          id: ev?.id || row.client_event_id || `dashboard:${row.id}`,
          dashboardEventId: row.id,
          sseId: `dashboard:${row.id}`,
          ...(transportTruncated ? {
            transportTruncated: true,
            originalTextChars: Number(row.text_length || 0),
            originalEventChars: Number(row.event_json_length || 0),
          } : {}),
        });
      });
  }

  clearAgents(agentIds) {
    const ids = Array.isArray(agentIds) ? agentIds : [agentIds];
    const tx = this.db.transaction(() => {
      for (const id of ids) this.deleteByAgent.run(id);
    });
    tx();
  }

  clearAll() {
    this.deleteAll.run();
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

function normalizeEvent(agentId, event) {
  const ev = { ...(event || {}) };
  ev.agentId = ev.agentId || agentId;
  ev.kind = ev.kind || 'meta';
  if (ev.kind === 'assistant-partial') {
    ev.kind = 'text-stream';
    ev.evtType = ev.evtType || 'text_delta';
    ev.delta = ev.delta ?? ev.text ?? '';
    ev.runId = ev.runId || ev.sessionId || ev.parentToolUseId || 'nosession';
  } else if (ev.kind === 'assistant-thinking-partial') {
    ev.kind = 'thinking-stream';
    ev.evtType = ev.evtType || 'thinking_delta';
    ev.delta = ev.delta ?? ev.text ?? '';
    ev.runId = ev.runId || ev.sessionId || ev.parentToolUseId || 'nosession';
  } else if ((ev.kind === 'text-stream' || ev.kind === 'thinking-stream') && !ev.runId) {
    ev.runId = ev.sessionId || ev.parentToolUseId || 'nosession';
  } else if (ev.kind === 'error' || (ev.kind === 'result' && ev.isError)) {
    ev.kind = 'prompt-error';
    ev.error = ev.error || ev.text || (Array.isArray(ev.errors) ? ev.errors.join('\n') : '') || 'Agent SDK turn failed';
    ev.provider = ev.provider || 'LiteLLM Anthropic Messages';
    ev.api = ev.api || '/v1/messages';
  }
  ev.ts = normalizeTs(ev.ts);
  return ev;
}

function dashboardTranscriptEvent(event, options = {}) {
  const ev = normalizeEvent(event?.agentId, event);
  const includeStream = options.includeStream !== false;
  if (!includeStream && (ev.kind === 'text-stream' || ev.kind === 'thinking-stream')) return null;
  if (ev.kind === 'result' && !ev.isError && !includeStream) return null;
  if (ev.kind === 'harness-init' || ev.kind === 'liveness') return null;
  return ev;
}

function truncateTransportField(value, maxFieldChars = DEFAULT_TRANSPORT_FIELD_CHARS) {
  if (typeof value !== 'string' || value.length <= maxFieldChars) return value;
  return `${value.slice(0, maxFieldChars)}\n\n[dashboard transport preview truncated; ${value.length - maxFieldChars} chars remain durable]`;
}

function compactTranscriptEventForTransport(event, options = {}) {
  if (!event || typeof event !== 'object') return event;
  const maxFieldChars = Math.max(1024, Math.min(1024 * 1024,
    Number(options.maxFieldChars) || DEFAULT_TRANSPORT_FIELD_CHARS));
  const out = { ...event };
  let truncated = false;
  for (const key of ['text', 'error', 'content', 'delta']) {
    if (typeof out[key] !== 'string' || out[key].length <= maxFieldChars) continue;
    out[key] = truncateTransportField(out[key], maxFieldChars);
    truncated = true;
  }
  for (const key of ['arguments', 'toolInput']) {
    const value = out[key];
    if (!value || typeof value !== 'object') continue;
    let serialized;
    try { serialized = JSON.stringify(value); } catch { continue; }
    if (serialized.length <= maxFieldChars) continue;
    out[key] = {
      dashboardTransportPreviewTruncated: true,
      originalChars: serialized.length,
      preview: truncateTransportField(serialized, maxFieldChars),
    };
    truncated = true;
  }
  if (truncated) out.transportTruncated = true;
  return out;
}

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  const parsed = Date.parse(ts || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function eventSortMs(ev) {
  if (!ev) return 0;
  if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) return ev.ts;
  const parsed = Date.parse(ev.ts || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventSseId(ev) {
  if (!ev) return null;
  if (ev.sseId) return String(ev.sseId);
  if (ev.dashboardEventId) return `dashboard:${ev.dashboardEventId}`;
  if (ev.id) return String(ev.id);
  const basis = [
    ev.agentId || '',
    ev.sessionId || '',
    ev.kind || '',
    ev.ts || '',
    ev.toolCallId || '',
    ev.text || ev.error || '',
  ].join('\0');
  return `event:${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

function eventDedupKey(ev) {
  if (!ev) return '';
  if (ev.dashboardEventId) return `dashboard:${ev.dashboardEventId}`;
  if (ev.id) return `id:${ev.id}`;
  if (ev.toolCallId) return `tool:${ev.kind || ''}:${ev.toolCallId}`;
  return `${ev.kind || ''}:${ev.ts || ''}:${ev.text || ev.error || ''}`;
}

function mergeTranscriptEvents(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    const events = Array.isArray(group) ? group : group?.events;
    const options = Array.isArray(group) ? {} : (group?.options || {});
    for (const raw of events || []) {
      const ev = dashboardTranscriptEvent(raw, options);
      if (!ev) continue;
      const key = eventDedupKey(ev);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
  }
  return out.sort((a, b) => {
    const d = eventSortMs(a) - eventSortMs(b);
    if (d) return d;
    return String(eventSseId(a) || '').localeCompare(String(eventSseId(b) || ''));
  });
}

function afterLastEventId(events, lastEventId) {
  if (!lastEventId) return events;
  const idx = events.findIndex(ev => eventSseId(ev) === lastEventId);
  return idx >= 0 ? events.slice(idx + 1) : events;
}

function sseFrame(ev, options = {}) {
  const out = dashboardTranscriptEvent(ev, options);
  if (!out) return '';
  const id = eventSseId(out);
  return `${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(out)}\n\n`;
}

module.exports = {
  DashboardTranscriptStore,
  compactTranscriptEventForTransport,
  eventSseId,
  normalizeEvent,
  dashboardTranscriptEvent,
  mergeTranscriptEvents,
  afterLastEventId,
  sseFrame,
};
