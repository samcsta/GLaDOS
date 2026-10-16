const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function clippyContext(extra = {}) {
  const context = vm.createContext({ AbortController, URLSearchParams, setTimeout, clearTimeout, Event, escapeHtml, state: { transcripts: new Map() }, ...extra });
  vm.runInContext(section('const CLIPPY_SEVERITIES =', 'async function renderClippyPane()'), context);
  return context;
}

test('unknown finding severity is preserved rather than presented as informational', () => {
  const context = clippyContext();
  assert.equal(context.clippySeverity('CRITICAL'), 'critical');
  assert.equal(context.clippySeverity('informational'), 'info');
  for (const value of [undefined, '', 'unknown', 'unrecognized']) assert.equal(context.clippySeverity(value), 'unknown');
});

test('superseded Clippy responses are rejected even if the transport ignores abort', async () => {
  const responses = [];
  const context = clippyContext({ fetch: () => new Promise(resolve => responses.push(resolve)) });
  vm.runInContext('globalThis.view = { wrap: { isConnected: true }, controllers: new Map(), disposed: false }; activeClippyView = view;', context);
  const first = context.clippyRead(context.view, '/findings?q=old', 'findings');
  const second = context.clippyRead(context.view, '/findings?q=new', 'findings');
  responses[1]({ ok: true, json: async () => ({ findings: [{ id: 'new' }] }) });
  assert.equal((await second).findings[0].id, 'new');
  responses[0]({ ok: true, json: async () => ({ findings: [{ id: 'old' }] }) });
  await assert.rejects(first, error => error.name === 'AbortError');
});

test('leaving the workspace cancels every in-flight lookup and ignores its late response', async () => {
  let resolve;
  let signal;
  const context = clippyContext({ fetch: (_url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); } });
  vm.runInContext('globalThis.view = { wrap: { isConnected: true }, controllers: new Map(), disposed: false }; activeClippyView = view;', context);
  const pending = context.clippyRead(context.view, '/file?path=example');
  context.disposeClippyPane();
  assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => ({ content: 'late' }) });
  await assert.rejects(pending, error => error.name === 'AbortError');
});

function inlineChatFixture(draft = '', availability = { agentExists: true, agentAvailable: true }) {
  const actions = [];
  const transcript = { innerHTML: '' };
  const composer = { value: draft, dispatchEvent: event => actions.push(event.type), focus: () => actions.push('focus') };
  const chat = { classList: { add() {} }, querySelector: () => transcript };
  const createButton = { addEventListener() {} };
  const target = { innerHTML: '', mounted: false, querySelector: selector => selector === '.chat-pane' ? target.mounted && chat : selector === '[data-clippy-create-agent]' ? createButton : composer };
  const panel = { hidden: true };
  const button = { setAttribute: (...args) => actions.push(args) };
  const wrap = { isConnected: true, classList: { add() {} }, querySelector: selector => ({ '[data-clippy-chat-panel]': panel, '[data-clippy-chat]': target, '[data-clippy-agent]': button })[selector] };
  const state = { currentSessionId: 'assessment', currentTeamId: 'glados', currentTab: 'clippy', transcripts: new Map(), clippyDashboard: {} };
  const context = clippyContext({
    state,
    packageApi: async (method, route, body) => { actions.push([method, route, body]); if (method === 'GET') return availability; return { sessionId: 'clippy-background', agentId: 'pkg-clippy-intel--clippy', teamId: 'agent:pkg-clippy-intel--clippy' }; },
    renderAgentChatSurface: (agentId, tabId, coordinator, options) => { actions.push({ agentId, tabId, coordinator, sessionId: options.sessionId, viewTabId: options.viewTabId }); target.mounted = true; state.transcripts.set(tabId, { events: [] }); return chat; },
    showToast: message => actions.push(message),
    confirmAction: () => assert.fail('an existing enabled agent must not ask for creation consent'),
    activateInvestigationSession: () => assert.fail('inline chat must not activate a session'),
    createInvestigationSession: () => assert.fail('inline chat must not create an active assessment'),
  });
  context.fixture = { wrap, status: availability, controllers: new Map(), disposed: false };
  vm.runInContext('activeClippyView = fixture;', context);
  return { context, actions, composer, state, panel, target };
}

test('Clippy Agent opens inline with its independent session without changing the active assessment', async () => {
  const { context, actions, composer, state, panel } = inlineChatFixture();
  await context.openClippyAgentChat('Explain finding 42');
  assert.equal(composer.value, 'Explain finding 42');
  assert.equal(panel.hidden, false);
  assert.equal(state.currentSessionId, 'assessment');
  assert.equal(state.currentTeamId, 'glados');
  assert.equal(state.currentTab, 'clippy');
  assert.equal(actions.filter(item => Array.isArray(item) && item[0] === 'POST').length, 1);
  assert.deepEqual(actions.find(item => item?.sessionId), { agentId: 'pkg-clippy-intel--clippy', tabId: 'clippy-chat', coordinator: false, sessionId: 'clippy-background', viewTabId: 'clippy' });
  assert.ok(actions.includes('input'));
  assert.ok(actions.includes('focus'));
});

test('inline Clippy chat reuses the mounted conversation and preserves an operator draft', async () => {
  const { context, actions, composer } = inlineChatFixture('My unsent question');
  await context.openClippyAgentChat('Explain another finding');
  await context.openClippyAgentChat();
  assert.equal(actions.filter(item => Array.isArray(item) && item[0] === 'POST').length, 1);
  assert.equal(composer.value, 'My unsent question');
  assert.ok(actions.some(item => typeof item === 'string' && item.includes('unsent question')));
});

test('only non-built-in connector cards offer disconnect, including Clippy and imported connectors', () => {
  const context = vm.createContext({ escapeHtml, clippyConnectorMarkup: () => '<span>C</span>' });
  vm.runInContext(section('function connectorIsBuiltIn(', 'function drawConnectorCollection('), context);
  const clippy = context.connectorCardMarkup({ id: 'clippy', name: 'Clippy MCP', source: 'integration', configured: true, enabled: true, available: true });
  assert.match(clippy, /data-disconnect-connector="clippy"/);
  assert.match(clippy, /data-open-clippy/);
  const builtin = context.connectorCardMarkup({ id: 'blackboard', source: 'builtin', enabled: true, available: true });
  assert.doesNotMatch(builtin, /data-disconnect-connector/);
  assert.match(builtin, /Managed by GLaDOS/);
  const imported = context.connectorCardMarkup({ id: 'custom', name: '<unsafe>', source: 'imported', enabled: false });
  assert.match(imported, /data-disconnect-connector="custom"/);
  assert.match(imported, /&lt;unsafe>/);
  assert.doesNotMatch(imported, /<unsafe>/);
});

test('empty severity pages retain backend continuation and mark sampled counts as loaded matches', async () => {
  const listeners = {};
  const element = () => ({ isConnected: true, innerHTML: '', textContent: '', setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], addEventListener(type, handler) { listeners[this.id + type] = handler; } });
  const elements = new Map();
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  get('[data-clippy-pagination]').querySelector = selector => {
    const button = get(selector);
    button.id = selector;
    return button;
  };
  const queries = [];
  const context = clippyContext({ state: { clippyDashboard: { query: '', severity: 'high', repo: '', category: '', offset: 0 } } });
  vm.runInContext(section('function updateClippyFilterOptions(', 'async function selectClippyFinding('), context);
  context.clippyViewAlive = () => true;
  context.clippyRead = async (_view, query) => { queries.push(query); return { findings: [], total: 0, counts: { high: 0 }, sampled: 25, hasMore: true, nextOffset: 25, partial: true, countsScope: 'loaded_matches', note: 'Only loaded matches are counted.' }; };
  const view = { wrap: { querySelector: get } };
  await context.loadClippyFindings(view);
  assert.match(queries[0], /limit=25/);
  assert.match(queries[0], /source=live/);
  assert.equal(get('[data-clippy-count-scope]').textContent, 'Loaded matches');
  assert.match(get('[data-clippy-pagination]').innerHTML, /data-clippy-next>Next/);
  listeners['[data-clippy-next]click']();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(queries[1], /offset=25/);
});

test('findings source defaults to live and switching to cache resets source-specific filters', () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(selector);
  };
  const target = { innerHTML: '', querySelector: element, querySelectorAll: () => [] };
  const dashboard = { query: 'access', severity: 'high', repo: '', category: 'old-category', offset: 50 };
  const context = clippyContext({ state: { clippyDashboard: dashboard } });
  vm.runInContext(section('function renderClippyFindings(', 'async function loadClippyRepoOptions('), context);
  context.loadClippyFindings = () => {};
  context.loadClippyRepoOptions = () => {};
  let renders = 0;
  context.renderClippyWorkspace = () => renders++;
  context.renderClippyFindings({ wrap: { querySelector: () => target }, controllers: new Map() });
  assert.equal(dashboard.findingsSource, 'live');
  assert.match(target.innerHTML, /value="live" selected>Live Clippy/);
  element('[data-clippy-source]').listeners.change({ target: { value: 'cache' } });
  assert.equal(dashboard.findingsSource, 'cache');
  assert.equal(dashboard.offset, 0);
  assert.equal(dashboard.category, '');
  assert.equal(dashboard.query, 'access');
  assert.equal(renders, 1);
  assert.equal(context.clippyFindingCountScope({ browseSource: 'live', index: { metadataPending: 5876 } }), 'Live search · parsed matches');
});


test('lead prompts cite the next verification and use connected intelligence beyond the cache', () => {
  const context = clippyContext();
  vm.runInContext(section('function clippyIndexSummary(', 'function renderClippyFindings('), context);
  const prompt = context.clippyLeadPrompt({ domain: 'portal.example.test', title: 'Historical authorization bypass', why: 'Cross-account evidence exists', nextStep: 'Verify account separation in scope', evidence: [{ repo: 'engagement-a', path: 'findings/auth.md', line: 24 }], reportCoverage: { label: 'Analyst checked Dradis; no tied report found' } });
  assert.match(prompt, /portal\.example\.test/);
  assert.match(prompt, /findings\/auth\.md \/ line 24/);
  assert.match(prompt, /Verify account separation in scope/);
  assert.match(prompt, /Query Clippy directly.*beyond the local cache/);
  assert.match(prompt, /Do not launch an assessment/);
  assert.match(prompt, /Missing cached matches do not establish/);
  const coverage = context.clippyCoverageMarkup({ status: 'no_match', label: 'No cached match', checkedAt: '2026-10-14T10:00:00Z', cacheAgeSeconds: 300 });
  assert.match(coverage, /No cached match/);
  assert.match(coverage, /Feed age 5 min/);
  assert.doesNotMatch(coverage, /confirmed|No Dradis report exists/);
});

test('independent transcript keeps receiving events when the active assessment changes', () => {
  const sources = [];
  const state = { currentSessionId: 'assessment-a', sessionGeneration: 1, transcripts: new Map() };
  const context = vm.createContext({
    state,
    EventSource: class { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } },
    withSession: (url, sessionId) => `${url}&session_id=${sessionId}`,
    normalizeIncomingTranscriptEvent: ev => ev,
    compactTranscriptEvent: ev => ev,
    insertTranscriptEvent: (rec, ev) => { rec.events.push(ev); return { added: true }; },
    transcriptEventMs: () => 1,
  });
  vm.runInContext(section('function ensureTranscript(', 'function stripSessionTimestampPrefix('), context);
  const independent = context.ensureTranscript('clippy-chat', 'clippy-agent', { sessionId: 'clippy-background', viewTabId: 'clippy' });
  const assessment = context.ensureTranscript('glados-chat', 'glados');
  state.currentSessionId = 'assessment-b';
  state.sessionGeneration++;
  sources[0].onmessage({ data: JSON.stringify({ kind: 'meta', text: 'Clippy continues' }) });
  sources[1].onmessage({ data: JSON.stringify({ kind: 'meta', text: 'stale assessment' }) });
  assert.equal(independent.events.length, 1);
  assert.equal(assessment.events.length, 0);
  assert.match(sources[0].url, /session_id=clippy-background/);
  assert.equal(independent.independentSession, true);
});

test('switching assessment streams preserves the independent Clippy transcript and connection', () => {
  const closed = [];
  const independent = { independentSession: true, es: { close: () => closed.push('clippy') } };
  const state = { transcripts: new Map([['clippy-chat', independent], ['glados-chat', { es: { close: () => closed.push('assessment') } }]]), active: new Map(), agentActivity: new Map(), sessionGeneration: 1 };
  const context = vm.createContext({ state, renderSecurityReviews() {} });
  vm.runInContext(section('function closeSessionStreams(', 'async function loadInvestigationSessions('), context);
  context.closeSessionStreams();
  assert.deepEqual(closed, ['assessment']);
  assert.equal(state.transcripts.get('clippy-chat'), independent);
  assert.equal(state.transcripts.has('glados-chat'), false);
});

test('coverage evidence exposes escaped Dradis links and rejects executable URL schemes', () => {
  const context = clippyContext();
  vm.runInContext(section('function clippyIndexSummary(', 'function renderClippyFindings('), context);
  const markup = context.clippyCoverageMarkup({ status: 'reported', label: 'Delivered report', projects: [
    { name: '<Engagement>', status: 'Report Delivered', url: 'https://dradis.example.test/projects/42' },
    { name: 'Unsafe source', status: 'Unknown', url: 'javascript:alert(1)' },
  ] });
  assert.match(markup, /href="https:\/\/dradis\.example\.test\/projects\/42"/);
  assert.match(markup, /&lt;Engagement>/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.doesNotMatch(markup, /javascript:/);
});

test('Clippy background work does not mark an unrelated assessment busy', () => {
  const state = { currentSessionId: 'assessment', investigationSessions: [{ id: 'assessment', runningCount: 0 }], active: new Map(), transcripts: new Map([['clippy-chat', { sending: true, independentSession: true, sessionId: 'clippy-background' }]]) };
  const context = vm.createContext({ state });
  vm.runInContext(section('function investigationSessionBusy(', 'async function confirmDeleteInvestigationSession('), context);
  assert.equal(context.investigationSessionBusy('assessment'), false);
  state.transcripts.set('glados-chat', { sending: true, sessionId: 'assessment' });
  assert.equal(context.investigationSessionBusy('assessment'), true);
});

test('editable integration capability choices stay within the supported connector and tool catalog', () => {
  const context = vm.createContext({});
  vm.runInContext(section('function packageEditorCatalog(', 'function teamEditorMarkup('), context);
  const catalog = { tools: ['Read', 'mcp__clippy__search', 'mcp__other__send'], connectors: [{ id: 'clippy' }, { id: 'other' }] };
  const filtered = context.packageEditorCatalog({ editableIntegration: true, integrationCapabilities: { tools: ['mcp__clippy__search'], connectors: ['clippy'] } }, catalog);
  assert.deepEqual(Array.from(filtered.tools), ['mcp__clippy__search']);
  assert.deepEqual(Array.from(filtered.connectors, row => row.id), ['clippy']);
  assert.equal(context.packageEditorCatalog({}, catalog), catalog);
});

test('unparsed metadata stays distinct from findings whose severity is genuinely unspecified', () => {
  const context = clippyContext();
  assert.match(context.clippyFindingSeverityMarkup({ metadataPending: true, severity: 'unknown' }), /Not parsed/);
  assert.doesNotMatch(context.clippyFindingSeverityMarkup({ metadataPending: true }), /Unspecified/);
  assert.match(context.clippyFindingSeverityMarkup({ severity: 'unknown' }), /Unspecified/);
  assert.match(context.clippyFindingSeverityMarkup({ severity: 'critical' }), /critical/);
  assert.equal(context.clippyFindingCountScope({ countsScope: 'parsed_indexed_findings', totalUnfiltered: 406, metadataLoaded: 12, metadataPending: 394 }), 'Local cache · 12/406 parsed · 394 not parsed');
  assert.equal(context.clippyFindingCountScope({ countsScope: 'indexed_findings', index: { findings: 406, metadataLoaded: 406, metadataPending: 0 } }), 'Local cache');
});

test('paused indexing progress exposes both parsed and pending records', () => {
  const context = clippyContext();
  vm.runInContext(section('function clippyIndexSummary(', 'async function refreshClippyIndex('), context);
  assert.match(context.clippyIndexSummary({ state: 'paused', findings: 406, metadataLoaded: 12, metadataPending: 394 }), /406 indexed findings · 12 parsed · 394 pending/);
  const refresh = section('async function refreshClippyIndex(', 'function clippyLeadPrompt(');
  assert.match(refresh, /Continue indexing/);
  assert.match(refresh, /100 lookups or two minutes/);
});


test('viewing Clippy without an agent shows an optional setup card and performs no agent mutation', async () => {
  const { context, actions, target } = inlineChatFixture('', { agentExists: false, agentAvailable: false });
  await context.openClippyAgentChat('', { askForAgent: false });
  assert.match(target.innerHTML, /Create Clippy Agent/);
  assert.match(target.innerHTML, /separate choice from connecting Clippy/);
  assert.equal(actions.filter(item => Array.isArray(item) && item[0] === 'POST').length, 0);
  assert.equal(target.mounted, false);
});

test('declining the separate agent choice leaves the connector available without creating a chat session', async () => {
  const { context, actions, target } = inlineChatFixture('', { connected: true, agentExists: false, agentAvailable: false });
  context.confirmAction = async options => { actions.push(['confirm', options]); return false; };
  await context.openClippyAgentChat('Explain this finding');
  assert.equal(actions.filter(item => Array.isArray(item) && item[0] === 'POST').length, 0);
  const [, choice] = actions.find(item => item[0] === 'confirm');
  assert.equal(choice.title, 'Create Clippy Agent?');
  assert.equal(choice.confirmLabel, 'Create agent');
  assert.equal(choice.cancelLabel, 'Not now');
  assert.match(choice.message, /read-only Clippy tools/);
  assert.equal(context.fixture.status.connected, true);
  assert.equal(target.mounted, false);
});

test('explicit agent consent creates the agent before opening its independent conversation', async () => {
  const { context, actions, composer } = inlineChatFixture('', { agentExists: false, agentAvailable: false });
  context.confirmAction = async () => true;
  await context.openClippyAgentChat('Explain this finding');
  const posts = actions.filter(item => Array.isArray(item) && item[0] === 'POST');
  assert.deepEqual(posts.map(item => item[1]), ['/api/clippy/agent/start', '/api/clippy/chat-session']);
  assert.equal(posts[0][2].createAgent, true);
  assert.equal(Object.hasOwn(posts[1][2], 'createAgent'), false);
  assert.equal(composer.value, 'Explain this finding');
});

test('disabled agents ask to enable the saved agent and preserve customization wording', async () => {
  const { context, actions, target } = inlineChatFixture('', { agentExists: true, agentAvailable: false });
  context.confirmAction = async options => { actions.push(['confirm', options]); return false; };
  await context.openClippyAgentChat();
  const [, choice] = actions.find(item => item[0] === 'confirm');
  assert.equal(choice.title, 'Enable Clippy Agent?');
  assert.equal(choice.confirmLabel, 'Enable agent');
  assert.match(choice.message, /instructions and settings will be preserved/);
  assert.match(target.innerHTML, /Enable Clippy Agent/);
  assert.equal(actions.filter(item => Array.isArray(item) && item[0] === 'POST').length, 0);
});

test('successful smart connect offers optional agent creation after saving the key', () => {
  const flow = section("await request('PUT', '/api/settings/clippy'", '} catch (error)');
  assert.match(flow, /close\(\)/);
  assert.match(flow, /await offerClippyAgent\(\)/);
  assert.doesNotMatch(flow, /agent\/start|createAgent: true/);
  const load = section('async function renderClippyPane(', 'function renderClippyWorkspace(');
  assert.match(load, /askForAgent: false/);
});

test('the shortlist rejects cached absence, unknown coverage, expired checks, and positive reports', () => {
  const context = clippyContext();
  vm.runInContext(section('function clippyLeadPrompt(', 'function renderClippyFindings('), context);
  const statuses = ['no_report_verified', 'no_match', 'unknown', 'stale', 'needs_verification', 'reported'];
  const rows = statuses.map((status, index) => ({ id: `lead-${index}`, domain: 'target.example.test', reportCoverage: { status } }));
  const result = context.clippyLeadCollections({ leads: rows, review: [rows[1], rows[5]] });
  assert.deepEqual(Array.from(result.ready, item => item.id), ['lead-0']);
  assert.deepEqual(Array.from(result.review, item => item.id), ['lead-1', 'lead-2', 'lead-3', 'lead-4', 'lead-5']);
  assert.equal(context.clippyLeadCollections({ leads: Array.from({ length: 8 }, (_, index) => ({ id: index, reportCoverage: { status: 'no_report_verified' } })) }).ready.length, 5);
});

test('possible report matches remain withheld while a confirmed tie cannot record a negative Dradis check', () => {
  const context = clippyContext();
  vm.runInContext(section('function clippyLeadPrompt(', 'function renderClippyFindings('), context);
  const item = { id: '<unsafe>', domain: 'target.example.test', title: '<script>bad</script>', why: 'Stored evidence', nextStep: 'Check scope', reportCoverage: { status: 'reported', label: 'Dradis report found' } };
  const markup = context.clippyLeadCard(item, 0, { review: true });
  assert.match(markup, /Withheld: possible Dradis matches need a direct analyst check/);
  assert.match(markup, /data-clippy-record-coverage/);
  assert.doesNotMatch(markup, /data-clippy-save-lead|Plan with Clippy/);
  assert.match(markup, /&lt;script>bad&lt;\/script>/);
  assert.doesNotMatch(markup, /<script>/);
  item.reportCoverage.confirmedTie = true;
  assert.doesNotMatch(context.clippyLeadCard(item, 0, { review: true }), /data-clippy-record-coverage/);
  context.openClippyCoverageCheck({}, item); // Must return before creating a dialog.
});

test('a bounded direct search prompt withholds unchecked coverage and never sends itself', () => {
  const context = clippyContext();
  const prompt = context.clippyLeadSearchPrompt('example.test');
  assert.match(prompt, /example\.test/);
  assert.match(prompt, /Do not restrict yourself to the local index/);
  assert.match(prompt, /Exclude candidates with a matching report/);
  assert.match(prompt, /withhold the candidate from recommendations/);
  assert.match(prompt, /Stop after a bounded evidence pass/);
  const chat = section('async function openClippyAgentChat(', 'async function editClippyAgent(');
  assert.doesNotMatch(chat, /requestSubmit|\.submit\(|sendChat|sendMessage/);
});

function leadPollingFixture(result, timers = []) {
  const content = { isConnected: true, innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const status = { innerHTML: '', querySelector: () => null };
  const button = {};
  const elements = { '[data-clippy-leads-content]': content, '[data-clippy-lead-status]': status, '[data-clippy-find-leads]': button };
  const context = clippyContext({ state: { clippyDashboard: { view: 'leads' } }, setTimeout: fn => { timers.push(fn); return timers.length; } });
  vm.runInContext(section('function clippyLeadPrompt(', 'function renderClippyFindings('), context);
  const requests = [];
  context.clippyViewAlive = () => true;
  context.clippyRead = async (_view, endpoint) => { requests.push(endpoint); return result; };
  const view = { wrap: { querySelector: selector => elements[selector] } };
  return { context, view, requests, content, status, button, timers };
}

test('lead search polling stops on bounded completion and never polls or starts the local index', async () => {
  const result = { leads: [], review: [], search: { state: 'running', reason: 'Inspecting evidence', calls: 3 } };
  const fixture = leadPollingFixture(result);
  await fixture.context.loadClippyLeads(fixture.view);
  assert.equal(fixture.button.disabled, true);
  assert.equal(fixture.timers.length, 1);
  assert.match(fixture.status.innerHTML, /Stop search/);
  assert.match(fixture.content.innerHTML, /No verified leads yet/);
  result.search = { state: 'paused', reason: 'Lookup limit reached' };
  await fixture.context.loadClippyLeads(fixture.view);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.button.disabled, false);
  assert.match(fixture.status.innerHTML, /Lookup limit reached/);
  assert.doesNotMatch(fixture.status.innerHTML, /Stop search/);
  assert.deepEqual(fixture.requests, ['/leads?query=', '/leads?query=']);
  const pane = section('async function renderClippyPane(', 'function renderClippyWorkspace(');
  assert.doesNotMatch(pane, /refreshClippyIndex|index\/sync|data-clippy-index-status/);
});

test('the unchanged shortlist does not replace open evidence on each progress poll', async () => {
  const result = { leads: [{ id: 'good', domain: 'target.example.test', reportCoverage: { status: 'no_report_verified', label: 'Checked' } }], review: [], search: { state: 'running' } };
  const fixture = leadPollingFixture(result);
  await fixture.context.loadClippyLeads(fixture.view);
  fixture.content.innerHTML = 'operator is reading expanded evidence';
  result.search.calls = 8;
  await fixture.context.loadClippyLeads(fixture.view);
  assert.equal(fixture.content.innerHTML, 'operator is reading expanded evidence');
});

test('planning hands the agent the attributable analyst receipt and current evidence digest', () => {
  const context = clippyContext();
  vm.runInContext(section('function clippyLeadPrompt(', 'function renderClippyFindings('), context);
  const item = { domain: 'example.test', evidenceDigest: 'digest-42', reportCoverage: { kind: 'analyst_attestation', sourceUrl: 'https://dradis.example.test/projects/42', scope: 'example.test', notes: 'Checked target aliases and the project report inventory', expiresAt: '2026-10-16T12:00:00Z' } };
  const prompt = context.clippyLeadPrompt(item);
  for (const value of ['analyst_attestation', 'https://dradis.example.test/projects/42', 'example.test', 'Checked target aliases and the project report inventory', '2026-10-16T12:00:00Z', 'digest-42']) assert.ok(prompt.includes(value));
  assert.match(prompt, /Attribute an analyst Dradis check to its recorded receipt/);
});
