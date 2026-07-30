const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const {
  DashboardTranscriptStore,
  compactTranscriptEventForTransport,
  eventSseId,
  dashboardTranscriptEvent,
  mergeTranscriptEvents,
  afterLastEventId,
  sseFrame,
} = require('../lib/transcript-store');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-transcript-test-'));
  const dbPath = path.join(dir, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  return { dir, dbPath };
}

test('persists dashboard-only transcript events with durable SSE ids', () => {
  const { dbPath } = tempDb();
  const store = new DashboardTranscriptStore(dbPath);
  const ev = store.record('glados', {
    kind: 'assistant-text',
    text: 'approval prompt',
    id: 'dashboard:test',
    ts: '2026-06-24T00:00:00.000Z',
  });
  assert.equal(eventSseId(ev), `dashboard:${ev.dashboardEventId}`);
  const [row] = store.list('glados');
  assert.equal(row.text, 'approval prompt');
  assert.equal(eventSseId(row), eventSseId(ev));
  store.close();
});

test('clearAll removes durable transcripts for every agent', () => {
  const { dbPath } = tempDb();
  const store = new DashboardTranscriptStore(dbPath);
  store.record('glados', { kind: 'assistant-text', text: 'leader' });
  store.record('webapp-recon', { kind: 'assistant-text', text: 'child' });
  assert.equal(store.list('glados').length, 1);
  assert.equal(store.list('webapp-recon').length, 1);
  store.clearAll();
  assert.equal(store.list('glados').length, 0);
  assert.equal(store.list('webapp-recon').length, 0);
  store.close();
});

test('investigation sessions isolate transcript replay and clearing', () => {
  const { dbPath } = tempDb();
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("UPDATE investigation_sessions SET state='archived', archived_at=datetime('now') WHERE id='legacy'").run();
  db.prepare("INSERT INTO investigation_sessions (id, name, state) VALUES ('session-a', 'A', 'active')").run();
  db.prepare("INSERT INTO investigation_sessions (id, name, state) VALUES ('session-b', 'B', 'archived')").run();
  db.close();
  const store = new DashboardTranscriptStore(dbPath);
  store.record('session-a', 'glados', { kind: 'assistant-text', text: 'only A' });
  store.record('session-b', 'glados', { kind: 'assistant-text', text: 'only B' });
  assert.deepEqual(store.list('session-a', 'glados').map(event => event.text), ['only A']);
  assert.deepEqual(store.list('session-b', 'glados').map(event => event.text), ['only B']);
  store.clearSession('session-a');
  assert.equal(store.list('session-a', 'glados').length, 0);
  assert.equal(store.list('session-b', 'glados').length, 1);
  store.close();
});

test('recent transcript replay is newest-first bounded and does not parse oversized event JSON', () => {
  const { dbPath } = tempDb();
  const store = new DashboardTranscriptStore(dbPath);
  store.record('plan-synthesizer', { kind: 'tool-result', text: 'x'.repeat(20_000), marker: 'oversized' });
  store.record('plan-synthesizer', { kind: 'assistant-text', text: 'done' });
  store.record('plan-synthesizer', { kind: 'assistant-text', text: 'latest' });
  const rows = store.listRecent('plan-synthesizer', { limit: 2, maxFieldChars: 1024 });
  assert.deepEqual(rows.map(row => row.text), ['done', 'latest']);
  assert.equal(rows.some(row => row.marker === 'oversized'), false);

  const [oversized] = store.listRecent('plan-synthesizer', { limit: 3, maxFieldChars: 1024 });
  assert.equal(oversized.transportTruncated, true);
  assert.equal(oversized.text.length, 1024);
  assert.equal(oversized.originalTextChars, 20_000);
  store.close();
});

test('live transcript transport compacts large tool fields while leaving the source event intact', () => {
  const event = { kind: 'tool-result', text: 'z'.repeat(5000), toolInput: { body: 'q'.repeat(5000) } };
  const compact = compactTranscriptEventForTransport(event, { maxFieldChars: 1024 });
  assert.equal(compact.transportTruncated, true);
  assert.match(compact.text, /transport preview truncated/);
  assert.equal(compact.toolInput.dashboardTransportPreviewTruncated, true);
  assert.equal(event.text.length, 5000);
  assert.equal(event.toolInput.body.length, 5000);
});

test('merged transcript replay dedupes by native id and trims after Last-Event-ID', () => {
  const jsonl = [
    { agentId: 'glados', kind: 'assistant-text', id: 'jsonl-1', text: 'hello', ts: '2026-06-24T00:00:00.000Z' },
  ];
  const dashboard = [
    { agentId: 'glados', kind: 'assistant-text', id: 'dash-client', dashboardEventId: 4, text: 'prompt', ts: '2026-06-24T00:00:01.000Z' },
  ];
  const ring = [
    { agentId: 'glados', kind: 'assistant-text', id: 'jsonl-1', text: 'hello duplicate', ts: '2026-06-24T00:00:00.000Z' },
  ];
  const merged = mergeTranscriptEvents(jsonl, dashboard, ring);
  assert.equal(merged.length, 2);
  assert.deepEqual(afterLastEventId(merged, 'jsonl-1').map(ev => ev.text), ['prompt']);
  assert.match(sseFrame(dashboard[0]), /^id: dashboard:4\n/);
});

test('dashboard transcript SSE normalizes SDK partials and gates control noise by client capability', () => {
  const legacyPartial = {
    agentId: 'glados',
    kind: 'assistant-partial',
    text: 'hel',
    sessionId: 'sess-stream',
    id: 'partial-1',
    ts: '2026-06-24T00:00:00.000Z',
  };
  const streamEvent = dashboardTranscriptEvent(legacyPartial);
  assert.equal(streamEvent.kind, 'text-stream');
  assert.equal(streamEvent.delta, 'hel');
  assert.equal(streamEvent.runId, 'sess-stream');
  assert.match(sseFrame(legacyPartial), /"kind":"text-stream"/);
  assert.equal(sseFrame(legacyPartial, { includeStream: false }), '');

  assert.equal(sseFrame({
    agentId: 'glados',
    kind: 'harness-init',
    text: 'Agent SDK initialized',
    ts: '2026-06-24T00:00:00.000Z',
  }), '');
  assert.match(sseFrame({
    agentId: 'glados',
    kind: 'result',
    isError: false,
    text: 'final answer duplicate',
    ts: '2026-06-24T00:00:00.000Z',
  }), /"kind":"result"/);
  assert.equal(sseFrame({
    agentId: 'glados',
    kind: 'result',
    isError: false,
    text: 'final answer duplicate',
    ts: '2026-06-24T00:00:00.000Z',
  }, { includeStream: false }), '');

  const errorFrame = sseFrame({
    agentId: 'glados',
    kind: 'result',
    isError: true,
    text: 'provider failed',
    ts: '2026-06-24T00:00:00.000Z',
  });
  assert.match(errorFrame, /"kind":"prompt-error"/);
  assert.match(errorFrame, /provider failed/);
});
