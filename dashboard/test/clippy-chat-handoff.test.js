const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test('only a newly completed successful Clippy turn stages cited evidence', () => {
  const staged = [];
  const context = vm.createContext({
    transcriptEventMs: event => event?.ts || 0,
    finalizeActiveStreamEntries() {}, insertTranscriptEvent() {}, finishWorkActivities() {}, updateSendingIndicator() {},
    syncClippyChatCandidates: (rec, boundary) => staged.push([rec.agentId, boundary.outcome]),
  });
  vm.runInContext(section('function workTurnBoundary(', 'function formatElapsed('), context);
  const record = extra => ({ agentId: 'pkg-clippy-intel--clippy', sending: true, turnStartedAt: 10, ...extra });
  context.finishTranscriptTurn(record(), 'clippy', { kind: 'work-turn-ended', ts: 20 });
  assert.equal(staged.length, 1);
  context.finishTranscriptTurn(record({ sending: false }), 'clippy', { kind: 'work-turn-ended', ts: 20 });
  context.finishTranscriptTurn(record({ agentId: 'glados' }), 'glados', { kind: 'work-turn-ended', ts: 20 });
  context.finishTranscriptTurn(record(), 'clippy', { kind: 'prompt-error', ts: 20 });
  context.finishTranscriptTurn(record({ activity: 'stopping' }), 'clippy');
  assert.equal(staged.length, 1, 'replay, other agents, errors and stops cannot trigger retrieval');
});

test('handoff uses the latest current-turn answer once and refreshes visible review', async () => {
  const calls = [], reads = [];
  let refreshes = 0;
  const view = {};
  const context = vm.createContext({
    transcriptEventMs: event => event.ts,
    clippySourcePathsFromText: text => { reads.push(text); return text.includes('new') ? ['repo/findings/new.md'] : []; },
    packageApi: async (...args) => { calls.push(args); },
    activeClippyView: view, clippyViewAlive: () => true, state: { clippyDashboard: { view: 'leads' } },
    loadClippyLeads: async () => { refreshes++; }, showToast: () => assert.fail('unexpected handoff error'),
  });
  vm.runInContext(section('async function syncClippyChatCandidates(', 'async function renderClippyPane('), context);
  const rec = { turnStartedAt: 3000, events: [{ kind: 'assistant-text', text: 'old source', ts: 1000 }, { kind: 'assistant-text', text: 'new source', ts: 3100 }] };
  await context.syncClippyChatCandidates(rec, { id: 'new-result' });
  await context.syncClippyChatCandidates(rec, { id: 'new-result' });
  assert.deepEqual(reads, ['new source']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/api/clippy/leads/from-sources');
  assert.deepEqual([...calls[0][2].paths], ['repo/findings/new.md']);
  assert.equal(refreshes, 1);
});

test('an answer without current-turn citations makes no requests and a failed import preserves the answer', async () => {
  const notices = [], calls = [];
  const context = vm.createContext({
    transcriptEventMs: event => event.ts,
    clippySourcePathsFromText: text => text ? ['repo/findings/example.md'] : [],
    packageApi: async () => { calls.push(1); throw new Error('Search already running'); },
    showToast: text => notices.push(text),
  });
  vm.runInContext(section('async function syncClippyChatCandidates(', 'async function renderClippyPane('), context);
  await context.syncClippyChatCandidates({ turnStartedAt: 3000, events: [{ kind: 'assistant-text', text: 'old', ts: 1000 }] }, { id: 'no-source' });
  assert.equal(calls.length, 0);
  const rec = { turnStartedAt: 3000, events: [{ kind: 'assistant-text', text: 'Current supported candidate', ts: 3100 }] };
  await context.syncClippyChatCandidates(rec, { id: 'failed-import' });
  assert.equal(rec.events[0].text, 'Current supported candidate');
  assert.match(notices[0], /answer is saved/);
});

test('integrated Herbie revisions can retain inherited models when edited', () => {
  const context = vm.createContext({});
  vm.runInContext(section('function agentPackageIssues(', 'function agentPackageSummary('), context);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates/integrated-teams/herbie.glados-agent.json')));
  assert.equal(context.agentPackageIssues(manifest, { allowInheritedModel: true }).length, 0);
  assert.ok(context.agentPackageIssues(manifest).some(issue => /Choose a model/.test(issue)));
});
