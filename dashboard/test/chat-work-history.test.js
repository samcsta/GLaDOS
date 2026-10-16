const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

// The folding code needs only node movement, class queries, and native details
// toggles. Keep those operations real enough to detect duplicate/misplaced rows.
class Node {
  constructor(tagName = 'div') {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.parentElement = null;
    this.listeners = new Map();
    this.open = false;
    this.hidden = false;
    this.textContent = '';
    this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
  }
  get isConnected() { return this.connected === true || this.parentElement?.isConnected === true; }
  appendChild(node) {
    node.parentElement?.removeChild(node);
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    assert.notEqual(index, -1, 'node must belong to the parent that removes it');
    this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }
  insertBefore(node, reference) {
    assert.ok(this.children.includes(reference), 'insertBefore reference must belong to the container');
    node.parentElement?.removeChild(node);
    node.parentElement = this;
    this.children.splice(this.children.indexOf(reference), 0, node);
    return node;
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    return selector.startsWith('.')
      ? selector.slice(1).split('.').every(name => this.classList.contains(name))
      : this.tagName === selector;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() {
    if (this.tagName === 'summary' && this.parentElement?.tagName === 'details') {
      this.parentElement.open = !this.parentElement.open;
      this.parentElement.listeners.get('toggle')?.();
    }
  }
}

function row(classes, text, ts, workId) {
  const node = new Node();
  node.className = `entry ${classes}`;
  node.textContent = text;
  node.dataset.eventTs = String(ts);
  if (workId) node.dataset.workId = workId;
  return node;
}
function activity(id, ts, { running = false, background = false } = {}) {
  const node = row('work-activity', `Work ${id}`, ts, id);
  node.dataset.workState = running ? 'running' : 'completed';
  node._workActivity = { background };
  const status = row('work-status', running ? 'Running' : 'Done', ts);
  const preview = row('work-detail-preview', running ? 'Outcome: Running' : 'Outcome: Completed', ts);
  node.appendChild(status);
  node.appendChild(preview);
  return node;
}
function fixture() {
  const container = new Node();
  container.connected = true;
  const calls = { finalized: 0, indicators: [] };
  const rec = { el: container, events: [], sending: true, activity: 'working', turnStartedAt: 10 };
  const context = vm.createContext({
    document: { createElement: tag => new Node(tag) },
    debugModeEl: { checked: false },
    errorsOnlyEl: { checked: false },
    transcriptEventMs: event => Number(event?.ts) || 0,
    finalizeActiveStreamEntries: () => calls.finalized++,
    updateSendingIndicator: tabId => calls.indicators.push(tabId),
    insertTranscriptEvent(record, event) {
      if (!record.events.some(prior => prior.id === event.id)) record.events.push(event);
    },
  });
  vm.runInContext(section('function applyWorkHistoryMode(', 'function applyDebugMode('), context);
  vm.runInContext(section('function finishWorkActivities(', 'function appendEntry('), context);
  vm.runInContext(section('function workTurnBoundary(', 'function formatElapsed('), context);
  return { container, context, rec, calls };
}
function add(container, ...nodes) { nodes.forEach(node => container.appendChild(node)); }
function fold(fixture, id, ts, outcome = 'ended') {
  fixture.context.compactCompletedWork(fixture.container, { kind: 'work-turn-ended', id, ts, outcome }, fixture.rec);
}

// Evaluate the actual Debug-off display declarations for entry class selectors,
// along with the native closed-details rule. Opening history must not bypass CSS.
function visibleWithDebugOff(node) {
  if (node.hidden) return false;
  let display = '';
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaration = rule[2].match(/(?:^|;)\s*display:\s*([^;]+)/)?.[1]?.trim();
    if (!declaration) continue;
    for (const selector of rule[1].split(',')) {
      const classes = selector.trim().match(/^body\.debug-off\s+(\.entry(?:\.[\w-]+)+)$/)?.[1];
      if (classes && node.matches(classes)) display = declaration;
    }
  }
  if (display === 'none') return false;
  for (let current = node; current.parentElement; current = current.parentElement) {
    const parent = current.parentElement;
    if (parent.hidden || (parent.tagName === 'details' && !parent.open && current.tagName !== 'summary')) return false;
  }
  return true;
}

test('turn completion folds progress and tools while retaining the user message and final answer', () => {
  const f = fixture();
  const user = row('user-message', 'Check the handler', 10);
  const progress = row('assistant-text', 'Reading the handler and call sites.', 20);
  const tool = activity('read', 30, { running: true });
  const rawCall = row('tool-call', 'Raw read call', 30);
  const answer = row('assistant-text', 'The handler is correct.', 40);
  add(f.container, user, progress, rawCall, tool, answer);
  f.context.finishTranscriptTurn(f.rec, 'clippy-chat', { id: 'result-1', kind: 'result', ts: 50 });
  const history = f.container.querySelector('.work-history');
  assert.ok(history);
  assert.equal(history.open, false);
  assert.equal(history.querySelector('summary').textContent, '2 previous updates');
  assert.equal(progress.parentElement, history.querySelector('.work-history-content'));
  assert.equal(tool.parentElement, progress.parentElement);
  assert.equal(tool.dataset.workState, 'unavailable');
  assert.equal(tool.querySelector('.work-status').textContent, 'Ended');
  assert.equal(user.parentElement, f.container);
  assert.equal(answer.parentElement, f.container);
  assert.equal(visibleWithDebugOff(answer), true);
  assert.equal(visibleWithDebugOff(progress), false);
  assert.equal(f.rec.sending, false);
  assert.equal(f.rec.activity, null);
  assert.equal(f.rec.events[0].kind, 'work-turn-ended');
  assert.equal(f.rec.events[0].ts, 50);
  assert.equal(f.calls.finalized, 1);
  assert.deepEqual(f.calls.indicators, ['clippy-chat']);
});

test('expanding completed work reveals public updates while Debug CSS still hides private traces', () => {
  const f = fixture();
  const progress = row('assistant-text', 'Found the relevant route.', 20);
  const work = activity('mcp', 25);
  const privateRows = ['thinking', 'tool-call', 'tool-result', 'meta', 'liveness'].map(kind => row(kind, `Private ${kind}`, 26));
  add(f.container, row('user-message', 'Find it', 10), progress, work, ...privateRows, row('assistant-text', 'The route is /leads.', 30));
  fold(f, 'turn-1', 40);
  const history = f.container.querySelector('.work-history');
  history.querySelector('summary').click();
  assert.equal(history.open, true);
  assert.equal(f.rec.workHistoryExpanded.has('turn-1'), true);
  assert.equal(visibleWithDebugOff(progress), true);
  assert.equal(visibleWithDebugOff(work), true);
  for (const raw of privateRows) assert.equal(visibleWithDebugOff(raw), false, raw.className);
  history.querySelector('summary').click();
  assert.equal(f.rec.workHistoryExpanded.has('turn-1'), false);
  assert.equal(visibleWithDebugOff(progress), false);
});

test('multiple turns and durable replay create one history per boundary with each final answer outside', () => {
  const render = () => {
    const f = fixture();
    for (let turn = 1; turn <= 2; turn++) {
      const ts = turn * 100;
      add(f.container, row('user-message', `Question ${turn}`, ts), row('assistant-text', `Progress ${turn}`, ts + 10), activity(`read-${turn}`, ts + 20), row('assistant-text', `Answer ${turn}`, ts + 30));
      fold(f, `turn-${turn}`, ts + 40);
    }
    fold(f, 'turn-1', 140);
    fold(f, 'turn-2', 240);
    const histories = f.container.querySelectorAll('.work-history');
    assert.equal(histories.length, 2);
    assert.equal(f.container.children.filter(node => node.dataset.workBoundary).length, 2);
    const answers = f.container.children.filter(node => node.classList.contains('assistant-text'));
    assert.deepEqual(answers.map(node => node.textContent), ['Answer 1', 'Answer 2']);
    assert.equal(f.container.children.filter(node => node.classList.contains('user-message')).length, 2);
    assert.deepEqual(histories.map(history => history.querySelector('.work-history-content').children.filter(node => node.classList.contains('assistant-text')).map(node => node.textContent)), [['Progress 1'], ['Progress 2']]);
    return f.container.children.map(node => [node.className, node.textContent, node.dataset.workBoundary]);
  };
  assert.deepEqual(render(), render());
});

test('terminal errors and denied permissions remain visible outside folded progress', () => {
  const f = fixture();
  const error = row('prompt-error', 'The provider is unavailable; retry later.', 40);
  const denied = row('permission-denied', 'Tool permission denied.', 30);
  const progress = row('assistant-text', 'Checking the source.', 20);
  add(f.container, row('user-message', 'Check it', 10), progress, activity('read', 25), denied, error);
  f.context.finishTranscriptTurn(f.rec, 'main', { kind: 'prompt-error', id: 'failure', ts: 40 });
  assert.equal(error.parentElement, f.container);
  assert.equal(denied.parentElement, f.container);
  assert.equal(visibleWithDebugOff(error), true);
  assert.equal(visibleWithDebugOff(denied), true);
  assert.equal(visibleWithDebugOff(progress), false);
  assert.equal(f.rec.events[0].outcome, 'error');
});

test('errors-only opens histories containing tool failures without overwriting normal expansion', () => {
  const f = fixture();
  const failedWork = activity('failed-read', 25);
  failedWork.className += ' error';
  failedWork.dataset.workState = 'error';
  add(f.container, row('user-message', 'Read it', 10), row('assistant-text', 'Checking the file.', 20), failedWork, row('assistant-text', 'Could not read the file.', 30));
  fold(f, 'tool-failure', 40);
  const history = f.container.querySelector('.work-history');
  assert.equal(history.open, false);
  f.context.errorsOnlyEl.checked = true;
  f.context.applyWorkHistoryMode(history);
  assert.equal(history.open, true);
  history.listeners.get('toggle')();
  assert.equal(history.dataset.expanded, 'false');
  f.context.errorsOnlyEl.checked = false;
  f.context.applyWorkHistoryMode(history);
  assert.equal(history.open, false);
  assert.equal(f.rec.workHistoryExpanded, undefined);
});

test('background work stays running and outside history after its parent finishes', () => {
  const f = fixture();
  const background = activity('child', 25, { running: true, background: true });
  const rawCall = row('tool-call', 'Launch background child', 25);
  rawCall.dataset.toolCallId = 'child';
  add(f.container, row('user-message', 'Start work', 10), row('assistant-text', 'Started the child.', 20), rawCall, background, row('assistant-text', 'The child will continue in the background.', 40));
  f.context.finishTranscriptTurn(f.rec, 'main', { kind: 'result', id: 'parent-result', ts: 50 });
  assert.equal(background.dataset.workState, 'running');
  assert.equal(background.parentElement, f.container);
  assert.equal(rawCall.parentElement, f.container);
  assert.equal(visibleWithDebugOff(background), true);
  assert.ok(f.container.querySelector('.work-history'));
});

test('historical cutoff cannot settle or fold newer active work', () => {
  const f = fixture();
  const oldProgress = row('assistant-text', 'Earlier progress.', 100);
  const oldAnswer = row('assistant-text', 'Earlier answer.', 150);
  const newerWork = activity('new-read', 300, { running: true });
  const newerProgress = row('assistant-text', 'Currently reading another file.', 350);
  add(f.container, row('user-message', 'Earlier question', 90), oldProgress, activity('old-read', 120), oldAnswer, newerWork, newerProgress);
  const terminal = { kind: 'work-turn-ended', id: 'old-boundary', ts: 200 };
  f.context.finishWorkActivities(f.rec, terminal);
  f.context.compactCompletedWork(f.container, terminal, f.rec);
  assert.equal(newerWork.dataset.workState, 'running');
  assert.equal(newerWork.parentElement, f.container);
  assert.equal(newerProgress.parentElement, f.container);
  assert.equal(visibleWithDebugOff(newerProgress), true);
  assert.equal(oldAnswer.parentElement, f.container);
  assert.equal(visibleWithDebugOff(oldProgress), false);
});
