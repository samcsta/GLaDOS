const crypto = require('node:crypto');
const Database = require('better-sqlite3');

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
    this.deleteByAgent = this.db.prepare(`
      DELETE FROM dashboard_transcript_events WHERE agent_id = ?
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
      return {
        ...(ev && typeof ev === 'object' ? ev : {}),
        agentId: row.agent_id,
        kind: row.kind,
        text: row.text,
        ts: ev?.ts || row.ts,
        id: ev?.id || row.client_event_id || `dashboard:${row.id}`,
        dashboardEventId: row.id,
        sseId: `dashboard:${row.id}`,
      };
    });
  }

  clearAgents(agentIds) {
    const ids = Array.isArray(agentIds) ? agentIds : [agentIds];
    const tx = this.db.transaction(() => {
      for (const id of ids) this.deleteByAgent.run(id);
    });
    tx();
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

function normalizeEvent(agentId, event) {
  const ev = { ...(event || {}) };
  ev.agentId = ev.agentId || agentId;
  ev.kind = ev.kind || 'meta';
  ev.ts = normalizeTs(ev.ts);
  return ev;
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
    for (const ev of group || []) {
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

function sseFrame(ev) {
  const id = eventSseId(ev);
  return `${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(ev)}\n\n`;
}

module.exports = {
  DashboardTranscriptStore,
  eventSseId,
  mergeTranscriptEvents,
  afterLastEventId,
  sseFrame,
};
