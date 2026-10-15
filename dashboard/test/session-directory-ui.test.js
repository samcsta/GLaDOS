const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
const source = app.slice(app.indexOf('function investigationSessionBusy('), app.indexOf('function showNameInput('));

function deletionRenderer(fetchImpl) {
  const calls = [];
  const context = vm.createContext({
    state: { currentSessionId: 'current', currentTeamId: 'pkg-custom--crew', currentTab: 'sessions', sessionActivationGeneration: 0, sessionActivationPending: false,
      active: new Map(), transcripts: new Map(), unreadCompletedSessionIds: new Set(['old']), investigationProjects: [{ id: 'project' }],
      investigationSessions: [{ id: 'current', name: 'Current session', runningCount: 0 }, { id: 'old', name: 'Old session', runningCount: 0 }] },
    calls,
    fetch: fetchImpl,
    confirmAction: async () => true,
    persistUnreadCompletedSessions() {}, persistWorkspaceState() {}, clearPlanClientState() {},
    closeSessionStreams() { calls.push('closeStreams'); },
    loadAgents: async () => { calls.push('loadAgents'); },
    openGladosChat() { calls.push('openDraft'); context.state.currentTab = 'glados-chat'; },
    subscribeLobby() { calls.push('lobby'); },
    renderInvestigationNavigation() { calls.push('navigation'); },
    renderPane() { calls.push('pane'); },
  });
  vm.runInContext(source, context);
  return context;
}

const response = sessions => ({ ok: true, json: async () => ({ ok: true, sessions }) });

test('deleting a different directory session preserves the selected conversation and its team', async () => {
  let requests = 0;
  const context = deletionRenderer(async (url, options) => {
    requests++;
    assert.equal(url, '/api/investigation-sessions/old');
    assert.equal(options.method, 'DELETE');
    return response([{ id: 'current' }]);
  });
  context.state.active.set('busy-current-agent', {});
  await context.confirmDeleteInvestigationSession(context.state.investigationSessions[1]);
  assert.equal(requests, 1);
  assert.equal(context.state.currentSessionId, 'current');
  assert.equal(context.state.currentTeamId, 'pkg-custom--crew');
  assert.deepEqual(context.calls, ['navigation', 'pane']);
  assert.equal(context.state.unreadCompletedSessionIds.has('old'), false);
});

test('deleting the current idle session opens an empty GLaDOS draft without creating another record', async () => {
  const methods = [];
  const context = deletionRenderer(async (_url, options) => { methods.push(options.method); return response([{ id: 'old' }]); });
  await context.deleteInvestigationSession('current');
  assert.equal(context.state.currentSessionId, null);
  assert.equal(context.state.currentTeamId, 'glados');
  assert.equal(context.state.currentTab, 'glados-chat');
  assert.deepEqual(methods, ['DELETE']);
  assert.deepEqual(context.calls, ['closeStreams', 'loadAgents', 'openDraft', 'lobby']);
});

test('running sessions and canceled confirmations never send a deletion request', async () => {
  let requests = 0;
  const context = deletionRenderer(async () => { requests++; throw new Error('unexpected mutation'); });
  context.state.investigationSessions[1].runningCount = 1;
  await assert.rejects(context.confirmDeleteInvestigationSession(context.state.investigationSessions[1]), /Finish or stop/);
  context.state.investigationSessions[1].runningCount = 0;
  context.confirmAction = async () => false;
  assert.equal(await context.confirmDeleteInvestigationSession(context.state.investigationSessions[1]), false);
  context.state.transcripts.set('glados-chat', { sending: true });
  await assert.rejects(context.deleteInvestigationSession('current'), /Finish or stop/);
  assert.equal(requests, 0);
});

test('a late deletion cannot reset a conversation selected while the request was pending', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = deletionRenderer(async () => pending);
  const deleting = context.deleteInvestigationSession('current');
  context.state.currentSessionId = 'new-selection';
  context.state.currentTeamId = 'agent:pkg-isolated--specialist';
  release(response([{ id: 'new-selection' }]));
  await deleting;
  assert.equal(context.state.currentSessionId, 'new-selection');
  assert.equal(context.state.currentTeamId, 'agent:pkg-isolated--specialist');
  assert.equal(context.calls.includes('closeStreams'), false);
  assert.equal(context.calls.includes('openDraft'), false);
});

test('directory search has a themed icon field and each session has an independent delete action', () => {
  const directory = app.slice(app.indexOf('function renderSessionsPane()'), app.indexOf('function persistUnreadCompletedSessions()'));
  assert.match(directory, /sessions-search-control.*searchIcon.*type="search"/);
  assert.match(directory, /data-directory-session-delete/);
  assert.match(directory, /confirmDeleteInvestigationSession/);
  assert.match(directory, /investigationSessionBusy\(session\.id\)/);
  assert.match(css, /\.sessions-search-control\s*\{[^}]*padding:\s*0 14px[^}]*border-radius:\s*9px[^}]*background:\s*var\(--bg-alt\)/s);
  assert.match(css, /\.sessions-search input\s*\{[^}]*appearance:\s*none[^}]*background:\s*transparent[^}]*color:\s*var\(--fg\)/s);
});


test('directory renderer hides empty bootstrap placeholders and retains named, historical, and working sessions', () => {
  let rendered;
  const control = { addEventListener() {} };
  const wrap = { innerHTML: '', querySelector: () => control, querySelectorAll: () => [] };
  const context = vm.createContext({
    state: { sessionListProjectId: null, investigationProjects: [], investigationSessions: [
      { id: 'bootstrap', name: 'Unassigned session', metadata: { unassigned: true }, engagementCount: 0, runningCount: 0 },
      { id: 'named', name: 'Operator conversation', metadata: {}, engagementCount: 0, runningCount: 0 },
      { id: 'history', name: 'Historical review', metadata: { unassigned: true }, engagementCount: 1, runningCount: 0 },
      { id: 'working', name: 'Background work', metadata: { unassigned: true }, engagementCount: 0, runningCount: 1 },
    ] },
    document: { createElement: () => wrap }, paneEl: { appendChild: element => { rendered = element.innerHTML; } },
    compareSessionActivity: () => 0, escapeHtml: value => String(value ?? ''), investigationSessionBusy: id => id === 'working',
    sessionActivityTime: () => 0, formatReportDate: () => 'Today',
  });
  vm.runInContext(app.slice(app.indexOf('function renderSessionsPane()'), app.indexOf('function persistUnreadCompletedSessions()')), context);
  context.renderSessionsPane();
  assert.doesNotMatch(rendered, /data-directory-session="bootstrap"|Unassigned session/);
  for (const id of ['named', 'history', 'working']) assert.match(rendered, new RegExp(`data-directory-session="${id}"`));
  assert.match(rendered, /data-directory-session-delete="working"[^>]+disabled/);
});
