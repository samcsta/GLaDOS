const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const {
  DashboardTranscriptStore,
  eventSseId,
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
