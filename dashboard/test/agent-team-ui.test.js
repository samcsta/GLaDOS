const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const plain = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function teamRenderer() {
  const calls = [];
  const context = vm.createContext({
    state: { currentSessionId: null, currentTeamId: 'glados', currentTab: 'glados-chat', sessionActivationGeneration: 0, sessionActivationPending: false, teamCatalogGeneration: 0,
      investigationSessions: [], teamCatalog: { teams: [{ id: 'glados', name: 'GLaDOS', coordinatorId: 'glados', available: true }, { id: 'pkg-custom--crew', name: 'Custom crew', coordinatorId: 'pkg-custom--crew', available: true }], agents: [] },
      transcripts: new Map([['glados-chat', { composerAttachments: [{ name: 'Screenshot.png', dataUrl: 'image' }] }]]),
    },
    calls,
    escapeHtml,
    document: { querySelector: () => ({ value: 'A draft task' }) },
    closeSessionStreams() { calls.push('closeStreams'); context.state.transcripts.clear(); },
    async loadAgents() { calls.push(`agents:${context.sessionQuery()}`); },
    openGladosChat() { calls.push(`chat:${context.activeCoordinatorId()}`); },
    subscribeLobby() { calls.push(`lobby:${context.sessionQuery()}`); },
  });
  vm.runInContext(section('function sessionQuery()', 'function closeSessionStreams()'), context);
  return context;
}

test('choosing a draft team updates its coordinator and scoped roster without creating a session', async () => {
  const context = teamRenderer();
  await context.selectDraftTeam('pkg-custom--crew');
  assert.equal(context.state.currentSessionId, null);
  assert.equal(context.state.currentTeamId, 'pkg-custom--crew');
  assert.equal(context.activeCoordinatorId(), 'pkg-custom--crew');
  assert.equal(context.currentTeamName(), 'Custom crew');
  assert.deepEqual(context.calls, ['closeStreams', 'agents:session_id=draft&team_id=pkg-custom--crew', 'chat:pkg-custom--crew', 'lobby:session_id=draft&team_id=pkg-custom--crew']);
  assert.equal(context.state.teamChangeDraft.text, 'A draft task');
  assert.equal(context.state.teamChangeDraft.attachments[0].name, 'Screenshot.png');
});

test('existing sessions retain their team and unavailable teams cannot be selected for a draft', async () => {
  const context = teamRenderer();
  context.state.currentSessionId = 'existing';
  await assert.rejects(context.selectDraftTeam('pkg-custom--crew'), /existing session keeps its team/);
  assert.equal(context.state.currentTeamId, 'glados');
  assert.equal(context.sessionQuery(), 'session_id=existing');
  context.state.currentSessionId = null;
  context.state.teamCatalog.teams[1].available = false;
  await assert.rejects(context.selectDraftTeam('pkg-custom--crew'), /unavailable/);
  assert.equal(context.state.currentTeamId, 'glados');
  assert.equal(context.calls.length, 0);
});

test('draft team picker defaults to GLaDOS and shows human names for saved custom teams', () => {
  const context = teamRenderer();
  const markup = context.newSessionTeamPickerMarkup();
  assert.match(markup, /value="glados" selected>GLaDOS</);
  assert.match(markup, /value="pkg-custom--crew">Custom crew</);
  assert.ok(markup.indexOf('value="glados"') < markup.indexOf('value="pkg-custom--crew"'));
  const renderer = section('function renderAgentChatSurface(', 'async function stopChatTurnFromUi(');
  assert.match(renderer, /data-new-session-team.*addEventListener\('change'.*selectDraftTeam/s);
  assert.match(renderer, /renderAgentChatSurface\(coordinatorId, 'glados-chat', true\)/);
});

test('background completion resolves the coordinator for each session’s own team', () => {
  const context = teamRenderer();
  context.state.investigationSessions = [{ id: 'builtin-session', teamId: 'glados' }, { id: 'custom-session', teamId: 'pkg-custom--crew' }];
  assert.equal(context.isSessionCoordinatorEvent({ investigationSessionId: 'custom-session', agentId: 'pkg-custom--crew' }), true);
  assert.equal(context.isSessionCoordinatorEvent({ investigationSessionId: 'custom-session', agentId: 'glados' }), false);
  assert.equal(context.isSessionCoordinatorEvent({ investigationSessionId: 'builtin-session', agentId: 'glados' }), true);
});

test('old Active sidebar filter migrates to All; Custom shows package members in the current roster', () => {
  const saved = new Map([['glados-dash.agent-filter', 'active']]);
  const context = vm.createContext({ localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } });
  vm.runInContext(section('function savedAgentFilter()', 'const state ='), context);
  vm.runInContext(section('function agentMatchesSidebarFilter(', 'function renderAgentList('), context);
  assert.equal(context.savedAgentFilter(), 'all');
  assert.equal(saved.get('glados-dash.agent-filter'), 'all');
  assert.equal(context.agentMatchesSidebarFilter({ id: 'pkg-local--member', packageId: 'local', teamInternal: true }, 'custom'), true);
  assert.equal(context.agentMatchesSidebarFilter({ id: 'recon' }, 'custom'), false);
  assert.equal(context.agentMatchesSidebarFilter({ id: 'recon', halted: true }, 'halted'), true);
  assert.match(html, /data-agent-filter="custom">Custom/);
  assert.doesNotMatch(html, /data-agent-filter="active"/);
});

test('team assignments allow explicitly selected package members while excluding coordinators and own base members', () => {
  const context = vm.createContext({ state: { teamCatalog: {} } });
  vm.runInContext(section('function teamAssignableAgents(', 'function teamAssignmentsMarkup('), context);
  const agents = [
    { id: 'glados', assignable: false }, { id: 'recon', assignable: true },
    { id: 'pkg-own--member', packageId: 'own', assignable: true, teamInternal: true },
    { id: 'pkg-other--member', packageId: 'other', assignable: true, teamInternal: true },
    { id: 'pkg-other--crew', packageId: 'other', assignable: false, teamCoordinator: true },
  ];
  const glados = context.teamAssignableAgents({ id: 'glados', memberIds: ['glados', 'recon'], assignedAgentIds: [] }, { agents });
  assert.deepEqual(plain(glados.map(agent => agent.id)), ['pkg-own--member', 'pkg-other--member']);
  const custom = context.teamAssignableAgents({ id: 'pkg-own--crew', memberIds: ['pkg-own--member'], assignedAgentIds: [] }, { agents });
  assert.deepEqual(plain(custom.map(agent => agent.id)), ['recon', 'pkg-other--member']);
});

function element() {
  return { dataset: {}, value: '', textContent: '', disabled: false, hidden: false, listeners: {}, classList: { toggle() {}, add() {} }, addEventListener(event, callback) { this.listeners[event] = callback; }, insertAdjacentHTML() {} };
}

test('all-team model dropdown stages only GLaDOS built-ins and assigned custom agents until Save Changes', async () => {
  const rows = [
    { id: 'glados', model: 'shared-model', enabled: true }, { id: 'recon', model: 'old-model', enabled: false },
    { id: 'pkg-assigned--specialist', model: 'old-model', enabled: true, packageId: 'assigned' },
    { id: 'pkg-other--specialist', model: 'old-model', enabled: true, packageId: 'other' },
  ];
  const cards = [];
  const fields = Object.fromEntries(['settings-model-catalog', 'settings-agent-search', 'settings-save-models', 'settings-pending-models'].map(id => [`#${id}`, element()]));
  const allModel = element();
  fields['[data-all-agent-model]'] = allModel;
  const list = {
    innerHTML: '', appendChild: card => cards.push(card),
    querySelector(selector) { const id = selector.match(/data-agent-id="([^"]+)"/)?.[1]; return id ? cards.find(card => card.dataset.agentId === id) || null : null; },
    querySelectorAll: () => cards, insertAdjacentHTML() {},
  };
  fields['#settings-list'] = list;
  const mutations = [];
  const context = vm.createContext({
    state: { agentLibrary: { catalog: { builtInAgents: [{ id: 'glados' }, { id: 'recon' }] } }, teamCatalog: { teams: [{ id: 'glados', assignedAgentIds: ['pkg-assigned--specialist'] }] } },
    CSS: { escape: value => value }, escapeHtml,
    fetchJson: async url => url === '/api/models' ? { available: true, models: ['shared-model', 'old-model'] } : { agents: rows },
    fetch: async (url, options) => { const body = JSON.parse(options.body); mutations.push({ url, ...body }); return { ok: true, json: async () => ({ results: body.changes.map(change => ({ ok: true, agentId: change.agentId, newModel: change.model })) }) }; },
    loadAgents: async () => {}, showToast() {}, pushNotification() {},
    document: { createElement() { const card = element(); const model = element(); const details = element(); details.dataset.loaded = 'false'; const saved = element(); card.querySelector = selector => selector === '[data-model-select]' ? model : selector === '[data-agent-details-toggle]' ? element() : selector === '[data-saved-model]' ? saved : selector === '.agent-card-body' ? details : null; return card; } },
  });
  vm.runInContext(section('function gladosTeamSettingsAgents(', 'function builtInAgentsMarkup('), context);
  vm.runInContext(section('async function loadBuiltInAgentSettings(', 'function renderSettingsVersion('), context);
  const wrap = { isConnected: true, querySelector: selector => fields[selector], querySelectorAll: () => [] };
  await context.loadBuiltInAgentSettings(wrap);
  assert.deepEqual(cards.map(card => card.dataset.agentId), ['glados', 'recon', 'pkg-assigned--specialist']);
  allModel.value = 'shared-model';
  allModel.listeners.change();
  assert.equal(mutations.length, 0);
  assert.equal(fields['#settings-save-models'].disabled, false);
  assert.match(fields['#settings-pending-models'].textContent, /2 pending/);
  await fields['#settings-save-models'].listeners.click();
  assert.equal(mutations[0].url, '/api/settings/agents/models');
  assert.deepEqual(mutations[0].changes.map(change => change.agentId), ['recon', 'pkg-assigned--specialist']);
  assert.ok(mutations[0].changes.every(change => change.model === 'shared-model' && change.expectedModel === 'old-model'));
});

test('GLaDOS Agentic Team precedes Custom Agents and deletion controls identify individual saved entries', () => {
  const page = section('async function renderAgentsLibraryPane(', 'function teamAssignableAgents(');
  assert.ok(page.indexOf('GLaDOS Agentic Team') < page.indexOf('Custom Agents'));
  assert.match(app, /agentLibrary: \{ view: 'built-in'/);
  assert.match(app, /data-delete-package-entry="agent"/);
  assert.match(app, /data-delete-package-entry="team"/);
  assert.match(app, /data-delete-package[^>]*>Delete package/);
  assert.match(app, /\$\{kind\}s\/\$\{encodeURIComponent\(localId\)\}/);
  assert.doesNotMatch(app, /Herbie/);
});


test('custom team coordinators keep the specialist composer boundary without Full Access controls', () => {
  const renderer = section('function renderAgentChatSurface(', 'function renderChatPane(');
  assert.match(renderer, /chatComposerMarkup\(tabId, label, \{ coordinator: coordinator && agentId === 'glados' \}\)/);
  const assignments = section('function teamAssignmentsMarkup(', 'function renderTeamAssignments(');
  assert.match(assignments, /added agent/);
  assert.doesNotMatch(assignments, /custom assignment/);
});

test('direct agent drafts resolve a singleton coordinator and do not expose unrelated direct agents in the team picker', async () => {
  const context = teamRenderer();
  context.state.teamCatalog.directAgents = [
    { id: 'agent:pkg-local--specialist', name: 'Local specialist', coordinatorId: 'pkg-local--specialist', available: true },
    { id: 'agent:pkg-other--specialist', name: 'Other specialist', coordinatorId: 'pkg-other--specialist', available: true },
  ];
  assert.doesNotMatch(context.newSessionTeamPickerMarkup(), /Local specialist|Other specialist/);
  await context.selectDraftTeam('agent:pkg-local--specialist');
  assert.equal(context.activeCoordinatorId(), 'pkg-local--specialist');
  assert.equal(context.currentTeamName(), 'Local specialist');
  assert.ok(context.calls.includes('agents:session_id=draft&team_id=agent%3Apkg-local--specialist'));
  const markup = context.newSessionTeamPickerMarkup();
  assert.match(markup, /<span>Agent<\/span>/);
  assert.match(markup, /value="agent:pkg-local--specialist" selected>Local specialist/);
  assert.doesNotMatch(markup, /Other specialist/);
});

test('draft context picker is placed in the pane header and removed from the centered welcome', () => {
  const renderer = section('function renderAgentChatSurface(', 'function renderChatPane(');
  assert.match(renderer, /draftHeader\.className = 'draft-conversation-header'/);
  assert.match(renderer, /draftHeader\.innerHTML = newSessionTeamPickerMarkup\(\)/);
  assert.match(renderer, /new-session-welcome.*<h1>What are we working on\?<\/h1><\/div>/);
  assert.doesNotMatch(renderer, /new-session-welcome[^\n]+newSessionTeamPickerMarkup/);
});

test('managed integration fields are read-only while browsing and enabled-state actions remain available', () => {
  const fields = [{ tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'checkbox' }];
  const editingActions = [{ hidden: false }, { hidden: false }];
  const teamEnable = { disabled: false, hidden: false };
  const editor = { dataset: {}, querySelectorAll: selector => selector.startsWith('[data-package-field]') ? fields : editingActions };
  const context = vm.createContext({});
  vm.runInContext(section('function makeManagedPackageReadOnly(', 'function wireAgentPackageEditor('), context);
  context.makeManagedPackageReadOnly(editor);
  assert.equal(editor.dataset.managedIntegration, 'true');
  assert.equal(fields[0].readOnly, true);
  assert.equal(fields[1].readOnly, true);
  assert.equal(fields[2].disabled, true);
  assert.equal(fields[3].disabled, true);
  assert.ok(editingActions.every(action => action.hidden));
  assert.deepEqual(teamEnable, { disabled: false, hidden: false });
});

test('selected team Enable action posts its local identity and revision without rewriting instructions', async () => {
  const team = { id: 'chosen-team', enabled: false };
  const draft = { id: 'installed-workflows', agents: [{ id: 'worker' }], teams: [team] };
  const library = { details: { activeRevision: 'revision' }, draft, selectedId: draft.id };
  const enabledButton = element();
  const status = element();
  const mutation = [];
  const editor = { querySelectorAll: () => [], querySelector: selector => selector === '[data-package-team-enabled]' ? enabledButton : selector === '[data-package-status]' ? status : ['[data-save-package]', '[data-clear-package-test]', '[data-run-package-test]'].includes(selector) ? element() : null };
  const context = vm.createContext({ state: { agentLibrary: library }, wirePackageToolSearch() {}, packageApi: async (method, url, body) => { mutation.push({ method, url, body }); }, refreshAgentLibraryCatalog: async () => {}, loadAgentTeams: async () => {}, loadAgents: async () => {}, selectAgentPackage: async () => {}, showToast() {} });
  vm.runInContext(section('function wireAgentPackageEditor(', 'function resetAgentPackageTest('), context);
  context.wireAgentPackageEditor(editor, { isConnected: true }, draft.agents[0], team);
  await enabledButton.listeners.click({ currentTarget: enabledButton });
  assert.equal(mutation[0].method, 'PATCH');
  assert.equal(mutation[0].url, '/api/agent-packages/installed-workflows/teams/chosen-team/enabled');
  assert.deepEqual(plain(mutation[0].body), { enabled: true, expectedRevision: 'revision' });
});
