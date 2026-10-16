const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fakeRow() {
  const parts = {};
  return {
    dataset: {}, className: '', _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = value;
      parts.details = { open: /class="work-details" open/.test(value) };
      parts['.work-status'] = { textContent: value.match(/class="work-status">([^<]*)/)?.[1] || '' };
      parts['.work-detail-preview'] = { textContent: value.match(/class="work-detail-preview">([^]*)<\/pre>/)?.[1] || '' };
    },
    querySelector: selector => parts[selector] || null,
  };
}
function workContext() {
  const context = vm.createContext({ URL, escapeHtml, document: { createElement: fakeRow }, transcriptEventMs: event => Number(event?.ts) || 0 });
  vm.runInContext(section('function sanitizeWorkPreview(', 'function appendEntry('), context);
  return context;
}
function container() {
  return { children: [], appendChild(row) { this.children.push(row); }, querySelectorAll() { return this.children.filter(row => row.className.includes('work-activity')); } };
}

test('work previews pair calls/results by tool id and preserve interleaved public progress order', () => {
  const context = workContext();
  const transcript = container();
  const call = { kind: 'tool-call', toolCallId: 'read-1', toolName: 'Read', arguments: { file_path: 'dashboard/server.js', offset: 5, limit: 20 } };
  const rec = { events: [call], agentId: 'webapp-recon' };
  const row = context.appendWorkActivity(transcript, call, rec);
  assert.equal(row.dataset.workState, 'running');
  assert.match(row.innerHTML, /Read files/);
  assert.match(row.innerHTML, /dashboard\/server.js/);
  const progress = { className: 'entry assistant-text', text: 'The route uses the shared handler; checking its call sites.' };
  transcript.appendChild(progress);
  context.appendWorkActivity(transcript, { kind: 'tool-result', toolCallId: 'read-1', text: 'file contents', durationMs: 22 }, rec);
  assert.equal(row.dataset.workState, 'completed');
  assert.equal(transcript.children.length, 2);
  assert.equal(transcript.children[0], row);
  assert.equal(transcript.children[1], progress);
  assert.match(row.innerHTML, /Outcome: Completed/);
  assert.doesNotMatch(row.innerHTML, /file contents/);
  context.appendWorkActivity(transcript, call, rec); // Durable replay of the same call.
  assert.equal(transcript.children.length, 2);
  assert.equal(row.dataset.workState, 'completed');
});

test('historical tools and orphan errors render useful outcomes without duplicate raw output', () => {
  const context = workContext();
  const transcript = container();
  const call = { kind: 'tool-call', toolCallId: 'shell-1', toolName: 'Bash', toolInput: { command: 'node --test test/example.test.js', cwd: 'dashboard' } };
  const rec = { events: [call], agentId: 'clippy-agent', independentSession: true };
  context.appendWorkActivity(transcript, call, rec);
  context.appendWorkActivity(transcript, { kind: 'tool-result', toolCallId: 'shell-1', isError: true, text: 'Test failed: expected 2, received 3', exitCode: 1 }, rec);
  assert.equal(transcript.children[0].dataset.workState, 'error');
  assert.match(transcript.children[0].innerHTML, /Run command/);
  assert.match(transcript.children[0].innerHTML, /node --test test\/example.test.js/);
  assert.match(transcript.children[0].innerHTML, /expected 2, received 3/);
  context.appendWorkActivity(transcript, { kind: 'tool-result', toolCallId: 'older-call', isError: true, text: 'Connection refused' }, rec);
  assert.equal(transcript.children.length, 2);
  assert.equal(transcript.children[1].dataset.workState, 'error');
});

test('compact details redact credentials, URL queries, shell arguments, edit bodies, and delegation prompts', () => {
  const context = workContext();
  const input = {
    command: 'API_KEY=super-secret curl -H "Authorization: Bearer bearer-secret" --data "password=body-secret" https://service.test/a?token=query-secret',
    token: 'field-secret', key: 'bare-key-secret', nested: { password: 'nested-secret' },
    url: 'https://user:password@service.test/a?key=url-secret#fragment-secret',
    new_string: 'const token = "edit-secret"', prompt: 'delegation secret', args: ['--key', 'array-secret'],
  };
  const spec = context.workActivitySpec({ toolName: 'Bash', toolInput: input }, { isError: true, text: 'Authorization: Bearer result-secret', exitCode: 1 });
  for (const secret of ['super-secret', 'bearer-secret', 'body-secret', 'query-secret', 'field-secret', 'bare-key-secret', 'nested-secret', 'url-secret', 'fragment-secret', 'edit-secret', 'delegation secret', 'array-secret', 'result-secret']) assert.ok(!spec.details.includes(secret), secret);
  assert.equal(spec.target, 'curl …');
  assert.match(spec.details, /service\.test\/a\[query omitted\]/);
  assert.match(spec.details, /redacted/);
  assert.doesNotMatch(spec.details, /user:password@/);
});

test('activity categories cover browser, filesystem, connectors, commands and delegation', () => {
  const context = workContext();
  for (const [toolName, category] of [['mcp__playwright__browser_navigate', 'browser'], ['Read', 'read'], ['Grep', 'read'], ['Edit', 'edit'], ['Bash', 'command'], ['mcp__clippy__search', 'mcp'], ['Agent', 'delegation']]) assert.equal(context.workActivitySpec({ toolName }).category, category);
  assert.equal(context.appendWorkActivity(container(), { kind: 'thinking', text: 'private thought' }, {}), null);
  assert.equal(context.appendWorkActivity(container(), { kind: 'thinking-stream', delta: 'private delta' }, {}), null);
});

function transcriptFixture({ streamedEcho = false } = {}) {
  let stream;
  const finished = [];
  const state = { currentSessionId: 'assessment', sessionGeneration: 1, transcripts: new Map() };
  const context = vm.createContext({
    state, Date, Map, console,
    EventSource: class { constructor() { stream = this; } },
    withSession: url => url,
    normalizeIncomingTranscriptEvent: event => event,
    sdkResultToPromptError: event => ({ ...event, kind: 'prompt-error' }),
    finalizeActiveStreamEntries() {}, handleStreamDelta() {}, removeActiveStreamEntries() {}, reconcileStreamedEvent() {},
    wasRecentlyStreamed: () => streamedEcho,
    normalizeTranscriptText: text => text,
    eventBelongsToCurrentTurn: () => true,
    compactTranscriptEvent: event => event,
    insertTranscriptEvent: (rec, event) => { rec.events.push(event); return { added: true }; },
    transcriptEventMs: event => Number(event?.ts) || 0,
    markTranscriptActivity: (rec, _tabId, activity) => { rec.sending = true; rec.activity = activity; },
    finishTranscriptTurn: (rec, tabId) => { rec.sending = false; finished.push(tabId); },
    pushNotification() {},
  });
  vm.runInContext(section('function ensureTranscript(', 'function stripSessionTimestampPrefix('), context);
  const rec = context.ensureTranscript('agent-chat', 'agent');
  rec.sending = true;
  return { rec, finished, emit: event => stream.onmessage({ data: JSON.stringify(event) }) };
}

test('public progress and text_end keep send/stop state active until a terminal SDK result', () => {
  const { rec, finished, emit } = transcriptFixture();
  emit({ kind: 'text-stream', evtType: 'text_start', runId: 'run' });
  emit({ kind: 'text-stream', evtType: 'text_delta', delta: 'I will check the handler.', runId: 'run' });
  emit({ kind: 'text-stream', evtType: 'text_end', runId: 'run' });
  assert.equal(rec.sending, true);
  emit({ kind: 'assistant-text', text: 'I will check the handler.' });
  assert.equal(rec.sending, true);
  emit({ kind: 'tool-call', toolCallId: 'read', toolName: 'Read' });
  assert.equal(rec.activity, 'working');
  emit({ kind: 'tool-result', toolCallId: 'read', text: 'Read complete' });
  emit({ kind: 'assistant-text', text: 'The handler is correct.' });
  assert.equal(rec.sending, true);
  assert.equal(finished.length, 0);
  emit({ kind: 'result', isError: false });
  assert.equal(rec.sending, false);
  assert.deepEqual(finished, ['agent-chat']);
});

test('a durable echo of streamed public text is progress; provider failures remain terminal', () => {
  const fixture = transcriptFixture({ streamedEcho: true });
  fixture.emit({ kind: 'assistant-text', text: 'Checking the next source.' });
  assert.equal(fixture.rec.sending, true);
  assert.equal(fixture.finished.length, 0);
  fixture.emit({ kind: 'result', isError: true, error: 'Provider unavailable' });
  assert.equal(fixture.rec.sending, false);
  assert.equal(fixture.finished.length, 1);
});

test('Clippy fallback checks its independent transcript rather than the active assessment', () => {
  const calls = [];
  const context = vm.createContext({ state: { openTabs: [{ id: 'clippy', kind: 'clippy' }], currentTab: 'clippy', currentSessionId: 'assessment', transcripts: new Map([['clippy-chat', { agentId: 'pkg-clippy--clippy', sessionId: 'independent' }]]) }, refreshChatTurnStatus: (...args) => calls.push(args) });
  vm.runInContext(section('function refreshVisibleChatTurnStatuses(', 'function handleStreamDelta('), context);
  context.refreshVisibleChatTurnStatuses();
  assert.deepEqual(calls, [['clippy-chat', 'pkg-clippy--clippy']]);
});

test('Debug off keeps compact errors and work visible while raw thinking and tool output stay hidden', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /body\.debug-off \.entry\.thinking,/);
  assert.match(css, /body:not\(\.debug-off\) \.entry\.work-activity\s*\{\s*display: none/);
  assert.match(css, /body\.errors-only \.entry[^\n]*:not\(\.work-activity\.error\)/);
  assert.doesNotMatch(css, /body\.debug-off[^}]*\.entry\.work-activity[^}]*display:\s*none/s);
});

test('background delegation stays running through launch acknowledgement and parent completion', () => {
  const context = workContext();
  const transcript = container();
  const call = { kind: 'tool-call', toolCallId: 'delegate-1', toolName: 'Agent', toolInput: { subagent_type: 'source-review', run_in_background: true } };
  const rec = { events: [call], el: transcript };
  context.appendWorkActivity(transcript, call, rec);
  context.appendWorkActivity(transcript, { kind: 'tool-result', toolCallId: 'delegate-1', text: 'Subagent launched.' }, rec);
  assert.equal(transcript.children[0].dataset.workState, 'running');
  context.finishWorkActivities(rec);
  assert.equal(transcript.children[0].dataset.workState, 'running');
  context.appendWorkActivity(transcript, { kind: 'liveness', toolCallId: 'delegate-1', live: false, state: 'completed', text: 'Private worker text must not enter the preview' }, rec);
  assert.equal(transcript.children[0].dataset.workState, 'completed');
  assert.doesNotMatch(transcript.children[0].innerHTML, /Private worker text/);
  assert.equal(transcript.children.length, 1);
});

test('MCP task status remains connector activity rather than falsely claiming delegation', () => {
  const context = workContext();
  assert.equal(context.workActivitySpec({ toolName: 'mcp__watchdog__task_status' }).category, 'mcp');
});

test('unsupported deployment effort is disabled and explained without changing the saved preference', () => {
  const context = vm.createContext({});
  vm.runInContext(section('function applyComposerEffortSupport(', 'function wireChatComposerControls('), context);
  const label = { setAttribute(_name, value) { this.title = value; } };
  const select = { value: 'xhigh', closest: () => label };
  const note = {};
  context.applyComposerEffortSupport(select, note, { effortSupported: false, effortNote: 'This deployment cannot adjust effort; your saved preference is preserved.' });
  assert.equal(select.disabled, true);
  assert.equal(select.value, 'xhigh');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /cannot adjust effort/);
  assert.equal(label.title, note.textContent);
  context.applyComposerEffortSupport(select, note, { effortSupported: true });
  assert.equal(select.disabled, false);
  assert.equal(note.hidden, true);
  assert.equal(select.value, 'xhigh');
});

test('terminal boundaries survive rerender and end synchronous orphan calls without inventing success', () => {
  const context = workContext();
  // Use the real appendEntry boundary handling, without rendering unrelated bubbles.
  vm.runInContext(section('function appendEntry(', 'function scheduleStickyScroll('), context);
  const calls = [
    { kind: 'tool-call', toolCallId: 'old-orphan', toolName: 'Read', ts: 100 },
    { kind: 'work-turn-ended', ts: 200 },
    { kind: 'tool-call', toolCallId: 'new-active', toolName: 'Read', ts: 300 },
  ];
  for (let render = 0; render < 2; render++) {
    const transcript = container();
    const rec = { el: transcript, events: calls };
    for (const event of calls) {
      if (event.kind === 'work-turn-ended') context.appendEntry(transcript, event, rec);
      else context.appendWorkActivity(transcript, event, rec);
    }
    assert.equal(transcript.children[0].dataset.workState, 'unavailable');
    assert.equal(transcript.children[0].querySelector('.work-status').textContent, 'Ended');
    assert.equal(transcript.children[1].dataset.workState, 'running');
    assert.match(transcript.children[0].querySelector('.work-detail-preview').textContent, /Turn ended before a tool result was recorded/);
  }
});

test('historical success retains its boundary but cannot finish a newer active turn', () => {
  const fixture = transcriptFixture();
  fixture.rec.turnStartedAt = 300;
  fixture.emit({ kind: 'result', isError: false, ts: 200, id: 'old-result' });
  assert.equal(fixture.rec.sending, true);
  assert.equal(fixture.finished.length, 0);
  assert.equal(fixture.rec.events.at(-1).kind, 'work-turn-ended');
  assert.equal(fixture.rec.events.at(-1).ts, 200);
  fixture.emit({ kind: 'result', isError: false, ts: 400, id: 'current-result' });
  assert.equal(fixture.rec.sending, false);
  assert.equal(fixture.finished.length, 1);
});
