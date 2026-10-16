const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const navigation = app.slice(app.indexOf('async function loadInvestigationSessions()'), app.indexOf('async function renameInvestigationSession('));

function renderer(fetchImpl) {
  const calls = [];
  const context = vm.createContext({
    AbortController,
    fetch: fetchImpl,
    calls,
    document: { querySelector: () => null },
    persistUnreadCompletedSessions() {},
    persistWorkspaceState() {},
    renderInvestigationNavigation() {},
    renderSecurityReviews() {},
    clearPlanClientState() {},
    markSessionSeen() {},
    loadAgents: async () => {},
    loadDefaultTeamPreference: async () => ({ effectiveTeamId: 'glados' }),
    loadSecurityReviews: async () => {},
    closeSessionStreams() { calls.push('closeStreams'); context.state.transcripts.clear(); context.state.active.clear(); },
    ensureTranscript(tabId) { calls.push(`subscribe:${tabId}`); },
    openGladosChat() { calls.push('openChat'); },
    subscribeLobby() { calls.push('lobby'); },
    showToast() {},
  });
  vm.runInContext(`var state = { currentSessionId: null, currentTeamId: 'glados', investigationSessions: [], investigationProjects: [], expandedProjectIds: new Set(), unreadCompletedSessionIds: new Set(), sessionActivationGeneration: 0, sessionActivationPending: false, sessionActivationClientId: 'client', active: new Map(), transcripts: new Map(), securityReviews: [] }; ${navigation}`, context);
  return context;
}

const response = body => ({ ok: true, json: async () => ({ ok: true, ...body }) });

test('navigation refresh leaves the blank draft selected and preserves manual folder choices', async () => {
  const context = renderer(async () => response({ activeId: 'old', sessions: [{ id: 'old' }], projects: [{ id: 'project' }] }));
  context.state.unreadCompletedSessionIds.add('old');
  await context.loadInvestigationSessions();
  assert.equal(context.state.currentSessionId, null);
  assert.equal(context.state.expandedProjectIds.size, 0);
  assert.equal(context.state.unreadCompletedSessionIds.has('old'), true);
  context.state.expandedProjectIds.add('project');
  await context.loadInvestigationSessions();
  assert.equal(context.state.expandedProjectIds.has('project'), true);
});

test('New session opens a blank page without creating a record or stopping background work', async () => {
  let requests = 0;
  const context = renderer(async () => { requests++; throw new Error('unexpected API mutation'); });
  context.state.currentSessionId = 'working';
  context.state.investigationSessions = [{ id: 'working', runningCount: 1 }];
  await context.createInvestigationSession();
  assert.equal(requests, 0);
  assert.equal(context.state.currentSessionId, null);
  assert.equal(context.state.investigationSessions[0].runningCount, 1);
  assert.deepEqual(context.calls, ['closeStreams', 'openChat', 'lobby']);
});

test('new chats choose the saved default while explicit team launches override it', async () => {
  const context = renderer(async () => { throw new Error('No session is created before the first message'); });
  let preferenceReads = 0;
  context.loadDefaultTeamPreference = async () => { preferenceReads++; return { effectiveTeamId: 'pkg-review--crew' }; };
  context.state.currentSessionId = 'existing';
  context.state.investigationSessions = [{ id: 'existing', teamId: 'glados' }];
  await context.createInvestigationSession();
  assert.equal(context.state.currentSessionId, null);
  assert.equal(context.state.currentTeamId, 'pkg-review--crew');
  assert.equal(context.state.investigationSessions[0].teamId, 'glados');
  assert.equal(preferenceReads, 1);
  await context.createInvestigationSession({ teamId: 'glados' });
  assert.equal(context.state.currentTeamId, 'glados');
  assert.equal(preferenceReads, 1, 'explicit team launches do not read or replace the saved choice');
});

test('reading a changed default never reassigns an existing chat or an explicitly chosen draft', async () => {
  const helper = app.slice(app.indexOf('async function loadDefaultTeamPreference()'), app.indexOf('function activeTeam()'));
  const context = vm.createContext({ state: { currentSessionId: 'existing', currentTeamId: 'glados' }, fetchJson: async () => ({ defaultTeamId: 'pkg-review--crew', effectiveTeamId: 'pkg-review--crew' }) });
  vm.runInContext(helper, context);
  await context.loadDefaultTeamPreference();
  assert.equal(context.state.currentTeamId, 'glados');
  assert.equal(context.state.currentSessionId, 'existing');
  assert.equal(context.state.defaultTeamPreference.effectiveTeamId, 'pkg-review--crew');
  context.state.currentSessionId = null;
  context.state.currentTeamId = 'agent:chosen-specialist';
  await context.loadDefaultTeamPreference();
  assert.equal(context.state.currentTeamId, 'agent:chosen-specialist');
});

test('a late default lookup cannot replace a session opened while it was loading', async () => {
  const context = renderer(async () => { throw new Error('Unexpected session mutation'); });
  let release;
  context.loadDefaultTeamPreference = () => new Promise(resolve => { release = resolve; });
  const pending = context.createInvestigationSession();
  context.state.sessionActivationGeneration++;
  context.state.currentSessionId = 'opened-while-loading';
  context.state.currentTeamId = 'glados';
  release({ effectiveTeamId: 'pkg-review--crew' });
  assert.equal(await pending, null);
  assert.equal(context.state.currentSessionId, 'opened-while-loading');
  assert.equal(context.state.currentTeamId, 'glados');
  assert.deepEqual(context.calls, []);
});

test('concurrent first-send requests create one session and retain the draft transcript and attachments', async () => {
  let requests = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = renderer(async (url, options) => {
    requests++;
    assert.equal(url, '/api/investigation-sessions');
    assert.equal(options.method, 'POST');
    await pending;
    return response({ session: { id: 'new' }, sessions: [{ id: 'new' }], projects: [] });
  });
  const record = { agentId: 'glados', events: [], attachments: ['screenshot'] };
  context.state.transcripts.set('glados-chat', record);
  const first = context.materializeDraftSession();
  const second = context.materializeDraftSession();
  release();
  assert.deepEqual(await Promise.all([first, second]), ['new', 'new']);
  assert.equal(requests, 1);
  assert.equal(context.state.transcripts.get('glados-chat'), record);
  assert.deepEqual(record.attachments, ['screenshot']);
  assert.equal(context.calls.includes('closeStreams'), false);
  assert.equal(context.calls.includes('subscribe:glados-chat'), true);
});

test('late draft creation cannot replace a conversation the operator selected meanwhile', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = renderer(async () => { await pending; return response({ session: { id: 'late' }, sessions: [{ id: 'late' }] }); });
  const creation = context.materializeDraftSession();
  context.state.sessionActivationGeneration++;
  context.state.currentSessionId = 'selected';
  release();
  assert.equal(await creation, null);
  assert.equal(context.state.currentSessionId, 'selected');
});

test('opening an existing session selects Chat without creating a new conversation', async () => {
  const requests = [];
  const context = renderer(async url => { requests.push(url); return response({ activeId: 'existing', session: { id: 'existing' }, sessions: [{ id: 'existing' }] }); });
  await context.activateInvestigationSession('existing');
  assert.equal(context.state.currentSessionId, 'existing');
  assert.deepEqual(requests, ['/api/investigation-sessions/existing/activate']);
  assert.equal(context.calls.includes('openChat'), true);
});

test('recent ordering uses message activity and handles SQLite timestamps as UTC', () => {
  const context = vm.createContext({});
  vm.runInContext(app.slice(app.indexOf('function sessionActivityTime('), app.indexOf('function renderInvestigationNavigation(')), context);
  const older = { id: 'old', lastActivityAt: '2026-10-14 10:00:00', updatedAt: '2026-10-14T15:00:00Z' };
  const newer = { id: 'new', lastActivityAt: '2026-10-14T11:00:00.000Z' };
  assert.deepEqual([older, newer].sort(context.compareSessionActivity).map(session => session.id), ['new', 'old']);
  assert.equal(context.sessionActivityTime(older), Date.parse('2026-10-14T10:00:00Z'));
  older.lastActivityAt = '2026-10-14T12:00:00.000Z';
  assert.deepEqual([older, newer].sort(context.compareSessionActivity).map(session => session.id), ['old', 'new']);
});

test('first message persists the chosen draft team and keeps the draft team when the create response omits it', async () => {
  let payload;
  const context = renderer(async (url, options) => {
    payload = JSON.parse(options.body);
    return response({ session: { id: 'custom-session', teamId: 'pkg-custom--crew' }, sessions: [{ id: 'custom-session', teamId: 'pkg-custom--crew' }] });
  });
  context.state.currentTeamId = 'pkg-custom--crew';
  assert.equal(await context.materializeDraftSession(), 'custom-session');
  assert.equal(payload.teamId, 'pkg-custom--crew');
  assert.equal(context.state.currentTeamId, 'pkg-custom--crew');
});

test('opening an existing conversation restores its original team without changing the server team', async () => {
  let payload;
  const context = renderer(async (url, options) => {
    payload = JSON.parse(options.body);
    return response({ session: { id: 'old-custom', teamId: 'pkg-existing--crew' }, activeId: 'old-custom', sessions: [{ id: 'old-custom', teamId: 'pkg-existing--crew' }] });
  });
  await context.activateInvestigationSession('old-custom');
  assert.equal(context.state.currentTeamId, 'pkg-existing--crew');
  assert.equal(Object.hasOwn(payload, 'teamId'), false);
});


test('first message to a direct specialist persists agentId without adding a team assignment', async () => {
  let payload;
  const context = renderer(async (url, options) => {
    payload = JSON.parse(options.body);
    return response({ session: { id: 'direct-session', teamId: 'agent:pkg-custom--specialist' }, sessions: [{ id: 'direct-session', teamId: 'agent:pkg-custom--specialist' }] });
  });
  context.state.currentTeamId = 'agent:pkg-custom--specialist';
  assert.equal(await context.materializeDraftSession(), 'direct-session');
  assert.equal(payload.agentId, 'pkg-custom--specialist');
  assert.equal(Object.hasOwn(payload, 'teamId'), false);
  assert.equal(Object.hasOwn(payload, 'assignedAgentIds'), false);
  assert.equal(context.state.currentTeamId, 'agent:pkg-custom--specialist');
});
