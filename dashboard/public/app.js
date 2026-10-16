const ALERT_KINDS = new Set(['error', 'failed', 'offline', 'denied']);
const DASHBOARD_THEME_KEY = 'glados-dash.theme';
const DASHBOARD_THEMES = new Set(['quantum', 'classic']);
const CHAT_TEXT_SCALE_KEY = 'glados-dash.chat-text-scale';

function savedChatTextScale() {
  try {
    const value = Number(localStorage.getItem(CHAT_TEXT_SCALE_KEY));
    return Number.isFinite(value) && value >= 0.8 && value <= 1.8 ? value : 1;
  } catch { return 1; }
}

function savedDashboardTheme() {
  try {
    const saved = localStorage.getItem(DASHBOARD_THEME_KEY);
    return DASHBOARD_THEMES.has(saved) ? saved : 'quantum';
  } catch { return 'quantum'; }
}

function savedAgentFilter() {
  try {
    const value = localStorage.getItem('glados-dash.agent-filter');
    if (['all', 'custom', 'halted'].includes(value)) return value;
    if (value) localStorage.setItem('glados-dash.agent-filter', 'all');
  } catch {}
  return 'all';
}

const state = {
  agents: [],          // from /api/agents
  active: new Map(),   // agentId -> { sessionId }
  agentActivity: new Map(), // agentId -> last meaningful session or transcript event
  openTabs: [],        // [{ id: 'glados-chat' | agentId, kind: 'chat'|'agent', label }]
  currentTab: null,
  transcripts: new Map(), // tabId -> { es, el, events[], sending }
  agentsLoadedOnce: false,
  update: { lines: [], running: false, es: null, autoStart: false, availableVersion: null, dismissedVersion: null },
  reports: { query: '', scope: 'all', selectedPath: null, tree: [] },
  agentLibrary: { view: 'built-in', catalog: null, fordCatalog: null, selectedId: null, details: null, draft: null, selectedAgentId: null, selectedTeamId: null, query: '', testMessages: [], testBusy: false, testGeneration: 0, dirty: false, selectionGeneration: 0, loading: false },
  connectorLibrary: { catalog: null },
  clippyDashboard: { view: 'leads', browseView: 'findings', query: '', severity: '', repo: '', category: '', offset: 0, repoQuery: '', leadQuery: '', expandedLeads: new Set(), chatOpen: true, chatSession: null },
  investigationSessions: [],
  investigationProjects: [],
  currentSessionId: null,
  currentTeamId: 'glados',
  defaultTeamPreference: { defaultTeamId: 'glados', effectiveTeamId: 'glados', fallback: false, teams: [] },
  teamCatalog: { teams: [{ id: 'glados', name: 'GLaDOS', coordinatorId: 'glados', source: 'builtin', memberIds: [], assignedAgentIds: [], available: true }], agents: [], directAgents: [] },
  teamCatalogGeneration: 0,
  teamChangeDraft: null,
  sessionListProjectId: null,
  expandedProjectIds: (() => {
    try {
      const raw = localStorage.getItem('glados-dash.expanded-projects.v2');
      if (raw === null) return new Set();
      const stored = JSON.parse(raw);
      return new Set(Array.isArray(stored) ? stored : []);
    } catch { return new Set(); }
  })(),
  unreadCompletedSessionIds: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('glados-dash.unread-completed-sessions') || '[]');
      return new Set(Array.isArray(stored) ? stored.map(String) : []);
    } catch { return new Set(); }
  })(),
  operatorProfile: { name: '', initials: 'You' },
  sessionGeneration: 0,
  sessionActivationGeneration: 0,
  sessionActivationPending: false,
  sessionActivationController: null,
  sessionActivationClientId: (() => {
    try {
      const stored = sessionStorage.getItem('glados-dash.activation-client-id');
      if (stored) return stored;
      const created = globalThis.crypto?.randomUUID?.() || `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem('glados-dash.activation-client-id', created);
      return created;
    } catch { return `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  })(),
  overview: null,
  securityReviews: [],
  agentFilter: savedAgentFilter(),
  agentQuery: (() => { try { return localStorage.getItem('glados-dash.agent-query') || ''; } catch { return ''; } })(),
  notifications: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('glados-dash.notifications') || '[]');
      return Array.isArray(stored) ? stored.filter(item => ALERT_KINDS.has(item?.kind)).slice(-100) : [];
    }
    catch { return []; }
  })(),
  unreadNotifications: 0,
  provenanceFocus: null,
  theme: savedDashboardTheme(),
  chatTextScale: savedChatTextScale(),
};

function applyDashboardTheme(theme, { persist = true } = {}) {
  const next = DASHBOARD_THEMES.has(theme) ? theme : 'quantum';
  document.documentElement.dataset.theme = next;
  state.theme = next;
  if (persist) {
    try { localStorage.setItem(DASHBOARD_THEME_KEY, next); } catch {}
  }
  document.querySelectorAll('[data-dashboard-theme]').forEach(button => {
    const active = button.dataset.dashboardTheme === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  return next;
}

applyDashboardTheme(state.theme, { persist: false });

const tabsEl = document.getElementById('tabs');
const paneEl = document.getElementById('pane');
const agentListEl = document.getElementById('agent-list');
const securityReviewsEl = document.getElementById('security-reviews');
const securityReviewListEl = document.getElementById('security-review-list');
const eventsEl = document.getElementById('events');
const errorsOnlyEl = document.getElementById('errors-only');
const debugModeEl = document.getElementById('debug-mode');
const notificationDrawerEl = document.getElementById('notification-drawer');
const notificationListEl = document.getElementById('notification-list');

function setChatTextScale(value) {
  const clamped = Math.max(0.8, Math.min(1.8, Math.round(Number(value) * 10) / 10));
  state.chatTextScale = Number.isFinite(clamped) ? clamped : 1;
  document.documentElement.style.setProperty('--chat-text-scale', String(state.chatTextScale));
  try { localStorage.setItem(CHAT_TEXT_SCALE_KEY, String(state.chatTextScale)); } catch {}
}

setChatTextScale(state.chatTextScale);

function storageGetJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed === null ? fallback : parsed;
  } catch { return fallback; }
}

function persistWorkspaceState() {
  try {
    localStorage.setItem('glados-dash.open-tabs', JSON.stringify(state.openTabs));
    localStorage.setItem('glados-dash.current-tab', state.currentTab || '');
    localStorage.setItem('glados-dash.current-session', state.currentSessionId || '');
  } catch {}
}

function sessionQuery() {
  const session = `session_id=${encodeURIComponent(state.currentSessionId || 'draft')}`;
  return state.currentSessionId ? session : `${session}&team_id=${encodeURIComponent(state.currentTeamId || 'glados')}`;
}

function withSession(url, sessionId) {
  const query = sessionId ? `session_id=${encodeURIComponent(sessionId)}` : sessionQuery();
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

function allConversationContexts() {
  return [...(state.teamCatalog?.teams || []), ...(state.teamCatalog?.directAgents || [])];
}

async function loadDefaultTeamPreference() {
  const preference = await fetchJson('/api/settings/default-team', { timeoutMs: 8000 });
  state.defaultTeamPreference = preference;
  return preference;
}

function activeTeam() {
  return allConversationContexts().find(team => team.id === (state.currentTeamId || 'glados')) || null;
}

function activeCoordinatorId() {
  const teamId = state.currentTeamId || 'glados';
  return teamId === 'glados' ? 'glados' : activeTeam()?.coordinatorId || null;
}

function isSessionCoordinatorEvent(event) {
  const session = state.investigationSessions.find(item => item.id === event.investigationSessionId);
  const teamId = session?.teamId || (event.investigationSessionId === state.currentSessionId ? state.currentTeamId : 'glados') || 'glados';
  const coordinatorId = teamId === 'glados' ? 'glados' : allConversationContexts().find(team => team.id === teamId)?.coordinatorId;
  return event.agentId === coordinatorId;
}

function currentTeamName() {
  return (state.currentTeamId || 'glados') === 'glados' ? 'GLaDOS' : activeTeam()?.name || 'Selected team';
}

async function loadAgentTeams() {
  const generation = ++state.teamCatalogGeneration;
  const catalog = await fetchJson('/api/agent-teams', { timeoutMs: 10000 });
  if (generation === state.teamCatalogGeneration) {
    state.teamCatalog = { teams: catalog.teams || [], agents: catalog.agents || [], directAgents: catalog.directAgents || [] };
    if (state.currentTeamId && state.currentTeamId !== 'glados' && !allConversationContexts().some(team => team.id === state.currentTeamId)) clearUnavailableTeamRoster();
  }
  return state.teamCatalog;
}

function clearUnavailableTeamRoster() {
  const removed = state.openTabs.filter(tab => tab.kind === 'agent');
  for (const tab of removed) clearTranscriptTab(tab.id);
  state.openTabs = state.openTabs.filter(tab => tab.kind !== 'agent');
  state.agents = [];
  state.active.clear();
  if (removed.some(tab => tab.id === state.currentTab)) state.currentTab = 'glados-chat';
  renderAgentList();
  renderTabs();
  updateWorkspaceNav();
  if (state.currentTab === 'glados-chat') renderPane();
}

function draftContextOptions() {
  const options = [...(state.teamCatalog?.teams || [])].sort((left, right) => left.id === 'glados' ? -1 : right.id === 'glados' ? 1 : String(left.name).localeCompare(String(right.name)));
  const direct = (state.teamCatalog?.directAgents || []).find(agent => agent.id === state.currentTeamId);
  if (direct) options.push(direct);
  return options;
}

function draftContextOptionsMarkup() {
  return draftContextOptions().map(context => `<option value="${escapeHtml(context.id)}"${context.id === (state.currentTeamId || 'glados') ? ' selected' : ''}${context.available === false ? ' disabled' : ''}>${escapeHtml(context.id === 'glados' ? 'GLaDOS' : context.name)}${context.available === false ? ' (unavailable)' : ''}</option>`).join('');
}

function newSessionTeamPickerMarkup() {
  const direct = String(state.currentTeamId || '').startsWith('agent:');
  return `<label class="new-session-team-picker"><span>${direct ? 'Agent' : 'Team'}</span><select data-new-session-team aria-label="${direct ? 'Agent or team' : 'Team'} for the new session">${draftContextOptionsMarkup()}</select></label>`;
}

async function selectDraftTeam(teamId) {
  if (state.currentSessionId) throw new Error('An existing session keeps its team. Start a new session to choose another team.');
  if (teamId === state.currentTeamId) return;
  const team = allConversationContexts().find(item => item.id === teamId);
  if (!team || team.available === false) throw new Error('This team is unavailable. Enable it and connect its required tools first.');
  const composer = document.querySelector('[data-chat-composer][data-chat-tab="glados-chat"] textarea');
  const record = state.transcripts.get('glados-chat');
  const carry = { text: composer?.value || '', attachments: [...(record?.composerAttachments || [])] };
  ++state.sessionActivationGeneration;
  state.sessionActivationController?.abort();
  state.sessionActivationPending = false;
  state.sessionActivationController = null;
  closeSessionStreams();
  state.currentTeamId = teamId;
  state.teamChangeDraft = carry;
  await loadAgents();
  openGladosChat();
  subscribeLobby();
}

function refreshDraftTeamOptions() {
  if (state.currentSessionId) return;
  const picker = document.querySelector('[data-new-session-team]');
  if (!picker) return;
  picker.innerHTML = draftContextOptionsMarkup();
}

function rosterAgentIds(agents = state.agents) {
  return new Set(agents.map(agent => agent.id));
}

function closeSessionStreams() {
  state.sessionGeneration++;
  try { state._lobbySource?.close(); } catch {}
  state._lobbySource = null;
  for (const [tabId, rec] of state.transcripts) {
    if (rec.independentSession) continue;
    try { rec.es?.close(); } catch {}
    state.transcripts.delete(tabId);
  }
  state.active.clear();
  state.agentActivity.clear();
  state.securityReviews = [];
  renderSecurityReviews();
}

async function loadInvestigationSessions() {
  const activationGeneration = state.sessionActivationGeneration;
  const response = await fetch('/api/investigation-sessions');
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not load investigation sessions');
  if (activationGeneration !== state.sessionActivationGeneration) return false;
  state.investigationSessions = body.sessions || [];
  state.investigationProjects = body.projects || [];
  if (!state.sessionActivationPending && state.currentSessionId && !state.investigationSessions.some(session => session.id === state.currentSessionId)) {
    await createInvestigationSession();
  }
  const validSessions = new Set(state.investigationSessions.map(session => session.id));
  state.unreadCompletedSessionIds = new Set([...state.unreadCompletedSessionIds].filter(id => validSessions.has(id) && id !== state.currentSessionId));
  persistUnreadCompletedSessions();
  const validProjects = new Set(state.investigationProjects.map(project => project.id));
  if (!(state.expandedProjectIds instanceof Set)) state.expandedProjectIds = new Set();
  else state.expandedProjectIds = new Set([...state.expandedProjectIds].filter(id => validProjects.has(id)));
  renderInvestigationNavigation();
  return true;
}

async function loadOperatorProfile() {
  const response = await fetch('/api/settings/operator-profile');
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not load chat identity');
  state.operatorProfile = { name: body.name || '', initials: body.initials || 'You' };
  return state.operatorProfile;
}

function nextSessionActivationGeneration() {
  let stored = 0;
  try { stored = Number(sessionStorage.getItem('glados-dash.activation-generation')) || 0; } catch {}
  const next = Math.max(Date.now(), state.sessionActivationGeneration + 1, stored + 1);
  state.sessionActivationGeneration = next;
  try { sessionStorage.setItem('glados-dash.activation-generation', String(next)); } catch {}
  return next;
}

async function activateInvestigationSession(sessionId) {
  if (!sessionId) return;
  if (sessionId === state.currentSessionId) { openGladosChat(); return; }
  const previousSessionId = state.currentSessionId;
  const previousTeamId = state.currentTeamId;
  const previous = state.investigationSessions.find(session => session.id === previousSessionId);
  const continuesInBackground = Number(previous?.runningCount || 0) > 0 || state.active.size > 0;
  const activationGeneration = nextSessionActivationGeneration();
  state.sessionActivationController?.abort();
  const controller = new AbortController();
  state.sessionActivationController = controller;
  state.sessionActivationPending = true;
  state.currentSessionId = sessionId;
  renderInvestigationNavigation();
  let response;
  let body;
  try {
    response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}/activate`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: state.sessionActivationClientId,
        generation: activationGeneration,
      }),
    });
    body = await response.json();
  } catch (error) {
    if (error?.name === 'AbortError' || activationGeneration !== state.sessionActivationGeneration) return;
    state.currentSessionId = previousSessionId;
    state.currentTeamId = previousTeamId;
    state.sessionActivationPending = false;
    renderInvestigationNavigation();
    throw error;
  }
  if (activationGeneration !== state.sessionActivationGeneration) return;
  if (!response.ok || !body.ok) {
    state.currentSessionId = previousSessionId;
    state.currentTeamId = previousTeamId;
    state.sessionActivationPending = false;
    renderInvestigationNavigation();
    throw new Error(body.error || 'could not activate investigation');
  }
  state.sessionActivationPending = false;
  state.sessionActivationController = null;
  closeSessionStreams();
  state.currentSessionId = body.activeId || body.session.id;
  state.currentTeamId = body.session.teamId || 'glados';
  state.teamChangeDraft = null;
  state.investigationSessions = body.sessions || [];
  state.investigationProjects = body.projects || state.investigationProjects;
  markSessionSeen(state.currentSessionId);
  clearPlanClientState();
  persistWorkspaceState();
  await Promise.all([loadAgents(), loadSecurityReviews()]);
  openGladosChat();
  if (!state._lobbySource) subscribeLobby();
  if (continuesInBackground) showToast(`${previous?.name || 'The previous session'} is still working in the background.`, { kind: 'info', label: 'Sessions' });
}

async function createInvestigationSession({ teamId } = {}) {
  const requestedGeneration = state.sessionActivationGeneration;
  const selectedTeamId = teamId || (await loadDefaultTeamPreference()).effectiveTeamId || 'glados';
  if (requestedGeneration !== state.sessionActivationGeneration) return null;
  const current = state.investigationSessions.find(session => session.id === state.currentSessionId);
  const continuesInBackground = Number(current?.runningCount || 0) > 0 || state.active.size > 0;
  ++state.sessionActivationGeneration;
  state.sessionActivationController?.abort();
  state.sessionActivationPending = false;
  state.sessionActivationController = null;
  closeSessionStreams();
  state.currentSessionId = null;
  state.currentTeamId = selectedTeamId;
  state.teamChangeDraft = null;
  state.securityReviews = [];
  renderSecurityReviews();
  clearPlanClientState();
  renderInvestigationNavigation();
  openGladosChat();
  await loadAgents();
  subscribeLobby();
  if (continuesInBackground) showToast(`${current?.name || 'The previous session'} is still working in the background.`, { kind: 'info', label: 'Sessions' });
  return null;
}

let draftSessionCreation = null;
async function materializeDraftSession() {
  if (state.currentSessionId) return state.currentSessionId;
  if (draftSessionCreation) return draftSessionCreation;
  const activationGeneration = state.sessionActivationGeneration;
  draftSessionCreation = (async () => {
  const response = await fetch('/api/investigation-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New session', metadata: { unassigned: true }, projectId: null, ...(String(state.currentTeamId || '').startsWith('agent:') ? { agentId: state.currentTeamId.slice(6) } : { teamId: state.currentTeamId || 'glados' }) }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not create investigation');
  if (activationGeneration !== state.sessionActivationGeneration) return null;
  state.currentSessionId = body.session.id;
  state.currentTeamId = body.session.teamId || state.currentTeamId || 'glados';
  state.investigationSessions = body.sessions || [];
  state.investigationProjects = body.projects || state.investigationProjects;
  markSessionSeen(body.session.id);
  clearPlanClientState();
  persistWorkspaceState();
  renderInvestigationNavigation();
  for (const [tabId, rec] of state.transcripts) ensureTranscript(tabId, rec.agentId);
  document.querySelector('.chat-new-session')?.classList.remove('chat-new-session');
  document.querySelector('.new-session-welcome')?.remove();
  await loadAgents();
  subscribeLobby();
  return body.session.id;
  })();
  try { return await draftSessionCreation; }
  finally { draftSessionCreation = null; }
}

async function renameInvestigationSession(sessionId, name) {
  const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not rename investigation');
  state.investigationSessions = body.sessions || [];
  state.investigationProjects = body.projects || state.investigationProjects;
  return body.session;
}

async function moveInvestigationSession(sessionId, projectId) {
  const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: projectId || null }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not move session');
  state.investigationSessions = body.sessions || [];
  state.investigationProjects = body.projects || [];
  renderInvestigationNavigation();
  return body.session;
}

async function createInvestigationProject() {
  const name = await showNameInput({ title: 'New project', confirmLabel: 'Create project', label: 'Project name', placeholder: 'Security reviews' });
  if (!name) return null;
  const response = await fetch('/api/investigation-projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not create project');
  state.investigationProjects = body.projects || [];
  state.investigationSessions = body.sessions || [];
  if (!(state.expandedProjectIds instanceof Set)) state.expandedProjectIds = new Set();
  state.expandedProjectIds.add(body.project.id);
  persistExpandedProjects();
  renderInvestigationNavigation();
  return body.project;
}

async function renameInvestigationProject(projectId, name) {
  const response = await fetch(`/api/investigation-projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not rename project');
  state.investigationProjects = body.projects || [];
  state.investigationSessions = body.sessions || [];
  renderInvestigationNavigation();
  return body.project;
}

async function deleteInvestigationProject(projectId) {
  const response = await fetch(`/api/investigation-projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not delete project');
  state.investigationProjects = body.projects || [];
  state.investigationSessions = body.sessions || [];
  state.expandedProjectIds.delete(projectId);
  persistExpandedProjects();
  renderInvestigationNavigation();
  return body.project;
}

function investigationSessionBusy(sessionId) {
  const session = state.investigationSessions.find(item => item.id === sessionId);
  return Number(session?.runningCount || 0) > 0 || (sessionId === state.currentSessionId && (state.active.size > 0 || [...state.transcripts.values()].some(record => record.sending && (!record.independentSession || record.sessionId === sessionId))));
}

async function confirmDeleteInvestigationSession(session) {
  if (!session) return false;
  if (investigationSessionBusy(session.id)) throw new Error('Finish or stop this session’s active agents before deleting it.');
  const approved = await confirmAction({ title: 'Delete session', message: `Permanently delete "${session.name}" and its database records? Evidence and report files are preserved.`, confirmLabel: 'Delete session', danger: true });
  if (!approved) return false;
  await deleteInvestigationSession(session.id);
  return true;
}

async function deleteInvestigationSession(sessionId) {
  if (investigationSessionBusy(sessionId)) throw new Error('Finish or stop this session’s active agents before deleting it.');
  const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not delete investigation');
  state.investigationSessions = body.sessions || [];
  state.investigationProjects = body.projects || state.investigationProjects;
  state.unreadCompletedSessionIds.delete(sessionId);
  persistUnreadCompletedSessions();
  if (sessionId === state.currentSessionId) {
    ++state.sessionActivationGeneration;
    state.sessionActivationController?.abort();
    state.sessionActivationPending = false;
    state.sessionActivationController = null;
    closeSessionStreams();
    state.currentSessionId = null;
    state.currentTeamId = state.defaultTeamPreference?.effectiveTeamId || 'glados';
    state.teamChangeDraft = null;
    clearPlanClientState();
    persistWorkspaceState();
    await loadAgents();
    openGladosChat();
    subscribeLobby();
  } else {
    renderInvestigationNavigation();
    if (state.currentTab === 'sessions') renderPane();
  }
  return true;
}

function showNameInput({ title, value = '', confirmLabel = 'Save', label = 'Investigation name', placeholder = '' }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<section class="app-modal session-name-modal" role="dialog" aria-modal="true" aria-labelledby="session-name-title">
      <header><h2 id="session-name-title">${escapeHtml(title)}</h2><button type="button" data-modal-close aria-label="Close">×</button></header>
      <div class="app-modal-copy"><label for="session-name-input">${escapeHtml(label)}</label><input id="session-name-input" maxlength="120" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" /></div>
      <footer><button type="button" data-modal-cancel>Cancel</button><button type="button" data-modal-confirm class="safe">${escapeHtml(confirmLabel)}</button></footer>
    </section>`;
    const input = backdrop.querySelector('input');
    const finish = result => { backdrop.remove(); resolve(result); };
    const submit = () => { const next = input.value.trim(); if (next) finish(next); };
    backdrop.querySelector('[data-modal-close]').addEventListener('click', () => finish(null));
    backdrop.querySelector('[data-modal-cancel]').addEventListener('click', () => finish(null));
    backdrop.querySelector('[data-modal-confirm]').addEventListener('click', submit);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
    root.replaceChildren(backdrop);
    input.focus(); input.select();
  });
}

function persistNotifications() {
  state.notifications = state.notifications.slice(-100);
  try { localStorage.setItem('glados-dash.notifications', JSON.stringify(state.notifications)); } catch {}
}

function notificationTone(kind) {
  if (/error|failed|halt|denied|offline/.test(kind)) return 'danger';
  if (/warn|pending|approval/.test(kind)) return 'warning';
  if (/resume|started|success|complete|live/.test(kind)) return 'success';
  return 'info';
}

function renderNotifications() {
  const badge = document.getElementById('notifications-badge');
  const summary = document.getElementById('notification-summary');
  if (badge) {
    badge.textContent = String(state.unreadNotifications);
    badge.classList.toggle('hidden', state.unreadNotifications === 0);
  }
  if (summary) summary.textContent = state.unreadNotifications ? `${state.unreadNotifications} unread` : 'All caught up';
  if (!notificationListEl) return;
  notificationListEl.innerHTML = '';
  if (!state.notifications.length) {
    notificationListEl.innerHTML = '<div class="notification-empty">Operational events and alerts will appear here.</div>';
    return;
  }
  for (const item of [...state.notifications].reverse()) {
    const row = document.createElement('div');
    row.className = `notification-item ${notificationTone(item.kind)}`;
    row.innerHTML = `<span class="notification-dot"></span><div><strong>${escapeHtml(item.label || 'GLaDOS')}</strong>` +
      `<p>${escapeHtml(item.text)}</p><time>${new Date(item.ts).toLocaleString()}</time></div>`;
    notificationListEl.appendChild(row);
  }
}

function pushNotification(kind, text, { toast = false, label = null, unread = true } = {}) {
  if (!ALERT_KINDS.has(kind)) {
    if (toast) showToast(text, { kind, label });
    return null;
  }
  const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, kind, text: String(text), label, ts: Date.now() };
  state.notifications.push(item);
  if (unread && notificationDrawerEl?.getAttribute('aria-hidden') !== 'false') state.unreadNotifications++;
  persistNotifications();
  renderNotifications();
  if (toast) showToast(text, { kind, label });
  return item;
}

function showToast(text, { kind = 'info', label = null, timeoutMs = 5000 } = {}) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast ${notificationTone(kind)}`;
  toast.innerHTML = `<span class="toast-mark"></span><div>${label ? `<strong>${escapeHtml(label)}</strong>` : ''}<p>${escapeHtml(text)}</p></div>` +
    '<button type="button" aria-label="Dismiss notification">×</button>';
  const remove = () => toast.remove();
  toast.querySelector('button').addEventListener('click', remove);
  region.appendChild(toast);
  setTimeout(remove, timeoutMs);
}

function showDialog({ title, message, confirmLabel = 'OK', cancelLabel = null, danger = false, detail = false }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<section class="app-modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">` +
      `<header><h2 id="app-modal-title">${escapeHtml(title)}</h2><button type="button" data-modal-close aria-label="Close">×</button></header>` +
      `<div class="app-modal-copy ${detail ? 'detail' : ''}">${detail ? `<pre>${escapeHtml(message)}</pre>` : `<p>${escapeHtml(message)}</p>`}</div>` +
      `<footer>${cancelLabel ? `<button type="button" data-modal-cancel>${escapeHtml(cancelLabel)}</button>` : ''}` +
      `<button type="button" data-modal-confirm class="${danger ? 'danger' : 'safe'}">${escapeHtml(confirmLabel)}</button></footer></section>`;
    const finish = value => { backdrop.remove(); resolve(value); };
    backdrop.querySelector('[data-modal-close]').addEventListener('click', () => finish(false));
    backdrop.querySelector('[data-modal-cancel]')?.addEventListener('click', () => finish(false));
    backdrop.querySelector('[data-modal-confirm]').addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(false); });
    root.replaceChildren(backdrop);
    backdrop.querySelector('[data-modal-confirm]').focus();
  });
}

function confirmAction({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false }) {
  return showDialog({ title, message, confirmLabel, cancelLabel, danger });
}

function openNotificationDrawer(open = true) {
  if (!notificationDrawerEl) return;
  notificationDrawerEl.setAttribute('aria-hidden', open ? 'false' : 'true');
  notificationDrawerEl.inert = !open;
  notificationDrawerEl.classList.toggle('open', open);
  if (open) {
    state.unreadNotifications = 0;
    renderNotifications();
  }
}

errorsOnlyEl.addEventListener('change', () => {
  document.body.classList.toggle('errors-only', errorsOnlyEl.checked);
  document.querySelectorAll('.work-history').forEach(applyWorkHistoryMode);
  if (errorsOnlyEl.checked) {
    document.querySelectorAll('.entry.tool-result.error .tool-details')
      .forEach(details => { details.open = true; });
  }
});

// Debug off shows live progress, then folds completed work behind a summary.
// Debug additionally exposes raw tool events and internal thinking.
function applyWorkHistoryMode(history) {
  const hasVisibleError = errorsOnlyEl.checked && history.querySelector('.entry.error, .entry.prompt-error, .entry.permission-denied');
  history.open = debugModeEl.checked || !!hasVisibleError || history.dataset.expanded === 'true';
}

function applyDebugMode() {
  document.body.classList.toggle('debug-off', !debugModeEl.checked);
  document.querySelectorAll('.work-history').forEach(applyWorkHistoryMode);
  if (debugModeEl.checked) {
    document.querySelectorAll('.entry.tool-call .tool-details, .entry.tool-result .tool-details')
      .forEach(details => { details.open = true; });
  }
  try { localStorage.setItem('glados-dash.debug-mode', debugModeEl.checked ? '1' : '0'); } catch {}
}
try { debugModeEl.checked = localStorage.getItem('glados-dash.debug-mode') === '1'; } catch {}
debugModeEl.addEventListener('change', applyDebugMode);
applyDebugMode();

function setAgentHaltedState(agentId, halted) {
  const agent = state.agents.find(entry => entry.id === agentId);
  if (agent) agent.halted = !!halted;
  noteAgentActivity(agentId, halted ? 'Operator halted agent' : 'Agent resumed', { status: halted ? 'halted' : 'running' });
  renderAgentList();
  syncAgentViewToolbars(agentId);
}

function agentDisplayName(agentOrId) {
  const agent = typeof agentOrId === 'string' ? state.agents.find(item => item.id === agentOrId) : agentOrId;
  const id = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id || '';
  if (id === 'glados') return 'GLaDOS';
  return (agent?.packageId || id.startsWith('pkg-')) && agent?.name ? agent.name : id;
}

function agentStatusLabel(status, compact = false) {
  if (status === 'quiet') return compact ? 'No updates' : 'No recent activity';
  if (!status) return compact ? '' : 'Idle';
  return compact ? status : status[0].toUpperCase() + status.slice(1);
}

function syncAgentViewToolbars(agentId = null) {
  document.querySelectorAll('.agent-view-toolbar').forEach(toolbar => {
    const id = toolbar.dataset.agentId;
    if (agentId && id !== agentId) return;
    const agent = state.agents.find(entry => entry.id === id);
    const title = toolbar.querySelector('.agent-view-title strong');
    if (title) { title.textContent = agentDisplayName(id); title.title = id; }
    const halted = !!agent?.halted;
    const view = agentActivityView(id);
    const status = toolbar.querySelector('.agent-runtime-status');
    if (status) {
      status.className = `agent-runtime-status ${view.status || 'idle'}`;
      status.textContent = agentStatusLabel(view.status);
      status.title = view.status === 'quiet' ? 'Still running; no agent activity for over 2 minutes.' : '';
    }
    const lastActivity = toolbar.querySelector('.agent-last-activity');
    if (lastActivity) lastActivity.textContent = view.detail;
    const halt = toolbar.querySelector('[data-agent-action="halt"]');
    const resume = toolbar.querySelector('[data-agent-action="resume"]');
    if (halt) halt.disabled = halted;
    if (resume) resume.disabled = !halted;
    toolbar.querySelector('.agent-actions')?.classList.toggle('halted', halted);
  });
}

function createAgentViewToolbar(agentId) {
  const toolbar = document.createElement('div');
  toolbar.className = 'agent-view-toolbar';
  toolbar.dataset.agentId = agentId;
  const resetLabel = agentId === 'glados' ? 'Reset SDK conversations' : 'Reset SDK conversation';
  const label = agentDisplayName(agentId);
  const role = agentId === 'glados' ? 'Coordinator' : state.agents.find(agent => agent.id === agentId)?.teamCoordinator ? 'Agent team' : 'Specialist agent';
  const avatar = agentId === 'glados'
    ? '<img class="agent-avatar glados-avatar" src="/assets/glados-logo.png" alt="" />'
    : `<span class="agent-avatar" aria-hidden="true">${escapeHtml(label.slice(0, 1).toUpperCase())}</span>`;
  toolbar.innerHTML = `
    <div class="agent-view-identity">
      ${avatar}
      <span class="agent-view-title"><strong title="${escapeHtml(agentId)}">${escapeHtml(label)}</strong><small>${role}</small></span>
      <span class="agent-runtime-status idle">Idle</span>
    </div>
    <span class="agent-last-activity" aria-live="off"></span>
    <details class="agent-actions">
      <summary>Actions</summary>
      <div class="agent-actions-menu" role="menu" aria-label="${escapeHtml(agentId)} actions">
        <button type="button" class="danger" data-agent-action="halt" role="menuitem">Halt agent</button>
        <button type="button" data-agent-action="resume" role="menuitem">Resume agent</button>
        <div class="agent-actions-separator"></div>
        <button type="button" data-agent-action="reset" role="menuitem">${resetLabel}</button>
      </div>
    </details>`;
  const details = toolbar.querySelector('.agent-actions');
  toolbar.querySelector('[data-agent-action="halt"]').addEventListener('click', async () => {
    details.open = false;
    await handleHaltAgent(agentId);
  });
  toolbar.querySelector('[data-agent-action="resume"]').addEventListener('click', async () => {
    details.open = false;
    await handleResumeAgent(agentId);
  });
  toolbar.querySelector('[data-agent-action="reset"]').addEventListener('click', async () => {
    details.open = false;
    await handleResetAgentSession(agentId);
  });
  return toolbar;
}

document.addEventListener('click', event => {
  document.querySelectorAll('details.agent-actions[open]').forEach(details => {
    if (!details.contains(event.target)) details.open = false;
  });
});

async function fetchJson(url, { timeoutMs = 10000, retries = 0, ...options } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      return json;
    } catch (e) {
      lastError = e?.name === 'AbortError'
        ? new Error(`timed out loading ${url}`)
        : e;
      if (attempt >= retries) throw lastError;
      // Yield before retrying so a transcript burst cannot monopolize the UI
      // task queue and immediately starve the replacement request as well.
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`failed loading ${url}`);
}

async function handleHaltAgent(agentId) {
  try {
    const result = await fetchJson(withSession('/api/halt/' + encodeURIComponent(agentId)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: `operator halt from ${agentId} agent view` }),
    });
    setAgentHaltedState(agentId, true);
    logEvent('ended', `halted ${agentId}${result.interruptedParent ? `; interrupted ${result.interruptedParent}` : ''}`);
    showToast(`${agentId} was halted. GLaDOS has been notified.`, { kind: 'warning', label: 'Agent halted' });
  } catch (error) {
    pushNotification('error', `Could not halt ${agentId}: ${error.message}`, { toast: true, label: 'Halt failed' });
  }
}

async function handleResumeAgent(agentId) {
  try {
    const result = await fetchJson(withSession('/api/resume/' + encodeURIComponent(agentId)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    setAgentHaltedState(agentId, false);
    logEvent('started', `resumed ${agentId}${result.continuationScheduled ? '; saved work queued through GLaDOS' : ''}`);
    showToast(`${agentId} resumed${result.continuationScheduled ? ' and its saved task was queued through GLaDOS' : ''}.`, { kind: 'success', label: 'Agent resumed' });
  } catch (error) {
    pushNotification('error', `Could not resume ${agentId}: ${error.message}`, { toast: true, label: 'Resume failed' });
  }
}

let lastRuntimeSurfaceRefresh = null;

function applyRuntimeSurfaceRefresh(info = {}) {
  if (info.refreshId && info.refreshId === lastRuntimeSurfaceRefresh) return;
  if (info.refreshId) lastRuntimeSurfaceRefresh = info.refreshId;
  if (info.proxyReset) clearProxyClientState();
  if (info.plansReset || info.blackboardReset) clearPlanClientState();
  const kind = state.openTabs.find(tab => tab.id === state.currentTab)?.kind;
  if ((info.proxyReset && kind === 'proxy')
      || ((info.plansReset || info.blackboardReset) && kind === 'plans')
      || (info.blackboardReset && kind === 'overview')) renderPane();
  if (info.plansReset) refreshPlansBadge();
}

async function handleRefreshRuntime() {
  if (!await confirmAction({
    title: 'Refresh runtime',
    message: 'Refresh local Agent SDK and proxy processes? Investigation sessions, blackboard data, transcripts, plans, evidence, reports, and proxy history are preserved.',
    confirmLabel: 'Refresh runtime',
    danger: true,
  })) return;
  const btn = document.getElementById('refresh-runtime');
  const orig = btn?.textContent || 'Refresh runtime';
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
  try {
    const r = await fetch('/api/gateway/restart', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'refresh failed');
    applyRuntimeSurfaceRefresh(j);
    if (btn) {
      btn.textContent = 'Refreshed';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
  } catch (e) {
    pushNotification('error', 'Runtime refresh failed: ' + e.message, { toast: true, label: 'Runtime' });
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

async function handleResetAgentSession(agentId) {
  const tabId = tabIdForAgent(agentId);
  const resetLabel = agentId === 'glados' ? 'Reset SDK conversations' : 'Reset SDK conversation';
  const resetMsg = agentId === 'glados'
    ? 'Start fresh Agent SDK conversations for this investigation session? Existing transcript history, blackboard findings, plans, evidence, reports, and all other investigation sessions are preserved.'
    : `Start a fresh Agent SDK conversation for "${agentId}"? Existing transcript history and investigation data are preserved.`;
  if (!await confirmAction({ title: resetLabel, message: resetMsg, confirmLabel: resetLabel, danger: true })) return;
  try {
    const r = await fetch(withSession(`/api/agents/${encodeURIComponent(agentId)}/reset-session`), { method: 'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'reset failed');
    const rec = state.transcripts.get(tabId);
    if (rec) {
      try { rec.es && rec.es.close(); } catch {}
      state.transcripts.delete(tabId);
    }
    renderPane();
  } catch (e) { pushNotification('error', 'Reset failed: ' + e.message, { toast: true, label: agentId }); }
}

function wireOperationControls(root = document) {
  root.querySelector('#update-app')?.addEventListener('click', () => openUpdatePane({ autoStart: true }));
  root.querySelector('#refresh-runtime')?.addEventListener('click', handleRefreshRuntime);
}

async function loadAgents() {
  const sessionId = state.currentSessionId;
  const generation = state.sessionGeneration;
  const res = await fetch(withSession('/api/agents'));
  const j = await res.json();
  if (generation !== state.sessionGeneration || sessionId !== state.currentSessionId) return false;
  const previouslyActive = new Set(state.active.keys());
  state.agents = j.agents || [];
  const rosterIds = rosterAgentIds();
  const removedTabs = state.openTabs.filter(tab => tab.kind === 'agent' && (!rosterIds.has(tab.id) || tab.id === activeCoordinatorId()));
  const removedCurrentTab = removedTabs.some(tab => tab.id === state.currentTab);
  for (const tab of removedTabs) clearTranscriptTab(tab.id);
  state.openTabs = state.openTabs.filter(tab => !removedTabs.includes(tab));
  if (removedCurrentTab) state.currentTab = 'glados-chat';
  state.active.clear();
  for (const a of state.agents) {
    if (a.active) {
      state.active.set(a.id, { sessionId: a.session?.sessionId });
      if (state.agentActivity.get(a.id)?.status !== 'running') noteAgentActivity(a.id, 'Detected active', { startedAt: a.session?.startedAt });
    }
  }
  for (const id of previouslyActive) {
    if (!state.active.has(id)) noteAgentActivity(id, 'Session finished', { status: 'done' });
  }
  for (const a of state.agents) {
    if (!a.active || a.id === activeCoordinatorId()) continue;
    if (state.openTabs.find(t => t.id === a.id)) continue;
    // If the lobby SSE missed session-started, polling still creates the live
    // agent's tab. Durable transcript backfill catches it up when opened.
    if (!state.agentsLoadedOnce || !previouslyActive.has(a.id)) ensureAgentTab(a.id);
  }
  state.agentsLoadedOnce = true;
  for (const tab of state.openTabs) if (tab.kind === 'agent') tab.label = agentDisplayName(tab.id);
  renderTabs();
  renderAgentList();
  syncAgentViewToolbars();
  syncPackageInvocationControls();
  if (removedCurrentTab) { updateWorkspaceNav(); renderPane(); persistWorkspaceState(); }
  return true;
}

function activityTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function noteAgentActivity(agentId, detail, { status = 'running', startedAt = null, at = Date.now() } = {}) {
  if (!agentId) return;
  const previous = state.agentActivity.get(agentId) || {};
  const eventTime = activityTime(at) || Date.now();
  if (previous.lastAt && eventTime < previous.lastAt) return;
  state.agentActivity.set(agentId, {
    status,
    detail,
    lastAt: eventTime,
    startedAt: activityTime(startedAt) || (status === 'running'
      ? (previous.status === 'running' ? previous.startedAt || eventTime : eventTime)
      : previous.startedAt || null),
  });
}

function agentActivityView(agentId) {
  const agent = state.agents.find(item => item.id === agentId);
  const record = state.agentActivity.get(agentId);
  const running = state.active.has(agentId);
  const elapsed = record?.lastAt ? formatElapsed(Date.now() - record.lastAt) : null;
  const last = record?.detail ? `${record.detail}${elapsed ? ` · ${elapsed} ago` : ''}` : '';
  if (agent?.halted) return { status: 'halted', detail: last || 'Needs attention' };
  if (running) {
    const quiet = record?.lastAt && Date.now() - record.lastAt > 120_000;
    const age = record?.startedAt ? formatElapsed(Date.now() - record.startedAt) : '';
    return { status: quiet ? 'quiet' : 'running', detail: last || (age ? `Active for ${age}` : 'Working') };
  }
  if (record?.status === 'done') return { status: 'done', detail: '' };
  return { status: '', detail: '' };
}

function updateAgentActivityTimes() {
  document.querySelectorAll('#agent-list li[data-id]').forEach(row => {
    const view = agentActivityView(row.dataset.id);
    const stateElement = row.querySelector('.agent-row-state');
    const detailElement = row.querySelector('.agent-row-last');
    if (stateElement) stateElement.textContent = agentStatusLabel(view.status, true);
    if (detailElement) detailElement.textContent = view.detail;
    row.classList.toggle('quiet', view.status === 'quiet');
    row.title = view.status === 'quiet'
      ? `${row.dataset.id}: still running; no agent activity for over 2 minutes. ${view.detail}`
      : (view.detail ? `${row.dataset.id}: ${view.status || 'available'} · ${view.detail}` : row.dataset.id);
  });
  document.querySelectorAll('.agent-view-toolbar').forEach(toolbar => {
    const view = agentActivityView(toolbar.dataset.agentId);
    const status = toolbar.querySelector('.agent-runtime-status');
    if (status) {
      status.className = `agent-runtime-status ${view.status || 'idle'}`;
      status.textContent = agentStatusLabel(view.status);
      status.title = view.status === 'quiet' ? 'Still running; no agent activity for over 2 minutes.' : '';
    }
    const detail = toolbar.querySelector('.agent-last-activity');
    if (detail) detail.textContent = view.detail;
  });
}

let agentActivityRefreshTimer = null;
function scheduleAgentActivityRefresh() {
  if (agentActivityRefreshTimer) return;
  agentActivityRefreshTimer = setTimeout(() => {
    agentActivityRefreshTimer = null;
    renderAgentList();
    syncAgentViewToolbars();
  }, 350);
}


function agentMatchesSidebarFilter(agent, filter) {
  if (filter === 'custom') return !!agent.packageId || String(agent.id).startsWith('pkg-');
  if (filter === 'halted') return !!agent.halted;
  return true;
}

function renderAgentList() {
  agentListEl.innerHTML = '';
  const query = state.agentQuery.trim().toLowerCase();
  const filtered = state.agents.filter(a => {
    if (a.id === activeCoordinatorId()) return false;
    if (query && !`${a.id} ${a.name || ''} ${a.model || ''}`.toLowerCase().includes(query)) return false;
    if (!agentMatchesSidebarFilter(a, state.agentFilter)) return false;
    return true;
  });
  const groups = [
    ['Needs attention', filtered.filter(a => a.halted)],
    ['Running', filtered.filter(a => state.active.has(a.id) && !a.halted)],
    ['Recent', filtered.filter(a => !state.active.has(a.id) && !a.halted && state.agentActivity.get(a.id)?.status === 'done')],
    ['Available', filtered.filter(a => !state.active.has(a.id) && !a.halted && state.agentActivity.get(a.id)?.status !== 'done')],
  ];
  for (const [label, agents] of groups) {
    if (!agents.length) continue;
    const group = document.createElement('li');
    group.className = 'agent-group-label';
    group.innerHTML = `<span>${label}</span><span>${agents.length}</span>`;
    agentListEl.appendChild(group);
    for (const a of agents) {
    const li = document.createElement('li');
    li.dataset.id = a.id;
    li.tabIndex = 0;
    li.className = (state.active.has(a.id) ? 'live ' : '') + (a.halted ? 'halted ' : '') + (state.currentTab === a.id ? 'active ' : '');
    const activity = agentActivityView(a.id);
    li.classList.toggle('quiet', activity.status === 'quiet');
    if (activity.status === 'quiet') li.title = `${a.id}: still running; no agent activity for over 2 minutes. ${activity.detail}`;
    li.innerHTML = `<span class="dot"></span><span class="agent-row-main"><span class="name">${escapeHtml(agentDisplayName(a))}</span><small class="agent-row-model">${escapeHtml(a.model || a.name || 'Ready')}</small><small class="agent-row-last">${escapeHtml(activity.detail)}</small></span>` +
      `<span class="agent-row-state">${escapeHtml(agentStatusLabel(activity.status, true))}</span>`;
    li.addEventListener('click', () => openAgentTab(a.id));
    li.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') openAgentTab(a.id); });
    agentListEl.appendChild(li);
    }
  }
  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'agent-list-empty';
    empty.textContent = query ? 'No matching agents' : 'No agents in this view';
    agentListEl.appendChild(empty);
  }
  syncAgentViewToolbars();
  updateAgentActivityTimes();
}

function parseUtcTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

function securityReviewElapsed(job, now = Date.now()) {
  const started = parseUtcTimestamp(job.started_at);
  if (!started) return null;
  const finished = parseUtcTimestamp(job.finished_at);
  return Math.max(0, (finished || now) - started);
}

function updateSecurityReviewTimes() {
  document.querySelectorAll('[data-security-review-started]').forEach(element => {
    const started = parseUtcTimestamp(element.dataset.securityReviewStarted);
    if (!started) return;
    element.textContent = formatElapsed(Date.now() - started);
  });
}

function renderSecurityReviews() {
  if (!securityReviewsEl || !securityReviewListEl) return;
  const reviews = state.securityReviews || [];
  securityReviewsEl.classList.toggle('hidden', reviews.length === 0);
  const count = document.getElementById('security-review-count');
  if (count) count.textContent = String(reviews.length);
  securityReviewListEl.innerHTML = reviews.map(job => {
    const progress = job.progress || {};
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const started = job.started_at || '';
    const elapsed = securityReviewElapsed(job);
    const target = String(job.target || 'repository').split(/[\\/]/).filter(Boolean).at(-1) || 'repository';
    return `<article class="security-review-card ${escapeHtml(job.status || 'queued')}" data-security-review-id="${escapeHtml(job.id)}">
      <div class="security-review-card-head"><strong title="${escapeHtml(job.target || '')}">${escapeHtml(target)}</strong><span>${escapeHtml(job.status || 'queued')}</span></div>
      <div class="security-review-phase"><span>${escapeHtml(progress.phase || 'Initializing')}</span><time ${started ? `data-security-review-started="${escapeHtml(started)}"` : ''}>${elapsed == null ? 'not started' : formatElapsed(elapsed)}</time></div>
      <div class="security-review-progress" role="progressbar" aria-label="${escapeHtml(target)} security review progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
      <p>${escapeHtml(progress.detail || '')}</p>
    </article>`;
  }).join('');
  securityReviewListEl.querySelectorAll('.security-review-card').forEach(card => {
    card.addEventListener('click', openGladosChat);
  });
  updateSecurityReviewTimes();
}

const securityReviewLoads = new Map();
async function loadSecurityReviews() {
  const sessionId = state.currentSessionId;
  const generation = state.sessionGeneration;
  if (!sessionId) return false;
  securityReviewLoads.get(sessionId)?.abort();
  const controller = new AbortController();
  securityReviewLoads.set(sessionId, controller);
  try {
    const response = await fetch(`/api/controller/status?session_id=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || 'could not load security reviews');
    if (generation !== state.sessionGeneration || sessionId !== state.currentSessionId) return false;
    state.securityReviews = body.securityReviews || [];
    renderSecurityReviews();
    return true;
  } catch {}
  finally { if (securityReviewLoads.get(sessionId) === controller) securityReviewLoads.delete(sessionId); }
}

function openOverview() {
  const id = 'overview';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.unshift({ id, kind: 'overview', label: 'Overview' });
  setCurrentTab(id);
}

function openGladosChat() {
  const id = 'glados-chat';
  if (!state.openTabs.find(t => t.id === id)) {
    state.openTabs.unshift({ id, kind: 'chat', label: 'Chat' });
  }
  setCurrentTab(id);
}

function openAgentTab(agentId) {
  if (agentId === activeCoordinatorId()) {
    openGladosChat();
    return;
  }
  if (!state.agents.some(agent => agent.id === agentId)) { showToast('Add this agent to the selected team before opening its conversation.', { kind: 'info', label: 'Agents' }); return; }
  ensureAgentTab(agentId);
  setCurrentTab(agentId);
}

// Runtime events may create a work tab, but must never steal focus from an
// operator reading Overview, Reports, Proxy, or another agent transcript.
function ensureAgentTab(agentId) {
  if (!agentId || agentId === activeCoordinatorId() || !state.agents.some(agent => agent.id === agentId) || state.openTabs.find(t => t.id === agentId)) return;
  state.openTabs.push({ id: agentId, kind: 'agent', label: agentDisplayName(agentId) });
  renderTabs();
  persistWorkspaceState();
}

function closeTab(id) {
  state.openTabs = state.openTabs.filter(t => t.id !== id);
  const rec = state.transcripts.get(id);
  if (rec?.es) rec.es.close();
  state.transcripts.delete(id);
  if (state.currentTab === id) {
    state.currentTab = state.openTabs[0]?.id || null;
  }
  renderTabs();
  renderPane();
  persistWorkspaceState();
}

function tabIdForAgent(agentId) {
  return agentId === activeCoordinatorId() ? 'glados-chat' : agentId;
}

function clearTranscriptTab(tabId) {
  const rec = state.transcripts.get(tabId);
  if (rec?.es) {
    try { rec.es.close(); } catch {}
  }
  state.transcripts.delete(tabId);
  if (rec?.el) rec.el.innerHTML = '';
}

function clearRuntimeTranscriptState(agentIds = []) {
  const ids = agentIds.length ? agentIds.map(tabIdForAgent) : [...state.transcripts].filter(([, rec]) => !rec.independentSession).map(([id]) => id);
  for (const id of ids) clearTranscriptTab(id);
  state.active.clear();
  for (const tab of state.openTabs) {
    const rec = state.transcripts.get(tab.id);
    if (rec) {
      rec.sending = false;
      rec.activity = null;
      rec.turnStartedAt = null;
      rec.completedAt = null;
    }
  }
  renderAgentList();
  renderPane();
}

function setCurrentTab(id) {
  state.currentTab = id;
  renderTabs();
  renderAgentList();
  updateWorkspaceNav();
  renderPane();
  persistWorkspaceState();
}

function updateWorkspaceNav() {
  const mapping = {
    'glados-chat': 'open-glados',
    plans: 'open-plans',
    reports: 'open-reports',
    terminal: 'open-terminal',
    proxy: 'open-proxy',
    'agent-library': 'open-agent-library',
    clippy: 'open-clippy',
    connectors: 'open-connectors',
    settings: 'open-settings',
  };
  document.querySelectorAll('.workspace-links a').forEach(link => { link.classList.remove('nav-active'); link.removeAttribute('aria-current'); });
  const proxyTab = state.openTabs.find(tab => tab.id === state.currentTab)?.kind === 'proxy';
  const selectedLink = document.getElementById(proxyTab ? 'open-proxy' : mapping[state.currentTab]);
  selectedLink?.classList.add('nav-active');
  selectedLink?.setAttribute('aria-current', 'page');
  document.getElementById('workspace-tools')?.classList.toggle('nav-active', proxyTab || ['agent-library', 'clippy', 'connectors', 'reports', 'terminal'].includes(state.currentTab));
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of state.openTabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (state.currentTab === t.id ? ' active' : '');
    // Chat stays first; the remaining workspace tabs can be closed.
    const closable = t.kind !== 'chat';
    const label = t.kind === 'agent' ? agentDisplayName(t.id) : t.label;
    if (t.kind === 'agent') el.title = t.id;
    el.innerHTML = `<span class="label">${escapeHtml(label)}</span>` +
      (closable ? `<span class="close" data-close="${t.id}">×</span>` : '');
    el.addEventListener('click', async ev => {
      if (ev.target.dataset.close) {
        ev.stopPropagation();
        closeTab(t.id);
      } else {
        try {
          if (t.kind === 'proxy' && t.sessionId !== state.currentSessionId) {
            await activateInvestigationSession(t.sessionId);
            if (state.currentSessionId !== t.sessionId) return;
          }
          setCurrentTab(t.id);
        } catch (error) {
          showToast(error.message, { kind: 'error', label: 'Proxy' });
        }
      }
    });
    tabsEl.appendChild(el);
  }
}

function openReports() {
  const id = 'reports';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'reports', label: 'Reports' });
  setCurrentTab(id);
}

function openPlans() {
  const id = 'plans';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'plans', label: 'Plans' });
  setCurrentTab(id);
}

function openSettings() {
  const id = 'settings';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'settings', label: 'Settings' });
  setCurrentTab(id);
}

function openAgentsLibrary() {
  const id = 'agent-library';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'agent-library', label: 'Agents' });
  setCurrentTab(id);
}

function openConnectors() {
  const id = 'connectors';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'connectors', label: 'Connectors' });
  setCurrentTab(id);
}

function openTerminal() {
  const id = 'terminal';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'terminal', label: 'Terminal' });
  setCurrentTab(id);
}

async function openProxy(options = {}) {
  try {
    const sessionId = options.sessionId || state.currentSessionId || await materializeDraftSession();
    if (!sessionId) return;
    const session = state.investigationSessions.find(item => item.id === sessionId);
    const id = `proxy:${sessionId}`;
    if (!state.openTabs.some(tab => tab.id === id)) {
      state.openTabs.push({ id, kind: 'proxy', sessionId, sessionName: session?.name || sessionId, label: `Proxy · ${session?.name || 'Session'}` });
    }
    setCurrentTab(id);
  } catch (error) {
    showToast(error.message, { kind: 'error', label: 'Proxy' });
  }
}

function openUpdatePane({ autoStart = false } = {}) {
  const id = 'update';
  state.update.autoStart = autoStart;
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'update', label: 'Update' });
  setCurrentTab(id);
}

function renderPane() {
  disposeClippyPane();
  GladosProxyWorkspace.dispose();
  paneEl.innerHTML = '';
  const id = state.currentTab;
  if (!id) {
    paneEl.innerHTML = '<div class="pane-empty">Open Chat to start a conversation.</div>';
    return;
  }
  const tab = state.openTabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.kind === 'overview') renderOverviewPane();
  else if (tab.kind === 'chat') renderChatPane();
  else if (tab.kind === 'plans') renderPlansPane();
  else if (tab.kind === 'reports') renderReportsPane();
  else if (tab.kind === 'sessions') renderSessionsPane();
  else if (tab.kind === 'settings') renderSettingsPane();
  else if (tab.kind === 'agent-library') renderAgentsLibraryPane();
  else if (tab.kind === 'clippy') renderClippyPane();
  else if (tab.kind === 'connectors') renderConnectorsPane();
  else if (tab.kind === 'terminal') renderTerminalPane();
  else if (tab.kind === 'proxy') renderProxyPane();
  else if (tab.kind === 'update') renderUpdatePane();
  else renderAgentPane(id);
}

function overviewScopeText(scope) {
  if (!scope) return 'No explicit scope is recorded yet.';
  if (typeof scope === 'string') return scope;
  const included = scope.include || scope.in_scope || scope.targets || scope.allowed || [];
  const excluded = scope.exclude || scope.out_of_scope || scope.denied || [];
  const parts = [];
  if (included.length) parts.push(`In scope: ${included.join(', ')}`);
  if (excluded.length) parts.push(`Excluded: ${excluded.join(', ')}`);
  return parts.join('\n') || JSON.stringify(scope, null, 2);
}

function overviewStatusClass(value) {
  const text = String(value || '').toLowerCase();
  if (/halt|fail|critical|offline|unhealthy/.test(text)) return 'danger';
  if (/pending|await|stale|approval/.test(text)) return 'warning';
  if (/active|running|healthy|execution|complete/.test(text)) return 'success';
  return 'neutral';
}

function overviewProgress(tasks = {}) {
  const total = Number(tasks.total) || 0;
  const terminal = (Number(tasks.complete) || 0) + (Number(tasks.failed) || 0) + (Number(tasks.cancelled) || 0);
  return {
    total,
    terminal,
    percent: total > 0 ? Math.min(100, Math.round((terminal / total) * 100)) : 0,
  };
}

function renderOverviewFindings(findings = []) {
  if (!findings.length) return '<div class="overview-empty">No findings have been recorded for this engagement.</div>';
  return `<div class="overview-finding-list">${findings.map(finding => `
    <button type="button" class="overview-finding-row" data-overview-reports title="Open reports">
      <span class="finding-rank ${overviewStatusClass(finding.severity)}">${escapeHtml(finding.severity || 'info')}</span>
      <span class="finding-copy"><strong>${escapeHtml(finding.title || `Finding #${finding.id}`)}</strong><small>${escapeHtml([finding.cwe, finding.component].filter(Boolean).join(' · '))}</small></span>
      <span class="finding-score">${finding.cvss == null ? '—' : escapeHtml(Number(finding.cvss).toFixed(1))}<small>${escapeHtml(finding.validationStatus || 'pending')}</small></span>
    </button>`).join('')}</div>`;
}

function renderOverviewPlan(plan) {
  if (!plan) return '<div class="overview-empty">No plan has been synthesized yet.</div>';
  const vectors = plan.vectors || [];
  return `<div class="overview-plan-card">
    <div class="overview-plan-meta"><span class="status-chip ${overviewStatusClass(plan.state)}">${escapeHtml(plan.state?.replaceAll('_', ' ') || 'unknown')}</span><strong>Plan v${escapeHtml(plan.version)}</strong></div>
    <p>${escapeHtml(plan.objective || 'Review the approved vectors and current evidence.')}</p>
    ${vectors.length ? `<div class="overview-plan-vectors">${vectors.map(vector => `<span>${escapeHtml(vector.cwe || 'Vector')} · ${escapeHtml(vector.risk || 'risk pending')}</span>`).join('')}</div>` : ''}
    ${plan.agentChain?.length ? `<small>Agent chain: ${escapeHtml(plan.agentChain.join(' → '))}</small>` : ''}
    <button type="button" data-overview-plans>Open plan</button>
  </div>`;
}

function renderOverviewProgress(tasks = {}, phase = 'Standby') {
  const progress = overviewProgress(tasks);
  return `<div class="overview-progress-card">
    <div class="overview-progress-value"><strong>${progress.percent}%</strong><span>${escapeHtml(phase)}</span></div>
    <div class="overview-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}"><span style="width:${progress.percent}%"></span></div>
    <p>${progress.terminal} of ${progress.total} tracked tasks are terminal.</p>
    <div class="overview-progress-breakdown">
      <span><strong>${Number(tasks.complete) || 0}</strong> complete</span>
      <span><strong>${Number(tasks.running) || 0}</strong> running</span>
      <span><strong>${Number(tasks.pending) || 0}</strong> pending</span>
      <span><strong>${Number(tasks.failed) || 0}</strong> failed</span>
      <span><strong>${Number(tasks.cancelled) || 0}</strong> cancelled</span>
    </div>
  </div>`;
}

function formatUsageCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function formatUsageNumber(value) {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

function formatUsageInteger(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function usageMetricValue(model, metric) {
  if (metric === 'tokens') return Number(model.totalTokens) || 0;
  if (metric === 'requests') return Number(model.requests) || 0;
  return Number(model.spend) || 0;
}

function formatUsageMetric(value, metric) {
  if (metric === 'spend') return formatUsageCurrency(value);
  if (metric === 'requests') return `${formatUsageInteger(value)} req`;
  return `${formatUsageNumber(value)} tokens`;
}

function renderUsageModelRows(usage, metric = 'spend') {
  const models = [...(usage?.models || [])].sort((a, b) => usageMetricValue(b, metric) - usageMetricValue(a, metric));
  const total = metric === 'tokens'
    ? Number(usage?.totals?.totalTokens) || 0
    : metric === 'requests'
      ? Number(usage?.totals?.requests) || 0
      : Number(usage?.totals?.spend) || 0;
  if (!models.length) return '<div class="overview-empty">No model activity was recorded in this window.</div>';
  return models.map(model => {
    const value = usageMetricValue(model, metric);
    const share = total > 0 ? value / total : 0;
    const width = value > 0 ? Math.max(1, Math.min(100, share * 100)) : 0;
    return `<div class="usage-model-row">
      <div class="usage-model-label"><strong>${escapeHtml(model.name)}</strong><small>${formatUsageMetric(value, metric)} · ${(share * 100).toFixed(1)}%</small></div>
      <div class="usage-bar" aria-label="${escapeHtml(model.name)} ${(share * 100).toFixed(1)} percent"><span style="width:${width.toFixed(2)}%"></span></div>
    </div>`;
  }).join('');
}

function renderLiteLlmUsage(usage, metric = 'spend') {
  const selectedPeriod = usage?.period?.days === 1 ? 'daily' : 'weekly';
  if (!usage?.available && !usage?.sdkObserved) {
    return `<section class="overview-section overview-usage">
      <div class="overview-section-head"><div><h2>LLM usage</h2><p>Configured virtual key only</p></div><span class="status-chip warning">Unavailable</span></div>
      <div class="usage-unavailable"><strong>Usage metrics unavailable</strong><span>${escapeHtml(usage?.message || 'No reporting data is available.')}</span></div>
      </section>`;
  }
  if (!usage?.available && usage?.sdkObserved) {
    const observed = usage.sdkObserved.totals || {};
    return `<section class="overview-section overview-usage"><div class="overview-section-head"><div><h2>LLM usage</h2><p>Local provisional Agent SDK totals</p></div><span class="status-chip warning">LiteLLM unavailable</span></div><div class="overview-usage-summary"><div><span>GLaDOS observed</span><strong>${formatUsageCurrency(observed.costUsd || 0)}</strong><small>Provisional SDK cost · ${formatUsageInteger(observed.completedTurns || 0)} completed turns</small></div><div><span>Tokens</span><strong>${formatUsageNumber(observed.totalTokens || 0)}</strong><small>Local terminal SDK usage</small></div></div></section>`;
  }
  const totals = usage.totals || {};
  const sdkObserved = usage.sdkObserved?.totals || {};
  const daily = usage.daily || [];
  const maxDailySpend = Math.max(0, ...daily.map(day => Number(day.spend) || 0));
  const failureRate = totals.requests > 0 ? (totals.failedRequests / totals.requests) * 100 : 0;
  const fetchedAt = usage.fetchedAt ? new Date(usage.fetchedAt).toLocaleTimeString() : 'just now';
  const budget = usage.budget || {};
  const budgetSpend = Number(daily.at(-1)?.spend || 0);
  const budgetPercent = Number(budget.max) > 0 ? Math.min(100, (budgetSpend / Number(budget.max)) * 100) : 0;
  const windowLabel = selectedPeriod === 'daily' ? 'Today' : 'Seven days';
  return `<section class="overview-section overview-usage">
    <div class="overview-section-head">
      <div><h2>LLM usage</h2><p>${escapeHtml(usage.keyAlias || 'Configured key')} · ${escapeHtml(usage.period?.startDate || '')}${selectedPeriod === 'weekly' ? ` to ${escapeHtml(usage.period?.endDate || '')}` : ''}</p></div>
      <div class="usage-period-controls"><div class="usage-segments" role="group" aria-label="Usage period"><button type="button" data-usage-period="daily" class="${selectedPeriod === 'daily' ? 'active' : ''}">Daily</button><button type="button" data-usage-period="weekly" class="${selectedPeriod === 'weekly' ? 'active' : ''}">Weekly</button></div><span class="overview-updated">Synced ${escapeHtml(fetchedAt)}</span></div>
    </div>
    <div class="overview-usage-summary">
      <div><span>LiteLLM posted</span><strong>${formatUsageCurrency(totals.spend)}</strong><small>${windowLabel} · this key only</small></div>
      <div><span>GLaDOS observed</span><strong>${formatUsageCurrency(sdkObserved.costUsd || 0)}</strong><small>Provisional SDK cost · ${formatUsageInteger(sdkObserved.completedTurns || 0)} completed turn${Number(sdkObserved.completedTurns) === 1 ? '' : 's'}</small></div>
      <div><span>Tokens</span><strong>${formatUsageNumber(totals.totalTokens)}</strong><small>${formatUsageNumber(totals.promptTokens)} input · ${formatUsageNumber(totals.completionTokens)} output</small></div>
      <div><span>Requests</span><strong>${formatUsageInteger(totals.requests)}</strong><small>${formatUsageInteger(totals.successfulRequests)} successful · ${formatUsageInteger(totals.failedRequests)} failed (${failureRate.toFixed(1)}%)</small></div>
    </div>
    <div class="overview-usage-body">
      <div class="usage-daily">
        <div class="usage-subhead"><strong>Daily spend</strong><span>Tokens shown at right</span></div>
        ${daily.map(day => {
          const width = maxDailySpend > 0 ? (Number(day.spend) / maxDailySpend) * 100 : 0;
          const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short' });
          return `<div class="usage-daily-row">
            <span>${escapeHtml(label)}</span>
            <div class="usage-bar"><span style="width:${Math.max(0, width).toFixed(2)}%"></span></div>
            <strong>${formatUsageCurrency(day.spend)}</strong>
            <small>${formatUsageNumber(day.totalTokens)}</small>
          </div>`;
        }).join('')}
      </div>
      <div class="usage-models">
        <div class="usage-subhead"><strong>Virtual-key budget</strong><span>${escapeHtml(usage.keyAlias || '')}</span></div>
        <div class="usage-key-budget">
          <div><span>Daily ceiling</span><strong>${Number(budget.max) > 0 ? formatUsageCurrency(budget.max) : 'Not set'}</strong></div>
          <div class="usage-bar" aria-label="${budgetPercent.toFixed(1)} percent of key budget"><span style="width:${budgetPercent.toFixed(2)}%"></span></div>
          <small>${formatUsageCurrency(budgetSpend)} used in the current ${escapeHtml(budget.duration || 'budget window')} (${budgetPercent.toFixed(1)}%)${budget.resetAt ? ` · resets ${escapeHtml(new Date(budget.resetAt).toLocaleString())}` : ''}</small>
        </div>
      </div>
    </div>
  </section>`;
}

function renderInvestigationSessionManager(sessionHost) {
  if (!sessionHost) return;
  const current = state.investigationSessions.find(session => session.id === state.currentSessionId) || state.investigationSessions[0];
  const sorted = [...state.investigationSessions].sort((a, b) => {
    if (a.id === state.currentSessionId) return -1;
    if (b.id === state.currentSessionId) return 1;
    if (a.state !== b.state) return a.state === 'active' ? -1 : 1;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const pencilIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.8V14h2.2l7.4-7.4-2.2-2.2L3 11.8Zm10.8-6.4a.8.8 0 0 0 0-1.1l-1.1-1.1a.8.8 0 0 0-1.1 0l-.7.7L13.1 6l.7-.6Z"/></svg>';
  const trashIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2.5h5l.5 1.2h2v1.5H3V3.7h2l.5-1.2Zm-1 4h7l-.5 7H5l-.5-7Z"/></svg>';
  sessionHost.innerHTML = `<div class="overview-session-controls">
      <details class="overview-session-menu">
        <summary aria-label="Switch investigation session"><span class="session-state-dot ${current?.state || 'active'}"></span><span><strong>${escapeHtml(current?.name || 'Unassigned session')}</strong><small>${current?.metadata?.unassigned ? 'Ready for your first prompt' : `${current?.engagementCount || 0} engagement${current?.engagementCount === 1 ? '' : 's'}`}</small></span></summary>
        <div class="overview-session-popover">
          <div class="overview-session-popover-head"><div><strong>Sessions</strong><small>Switch, rename, or remove a workspace</small></div></div>
          <div class="overview-session-list">
            ${sorted.map(session => `<div class="overview-session-row${session.id === state.currentSessionId ? ' selected' : ''}">
              <button type="button" class="overview-session-option" data-session-select="${escapeHtml(session.id)}">
                <span class="session-state-dot ${session.state}"></span><span><strong>${escapeHtml(session.name)}</strong><small>${session.state === 'active' ? 'Active' : 'Archived'} · ${new Date(session.updatedAt).toLocaleDateString()} · ${session.engagementCount || 0} engagement${session.engagementCount === 1 ? '' : 's'}</small></span>${session.id === state.currentSessionId ? '<span class="session-current-mark">Open</span>' : ''}
              </button>
              <div class="session-row-actions">
                <button type="button" data-session-rename-id="${escapeHtml(session.id)}" title="Rename ${escapeHtml(session.name)}" aria-label="Rename ${escapeHtml(session.name)}">${pencilIcon}</button>
                <button type="button" class="danger" data-session-delete-id="${escapeHtml(session.id)}" title="Delete ${escapeHtml(session.name)}" aria-label="Delete ${escapeHtml(session.name)}">${trashIcon}</button>
              </div>
            </div>`).join('')}
          </div>
        </div>
      </details>
      <button type="button" class="overview-new-session" data-session-new><span aria-hidden="true">＋</span> New</button>
  </div>`;
  const details = sessionHost.querySelector('details');
  sessionHost.querySelectorAll('[data-session-select]').forEach(button => button.addEventListener('click', async () => {
    details.open = false;
    try { await activateInvestigationSession(button.dataset.sessionSelect); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  }));
  sessionHost.querySelector('[data-session-new]')?.addEventListener('click', async () => {
    details.open = false;
    try { await createInvestigationSession(); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  });
  sessionHost.querySelectorAll('[data-session-rename-id]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    details.open = false;
    const session = state.investigationSessions.find(item => item.id === button.dataset.sessionRenameId);
    if (!session) return;
    const name = await showNameInput({ title: 'Rename session', value: session.name, confirmLabel: 'Save name', label: 'Session name' });
    if (!name) return;
    try { await renameInvestigationSession(session.id, name); renderInvestigationSessionManager(sessionHost); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  }));
  sessionHost.querySelectorAll('[data-session-delete-id]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    const session = state.investigationSessions.find(item => item.id === button.dataset.sessionDeleteId);
    if (!session || !await confirmAction({ title: 'Delete investigation session', message: `Permanently delete "${session.name}", including its database records, transcripts, SDK conversation IDs, and chat attachments? Investigation evidence and exported report files are preserved.`, confirmLabel: 'Delete session', danger: true })) return;
    try {
      details.open = false;
      if (session.id === state.currentSessionId) await deleteInvestigationSession(session.id);
      else {
        const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || 'could not delete investigation');
        state.investigationSessions = body.sessions || [];
        renderInvestigationSessionManager(sessionHost);
      }
    } catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  }));
}

function positionSidebarSessionMenu(menu) {
  if (!menu?.open) return;
  const summary = menu.querySelector(':scope > summary');
  const panel = menu.querySelector(':scope > div');
  if (!summary || !panel) return;
  const gutter = 8;
  const gap = 4;
  const anchor = summary.getBoundingClientRect();
  const width = panel.offsetWidth || 196;
  const height = panel.offsetHeight;
  const left = Math.max(gutter, Math.min(window.innerWidth - width - gutter, anchor.right - width));
  let top = anchor.bottom + gap;
  if (top + height > window.innerHeight - gutter) top = anchor.top - height - gap;
  top = Math.max(gutter, Math.min(window.innerHeight - height - gutter, top));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.dataset.positioned = 'true';
}

function wireSidebarSessionMenus(host) {
  host.querySelectorAll('.sidebar-session-menu').forEach(menu => {
    menu.addEventListener('toggle', () => {
      const panel = menu.querySelector(':scope > div');
      if (!menu.open) {
        panel?.removeAttribute('data-positioned');
        return;
      }
      document.querySelectorAll('.sidebar-session-menu[open]').forEach(other => {
        if (other !== menu) other.open = false;
      });
      requestAnimationFrame(() => positionSidebarSessionMenu(menu));
    });
  });
}

let sidebarMenuPositionFrame = null;
function queueSidebarSessionMenuPosition() {
  if (sidebarMenuPositionFrame != null) return;
  sidebarMenuPositionFrame = requestAnimationFrame(() => {
    sidebarMenuPositionFrame = null;
    document.querySelectorAll('.sidebar-session-menu[open]').forEach(positionSidebarSessionMenu);
  });
}

function sessionActivityTime(session) {
  const value = session.lastActivityAt || session.createdAt || '';
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(utc) || 0;
}

function compareSessionActivity(a, b) {
  return sessionActivityTime(b) - sessionActivityTime(a) || b.id.localeCompare(a.id);
}

function renderInvestigationNavigation() {
  const projectsHost = document.getElementById('projects-section');
  const sessionsHost = document.getElementById('sessions-section');
  if (!projectsHost || !sessionsHost) return;
  const projects = state.investigationProjects || [];
  const sessions = state.investigationSessions || [];
  if (!(state.expandedProjectIds instanceof Set)) state.expandedProjectIds = new Set();
  const folderIcon = '<svg class="sidebar-project-folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.75A1.75 1.75 0 0 1 4.25 4h3.1l1.5 1.65h6.9A1.75 1.75 0 0 1 17.5 7.4v6.35a1.75 1.75 0 0 1-1.75 1.75H4.25a1.75 1.75 0 0 1-1.75-1.75v-8Z"/></svg>';
  const sortedSessions = list => [...list].sort(compareSessionActivity);
  const moveOptions = session => [
    `<option value=""${!session.projectId ? ' selected' : ''}>No project</option>`,
    ...projects.map(project => `<option value="${escapeHtml(project.id)}"${session.projectId === project.id ? ' selected' : ''}>${escapeHtml(project.name)}</option>`),
  ].join('');
  const sessionMarkup = (session, { nested = false } = {}) => {
    const activity = session.runningAgents?.length ? escapeHtml(session.runningAgents.join(', ')) : '';
    const running = session.runningCount > 0;
    const needsReview = !running && state.unreadCompletedSessionIds.has(session.id);
    const indicatorTitle = running
      ? `${session.runningCount} running agent${session.runningCount === 1 ? '' : 's'}`
      : needsReview ? 'Completed — open to review' : 'Idle';
    return `<div class="sidebar-session-row${nested ? ' nested' : ''}${session.id === state.currentSessionId ? ' selected' : ''}" data-session-row="${escapeHtml(session.id)}" draggable="true">
      <button type="button" class="sidebar-session-main" data-session-select="${escapeHtml(session.id)}" title="Open ${escapeHtml(session.name)}">
        <span class="session-run-state${running ? ' running' : needsReview ? ' attention' : ''}" title="${indicatorTitle}"><i></i></span>
        <span><strong>${escapeHtml(session.name)}</strong>${activity ? `<small>${activity}</small>` : ''}</span>
      </button>
      <details class="sidebar-session-menu"><summary aria-label="Session actions" title="Session actions">•••</summary><div>
        <button type="button" data-session-rename-id="${escapeHtml(session.id)}">Rename</button>
        <label>Move to project<select data-session-project-id="${escapeHtml(session.id)}">${moveOptions(session)}</select></label>
        <button type="button" class="danger" data-session-delete-id="${escapeHtml(session.id)}">Delete</button>
      </div></details>
    </div>`;
  };

  projectsHost.innerHTML = `
    <div class="sidebar-project-list">
      ${projects.map(project => {
        const expanded = state.expandedProjectIds.has(project.id);
        const projectSessions = sortedSessions(sessions.filter(session => session.projectId === project.id));
        return `<div class="sidebar-project-tree${expanded ? ' expanded' : ''}" data-project-id="${escapeHtml(project.id)}">
          <div class="sidebar-project-head">
            <button type="button" class="sidebar-project-row" data-project-toggle="${escapeHtml(project.id)}" data-project-drop="${escapeHtml(project.id)}" aria-expanded="${expanded}" title="${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(project.name)}">
              ${folderIcon}<span>${escapeHtml(project.name)}</span><b>${projectSessions.length}</b><i class="sidebar-project-chevron">›</i>
            </button>
            <details class="sidebar-session-menu sidebar-project-menu"><summary aria-label="Project actions" title="Project actions">•••</summary><div>
              <button type="button" data-project-rename-id="${escapeHtml(project.id)}">Rename</button>
              <button type="button" class="danger" data-project-delete-id="${escapeHtml(project.id)}">Delete</button>
            </div></details>
          </div>
          <div class="sidebar-project-sessions" ${expanded ? '' : 'hidden'}>
            ${projectSessions.slice(0, 3).map(session => sessionMarkup(session, { nested: true })).join('') || '<div class="sidebar-project-empty">Drop sessions here</div>'}
            ${projectSessions.length > 3 ? `<button type="button" class="sidebar-view-all" data-project-sessions="${escapeHtml(project.id)}">View all ${projectSessions.length} sessions</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  document.getElementById('sidebar-project-new').onclick = async event => {
    event.stopPropagation();
    try { await createInvestigationProject(); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Projects' }); }
  };
  document.getElementById('sidebar-project-collapse').onclick = event => {
    event.stopPropagation();
    state.expandedProjectIds.clear();
    persistExpandedProjects();
    renderInvestigationNavigation();
  };
  projectsHost.querySelectorAll('[data-project-sessions]').forEach(button => button.addEventListener('click', () => openSessions(button.dataset.projectSessions)));
  projectsHost.querySelectorAll('[data-project-toggle]').forEach(button => button.addEventListener('click', () => {
    const projectId = button.dataset.projectToggle;
    if (state.expandedProjectIds.has(projectId)) state.expandedProjectIds.delete(projectId);
    else state.expandedProjectIds.add(projectId);
    persistExpandedProjects();
    renderInvestigationNavigation();
  }));
  projectsHost.querySelectorAll('[data-project-rename-id]').forEach(button => button.addEventListener('click', async () => {
    const project = projects.find(item => item.id === button.dataset.projectRenameId);
    if (!project) return;
    const name = await showNameInput({ title: 'Rename project', value: project.name, confirmLabel: 'Save name', label: 'Project name' });
    if (!name) return;
    try { await renameInvestigationProject(project.id, name); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Projects' }); }
  }));
  projectsHost.querySelectorAll('[data-project-delete-id]').forEach(button => button.addEventListener('click', async () => {
    const project = projects.find(item => item.id === button.dataset.projectDeleteId);
    if (!project || !await confirmAction({
      title: 'Delete project',
      message: `Delete "${project.name}"? Its sessions and conversations will be preserved and returned to Sessions.`,
      confirmLabel: 'Delete project',
      danger: true,
    })) return;
    try { await deleteInvestigationProject(project.id); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Projects' }); }
  }));

  const recent = [...sessions].filter(session => !session.metadata?.unassigned || session.engagementCount > 0 || session.runningCount > 0)
    .sort(compareSessionActivity).slice(0, 3);
  sessionsHost.innerHTML = `
    <div class="sidebar-session-list">
      ${recent.map(session => sessionMarkup(session)).join('') || '<div class="sidebar-project-empty">Your conversations will appear here.</div>'}
    </div>`;
  document.getElementById('sidebar-session-new').onclick = async event => {
    event.stopPropagation();
    try { await createInvestigationSession(); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
  };
  document.getElementById('sidebar-sessions-all').onclick = event => { event.stopPropagation(); openSessions(); };
  const navigationHost = [projectsHost, sessionsHost];
  navigationHost.forEach(wireSidebarSessionMenus);
  navigationHost.forEach(host => host.querySelectorAll('[data-session-select]').forEach(button => button.addEventListener('click', async () => {
    try { await activateInvestigationSession(button.dataset.sessionSelect); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
  })));
  navigationHost.forEach(host => host.querySelectorAll('[data-session-rename-id]').forEach(button => button.addEventListener('click', async () => {
    const session = sessions.find(item => item.id === button.dataset.sessionRenameId);
    if (!session) return;
    const name = await showNameInput({ title: 'Rename session', value: session.name, confirmLabel: 'Save name', label: 'Session name' });
    if (!name) return;
    try { await renameInvestigationSession(session.id, name); renderInvestigationNavigation(); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
  })));
  navigationHost.forEach(host => host.querySelectorAll('[data-session-project-id]').forEach(select => select.addEventListener('change', async () => {
    const prior = sessions.find(item => item.id === select.dataset.sessionProjectId)?.projectId || '';
    try { await moveInvestigationSession(select.dataset.sessionProjectId, select.value || null); }
    catch (error) { select.value = prior; pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
  })));
  navigationHost.forEach(host => host.querySelectorAll('[data-session-delete-id]').forEach(button => button.addEventListener('click', async () => {
    try { await confirmDeleteInvestigationSession(sessions.find(session => session.id === button.dataset.sessionDeleteId)); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
  })));

  navigationHost.forEach(host => host.querySelectorAll('[data-session-row]').forEach(row => {
    row.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.sessionRow);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('.session-drop-target').forEach(target => target.classList.remove('session-drop-target'));
    });
  }));
  projectsHost.querySelectorAll('[data-project-drop]').forEach(target => {
    target.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      target.classList.add('session-drop-target');
    });
    target.addEventListener('dragleave', event => {
      if (!target.contains(event.relatedTarget)) target.classList.remove('session-drop-target');
    });
    target.addEventListener('drop', async event => {
      event.preventDefault();
      target.classList.remove('session-drop-target');
      const sessionId = event.dataTransfer.getData('text/plain');
      const projectId = target.dataset.projectDrop;
      if (!sessionId || sessions.find(session => session.id === sessionId)?.projectId === projectId) return;
      try { await moveInvestigationSession(sessionId, projectId); }
      catch (error) { pushNotification('error', error.message, { toast: true, label: 'Projects' }); }
    });
  });
  sessionsHost.ondragover = event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    sessionsHost.classList.add('session-drop-target');
  };
  sessionsHost.ondragleave = event => {
    if (!sessionsHost.contains(event.relatedTarget)) sessionsHost.classList.remove('session-drop-target');
  };
  sessionsHost.ondrop = async event => {
    event.preventDefault();
    sessionsHost.classList.remove('session-drop-target');
    const sessionId = event.dataTransfer.getData('text/plain');
    if (!sessionId || !sessions.find(session => session.id === sessionId)?.projectId) return;
    try { await moveInvestigationSession(sessionId, null); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
  };
}

function persistExpandedProjects() {
  try { localStorage.setItem('glados-dash.expanded-projects.v2', JSON.stringify([...state.expandedProjectIds])); } catch {}
}

function openSessions(projectId = null) {
  state.sessionListProjectId = projectId;
  if (!state.openTabs.some(tab => tab.id === 'sessions')) state.openTabs.push({ id: 'sessions', kind: 'sessions', label: 'Sessions' });
  setCurrentTab('sessions');
}

function renderSessionsPane() {
  const project = state.investigationProjects.find(project => project.id === state.sessionListProjectId);
  const sessions = [...state.investigationSessions]
    .filter(session => !session.metadata?.unassigned || session.engagementCount > 0 || session.runningCount > 0)
    .filter(session => !project || session.projectId === project.id)
    .sort(compareSessionActivity);
  const wrap = document.createElement('div');
  wrap.className = 'sessions-pane';
  const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg>';
  const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
  wrap.innerHTML = `<header><div><h1>${escapeHtml(project?.name || 'Sessions')}</h1><p>${project ? 'Project conversations' : 'All conversations'}</p></div><button type="button" data-new-session>＋ New session</button></header>
    <label class="sessions-search"><span class="sr-only">Search sessions</span><span class="sessions-search-control">${searchIcon}<input type="search" placeholder="Find a conversation…" aria-label="Search sessions" /></span></label>
    <div class="sessions-directory">${sessions.map(session => `<div class="session-directory-row" data-directory-session="${escapeHtml(session.id)}"><button type="button" class="session-directory-open" data-session-select="${escapeHtml(session.id)}"><span><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.projectName || 'No project')}</small></span><span class="session-directory-activity">${session.runningCount > 0 ? 'Working' : formatReportDate(sessionActivityTime(session))}</span></button><button type="button" class="session-directory-delete" data-directory-session-delete="${escapeHtml(session.id)}" aria-label="Delete ${escapeHtml(session.name)}" title="${investigationSessionBusy(session.id) ? 'Finish or stop this session before deleting it' : 'Delete this session'}"${investigationSessionBusy(session.id) ? ' disabled' : ''}>${trashIcon}<span>Delete</span></button></div>`).join('') || '<div class="pane-empty">No sessions yet.</div>'}</div>`;
  paneEl.appendChild(wrap);
  wrap.querySelector('[data-new-session]').onclick = () => createInvestigationSession().catch(error => pushNotification('error', error.message, { toast: true, label: 'Sessions' }));
  wrap.querySelectorAll('[data-session-select]').forEach(button => button.onclick = () => activateInvestigationSession(button.dataset.sessionSelect).catch(error => pushNotification('error', error.message, { toast: true, label: 'Sessions' })));
  wrap.querySelectorAll('[data-directory-session-delete]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await confirmDeleteInvestigationSession(sessions.find(session => session.id === button.dataset.directorySessionDelete)); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Sessions' }); }
    finally { if (button.isConnected) button.disabled = investigationSessionBusy(button.dataset.directorySessionDelete); }
  }));
  wrap.querySelector('input').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    wrap.querySelectorAll('.session-directory-row').forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  });
}

function persistUnreadCompletedSessions() {
  try { localStorage.setItem('glados-dash.unread-completed-sessions', JSON.stringify([...state.unreadCompletedSessionIds])); } catch {}
}

function markSessionSeen(sessionId) {
  if (!sessionId || !state.unreadCompletedSessionIds.delete(sessionId)) return;
  persistUnreadCompletedSessions();
}

function markBackgroundSessionCompleted(sessionId) {
  if (!sessionId || sessionId === state.currentSessionId) return;
  state.unreadCompletedSessionIds.add(sessionId);
  persistUnreadCompletedSessions();
}

let investigationNavigationRefreshTimer = null;
function refreshInvestigationNavigationSoon() {
  clearTimeout(investigationNavigationRefreshTimer);
  investigationNavigationRefreshTimer = setTimeout(() => loadInvestigationSessions().catch(() => {}), 180);
}

function overviewModelGroups(agents = []) {
  const groups = new Map();
  for (const agent of agents) {
    const model = String(agent.model || 'Not assigned');
    const current = groups.get(model) || { model, count: 0, agents: [] };
    current.count += 1;
    current.agents.push(agent.id);
    groups.set(model, current);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

function renderOverviewModelAssignments(agents = []) {
  const groups = overviewModelGroups(agents);
  const total = Math.max(1, agents.length);
  if (!groups.length) return '<div class="overview-empty">No enabled agents are configured.</div>';
  return `<div class="overview-model-list">${groups.map(group => {
    const width = Math.max(4, (group.count / total) * 100);
    return `<button type="button" class="overview-model-row" data-overview-settings title="Configure agent models">
      <span><strong>${escapeHtml(group.model)}</strong><small>${group.count} agent${group.count === 1 ? '' : 's'} · ${escapeHtml(group.agents.slice(0, 4).join(', '))}${group.agents.length > 4 ? ` +${group.agents.length - 4}` : ''}</small></span>
      <span class="overview-model-count">${group.count}</span>
      <span class="overview-model-bar"><i style="width:${width.toFixed(2)}%"></i></span>
    </button>`;
  }).join('')}</div>`;
}

async function renderOverviewPane() {
  const wrap = document.createElement('div');
  wrap.className = 'overview-pane';
  wrap.innerHTML = '<div class="overview-content"><div class="overview-loading">Loading operational state…</div></div>';
  paneEl.appendChild(wrap);
  const content = wrap.querySelector('.overview-content');
  let usageShareMetric = 'spend';
  let usagePeriod = 'weekly';

  const load = async ({ forceUsage = false } = {}) => {
    if (load.inFlight) {
      const pending = load.inFlight;
      await pending.catch(() => {});
      if (load.inFlight === pending) load.inFlight = null;
      if (forceUsage && wrap.isConnected) return load({ forceUsage: true });
      return;
    }
    const run = (async () => {
    const refreshButton = content.querySelector('[data-overview-refresh]');
    if (forceUsage && refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing…';
    }
    try {
      const data = await fetchJson(withSession(`/api/overview?usage_period=${usagePeriod}${forceUsage ? '&usage=refresh' : ''}`), {
        timeoutMs: 15000,
        retries: 1,
        cache: 'no-store',
      });
      state.overview = data;
      if (!wrap.isConnected) return;
      const engagement = data.engagement;
      const agents = data.agents || [];
      const coordinator = agents.find(agent => agent.id === 'glados');
      const specialists = agents.filter(agent => agent.id !== 'glados');
      const active = data.activeAgents || [];
      const activeSpecialists = active.filter(agent => agent.id !== 'glados');
      const halted = data.haltedAgents || [];
      const agentRows = [...halted, ...active.filter(agent => !agent.halted)].filter(agent => agent.id !== 'glados');
      const session = data.session || state.investigationSessions.find(item => item.id === state.currentSessionId) || {};
      const gatewayLive = data.llmUsage?.available === true;
      const proxyLive = data.proxy?.healthy === true;
      const fullAccessAvailable = data.fullAccess?.available === true;
      const fullAccessEnabled = fullAccessAvailable && data.fullAccess?.enabled === true;
      const fullAccessLabel = fullAccessAvailable ? (fullAccessEnabled ? 'Enabled' : 'Restricted') : 'Unavailable';
      const canEndInvestigation = engagement
        && !['cancelled', 'complete', 'completed', 'closed'].includes(String(engagement.status || '').toLowerCase());
      content.innerHTML = `
        <header class="overview-header">
          <div>
            <span class="overview-eyebrow">GLaDOS ${escapeHtml(data.version || '')}</span>
            <h1>Workspace command center</h1>
            <p class="overview-intro">Runtime health, model capacity, and AI gateway usage in one place.</p>
            <div class="overview-status-line">
              <span class="status-chip success">Runtime online</span>
              <span class="status-chip neutral">${escapeHtml(session.name || 'Current workspace')}</span>
              <span class="overview-updated">Updated ${new Date(data.generatedAt).toLocaleTimeString()}</span>
            </div>
          </div>
          <div class="overview-header-actions">
            <button type="button" data-overview-chat>Open GLaDOS</button>
            <button type="button" data-overview-new>New workspace</button>
            <button type="button" data-overview-refresh title="Refresh operational state">Refresh</button>
          </div>
        </header>
        <section class="overview-metrics" aria-label="Workstation metrics">
          <div><span>GLaDOS model</span><strong class="metric-model">${escapeHtml(coordinator?.model || 'Not assigned')}</strong><small>Coordinator</small></div>
          <div><span>Agent fleet</span><strong>${specialists.length}</strong><small>${activeSpecialists.length} running · ${halted.length} halted</small></div>
          <div><span>LiteLLM</span><strong class="metric-word ${gatewayLive ? 'success' : 'warning'}">${gatewayLive ? 'Reporting' : 'Needs setup'}</strong><small>${gatewayLive ? `${formatUsageInteger(data.llmUsage?.totals?.requests)} key requests / ${usagePeriod === 'daily' ? 'today' : '7 days'}` : escapeHtml(data.llmUsage?.reason || 'unavailable')}</small></div>
          <div><span>Proxy</span><strong class="metric-word ${proxyLive ? 'success' : 'danger'}">${proxyLive ? 'Live' : 'Offline'}</strong><small>${escapeHtml(data.proxy?.backend || 'not configured')}</small></div>
          <div><span>Full access</span><strong class="metric-word ${fullAccessEnabled ? 'warning' : ''}">${escapeHtml(fullAccessLabel)}</strong><small>${fullAccessEnabled ? 'Coordinator permission prompts bypassed' : 'Safer default mode'}</small></div>
          <div><span>Workspace</span><strong class="metric-workspace">${escapeHtml(session.name || 'Current')}</strong><small>${session.engagementCount || 0} recorded engagement${session.engagementCount === 1 ? '' : 's'}</small></div>
        </section>
        ${renderLiteLlmUsage(data.llmUsage, usageShareMetric)}
        <div class="overview-workbench-grid">
          <section class="overview-section overview-readiness">
            <div class="overview-section-head"><div><h2>System readiness</h2><p>The services GLaDOS depends on right now</p></div></div>
            <div class="overview-readiness-list">
              <button type="button" data-overview-chat><i class="readiness-dot success"></i><span><strong>Agent runtime</strong><small>Dashboard and local Agent SDK are responding</small></span><b>Online</b></button>
              <button type="button" data-overview-settings><i class="readiness-dot ${gatewayLive ? 'success' : 'warning'}"></i><span><strong>LiteLLM gateway</strong><small>${escapeHtml(gatewayLive ? 'Usage reporting is connected' : (data.llmUsage?.message || 'Configure or verify the reporting key'))}</small></span><b>${gatewayLive ? 'Connected' : 'Review'}</b></button>
              <button type="button" data-overview-proxy><i class="readiness-dot ${proxyLive ? 'success' : 'danger'}"></i><span><strong>Intercept proxy</strong><small>${escapeHtml(proxyLive ? `${data.proxy?.backend || 'Proxy'} is accepting traffic` : (data.proxy?.error || 'Proxy is not running'))}</small></span><b>${proxyLive ? 'Live' : 'Offline'}</b></button>
              <button type="button" data-overview-settings><i class="readiness-dot ${fullAccessEnabled ? 'warning' : 'success'}"></i><span><strong>Permission mode</strong><small>${fullAccessEnabled ? 'Full Access is enabled for the coordinator' : 'Per-action approval protections remain enabled'}</small></span><b>${escapeHtml(fullAccessLabel)}</b></button>
              <button type="button" data-overview-settings><i class="readiness-dot ${halted.length ? 'danger' : 'success'}"></i><span><strong>Agent fleet</strong><small>${specialists.length} specialists available across ${overviewModelGroups(agents).length} model assignment${overviewModelGroups(agents).length === 1 ? '' : 's'}</small></span><b>${halted.length ? `${halted.length} halted` : 'Ready'}</b></button>
            </div>
          </section>
          <section class="overview-section overview-models">
            <div class="overview-section-head"><div><h2>Model assignments</h2><p>Enabled coordinator and specialist capacity</p></div><button type="button" data-overview-settings>Manage</button></div>
            ${renderOverviewModelAssignments(agents)}
          </section>
        </div>
        <div class="overview-workbench-grid overview-workbench-secondary">
          <section class="overview-section overview-current-work">
            <div class="overview-section-head"><div><h2>Active now</h2><p>Only work that currently needs attention</p></div>${canEndInvestigation ? '<button type="button" class="danger quiet" data-overview-end>End active work</button>' : ''}</div>
            ${engagement ? `<div class="overview-work-summary"><span>Current objective</span><strong>${escapeHtml(engagement.target || 'Active engagement')}</strong><small>${escapeHtml(data.phase || engagement.status || 'Active')} · ${Number(data.tasks?.running) || 0} running task${Number(data.tasks?.running) === 1 ? '' : 's'} · ${Number(data.pendingApprovals) || 0} approval${Number(data.pendingApprovals) === 1 ? '' : 's'} waiting</small></div>` : ''}
            <div class="overview-agent-list">
              ${agentRows.length ? agentRows.map(agent => `
                <button type="button" class="overview-agent-row" data-overview-agent="${escapeHtml(agent.id)}">
                  <span class="dot ${agent.halted ? 'halted' : 'live'}"></span>
                  <span><strong>${escapeHtml(agent.id)}</strong><small>${escapeHtml(agent.model || 'model not set')}</small></span>
                  <span class="status-chip ${agent.halted ? 'danger' : 'success'}">${agent.halted ? 'Halted' : 'Running'}</span>
                </button>`).join('') : '<div class="overview-empty overview-idle"><strong>No agent runs in progress</strong><span>The fleet is available for a new review or task.</span></div>'}
            </div>
          </section>
          <section class="overview-section overview-launchpad">
            <div class="overview-section-head"><div><h2>Quick launch</h2><p>Common workstation actions</p></div></div>
            <div class="overview-launch-grid">
              <button type="button" data-overview-chat><span>01</span><strong>Talk to GLaDOS</strong><small>Start a task or security review</small></button>
              <button type="button" data-overview-new><span>02</span><strong>New workspace</strong><small>Open a new blackboard and SDK scope</small></button>
              <button type="button" data-overview-settings><span>03</span><strong>Models & setup</strong><small>Credentials, models, and permissions</small></button>
              <button type="button" data-overview-proxy><span>04</span><strong>Proxy traffic</strong><small>Inspect captured requests</small></button>
              <button type="button" data-overview-update><span>05</span><strong>App update</strong><small>Check the release channel</small></button>
            </div>
          </section>
        </div>`;
      content.querySelector('[data-overview-refresh]')?.addEventListener('click', () => load({ forceUsage: true }));
      content.querySelectorAll('[data-overview-chat]').forEach(button => button.addEventListener('click', openGladosChat));
      content.querySelectorAll('[data-overview-new]').forEach(button => button.addEventListener('click', async () => {
        try { await createInvestigationSession(); }
        catch (error) { pushNotification('error', error.message, { toast: true, label: 'Workspace' }); }
      }));
      content.querySelectorAll('[data-overview-settings]').forEach(button => button.addEventListener('click', openSettings));
      content.querySelectorAll('[data-overview-proxy]').forEach(button => button.addEventListener('click', openProxy));
      content.querySelectorAll('[data-overview-update]').forEach(button => button.addEventListener('click', () => openUpdatePane()));
      content.querySelector('[data-overview-end]')?.addEventListener('click', async () => {
        const confirmed = await confirmAction({
          title: 'End investigation',
          message: 'Stop active agents, cancel remaining tracked work, and end this engagement without starting report generation?',
          confirmLabel: 'End investigation',
          danger: true,
        });
        if (!confirmed) return;
        try {
          await fetchJson(withSession(`/api/engagements/${encodeURIComponent(engagement.id)}/end`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'operator ended investigation from Overview tab' }),
            timeoutMs: 15_000,
          });
          showToast('Investigation ended. Active work was stopped and reporting was not started.', { kind: 'success', label: 'Overview' });
          await load();
        } catch (error) {
          pushNotification('error', `end investigation failed: ${error.message}`, { toast: true, label: 'Overview' });
        }
      });
      content.querySelectorAll('[data-overview-agent]').forEach(button => button.addEventListener('click', () => openAgentTab(button.dataset.overviewAgent)));
      content.querySelectorAll('[data-usage-share]').forEach(button => button.addEventListener('click', () => {
        usageShareMetric = button.dataset.usageShare;
        content.querySelectorAll('[data-usage-share]').forEach(candidate => {
          const active = candidate.dataset.usageShare === usageShareMetric;
          candidate.classList.toggle('active', active);
          candidate.setAttribute('aria-selected', String(active));
        });
        const list = content.querySelector('[data-usage-model-list]');
        if (list) {
          const observed = data.llmUsage?.sdkObserved;
          const usage = observed?.models?.length ? {
            totals: { spend: observed.totals?.costUsd, totalTokens: observed.totals?.totalTokens, requests: observed.totals?.completedTurns },
            models: observed.models.map(model => ({ ...model, spend: model.costUsd, requests: 0 })),
          } : data.llmUsage;
          list.innerHTML = renderUsageModelRows(usage, usageShareMetric);
        }
      }));
      content.querySelectorAll('[data-usage-period]').forEach(button => button.addEventListener('click', () => {
        const next = button.dataset.usagePeriod;
        if (!['daily', 'weekly'].includes(next) || next === usagePeriod) return;
        usagePeriod = next;
        load({ forceUsage: false });
      }));
    } catch (error) {
      if (!wrap.isConnected) return;
      content.innerHTML = `<div class="overview-error"><strong>Overview unavailable</strong><p>${escapeHtml(error.message)}</p><button type="button">Retry</button></div>`;
      content.querySelector('button')?.addEventListener('click', load);
    }
    })();
    load.inFlight = run;
    try {
      return await run;
    } finally {
      if (load.inFlight === run) load.inFlight = null;
    }
  };
  await load();
  const timer = setInterval(() => {
    if (!wrap.isConnected) return clearInterval(timer);
    load();
  }, 10_000);
}

function normalizeIncomingTranscriptEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  if (ev.kind === 'assistant-partial') {
    return {
      ...ev,
      kind: 'text-stream',
      evtType: ev.evtType || 'text_delta',
      delta: ev.delta ?? ev.text ?? '',
      runId: ev.runId || ev.sessionId || ev.parentToolUseId || 'nosession',
    };
  }
  if (ev.kind === 'assistant-thinking-partial') {
    return {
      ...ev,
      kind: 'thinking-stream',
      evtType: ev.evtType || 'thinking_delta',
      delta: ev.delta ?? ev.text ?? '',
      runId: ev.runId || ev.sessionId || ev.parentToolUseId || 'nosession',
    };
  }
  if ((ev.kind === 'text-stream' || ev.kind === 'thinking-stream') && !ev.runId) {
    return { ...ev, runId: ev.sessionId || ev.parentToolUseId || 'nosession' };
  }
  return ev;
}

function sdkResultToPromptError(ev) {
  return {
    ...ev,
    kind: 'prompt-error',
    error: ev.error || ev.text || (Array.isArray(ev.errors) ? ev.errors.join('\n') : '') || 'Agent SDK turn failed',
    provider: ev.provider || 'LiteLLM Anthropic Messages',
    model: ev.model || '',
    api: ev.api || '/v1/messages',
  };
}

// Long investigations can emit thousands of durable events, including tool
// results whose full payload is hundreds of KB. Keeping every full object in
// every hidden tab eventually blocks the browser main thread long enough for
// unrelated workspace reads (Overview, Plans, Reports, Proxy) to time out.
// The server remains the durable source of truth; the client keeps a bounded
// working set and a useful preview of oversized payloads.
const TRANSCRIPT_EVENT_LIMIT = 600;
const TRANSCRIPT_FIELD_CHAR_LIMIT = 64 * 1024;

function truncateTranscriptField(value) {
  if (typeof value !== 'string' || value.length <= TRANSCRIPT_FIELD_CHAR_LIMIT) return value;
  const omitted = value.length - TRANSCRIPT_FIELD_CHAR_LIMIT;
  return `${value.slice(0, TRANSCRIPT_FIELD_CHAR_LIMIT)}\n\n[client preview truncated; ${omitted.toLocaleString()} chars remain in the durable transcript]`;
}

function compactTranscriptEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const next = { ...ev };
  for (const key of ['text', 'error', 'content']) {
    if (typeof next[key] === 'string') next[key] = truncateTranscriptField(next[key]);
  }
  for (const key of ['arguments', 'toolInput']) {
    const value = next[key];
    if (!value || typeof value !== 'object') continue;
    let serialized = '';
    try { serialized = JSON.stringify(value); } catch { continue; }
    if (serialized.length <= TRANSCRIPT_FIELD_CHAR_LIMIT) continue;
    next[key] = {
      _clientPreviewTruncated: true,
      originalChars: serialized.length,
      preview: truncateTranscriptField(serialized),
    };
  }
  return next;
}

function pruneTranscriptEvents(rec) {
  if (!rec?.events || rec.events.length <= TRANSCRIPT_EVENT_LIMIT) return;
  rec.events.splice(0, rec.events.length - TRANSCRIPT_EVENT_LIMIT);
}

// Ensure a transcript record exists for this tabId and is subscribed to the
// agent's SSE transcript. The SSE handler always appends to rec.el — which
// gets reassigned on every render — so switching tabs never orphans events.
function ensureTranscript(tabId, agentId, options = {}) {
  const sessionId = options.sessionId || state.currentSessionId;
  let rec = state.transcripts.get(tabId);
  if (rec && options.sessionId && rec.sessionId !== sessionId) {
    try { rec.es?.close(); } catch {}
    state.transcripts.delete(tabId);
    rec = null;
  }
  if (rec && (rec.es || !sessionId)) return rec;
  if (!rec) {
  rec = {
    agentId,
    sessionId,
    independentSession: !!options.sessionId,
    viewTabId: options.viewTabId || tabId,
    es: null,
    el: null,
    events: [],
    sending: false,
	    activity: null,
	    thinkingLevel: null,
	    autoScroll: true,
    // Live-streaming state from SDK partial-message deltas. Each runId gets a
    // growing entry per kind; after stream end, remember final text briefly so
    // durable transcript echoes do not duplicate the live bubble.
	    streamEntries: new Map(),        // key "<runId>:<kind>" -> { el, textNode, content }
	    recentlyStreamed: [],            // [{ kind: 'thinking'|'text', content, ts }]
	    streamedTextKeys: new Map(),     // normalized "kind:text" -> ts; robust JSONL duplicate suppression
	    pendingUserMessages: [],
	    turnStartedAt: null,
	    turnAgeMs: null,
	    firstTokenSeenAt: null,
	    completedAt: null,
	  };
  state.transcripts.set(tabId, rec);
  }
  if (!sessionId) return rec;
  rec.sessionId = sessionId;
  const generation = state.sessionGeneration;
  const es = new EventSource(withSession(`/api/agents/${encodeURIComponent(agentId)}/transcript?stream=v4`, sessionId));
  es.onmessage = e => {
    if (state.transcripts.get(tabId) !== rec || (!rec.independentSession && (generation !== state.sessionGeneration || sessionId !== state.currentSessionId))) return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    ev = normalizeIncomingTranscriptEvent(ev);
    if (!ev) return;

    // The SDK result object is control metadata. The assistant answer already
    // arrives as assistant-text, so success results should not become chat
    // bubbles. Error results are rendered as explicit prompt failures.
    if (ev.kind === 'result' && !ev.isError) {
      // Retain an invisible terminal boundary so replay cannot resurrect a
      // synchronous call whose result was never recorded as permanently live.
      const sourceTs = transcriptEventMs(ev);
      const belongsToCurrentTurn = eventBelongsToCurrentTurn(rec, ev) && (!rec.turnStartedAt || sourceTs >= rec.turnStartedAt);
      if (belongsToCurrentTurn) finalizeActiveStreamEntries(rec);
      const terminal = sourceTs || !rec.sending ? { kind: 'work-turn-ended', ts: sourceTs || Date.now(), id: `work-terminal:${ev.id || `${ev.runId || ev.sessionId || ''}:${ev.ts || 'unknown'}`}` } : null;
      if (terminal) {
        const inserted = insertTranscriptEvent(rec, terminal);
        if (rec.el?.isConnected) {
          if (inserted.outOfOrder) renderTranscriptEvents(rec);
          else appendEntry(rec.el, terminal, rec);
        }
      }
      if (belongsToCurrentTurn) {
        if (rec.sending) finishTranscriptTurn(rec, tabId, terminal);
      }
      return;
    }
    if (ev.kind === 'error' || (ev.kind === 'result' && ev.isError)) {
      ev = sdkResultToPromptError(ev);
    }
    if (ev.kind === 'context-status') {
      if (ev.status === 'compacting') markTranscriptActivity(rec, tabId, 'compacting');
      return;
    }
    if (ev.kind === 'context-compacted') {
      showToast('Conversation context compacted. GLaDOS is continuing automatically.', { kind: 'info', label: 'Context' });
      return;
    }

    // SDK partial deltas: don't buffer, don't push to events list, just update
    // the live entry. They arrive many-per-second and would blow out memory.
    if (ev.kind === 'thinking-stream' || ev.kind === 'text-stream') {
      const isText = ev.kind === 'text-stream';
      rec.firstTokenSeenAt ||= Date.now();
      markTranscriptActivity(rec, tabId, isText ? 'responding' : 'thinking');
      handleStreamDelta(rec, ev);
      // text_end finishes one public progress block, not the agent turn.
      return;
    }

    // Suppress durable thinking/assistant-text echoes if we just finished
    // streaming the same content live. Keeps the UI clean.
    if (ev.kind === 'thinking' || ev.kind === 'assistant-text') {
      const matchKind = ev.kind === 'thinking' ? 'thinking' : 'text';
      removeActiveStreamEntries(rec, ev.kind);
      if (wasRecentlyStreamed(rec, matchKind, ev.text)) {
        reconcileStreamedEvent(rec, ev);
        if (ev.kind === 'assistant-text' && rec.sending && eventBelongsToCurrentTurn(rec, ev)) {
          rec.firstTokenSeenAt ||= Date.now();
          markTranscriptActivity(rec, tabId, 'responding');
        }
        return;
      }
    }

    // Ack the durable user-message against the optimistic local bubble
    // instead of appending a duplicate. This keeps Sam's input visible during
    // the slow first-token/tool-call gap and removes the faded optimistic style
    // once the gateway has persisted the message.
	    if (ev.kind === 'user-message') {
	      if (ackOptimisticUserMessage(rec, ev)) return;
	      const idx = findEventIndexByText(rec, 'user-message', ev.text);
      if (idx >= 0) {
        rec.events[idx] = { ...rec.events[idx], ...ev, _optimistic: false };
        ensureVisibleUserMessage(rec, rec.events[idx]);
        return;
	      }
	    }
	    if (ev.kind === 'meta' && ev.sub === 'thinking-level') {
	      rec.thinkingLevel = ev.level || null;
	    }
    if (ev.kind === 'thinking' && normalizeTranscriptText(ev.text || '').length < 80) {
      rec.firstTokenSeenAt ||= Date.now();
      if (rec.sending) markTranscriptActivity(rec, tabId, 'thinking');
      return;
    }

    ev = compactTranscriptEvent(ev);
    const inserted = insertTranscriptEvent(rec, ev);
    if (!inserted.added) {
      if (rec.el && rec.el.isConnected && inserted.index >= 0) renderTranscriptEvents(rec);
      if (rec.sending && eventBelongsToCurrentTurn(rec, ev)) {
        if (ev.kind === 'prompt-error') finishTranscriptTurn(rec, tabId, ev);
        else if (ev.kind === 'assistant-text') markTranscriptActivity(rec, tabId, 'responding');
      }
      return;
    }
    if (rec.el && rec.el.isConnected) {
      if (inserted.outOfOrder) renderTranscriptEvents(rec);
      else appendEntry(rec.el, ev, rec);
    }
    const recentOperationalEvent = !transcriptEventMs(ev) || Date.now() - transcriptEventMs(ev) < 30_000;
    if (ev.kind === 'prompt-error' && recentOperationalEvent) {
      pushNotification('error', `${rec.agentId}: ${ev.error || ev.text || 'LLM prompt failed'}`, { toast: true, label: 'Agent runtime' });
    } else if (ev.kind === 'permission-denied' && recentOperationalEvent) {
      pushNotification('denied', `${rec.agentId}: ${ev.decisionReason || ev.text || 'tool use denied'}`, { toast: true, label: 'Safety gate' });
    }
    if (rec.sending) {
      if (ev.kind === 'assistant-text' || ev.kind === 'prompt-error') {
        if (eventBelongsToCurrentTurn(rec, ev)) {
          rec.firstTokenSeenAt ||= Date.now();
          if (ev.kind === 'prompt-error') finishTranscriptTurn(rec, tabId, ev);
          else markTranscriptActivity(rec, tabId, 'responding');
        }
      } else if (ev.kind === 'thinking') {
        rec.firstTokenSeenAt ||= Date.now();
        markTranscriptActivity(rec, tabId, 'thinking');
      } else if (ev.kind === 'tool-call' || ev.kind === 'tool-result' || ev.kind === 'meta') {
        rec.firstTokenSeenAt ||= Date.now();
        markTranscriptActivity(rec, tabId, 'working');
      }
    }
  };
  es.onerror = () => {};
  rec.es = es;
  return rec;
}

function stripSessionTimestampPrefix(value) {
  return String(value || '').replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [A-Z]{2,5}\]\s*/,
    ''
  );
}

function stripHarnessControlTags(value) {
  return String(value || '')
    .replace(/\[\[\s*\/?reply_to_current\s*\]\]\s*/gi, '')
    .replace(/\[\s*\/?reply_to_current\s*\]\s*/gi, '')
    .replace(/\[\[?\s*\/?reply_to_current\b\s*/gi, '')
    .replace(/\b\/?reply_to_current\]?\]?\s*/gi, '');
}

function displayTranscriptText(value) {
  return stripHarnessControlTags(value);
}

function normalizeTranscriptText(value) {
  return stripHarnessControlTags(stripSessionTimestampPrefix(value))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// Rough equality: streamed and durable transcript text can differ by trailing
// newlines or leading whitespace, so compare normalized content.
function textsMatch(a, b) {
  if (!a || !b) return false;
  const x = normalizeTranscriptText(a);
  const y = normalizeTranscriptText(b);
  if (x === y) return true;
  // Also match if one contains the other (start/end may be slightly trimmed).
  const longer = x.length >= y.length ? x : y;
  const shorter = x.length >= y.length ? y : x;
  return shorter.length > 40 && longer.includes(shorter);
}

function transcriptTextKey(kind, text) {
  const normalized = normalizeTranscriptText(text);
  return normalized ? `${kind}:${normalized}` : null;
}

function transcriptEventMs(ev) {
  if (!ev) return 0;
  if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) return ev.ts;
  const parsed = Date.parse(ev.ts || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventBelongsToCurrentTurn(rec, ev) {
  if (!rec?.turnStartedAt) return true;
  const evMs = transcriptEventMs(ev);
  if (!evMs) return true;
  return evMs >= rec.turnStartedAt - 1000;
}

function findEventIndexByIdentity(rec, ev) {
  if (!rec || !Array.isArray(rec.events) || !ev) return -1;
  if (ev.id) {
    const byId = rec.events.findIndex(x => x.id && x.id === ev.id);
    if (byId >= 0) return byId;
  }
  if (ev.toolCallId || ev.toolUseId) {
    const toolId = ev.toolCallId || ev.toolUseId;
    const byTool = rec.events.findIndex(x => x.kind === ev.kind && (x.toolCallId || x.toolUseId) === toolId);
    if (byTool >= 0) return byTool;
  }
  const evMs = transcriptEventMs(ev);
  if (ev.kind && ev.text && evMs) {
    return rec.events.findIndex(x =>
      x.kind === ev.kind &&
      transcriptEventMs(x) === evMs &&
      textsMatch(x.text, ev.text)
    );
  }
  return -1;
}

function insertTranscriptEvent(rec, ev) {
  const existingIdx = findEventIndexByIdentity(rec, ev);
  if (existingIdx >= 0) {
    rec.events[existingIdx] = { ...rec.events[existingIdx], ...ev };
    return { added: false, duplicate: true, index: existingIdx };
  }

  const evMs = transcriptEventMs(ev);
  let index = rec.events.length;
  if (evMs && !ev._optimistic) {
    while (index > 0) {
      const prev = rec.events[index - 1];
      const prevMs = transcriptEventMs(prev);
      if (!prevMs || prevMs <= evMs) break;
      index--;
    }
  }
  rec.events.splice(index, 0, ev);
  pruneTranscriptEvents(rec);
  return { added: true, duplicate: false, index, outOfOrder: index !== rec.events.length - 1 };
}

function renderTranscriptEvents(rec) {
  if (!rec?.el || !rec.el.isConnected) return;
  rec.el.innerHTML = '';
  for (const ev of rec.events) appendEntry(rec.el, ev, rec);
  if (rec.autoScroll !== false) scheduleStickyScroll(rec.el, rec);
}

function pruneRecentlyStreamed(rec) {
  if (!rec) return;
  const now = Date.now();
  rec.recentlyStreamed = (rec.recentlyStreamed || []).filter(s => (now - s.ts) < 120_000);
  if (rec.streamedTextKeys instanceof Map) {
    for (const [key, ts] of rec.streamedTextKeys) {
      if ((now - ts) >= 120_000) rec.streamedTextKeys.delete(key);
    }
  }
}

function markRecentlyStreamed(rec, kind, text) {
  if (!rec || !text) return;
  pruneRecentlyStreamed(rec);
  rec.recentlyStreamed.push({ kind, content: text, ts: Date.now() });
  if (!(rec.streamedTextKeys instanceof Map)) rec.streamedTextKeys = new Map();
  const key = transcriptTextKey(kind, text);
  if (key) rec.streamedTextKeys.set(key, Date.now());
}

function wasRecentlyStreamed(rec, kind, text) {
  if (!rec || !text) return false;
  pruneRecentlyStreamed(rec);
  const key = transcriptTextKey(kind, text);
  if (key && rec.streamedTextKeys instanceof Map && rec.streamedTextKeys.has(key)) {
    rec.streamedTextKeys.delete(key);
    return true;
  }
  const now = Date.now();
  const idx = (rec.recentlyStreamed || []).findIndex(s =>
    s.kind === kind && (now - s.ts) < 120_000 && textsMatch(s.content, text)
  );
  if (idx >= 0) {
    rec.recentlyStreamed.splice(idx, 1);
    return true;
  }
  return false;
}

function findEventIndexByText(rec, kind, text) {
  if (!rec || !Array.isArray(rec.events)) return -1;
  return rec.events.findIndex(x => x.kind === kind && textsMatch(x.text, text));
}

function reconcileStreamedEvent(rec, ev) {
  const idx = findEventIndexByText(rec, ev.kind, ev.text);
  if (idx >= 0 && rec.events[idx]?._streamed) {
    rec.events[idx] = { ...ev };
  }
}

function removeRecentStreamedPreToolText(rec, toolTs) {
  if (!rec) return;
  const cutoff = Date.parse(toolTs || '') || Date.now();
  rec.events = (rec.events || []).filter(ev => {
    if (ev.kind !== 'assistant-text' || !ev._streamed) return true;
    const evMs = Date.parse(ev.ts || '') || Number(ev.ts) || 0;
    return Math.abs(cutoff - evMs) > 15_000;
  });
  if (rec.el && rec.el.isConnected) {
    for (const node of [...rec.el.querySelectorAll('.entry.assistant-text')]) {
      const key = node.dataset.streamKey || '';
      if (!key) continue;
      const nodeMs = Number(node.dataset.streamTs || 0);
      if (nodeMs && Math.abs(cutoff - nodeMs) > 15_000) continue;
      node.remove();
    }
  }
  for (const [key, entry] of rec.streamEntries || []) {
    if (key.endsWith(':assistant-text')) {
      entry.el?.remove();
      rec.streamEntries.delete(key);
    }
  }
}

function removeActiveStreamEntries(rec, entryKind) {
  if (!rec?.streamEntries) return false;
  let removed = false;
  for (const [key, entry] of rec.streamEntries) {
    if (!key.endsWith(`:${entryKind}`)) continue;
    entry.el?.remove();
    rec.streamEntries.delete(key);
    removed = true;
  }
  return removed;
}

function finalizeActiveStreamEntries(rec) {
  if (!rec?.streamEntries) return false;
  let finalized = false;
  for (const [key, entry] of [...rec.streamEntries]) {
    if (!entry || !entry.el) {
      rec.streamEntries.delete(key);
      continue;
    }
    const isThinking = key.endsWith(':thinking');
    const durableKind = isThinking ? 'thinking' : 'assistant-text';
    const content = displayTranscriptText(entry.rawContent || entry.content || '');
    if (entry.el) {
      entry.el.classList.remove('streaming');
      const cursor = entry.el.querySelector('.stream-cursor');
      if (cursor) cursor.remove();
      if (!isThinking && entry.textNode && entry.textNode.parentNode) {
        try {
          const ts = entry.el.querySelector('.ts')?.outerHTML || '';
          entry.el.innerHTML = `${ts}${renderMarkdown(content)}`;
          enhanceMarkdownContent(entry.el, { clippySources: rec?.agentId === 'pkg-clippy-intel--clippy' });
        } catch (_) { /* keep plain text on error */ }
      }
    }
    if (content && findEventIndexByText(rec, durableKind, content) < 0) {
      rec.events.push({
        kind: durableKind,
        text: content,
        ts: Number(entry.el?.dataset.streamTs) || Date.now(),
        _streamed: true,
      });
    }
    if (content) markRecentlyStreamed(rec, isThinking ? 'thinking' : 'text', content);
    rec.streamEntries.delete(key);
    finalized = true;
  }
  pruneRecentlyStreamed(rec);
  return finalized;
}

function findVisibleUserMessage(rec, text) {
  if (!rec?.el || !rec.el.isConnected) return null;
  const candidates = [...rec.el.querySelectorAll('.entry.user-message')];
  return candidates.find(node => textsMatch(node.dataset.messageText || node.textContent || '', text)) || null;
}

function ensureVisibleUserMessage(rec, ev) {
  if (!rec?.el || !rec.el.isConnected) return;
  const existing = findVisibleUserMessage(rec, ev.text || '');
  if (existing) {
    existing.classList.remove('optimistic');
    existing.dataset.messageText = ev.text || '';
    if (ev.clientId) existing.dataset.clientId = ev.clientId;
    const ts = existing.querySelector('.ts');
    if (ts && ev.ts) ts.textContent = new Date(ev.ts).toLocaleTimeString();
    return;
  }
  appendEntry(rec.el, ev, rec);
}

function markTranscriptActivity(rec, tabId, activity) {
  if (!rec) return;
  rec.sending = true;
  rec.activity = activity || 'working';
  rec.lastActivityTs = Date.now();
  updateSendingIndicator(tabId);
}

function workTurnBoundary(rec, terminal = null) {
  if (terminal?.kind === 'work-turn-ended') return terminal;
  const ts = transcriptEventMs(terminal) || Date.now();
  return {
    kind: 'work-turn-ended',
    ts,
    id: `work-terminal:${terminal?.id || rec?.turnStartedAt || ts}`,
    outcome: terminal?.kind === 'prompt-error' ? 'error' : rec?.activity === 'stopping' ? 'stopped' : 'ended',
  };
}

function finishTranscriptTurn(rec, tabId, terminal = null) {
  if (!rec) return;
  const wasSending = rec.sending;
  finalizeActiveStreamEntries(rec);
  const boundary = workTurnBoundary(rec, terminal);
  if (boundary !== terminal) insertTranscriptEvent(rec, boundary);
  finishWorkActivities(rec, boundary);
  if (rec.el?.isConnected) compactCompletedWork(rec.el, boundary, rec);
  rec.sending = false;
  rec.activity = null;
  rec.lastActivityTs = Date.now();
  rec.turnAgeMs = null;
  rec.completedAt = Date.now();
  updateSendingIndicator(tabId);
  if (wasSending && rec.agentId === 'pkg-clippy-intel--clippy' && !['error', 'stopped'].includes(boundary.outcome)) syncClippyChatCandidates(rec, boundary);
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

function transcriptTurnAge(rec) {
  if (!rec) return 0;
  if (Number.isFinite(rec.turnAgeMs)) return rec.turnAgeMs;
  if (rec.turnStartedAt) return Date.now() - rec.turnStartedAt;
  return 0;
}

function transcriptStatusText(rec, label) {
  const base = label || rec?.agentId || 'Agent';
  const activity = rec?.activity || 'waiting';
  const age = transcriptTurnAge(rec);
  const ageText = age ? ` · ${formatElapsed(age)}` : '';
  if (activity === 'thinking') return `${base} is thinking live${ageText}…`;
  if (activity === 'responding') return `${base} is responding live${ageText}…`;
	  if (activity === 'compacting') return `${base} is compacting context and will continue automatically${ageText}…`;
	  if (activity === 'working') return `${base} is working${ageText}…`;
	  if (activity === 'stopping') return `${base} is stopping the current response…`;
	  if (activity === 'finalizing') return `${base} is finalizing the answer…`;
	  if (activity === 'waiting' && rec?.thinkingLevel === 'off') return `${base} is waiting for the first token${ageText} (thinking stream off)…`;
	  if (activity === 'waiting' && age >= 60_000) return `${base} is still waiting for the first token${ageText}…`;
	  return `${base} is waiting for the first token${ageText}…`;
	}

function ackOptimisticUserMessage(rec, ev) {
  const idx = rec.events.findIndex(x =>
    x.kind === 'user-message' && x._optimistic && textsMatch(x.text, ev.text)
  );
  if (idx < 0) return false;
  const old = rec.events[idx];
  rec.events[idx] = {
    ...ev,
    attachments: Array.isArray(ev.attachments) && ev.attachments.length ? ev.attachments : old.attachments,
    _optimistic: false,
    _acknowledgedClientId: old.clientId || null,
  };
  rec.pendingUserMessages = (rec.pendingUserMessages || [])
    .filter(p => !textsMatch(p.text, ev.text));
  if (rec.el && rec.el.isConnected) {
    const candidates = [...rec.el.querySelectorAll('.entry.user-message.optimistic')];
    const el = candidates.find(node => textsMatch(node.dataset.messageText || '', ev.text));
    if (el) {
      el.classList.remove('optimistic');
      el.dataset.messageText = ev.text || '';
      if (old.clientId) el.dataset.clientId = old.clientId;
      const ts = el.querySelector('.ts');
      if (ts && ev.ts) ts.textContent = new Date(ev.ts).toLocaleTimeString();
    } else {
      // Defensive recovery: if a render/reconnect removed the optimistic DOM
      // bubble before the JSONL ack arrived, still materialize the durable user
      // event. User prompts must never disappear from the transcript.
      ensureVisibleUserMessage(rec, rec.events[idx]);
    }
  }
  return true;
}

async function refreshChatTurnStatus(tabId, agentId) {
  const rec = state.transcripts.get(tabId);
  if (!rec || !(rec.sessionId || state.currentSessionId)) return;
  try {
    const r = await fetch(withSession(`/api/chat/status/${encodeURIComponent(agentId)}`, rec.sessionId));
    if (!r.ok) return;
    const status = await r.json();
    if (status.active) {
      if (rec.completedAt && status.startedAt && status.startedAt <= rec.completedAt) return;
      rec.turnStartedAt = status.startedAt || rec.turnStartedAt || Date.now();
      rec.turnAgeMs = status.ageMs;
      if (!rec.sending) {
        rec.sending = true;
        rec.activity = rec.firstTokenSeenAt ? 'working' : 'waiting';
      } else if (!rec.activity) {
        rec.activity = rec.firstTokenSeenAt ? 'working' : 'waiting';
      }
      updateSendingIndicator(tabId);
    } else if (rec.sending) {
      // Defensive recovery: lobby SSE can miss chat-turn-ended during a tab
      // reconnect, while the durable transcript has already been written.
      // If the server says the turn is no longer active, clear the spinner
      // even if we never entered the "finalizing" state.
      rec.activity = 'finalizing';
      updateSendingIndicator(tabId);
      setTimeout(() => {
        if (rec.sending && rec.activity === 'finalizing') finishTranscriptTurn(rec, tabId);
      }, 1000);
    } else {
      finishWorkActivities(rec);
    }
  } catch {}
}

function refreshVisibleChatTurnStatuses() {
  const tab = state.openTabs.find(item => item.id === state.currentTab);
  if (!tab) return;
  if (tab.kind === 'clippy') {
    const independent = state.transcripts.get('clippy-chat');
    if (independent?.agentId && independent.sessionId) refreshChatTurnStatus('clippy-chat', independent.agentId);
    return;
  }
  if (!['chat', 'agent'].includes(tab.kind)) return;
  const rec = state.transcripts.get(tab.id);
  refreshChatTurnStatus(tab.id, rec?.agentId || (tab.kind === 'chat' ? activeCoordinatorId() : tab.id));
}

function handleStreamDelta(rec, ev) {
  if (!rec.el || !rec.el.isConnected) return; // not visible yet — skip; JSONL final will render later
  const isThinking = ev.kind === 'thinking-stream';
  const entryKind = isThinking ? 'thinking' : 'assistant-text';
  const streamKey = `${ev.runId || 'nosession'}:${entryKind}`;
  const isStart = ev.evtType === 'thinking_start' || ev.evtType === 'text_start';
  const isEnd = ev.evtType === 'thinking_end' || ev.evtType === 'text_end';
  let entry = rec.streamEntries.get(streamKey);
  const nextRawContent = ev.content || `${entry?.rawContent || entry?.content || ''}${ev.delta || ''}`;
  const nextContent = displayTranscriptText(nextRawContent);
  const meaningfulThinking = normalizeTranscriptText(nextContent).length >= 80;

  // Thinking can arrive as one-token scratch fragments. Those fragments are status signal, not
  // useful transcript. Hold them in memory; only render/persist a thinking
  // bubble once it becomes a real paragraph.
  if (isThinking && !meaningfulThinking) {
    if (entry) {
      entry.rawContent = nextRawContent;
      entry.content = nextContent;
      if (entry.textNode) entry.textNode.data = nextContent;
      if (isEnd) {
        entry.el?.remove();
        rec.streamEntries.delete(streamKey);
      }
    } else if (!isEnd) {
      rec.streamEntries.set(streamKey, { el: null, textNode: null, rawContent: nextRawContent, content: nextContent });
    }
    return;
  }

  // The durable assistant-text event can win the race against text_end and
  // remove the live stream entry first. A trailing end event must never create
  // a new timestamp-only bubble when there is no stream left to finalize.
  if (isEnd && !entry) {
    if (rec.autoScroll !== false) scheduleStickyScroll(rec.el, rec);
    return;
  }

  if (!entry) {
    // First delta we see — create the live entry. We skip the 'start' event if
    // we missed it (streaming started before this client connected).
    const el = document.createElement('div');
    el.className = `entry ${entryKind} streaming`;
    el.dataset.streamKey = streamKey;
    el.dataset.streamTs = String(Date.parse(ev.ts || '') || Date.now());
    if (rec?.agentId) el.dataset.agent = rec.agentId;
    const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';
    el.innerHTML = `<span class="ts">${ts}</span><span class="stream-cursor"> ▍</span>`;
    const textNode = document.createTextNode('');
    // Insert text before the cursor span so the cursor always trails.
    el.insertBefore(textNode, el.querySelector('.stream-cursor'));
    rec.el.appendChild(el);
    entry = { el, textNode, rawContent: '', content: '' };
    rec.streamEntries.set(streamKey, entry);
  } else if (!entry.el && isThinking && meaningfulThinking) {
    const el = document.createElement('div');
    el.className = `entry ${entryKind} streaming`;
    el.dataset.streamKey = streamKey;
    el.dataset.streamTs = String(Date.parse(ev.ts || '') || Date.now());
    if (rec?.agentId) el.dataset.agent = rec.agentId;
    const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';
    el.innerHTML = `<span class="ts">${ts}</span><span class="stream-cursor"> ▍</span>`;
    const textNode = document.createTextNode('');
    el.insertBefore(textNode, el.querySelector('.stream-cursor'));
    rec.el.appendChild(el);
    entry.el = el;
    entry.textNode = textNode;
  }

  // Prefer `content` when present (full accumulated) — avoids drift if we
  // missed a delta. Fall back to appending `delta`.
  if (ev.content) {
    entry.rawContent = ev.content;
    entry.content = displayTranscriptText(entry.rawContent);
    if (entry.textNode) entry.textNode.data = entry.content;
  } else if (ev.delta) {
    entry.rawContent = `${entry.rawContent || entry.content || ''}${ev.delta}`;
    entry.content = displayTranscriptText(entry.rawContent);
    if (entry.textNode) entry.textNode.data = entry.content;
  }

  if (isEnd) {
    const durableKind = isThinking ? 'thinking' : 'assistant-text';
    if (findEventIndexByText(rec, durableKind, entry.content) >= 0) {
      // JSONL can occasionally win the race against raw text_end. In that
      // case the durable bubble already exists, so remove the transient live
      // stream bubble instead of showing the same answer twice.
      entry.el?.remove();
      rec.streamEntries.delete(streamKey);
      if (rec.autoScroll !== false) scheduleStickyScroll(rec.el, rec);
      return;
    }
    entry.el?.classList.remove('streaming');
    const cursor = entry.el?.querySelector('.stream-cursor');
    if (cursor) cursor.remove();
    // v4: upgrade finalized assistant-text from plain text to rendered markdown.
    // Thinking blocks stay plain (they're notes, not formatted output).
    if (!isThinking && entry.textNode && entry.textNode.parentNode) {
      try {
        const ts = entry.el.querySelector('.ts')?.outerHTML || '';
        entry.el.innerHTML = `${ts}${renderMarkdown(entry.content || '')}`;
        enhanceMarkdownContent(entry.el, { clippySources: rec?.agentId === 'pkg-clippy-intel--clippy' });
        addAskGladosAction(entry.el, entry.content, rec);
        const toggle = entry.el.querySelector('.expand-toggle');
        if (toggle) {
          toggle.addEventListener('click', () => {
            const target = entry.el.querySelector('.md-content.collapsible, pre.collapsible');
            if (!target) return;
            const open = target.classList.toggle('open');
            toggle.textContent = open ? '▾ collapse' : `▸ expand (${(target.textContent || '').length.toLocaleString()} chars)`;
          });
	        }
      } catch (_) { /* keep plain text on error */ }
    }
    if (entry.content && findEventIndexByText(rec, durableKind, entry.content) < 0) {
      rec.events.push(compactTranscriptEvent({
        kind: durableKind,
        text: entry.content,
        ts: ev.ts || Date.now(),
        runId: ev.runId,
        _streamed: true,
      }));
      pruneTranscriptEvents(rec);
    }
    markRecentlyStreamed(rec, isThinking ? 'thinking' : 'text', entry.content);
    // Evict old stream-handles so the map can't grow unbounded over a long
    // session. Anything older than 2 minutes definitely isn't getting more deltas.
    for (const [k, v] of rec.streamEntries) {
      if (!v.el?.isConnected) rec.streamEntries.delete(k);
    }
    rec.streamEntries.delete(streamKey);
    pruneRecentlyStreamed(rec);
  }

  if (rec.autoScroll !== false) scheduleStickyScroll(rec.el, rec);
}

function attachScrollTracker(container, rec) {
  // Ignore scroll events during the first ~1.5s of a render — the async SSE
  // backfill triggers layout shifts that the browser may surface as synthetic
  // scroll events, and we don't want to treat those as "user scrolled away".
  const settleUntil = Date.now() + 1500;
  container.addEventListener('scroll', () => {
    if (Date.now() < settleUntil) return;
    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
    rec.autoScroll = nearBottom;
  });
}

function renderAgentPane(agentId) {
  renderAgentChatSurface(agentId, agentId, false);
}

// v4 — Chat input history + retry.
// Per-chat ring buffer of user messages, persisted to localStorage. Arrow-up /
// Arrow-down in an empty textarea (or one whose value matches the currently
// recalled entry) scrolls back/forward through history. Separate keys per chat
// surface so GLaDOS history does not bleed between panes.
const CHAT_HISTORY_MAX = 50;
function chatHistoryKey(histKey) { return `glados-dash.chat-history.${histKey}`; }
function loadChatHistory(histKey) {
  try {
    const raw = localStorage.getItem(chatHistoryKey(histKey));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-CHAT_HISTORY_MAX) : [];
  } catch { return []; }
}
function pushChatHistory(histKey, msg) {
  if (!msg || typeof msg !== 'string') return;
  const list = loadChatHistory(histKey);
  // De-duplicate consecutive identical messages.
  if (list.length && list[list.length - 1] === msg) return;
  list.push(msg);
  while (list.length > CHAT_HISTORY_MAX) list.shift();
  try { localStorage.setItem(chatHistoryKey(histKey), JSON.stringify(list)); } catch {}
}
// v4 Tier 3 #10 — auto-growing textarea. Grows up to `maxVh` viewport height
// fraction before inner scroll kicks in. Shrinks as content is removed.
function attachAutoGrow(ta, { minHeightPx = 60, maxVh = 0.4 } = {}) {
  const resize = () => {
    ta.style.height = 'auto';
    const maxPx = Math.floor(window.innerHeight * maxVh);
    const next = Math.min(maxPx, Math.max(minHeightPx, ta.scrollHeight));
    ta.style.height = next + 'px';
    ta.style.overflowY = ta.scrollHeight > maxPx ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', resize);
  // Also run once to normalize the initial state.
  requestAnimationFrame(resize);
  // Expose so send()'s textarea-clear can trigger a re-fit.
  ta._gladosAutoGrow = resize;
}

function attachChatHistoryNav(ta, histKey) {
  // Cursor walks backwards from end (index === list.length means "fresh line").
  const navState = { index: null, draft: '' };
  ta.addEventListener('keydown', ev => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    // Only hijack arrow keys when the textarea is effectively single-line
    // (no embedded newlines) — otherwise we'd break multi-line editing.
    if (ta.value.includes('\n')) return;
    const list = loadChatHistory(histKey);
    if (list.length === 0) return;
    if (ev.key === 'ArrowUp') {
      if (navState.index === null) {
        navState.draft = ta.value;
        navState.index = list.length;
      }
      if (navState.index > 0) {
        navState.index -= 1;
        ta.value = list[navState.index];
        ev.preventDefault();
        // Place cursor at end.
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = ta.value.length; }, 0);
      }
    } else {
      if (navState.index === null) return;
      navState.index += 1;
      if (navState.index >= list.length) {
        navState.index = null;
        ta.value = navState.draft;
        navState.draft = '';
      } else {
        ta.value = list[navState.index];
      }
      ev.preventDefault();
      setTimeout(() => { ta.selectionStart = ta.selectionEnd = ta.value.length; }, 0);
    }
  });
  // Typing (or sending) resets nav state — next Arrow-up starts from the tail.
  ta.addEventListener('input', () => { navState.index = null; navState.draft = ''; });
  // Expose so send() can reset after clearing the field.
  ta._gladosHistoryReset = () => { navState.index = null; navState.draft = ''; };
}

// v4 — Retry: re-post a prior user message. Both chat surfaces register a
// retrier here keyed by their agentId; the context-menu handler on a rendered
// .user-message entry calls the right one.
const chatRetriers = new Map(); // agentId -> (msg: string) => void
function installChatRetryContextMenu(entryEl, agentId, msg) {
  entryEl.dataset.retryAgent = agentId;
  entryEl.dataset.retryMsg = msg;
  entryEl.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    const existing = document.querySelector('.chat-retry-menu');
    if (existing) existing.remove();
    const menu = document.createElement('div');
    menu.className = 'chat-retry-menu';
    menu.style.position = 'fixed';
    menu.style.left = ev.clientX + 'px';
    menu.style.top = ev.clientY + 'px';
    menu.innerHTML = `<button class="chat-retry-btn">↻ Retry this message</button>
      <button class="chat-copy-btn">📋 Copy text</button>`;
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', close, true); };
    setTimeout(() => document.addEventListener('click', close, true), 0);
    menu.querySelector('.chat-retry-btn').addEventListener('click', () => {
      const retrier = chatRetriers.get(agentId);
      if (retrier) retrier(msg);
      close();
    });
    menu.querySelector('.chat-copy-btn').addEventListener('click', () => {
      navigator.clipboard?.writeText(msg);
      close();
    });
  });
}

let composerModelsPromise = null;

function chatComposerMarkup(tabId, label, { coordinator = false } = {}) {
  const efforts = [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max'],
  ];
  return `
    <div class="chat-composer-shell" data-chat-composer data-chat-tab="${escapeHtml(tabId)}">
      <div class="chat-attachment-strip" data-chat-attachment-strip hidden></div>
      <textarea data-chat-tab="${escapeHtml(tabId)}" placeholder="Message ${escapeHtml(label)}…" aria-label="Message ${escapeHtml(label)}" rows="2"></textarea>
      <div class="chat-composer-toolbar">
        <div class="chat-composer-tools">
          <input data-chat-files type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
          <button type="button" data-chat-attach class="composer-icon-button" aria-label="Add screenshots" title="Add screenshots"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M8 12.5 13.7 6.8a3 3 0 0 1 4.2 4.2l-7.5 7.5a5 5 0 0 1-7.1-7.1l8-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          ${coordinator ? '<button type="button" data-chat-full-access class="composer-access-button" aria-pressed="false"><span class="composer-access-indicator" aria-hidden="true"></span><span data-chat-access-label>Full access</span></button>' : ''}
        </div>
        <span class="composer-keyboard-hint" aria-hidden="true">Enter to send · Shift+Enter for a new line</span>
        <div class="chat-composer-controls">
          <label class="composer-select" title="GLaDOS model">
            <span class="sr-only">Model</span>
            <select data-chat-model aria-label="Model"><option>Loading models…</option></select>
          </label>
          <label class="composer-select composer-effort" title="Reasoning effort">
            <span class="sr-only">Reasoning effort</span>
            <select data-chat-effort aria-label="Reasoning effort" disabled>${efforts.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select>
          </label>
          <button type="button" data-chat-stop data-chat-tab="${escapeHtml(tabId)}" class="composer-stop-button" title="Stop the current response" aria-label="Stop response" disabled><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
          <button type="button" data-chat-send data-chat-tab="${escapeHtml(tabId)}" class="composer-send-button" title="Send" aria-label="Send message"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>
      <p class="composer-effort-note" data-chat-effort-note hidden></p>
    </div>`;
}

function loadComposerModels() {
  if (!composerModelsPromise) {
    composerModelsPromise = fetchJson('/api/models', { timeoutMs: 16000 }).catch(error => {
      composerModelsPromise = null;
      throw error;
    });
  }
  return composerModelsPromise;
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function applyComposerEffortSupport(select, note, config, busy = false) {
  const supported = config?.effortSupported !== false;
  const message = supported ? 'Reasoning effort for new turns' : config.effortNote || 'This model deployment does not support adjustable reasoning effort. Your saved preference is preserved.';
  select.disabled = busy || !supported;
  select.title = message;
  select.closest?.('label')?.setAttribute('title', message);
  if (note) { note.hidden = supported; note.textContent = supported ? '' : message; }
}

function wireChatComposerControls(chat, { agentId, tabId, coordinator, rec }) {
  const root = chat.querySelector(`[data-chat-composer][data-chat-tab="${CSS.escape(tabId)}"]`);
  const textarea = root.querySelector('textarea');
  const fileInput = root.querySelector('[data-chat-files]');
  const attachButton = root.querySelector('[data-chat-attach]');
  const strip = root.querySelector('[data-chat-attachment-strip]');
  const modelSelect = root.querySelector('[data-chat-model]');
  const effortSelect = root.querySelector('[data-chat-effort]');
  const effortNote = root.querySelector('[data-chat-effort-note]');
  const accessButton = root.querySelector('[data-chat-full-access]');
  const selectedAttachments = rec.composerAttachments || (rec.composerAttachments = []);
  let config = null;
  let busy = false;
  rec.tabId = tabId;

  const renderAttachments = () => {
    strip.hidden = selectedAttachments.length === 0;
    strip.innerHTML = '';
    selectedAttachments.forEach((attachment, index) => {
      const item = document.createElement('div');
      item.className = 'chat-attachment-chip';
      const img = document.createElement('img');
      img.src = attachment.dataUrl;
      img.alt = '';
      const name = document.createElement('span');
      name.textContent = attachment.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${attachment.name}`);
      remove.addEventListener('click', () => { selectedAttachments.splice(index, 1); renderAttachments(); });
      item.append(img, name, remove);
      strip.appendChild(item);
    });
  };

  const addScreenshotFiles = async (files, { pasted = false } = {}) => {
    const incoming = [...(files || [])].filter(Boolean);
    if (!incoming.length) return 0;
    if (selectedAttachments.length + incoming.length > 4) throw new Error('Attach at most 4 screenshots per message.');
    const totalSize = selectedAttachments.reduce((sum, attachment) => sum + Number(attachment.size || 0), 0)
      + incoming.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalSize > 20 * 1024 * 1024) throw new Error('Screenshots may total at most 20 MB per message.');
    const startingCount = selectedAttachments.length;
    for (const file of incoming) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error(`${file.name || 'Clipboard image'} is not a supported image.`);
      if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name || 'Clipboard image'} is larger than 8 MB.`);
    }
    const prepared = await Promise.all(incoming.map(async (file, index) => {
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type] || 'png';
      const fallbackName = pasted ? `Clipboard screenshot ${startingCount + index + 1}.${extension}` : `Screenshot ${startingCount + index + 1}.${extension}`;
      return { name: file.name || fallbackName, type: file.type, size: file.size, dataUrl: await fileDataUrl(file) };
    }));
    selectedAttachments.push(...prepared);
    renderAttachments();
    return incoming.length;
  };

  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    try {
      await addScreenshotFiles(fileInput.files);
    } catch (error) {
      showToast(error.message, { kind: 'warning', label: 'Screenshots' });
    } finally {
      fileInput.value = '';
    }
  });
  textarea.addEventListener('paste', async event => {
    const items = [...(event.clipboardData?.items || [])];
    const screenshots = items
      .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    const fallbackFiles = screenshots.length ? [] : [...(event.clipboardData?.files || [])].filter(file => String(file.type || '').startsWith('image/'));
    const files = screenshots.length ? screenshots : fallbackFiles;
    if (!files.length) return;
    event.preventDefault();
    try {
      const added = await addScreenshotFiles(files, { pasted: true });
      showToast(`${added === 1 ? 'Screenshot' : `${added} screenshots`} attached.`, { kind: 'success', label: 'Clipboard' });
    } catch (error) {
      showToast(error.message, { kind: 'warning', label: 'Screenshots' });
    }
  });

  const renderAccess = fullAccess => {
    if (!accessButton) return;
    const enabled = fullAccess?.enabled === true;
    const available = fullAccess?.available !== false;
    accessButton.hidden = !available;
    accessButton.disabled = busy || !available;
    accessButton.classList.toggle('enabled', enabled);
    accessButton.setAttribute('aria-pressed', String(enabled));
    accessButton.querySelector('[data-chat-access-label]').textContent = 'Full access';
    accessButton.title = enabled ? 'Full Access is on. Click to return to restricted mode.' : 'Enable Full Access for new GLaDOS turns.';
  };

  accessButton?.addEventListener('click', async () => {
    if (busy || !config?.fullAccess?.available) return;
    const next = !config.fullAccess.enabled;
    const approved = await confirmAction({
      title: next ? 'Enable Full Access?' : 'Turn off Full Access?',
      message: next
        ? 'GLaDOS will be able to control visible apps, capture connected displays, edit requested files, and run commands without per-command prompts. Destructive or external actions still require a clear request from you, and macOS privacy permissions still apply.'
        : 'Desktop control and unrestricted command execution will be locked again for new tool calls.',
      confirmLabel: next ? 'Enable Full Access' : 'Turn Off',
      danger: next,
    });
    if (!approved) return;
    busy = true;
    renderAccess(config.fullAccess);
    try {
      const response = await fetch('/api/settings/full-access', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      config.fullAccess = { enabled: body.enabled, available: body.available };
      showToast(next ? 'Full Access is enabled for new GLaDOS turns.' : 'GLaDOS is back in restricted mode.', {
        kind: next ? 'warning' : 'success', label: 'Computer use',
      });
    } catch (error) {
      pushNotification('error', error.message, { toast: true, label: 'Computer use' });
    } finally {
      busy = false;
      renderAccess(config.fullAccess);
    }
  });

  modelSelect.addEventListener('change', async () => {
    if (!config || busy || modelSelect.value === config.model) return;
    const prior = config.model;
    const next = modelSelect.value;
    busy = true;
    modelSelect.disabled = true;
    try {
      const response = await fetch('/api/settings/agents/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [{ agentId, expectedModel: prior, model: next }] }),
      });
      const body = await response.json().catch(() => ({}));
      const result = body.results?.[0];
      if (!response.ok || !result?.ok) throw new Error(result?.error || body.error || `HTTP ${response.status}`);
      config.model = result.newModel;
      try {
        config = { ...config, ...await fetchJson(withSession(`/api/chat/${encodeURIComponent(agentId)}/composer`, rec.sessionId), { timeoutMs: 8000 }) };
        applyComposerEffortSupport(effortSelect, effortNote, config);
      } catch {
        effortSelect.disabled = true;
        effortSelect.title = 'Reopen this chat to reload reasoning support for the selected model.';
      }
      await loadAgents();
      showToast(`${agentId === 'glados' ? 'GLaDOS' : agentId} will use ${result.newModel} on the next turn.`, { kind: 'success', label: 'Model' });
    } catch (error) {
      modelSelect.value = prior;
      pushNotification('error', error.message, { toast: true, label: 'Model' });
    } finally {
      busy = false;
      modelSelect.disabled = false;
    }
  });

  effortSelect.addEventListener('change', async () => {
    if (!config || busy || config.effortSupported === false || effortSelect.value === config.effort) return;
    const prior = config.effort;
    busy = true;
    effortSelect.disabled = true;
    try {
      const response = await fetch(withSession(`/api/chat/${encodeURIComponent(agentId)}/composer`, rec.sessionId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort: effortSelect.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      config.effort = body.effort;
      showToast(`Reasoning set to ${effortSelect.options[effortSelect.selectedIndex].text} for new turns.`, { kind: 'success', label: 'Reasoning' });
    } catch (error) {
      effortSelect.value = prior;
      pushNotification('error', error.message, { toast: true, label: 'Reasoning' });
    } finally {
      busy = false;
      applyComposerEffortSupport(effortSelect, effortNote, config);
    }
  });

  renderAttachments();
  Promise.all([
    fetchJson(withSession(`/api/chat/${encodeURIComponent(agentId)}/composer`, rec.sessionId), { timeoutMs: 8000 }),
    loadComposerModels(),
  ]).then(([nextConfig, catalog]) => {
    config = nextConfig;
    const models = [...new Set([config.model, ...(catalog.models || [])].filter(Boolean))];
    modelSelect.innerHTML = models.map(model => `<option value="${escapeHtml(model)}"${model === config.model ? ' selected' : ''}>${escapeHtml(model)}</option>`).join('');
    modelSelect.disabled = !catalog.available || !models.length;
    modelSelect.title = catalog.available ? `Model for ${agentId}` : (catalog.message || 'Model catalog unavailable');
    if (Array.isArray(config.effortLevels)) {
      const labels = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
      effortSelect.innerHTML = config.effortLevels.filter(value => Object.hasOwn(labels, value))
        .map(value => `<option value="${value}">${labels[value]}</option>`).join('');
    }
    effortSelect.value = config.effort || 'high';
    applyComposerEffortSupport(effortSelect, effortNote, config);
    renderAccess(config.fullAccess);
  }).catch(error => {
    modelSelect.innerHTML = '<option>Models unavailable</option>';
    modelSelect.disabled = true;
    showToast(`Chat controls could not load: ${error.message}`, { kind: 'warning', label: 'Composer' });
  });

  return {
    hasAttachments: () => selectedAttachments.length > 0,
    takeAttachments: () => {
      const payload = selectedAttachments.map(({ name, type, size, dataUrl }) => ({ name, type, size, data: dataUrl }));
      selectedAttachments.splice(0, selectedAttachments.length);
      renderAttachments();
      return payload;
    },
    transcriptAttachments: attachments => attachments.map(row => ({ name: row.name, mimeType: row.type, size: row.size, dataUrl: row.data })),
  };
}

function renderLegacyChatPane() {
  const chat = document.createElement('div');
  chat.className = 'chat-pane chat-visual-chamber';
  const toolbar = createAgentViewToolbar('glados');
  chat.appendChild(toolbar);
  const transcript = document.createElement('div');
  transcript.className = 'transcript';
  const sendingEl = document.createElement('div');
  sendingEl.className = 'sending-indicator';
  sendingEl.id = 'sending-indicator';
  sendingEl.style.display = 'none';
  sendingEl.textContent = 'GLaDOS is thinking…';
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input';
  inputRow.innerHTML = chatComposerMarkup('glados-chat', 'GLaDOS', { coordinator: true });
  chat.appendChild(transcript);
  chat.appendChild(sendingEl);
  chat.appendChild(inputRow);
  paneEl.appendChild(chat);
  syncAgentViewToolbars('glados');

  const tabId = 'glados-chat';
  const rec = ensureTranscript(tabId, 'glados');
  rec.el = transcript;
  rec.autoScroll = true;
  attachScrollTracker(transcript, rec);
  for (const ev of rec.events) appendEntry(transcript, ev, rec);
  setTimeout(() => focusTranscriptProvenance(rec), 0);
  scrollToBottom(transcript, rec);
  updateSendingIndicator(tabId);
  refreshChatTurnStatus(tabId, 'glados');

  // Shared dispatcher — used by the Send button, Cmd+Enter, the slash-menu,
  // and the right-click Retry action. `override` bypasses the textarea read
  // (retry passes the prior message directly).
  const ta = chatElement(chat, 'textarea', tabId);
  const composer = wireChatComposerControls(chat, { agentId: 'glados', tabId, coordinator: true, rec });
  const dispatch = (override) => {
    const msg = override !== undefined ? override : (ta.value.trim() || (composer.hasAttachments() ? 'Please review the attached screenshot.' : ''));
    if (!msg) return;
    // Slash commands are handled locally against dashboard REST; they don't
    // go to the agent session.
    if (msg.startsWith('/')) {
      if (override === undefined) { ta.value = ''; ta.focus(); }
      runSlashCommand(msg, rec);
      return;
    }
    if (override === undefined) {
      ta.value = '';
      ta.focus();
      ta._gladosHistoryReset?.();
      ta._gladosAutoGrow?.();
    }
    pushChatHistory('glados', msg);
    const attachments = override === undefined ? composer.takeAttachments() : [];

    const clientId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      kind: 'user-message',
      text: msg,
      ts: Date.now(),
      _optimistic: true,
      clientId,
      attachments: composer.transcriptAttachments(attachments),
    };
    rec.events.push(optimistic);
    rec.pendingUserMessages.push({ clientId, text: msg, ts: optimistic.ts });
    rec.autoScroll = true;
    if (rec.el && rec.el.isConnected) appendEntry(rec.el, optimistic, rec);

    rec.sending = true;
    rec.activity = 'waiting';
    rec.turnStartedAt = Date.now();
    rec.turnAgeMs = 0;
    rec.firstTokenSeenAt = null;
    rec.completedAt = null;
    updateSendingIndicator(tabId);

    // The POST now durably admits the prompt and returns immediately. The
    // potentially long Agent SDK turn continues in the server and streams via
    // SSE, so quitting the UI cannot erase an accepted operator message.
    fetch('/api/chat/glados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, attachments, client_id: clientId, session_id: state.currentSessionId }),
    }).then(r => r.json()).then(j => {
      if (!j.ok) {
        logEvent('error', 'chat error: ' + (j.error || 'unknown'));
        finishTranscriptTurn(rec, tabId);
      }
      // On success, sending remains active until the terminal SDK result or
      // server turn status arrives. Progress text is not turn completion.
    }).catch(e => {
      logEvent('error', 'chat exception: ' + e.message);
      finishTranscriptTurn(rec, tabId);
    });
  };
  const send = () => dispatch();
  const stop = () => stopChatTurnFromUi(tabId, 'glados');
  chatRetriers.set('glados', (msg) => dispatch(msg));
  chat.querySelector('[data-chat-send]').addEventListener('click', send);
  chat.querySelector('[data-chat-stop]').addEventListener('click', stop);
  attachChatHistoryNav(ta, 'glados');
  attachAutoGrow(ta, {});
  attachSlashMenu(ta, inputRow, line => { ta.value = line; send(); });
  ta.addEventListener('keydown', ev => {
    if (ev.defaultPrevented) return;
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
}

function chatElement(root, selector, tabId) {
  return root?.querySelector(`${selector}[data-chat-tab="${CSS.escape(tabId)}"]`) || null;
}

function refreshChatFind(chat, { advance = 0 } = {}) {
  const bar = chat?.querySelector('.chat-find-bar');
  if (!bar || bar.hidden) return;
  const query = bar.querySelector('input').value.trim().toLocaleLowerCase();
  const transcript = chat.querySelector('.transcript');
  transcript.querySelectorAll('.entry.find-current').forEach(entry => entry.classList.remove('find-current'));
  const matches = query ? [...transcript.querySelectorAll('.entry')].filter(entry => {
    if (getComputedStyle(entry).display === 'none') return false;
    return (entry.textContent || '').toLocaleLowerCase().includes(query);
  }) : [];
  let index = Number(bar.dataset.findIndex || 0);
  if (advance) index += advance;
  index = matches.length ? (index + matches.length) % matches.length : 0;
  bar.dataset.findIndex = String(index);
  bar.querySelector('.chat-find-count').textContent = query ? `${matches.length ? index + 1 : 0} of ${matches.length}` : 'Type to search';
  const current = matches[index];
  if (current) {
    current.classList.add('find-current');
    const history = current.closest('.work-history');
    if (history) history.open = true;
    current.querySelectorAll('details').forEach(details => { details.open = true; });
    const rec = state.transcripts.get(state.currentTab);
    if (rec) rec.autoScroll = false;
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function closeChatFind(chat) {
  const bar = chat?.querySelector('.chat-find-bar');
  if (!bar) return;
  bar.hidden = true;
  chat.querySelectorAll('.entry.find-current').forEach(entry => entry.classList.remove('find-current'));
  if (bar.returnFocus?.isConnected) bar.returnFocus.focus();
  else chat.querySelector('textarea')?.focus();
}

function openChatFind(chat) {
  const bar = chat?.querySelector('.chat-find-bar');
  if (!bar) return;
  if (bar.hidden) bar.returnFocus = document.activeElement;
  bar.hidden = false;
  const input = bar.querySelector('input');
  input.focus();
  input.select();
  refreshChatFind(chat);
}

function renderAgentChatSurface(agentId, tabId, coordinator, options = {}) {
  const label = options.label || (coordinator ? currentTeamName() : agentDisplayName(agentId));
  const chat = document.createElement('div');
  chat.className = 'chat-pane chat-visual-chamber';
  if (coordinator && !state.currentSessionId) {
    chat.classList.add('chat-new-session');
    const draftHeader = document.createElement('div');
    draftHeader.className = 'draft-conversation-header';
    draftHeader.innerHTML = newSessionTeamPickerMarkup();
    chat.appendChild(draftHeader);
  }
  chat.dataset.agent = agentId;
  chat.style.setProperty('--agent-feed-label', JSON.stringify(`${String(label).toUpperCase()} / CHAMBER FEED`));
  if (!options.hideToolbar) chat.appendChild(createAgentViewToolbar(agentId));

  const findBar = document.createElement('div');
  findBar.className = 'chat-find-bar';
  findBar.hidden = true;
  findBar.innerHTML = '<label>Find in conversation <input type="search" autocomplete="off" aria-label="Find in conversation" /></label><span class="chat-find-count">Type to search</span><button type="button" data-find-previous aria-label="Previous result">↑</button><button type="button" data-find-next aria-label="Next result">↓</button><button type="button" data-find-close aria-label="Close find">×</button>';
  chat.appendChild(findBar);

  const transcript = document.createElement('div');
  transcript.className = 'transcript';
  if (coordinator && !state.currentSessionId) transcript.innerHTML = '<div class="new-session-welcome"><h1>What are we working on?</h1></div>';
  const sendingEl = document.createElement('div');
  sendingEl.className = 'sending-indicator';
  sendingEl.dataset.chatTab = tabId;
  sendingEl.style.display = 'none';
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input';
  inputRow.innerHTML = chatComposerMarkup(tabId, label, { coordinator: coordinator && agentId === 'glados' });
  chat.append(transcript, sendingEl, inputRow);
  (options.container || paneEl).appendChild(chat);
  chat.querySelector('[data-new-session-team]')?.addEventListener('change', event => selectDraftTeam(event.target.value).catch(error => showToast(error.message, { kind: 'warning', label: 'Teams' })));
  findBar.querySelector('input').addEventListener('input', () => { findBar.dataset.findIndex = '0'; refreshChatFind(chat); });
  findBar.querySelector('input').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); refreshChatFind(chat, { advance: event.shiftKey ? -1 : 1 }); }
    if (event.key === 'Escape') { event.preventDefault(); closeChatFind(chat); }
  });
  findBar.querySelector('[data-find-previous]').addEventListener('click', () => refreshChatFind(chat, { advance: -1 }));
  findBar.querySelector('[data-find-next]').addEventListener('click', () => refreshChatFind(chat, { advance: 1 }));
  findBar.querySelector('[data-find-close]').addEventListener('click', () => closeChatFind(chat));
  syncAgentViewToolbars(agentId);

  const rec = ensureTranscript(tabId, agentId, options);
  if (coordinator && !state.currentSessionId && state.teamChangeDraft) rec.composerAttachments = state.teamChangeDraft.attachments || [];
  rec.el = transcript;
  rec.autoScroll = true;
  attachScrollTracker(transcript, rec);
  for (const ev of rec.events) appendEntry(transcript, ev, rec);
  setTimeout(() => focusTranscriptProvenance(rec), 0);
  scrollToBottom(transcript, rec);
  updateSendingIndicator(tabId);
  refreshChatTurnStatus(tabId, agentId);

  const ta = chatElement(chat, 'textarea', tabId);
  if (rec.composerDraft) ta.value = rec.composerDraft;
  ta.addEventListener('input', () => { rec.composerDraft = ta.value; });
  if (coordinator && !state.currentSessionId && state.teamChangeDraft) { ta.value = state.teamChangeDraft.text || ''; state.teamChangeDraft = null; }
  const composer = wireChatComposerControls(chat, { agentId, tabId, coordinator, rec });
  let dispatching = false;
  const dispatch = async override => {
    const msg = override !== undefined ? override : (ta.value.trim() || (composer.hasAttachments() ? 'Please review the attached screenshot.' : ''));
    if (!msg || dispatching || rec.sending || (!options.sessionId && state.sessionActivationPending)) return;
    if (coordinator && activeTeam()?.available === false) { showToast('Enable this agent or team before sending a message.', { kind: 'info', label: 'Agents' }); return; }
    dispatching = true;
    try {
      const sessionId = options.sessionId || await materializeDraftSession();
      if (!sessionId || (!options.sessionId && sessionId !== state.currentSessionId) || state.transcripts.get(tabId) !== rec) return;
    } catch (error) {
      pushNotification('error', error.message, { toast: true, label: 'New session' });
      return;
    } finally { dispatching = false; }
    const sessionId = options.sessionId || state.currentSessionId;
    if (coordinator && agentId === 'glados' && msg.startsWith('/')) {
      if (override === undefined) { ta.value = ''; ta.focus(); }
      runSlashCommand(msg, rec);
      return;
    }
    if (override === undefined) {
      ta.value = '';
      rec.composerDraft = '';
      ta.focus();
      ta._gladosHistoryReset?.();
      ta._gladosAutoGrow?.();
    }
    pushChatHistory(agentId, msg);
    const attachments = override === undefined ? composer.takeAttachments() : [];
    const clientId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = { kind: 'user-message', text: msg, ts: Date.now(), _optimistic: true, clientId, attachments: composer.transcriptAttachments(attachments) };
    rec.events.push(optimistic);
    rec.pendingUserMessages.push({ clientId, text: msg, ts: optimistic.ts });
    rec.autoScroll = true;
    if (rec.el?.isConnected) appendEntry(rec.el, optimistic, rec);
    rec.sending = true;
    rec.activity = 'waiting';
    rec.turnStartedAt = Date.now();
    rec.turnAgeMs = 0;
    rec.firstTokenSeenAt = null;
    rec.completedAt = null;
    updateSendingIndicator(tabId);
    fetch(`/api/chat/${encodeURIComponent(agentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, attachments, client_id: clientId, session_id: sessionId }),
    }).then(async response => ({ response, body: await response.json().catch(() => ({})) })).then(({ response, body }) => {
      if (!response.ok || !body.ok) {
        pushNotification('error', body.error || `${label} could not start`, { toast: true, label: 'Agent chat' });
        finishTranscriptTurn(rec, tabId);
      }
    }).catch(error => {
      pushNotification('error', `${label} chat failed: ${error.message}`, { toast: true, label: 'Agent chat' });
      finishTranscriptTurn(rec, tabId);
    });
  };
  chatRetriers.set(tabId, msg => dispatch(msg));
  chat.querySelector('[data-chat-send]').addEventListener('click', () => dispatch());
  chat.querySelector('[data-chat-stop]').addEventListener('click', () => stopChatTurnFromUi(tabId, agentId));
  attachChatHistoryNav(ta, agentId);
  attachAutoGrow(ta, {});
  if (coordinator && agentId === 'glados') attachSlashMenu(ta, inputRow, line => { ta.value = line; dispatch(); });
  ta.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); dispatch(); }
  });
  return chat;
}

function renderChatPane() {
  const coordinatorId = activeCoordinatorId();
  if (!coordinatorId) { paneEl.innerHTML = '<div class="pane-empty">This session’s team is unavailable. Start a new session to choose another team.</div>'; return; }
  renderAgentChatSurface(coordinatorId, 'glados-chat', true);
}

async function stopChatTurnFromUi(tabId, agentId) {
  const rec = state.transcripts.get(tabId);
  if (!rec?.sending) return;
  rec.activity = 'stopping';
  updateSendingIndicator(tabId);
  const btn = document.querySelector(`[data-chat-stop][data-chat-tab="${CSS.escape(tabId)}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const r = await fetch(withSession(`/api/chat/${encodeURIComponent(agentId)}/stop`, rec.sessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'dashboard stop button', session_id: rec.sessionId || state.currentSessionId }),
    });
    const j = await r.json().catch(() => ({}));
    logEvent(j.stopped ? 'ended' : 'meta', j.stopped ? `stopped ${agentId}` : `${agentId} was not running`);
  } catch (e) {
    logEvent('error', `stop ${agentId} failed: ${e.message}`);
  } finally {
    finishTranscriptTurn(rec, tabId);
  }
}

function updateChatInputControls(tabId) {
  const rec = state.transcripts.get(tabId);
  if (state.currentTab !== (rec?.viewTabId || tabId)) return;
  const stopBtn = document.querySelector(`[data-chat-stop][data-chat-tab="${CSS.escape(tabId)}"]`);
  const sendBtn = document.querySelector(`[data-chat-send][data-chat-tab="${CSS.escape(tabId)}"]`);
  if (!stopBtn) return;
  const stopping = rec?.activity === 'stopping';
  stopBtn.disabled = !rec?.sending || stopping;
  stopBtn.textContent = stopping ? '…' : '■';
  if (sendBtn) {
    const unavailable = tabId === 'glados-chat' && activeTeam()?.available === false;
    sendBtn.disabled = !!rec?.sending || unavailable;
    sendBtn.title = unavailable ? 'Enable this agent or team before sending a message' : 'Send';
    sendBtn.hidden = !!rec?.sending;
  }
}

function updateSendingIndicator(tabId) {
  const rec = state.transcripts.get(tabId);
  if (state.currentTab !== (rec?.viewTabId || tabId)) return;
  const el = document.querySelector(`.sending-indicator[data-chat-tab="${CSS.escape(tabId)}"]`);
  if (!el) return;
  el.style.display = rec?.sending ? 'block' : 'none';
  if (rec?.sending) el.textContent = transcriptStatusText(rec, agentDisplayName(rec.agentId));
  updateChatInputControls(tabId);
}

function scrollToBottom(container, rec) {
  scheduleStickyScroll(container, rec);
  // Also schedule a late catch-up for the async SSE backfill that lands
  // after initial render — after 300ms most of the buffer has arrived.
  setTimeout(() => {
    if (!container.isConnected) return;
    if (rec?.autoScroll === false) return;
    container.scrollTop = container.scrollHeight;
  }, 300);
  setTimeout(() => {
    if (!container.isConnected) return;
    if (rec?.autoScroll === false) return;
    container.scrollTop = container.scrollHeight;
  }, 1200);
}

const COLLAPSE_LEN = 500;

function renderCollapsible(text, extraClass = '') {
  const safe = escapeHtml(text || '');
  if ((text || '').length <= COLLAPSE_LEN) {
    return `<pre class="${extraClass}">${safe}</pre>`;
  }
  return `<pre class="collapsible open ${extraClass}">${safe}</pre><span class="expand-toggle">▾ collapse</span>`;
}

// v4: Markdown rendering for assistant-text entries.
// Pipes text through `marked` + `DOMPurify`, retargets links, and attaches
// copy buttons to code blocks. Falls back to plain <pre> if libs unavailable.
function renderMarkdown(text, extraClass = '') {
  const src = String(text || '');
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    // Graceful fallback — never break chat if CDN is down.
    return renderCollapsible(src, extraClass);
  }
  try {
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
    const rawHtml = marked.parse(src);
    const clean = DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    });
    const long = src.length > COLLAPSE_LEN;
    const cls = `md-content ${extraClass} ${long ? 'collapsible open' : ''}`.trim();
    const toggle = long
      ? '<span class="expand-toggle">▾ collapse</span>'
      : '';
    return `<div class="${cls}">${clean}</div>${toggle}`;
  } catch (_) {
    return renderCollapsible(src, extraClass);
  }
}

// Post-process a rendered markdown container: open links in new tab,
// attach copy buttons to fenced code blocks. Idempotent — safe to re-run.
function enhanceMarkdownContent(container, { clippySources = false, source = null } = {}) {
  if (!container) return;
  container.querySelectorAll('a[href]').forEach(a => {
    const reference = clippySourceReference(a.getAttribute('href'), { allowRelative: clippySources, source });
    if (reference) {
      // Keep a stable same-origin citation even after a desktop restart changes
      // the dashboard port. Reading happens only when the analyst opens it.
      a.setAttribute('href', clippySourceHref(reference));
      a.removeAttribute('target');
      a.setAttribute('title', `Read Clippy source: ${reference.path}`);
      if (!a.dataset.clippySourceWired) {
        a.dataset.clippySourceWired = 'true';
        a.addEventListener('click', event => {
          event.preventDefault();
          const current = clippySourceReference(a.getAttribute('href'));
          if (current) openClippySourcePreview(current);
        });
      }
      return;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  container.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (!pre || pre.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.textContent = 'copy';
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const text = code.innerText || code.textContent || '';
      navigator.clipboard?.writeText(text).then(
        () => { btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); },
        () => { btn.textContent = '✗ failed'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); }
      );
    });
    pre.appendChild(btn);
  });
}

function addAskGladosAction(entry, responseText, rec) {
  if (!entry || rec?.agentId !== 'glados') return;
  entry.querySelector('.ask-glados-action')?.remove();
  const action = document.createElement('div');
  action.className = 'ask-glados-action';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Ask GLaDOS';
  button.title = 'Ask GLaDOS to elaborate and explain this response more clearly';
  button.addEventListener('click', () => {
    const excerpt = String(responseText || '').trim().slice(0, 12_000);
    if (!excerpt) return;
    (chatRetriers.get('glados-chat') || chatRetriers.get('glados'))?.(
      `Please elaborate on the response below and explain it in a more understandable way. Preserve the important technical details.\n\n${excerpt}`
    );
  });
  action.appendChild(button);
  entry.appendChild(action);
}

function extractEventUrl(ev) {
  const source = ev?.arguments ?? ev?.toolInput ?? ev?.text ?? '';
  const text = typeof source === 'string' ? source : JSON.stringify(source);
  const matches = text.match(/https?:\/\/[^\s"'<>)}\]]+/ig) || [];
  if (!matches.length) return null;
  const external = matches.filter(value => {
    try { return !['127.0.0.1', 'localhost', '::1'].includes(new URL(value).hostname); }
    catch { return true; }
  });
  const candidates = external.length ? external : matches;
  return candidates[candidates.length - 1];
}

function openRelatedTraffic(agentId, ev, sessionId = state.currentSessionId) {
  const url = extractEventUrl(ev);
  if (!url) return;
  let host = '';
  try { host = new URL(url).hostname; } catch { host = url; }
  if (!sessionId) return;
  GladosProxyWorkspace.focus(sessionId, { agentId, url, host, ts: transcriptEventMs(ev) || Date.now() });
  openProxy({ sessionId });
}

function focusTranscriptProvenance(rec) {
  const focus = state.provenanceFocus;
  if (!focus || !rec?.el || focus.agentId !== rec.agentId) return;
  const host = (() => { try { return new URL(focus.url).hostname; } catch { return focus.url || ''; } })();
  const candidates = [...rec.el.querySelectorAll('.entry.tool-call')];
  if (!candidates.length) return;
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestHasHost = false;
  for (const node of candidates) {
    const text = node.textContent || '';
    const nodeTs = Number(node.dataset.eventTs || 0);
    const hasHost = !!(host && text.includes(host));
    const urlPenalty = hasHost ? 0 : 120_000;
    const timePenalty = nodeTs && focus.ts ? Math.abs(nodeTs - focus.ts) : 60_000;
    const score = urlPenalty + timePenalty;
    if (score < bestScore) { best = node; bestScore = score; bestHasHost = hasHost; }
  }
  state.provenanceFocus = null;
  if (!best || (!bestHasHost && bestScore > 240_000)) {
    showToast(`Opened ${focus.agentId}; no matching transcript tool call was retained.`, { kind: 'warning', label: 'Related traffic' });
    return;
  }
  rec.autoScroll = false;
  best.classList.add('provenance-focus');
  best.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => best.classList.remove('provenance-focus'), 4500);
}

function openAgentProvenance(row) {
  const agentId = row?.agentTag;
  if (!agentId || !state.agents.some(agent => agent.id === agentId)) {
    showToast('This request does not have a recognized GLaDOS agent tag.', { kind: 'warning', label: 'Related transcript' });
    return;
  }
  state.provenanceFocus = { agentId, url: row.url || '', ts: Number(row.ts) || Date.parse(row.ts || '') || Date.now(), proxyId: row.id };
  if (agentId === activeCoordinatorId()) openGladosChat();
  else openAgentTab(agentId);
  for (const delay of [100, 500, 1500]) {
    setTimeout(() => focusTranscriptProvenance(state.transcripts.get(tabIdForAgent(agentId))), delay);
  }
  setTimeout(() => {
    if (!state.provenanceFocus || state.provenanceFocus.proxyId !== row.id) return;
    state.provenanceFocus = null;
    showToast(`Opened ${agentId}; no matching transcript tool call was retained.`, { kind: 'warning', label: 'Related traffic' });
  }, 3000);
}

// Public work previews are derived only from tool events, never thinking text.
function sanitizeWorkPreview(value, limit = 240) {
  let text = String(value ?? '').slice(0, 12000);
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]');
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, match => {
    try {
      const url = new URL(match);
      url.username = ''; url.password = '';
      const query = !!url.search || !!url.hash;
      url.search = ''; url.hash = '';
      return `${url.toString()}${query ? '[query omitted]' : ''}`;
    } catch { return '[URL omitted]'; }
  });
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+\/_=.:-]+/gi, '[authorization redacted]');
  text = text.replace(/((?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|client[_-]?secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
  text = text.replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:=)(?:"[^"]*"|'[^']*'|[^\s;]+)/g, '[assignment omitted]');
  text = text.replace(/(?:--?(?:password|passwd|token|api[_-]?key|secret|credential|authorization|cookie|user)|-u)\s+(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '[credential argument omitted]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_+\/-]{40,}={0,2})\b/g, '[opaque value omitted]');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function safeWorkCommand(command) {
  // Keep an executable, familiar subcommands, and file references. Arbitrary
  // command text/positional arguments can contain keys and are never echoed.
  const tokens = String(command || '').split(/[\n\r]/, 1)[0].match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  const executable = (tokens.shift() || '').replace(/^['"]|['"]$/g, '').split('/').pop();
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,40}$/.test(executable || '')) return 'Command (arguments omitted)';
  const safeWords = new Set(['run', 'test', 'build', 'check', 'lint', 'typecheck', 'diff', 'status', 'log', 'show', 'rev-parse', 'branch', 'version', 'install', 'ci', 'pytest', 'node:test']);
  const selected = [];
  for (let index = 0; index < tokens.length && selected.length < 5; index++) {
    const token = tokens[index].replace(/^['"]|['"]$/g, '');
    if (/^(?:--?(?:password|passwd|token|api[_-]?key|secret|credential|header|cookie|user)|-u|-H|--data(?:-raw|-binary)?|-d)$/i.test(token)) { index++; continue; }
    if (/^[;&|<>`]/.test(token) || token.includes('$(')) break;
    if (safeWords.has(token) || /^(?:--check|--stat|--name-only|--version|--test|--no-emit|-n|-l|-a|-m|-q)$/.test(token)) selected.push(token);
    else if (/^(?:\.{0,2}\/)?[A-Za-z0-9_.\/-]+\.(?:js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|json|md|css|html|sh|test|spec)$/i.test(token) && !/(?:token|secret|password|credential)/i.test(token)) selected.push(token);
  }
  return sanitizeWorkPreview([executable, ...selected, tokens.length > selected.length ? '…' : ''].filter(Boolean).join(' '), 150);
}

function sanitizeWorkInput(value, depth = 0) {
  if (depth > 4) return '[nested content omitted]';
  if (typeof value === 'string') return sanitizeWorkPreview(value, 350);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => sanitizeWorkInput(item, depth + 1));
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value).slice(0, 25)) {
    if (/authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|private[_-]?key|session[_-]?(?:id|key)|^(?:key|auth)$/i.test(key)) result[key] = '[redacted]';
    else if (/^(?:command|cmd|shell)$/i.test(key)) result[key] = safeWorkCommand(entry);
    else if (/^(?:body|content|old_string|new_string|code|script|prompt|headers|env|environment|stdin|input_data|args)$/i.test(key)) result[key] = '[content omitted]';
    else result[key] = sanitizeWorkInput(entry, depth + 1);
  }
  return result;
}

function workActivitySpec(call = {}, result = null) {
  const name = String(call.toolName || result?.toolName || 'Tool');
  const input = call.arguments || call.toolInput || {};
  const lower = name.toLowerCase();
  let category = 'tool', icon = '◇', label = 'Use tool';
  if (/browser|playwright|chrome|navigate|screenshot|computer|cua/.test(lower)) { category = 'browser'; icon = '◉'; label = 'Use browser'; }
  else if (/(?:^|__)(?:read|glob|grep|search|list|find)(?:$|_|file)|readfile|read_file|file_read/.test(lower)) { category = 'read'; icon = '▤'; label = /search|grep|glob|find/.test(lower) ? 'Search files' : 'Read files'; }
  else if (/edit|write|patch|notebook/.test(lower)) { category = 'edit'; icon = '✎'; label = 'Edit files'; }
  else if (/bash|shell|exec|terminal|command/.test(lower)) { category = 'command'; icon = '›_'; label = 'Run command'; }
  else if (/^(?:agent|task)$/.test(lower) || call.targetAgentId || /(?:^|__)(?:dispatch_agent|delegate_agent|spawn_agent|agent_dispatch)$/.test(lower)) { category = 'delegation'; icon = '↗'; label = 'Delegate work'; }
  else if (/^mcp__/.test(lower)) { category = 'mcp'; icon = '⌁'; label = 'Query connector'; }
  // MCP tool names describe the connector even when their action is read/search.
  if (/^mcp__/.test(lower) && category !== 'browser' && category !== 'delegation') { category = 'mcp'; icon = '⌁'; label = 'Use connector'; }
  const path = input.file_path || input.path || input.file || input.cwd || input.workdir || '';
  const target = category === 'command' ? safeWorkCommand(input.command || input.cmd || input.shell || '')
    : category === 'delegation' ? call.targetAgentId || input.subagent_type || input.agent || input.description || name
    : category === 'mcp' ? name.replace(/^mcp__/, '').replace(/__/g, ' · ')
    : category === 'browser' ? input.url || input.action || input.title || name
    : path || input.pattern || input.query || name;
  const error = result?.isError === true || Number(result?.exitCode || 0) !== 0;
  const state = result ? error ? 'error' : 'completed' : 'running';
  const outputSize = typeof result?.text === 'string' ? result.text.length : 0;
  const safeInput = sanitizeWorkInput(input);
  const details = [`Tool: ${sanitizeWorkPreview(name)}`, Object.keys(safeInput || {}).length ? `Input preview:\n${JSON.stringify(safeInput, null, 2)}` : '', result ? `Outcome: ${error ? 'Failed' : 'Completed'}${result.exitCode !== undefined ? ` · exit ${Number(result.exitCode)}` : ''}${Number.isFinite(result.durationMs) ? ` · ${result.durationMs}ms` : ''}` : 'Outcome: Running', outputSize ? `Tool output: ${outputSize.toLocaleString()} characters (raw output available in Debug).` : '', error ? `Error preview: ${sanitizeWorkPreview(result.text || result.error || 'Tool failed', 350)}` : ''].filter(Boolean).join('\n\n');
  return { category, icon, label, target: sanitizeWorkPreview(target, 150), state, details: sanitizeWorkPreview(details, 2400) };
}

function appendWorkActivity(container, ev, rec) {
  const kind = ev.kind;
  if (!['tool-call', 'tool-result', 'permission-denied', 'liveness'].includes(kind)) return null;
  if (kind === 'liveness' && !ev.toolCallId && !ev.taskId) return null;
  const id = String(ev.toolCallId || ev.toolUseId || ev.taskId || ev.id || '');
  let row = id ? [...container.querySelectorAll('.work-activity')].find(node => node.dataset.workId === id) : null;
  const prior = row?._workActivity || {};
  const savedCall = rec?.events?.find(event => event.kind === 'tool-call' && String(event.toolCallId || event.toolUseId || event.id || '') === id);
  const call = kind === 'tool-call' ? ev : prior.call || savedCall || { toolName: ev.toolName || (kind === 'liveness' ? 'Agent' : 'Tool'), targetAgentId: ev.subagentType };
  let result = kind === 'tool-result' ? ev : prior.result || null;
  // A background Agent launch acknowledgement is not completion. The paired
  // lifecycle event closes the activity when the delegated task actually ends.
  const backgroundAck = kind === 'tool-result' && /^Subagent launched\.?$/i.test(String(ev.text || '').trim()) && workActivitySpec(call).category === 'delegation';
  if (backgroundAck) result = null;
  if (kind === 'permission-denied') result = { ...ev, isError: true, text: ev.decisionReason || ev.text || 'Permission denied' };
  if (kind === 'liveness' && ev.live === false) result = { ...ev, isError: /error|failed/i.test(ev.state || ''), text: '' };
  if (!row) {
    row = document.createElement('div');
    row.dataset.workId = id;
    row.dataset.eventTs = String(transcriptEventMs(ev) || Date.now());
    if (rec?.agentId) row.dataset.agent = rec.agentId;
    container.appendChild(row);
  }
  row._workActivity = { call, result, background: prior.background || backgroundAck || call.toolInput?.run_in_background === true || call.arguments?.run_in_background === true };
  const spec = workActivitySpec(call, result);
  const expanded = row.querySelector('details')?.open === true;
  row.className = `entry work-activity work-${spec.category}${spec.state === 'error' ? ' error' : ''}`;
  row.dataset.workState = spec.state;
  const status = spec.state === 'running' ? 'Running' : spec.state === 'error' ? 'Failed' : 'Done';
  row.innerHTML = `<details class="work-details"${expanded ? ' open' : ''}><summary><span class="work-icon" aria-hidden="true">${spec.icon}</span><span class="work-label">${escapeHtml(spec.label)}</span><span class="work-target">${escapeHtml(spec.target)}</span><span class="work-status">${status}</span></summary><pre class="work-detail-preview">${escapeHtml(spec.details)}</pre></details>`;
  return row;
}

function finishWorkActivities(rec, terminal = null) {
  if (!rec?.el) return;
  const cutoff = transcriptEventMs(terminal);
  for (const row of rec.el.querySelectorAll('.work-activity')) {
    if (row.dataset.workState !== 'running' || row._workActivity?.background) continue;
    if (cutoff && Number(row.dataset.eventTs || 0) > cutoff) continue;
    row.dataset.workState = 'unavailable';
    const status = row.querySelector('.work-status');
    if (status) status.textContent = 'Ended';
    const detail = row.querySelector('.work-detail-preview');
    if (detail) detail.textContent = detail.textContent.replace('Outcome: Running', 'Outcome: Turn ended before a tool result was recorded.');
  }
}

// Fold only at an authoritative turn boundary. Public progress remains live
// while tools run; private traces retain their normal Debug visibility even
// when an operator expands this history.
function compactCompletedWork(container, terminal, rec) {
  if (!container?.children || !container.insertBefore) return;
  const boundaryId = String(terminal.id || `work-terminal:${transcriptEventMs(terminal)}`);
  const children = [...container.children];
  if (children.some(node => node.dataset.workBoundary === boundaryId)) return;
  const cutoff = transcriptEventMs(terminal);
  let start = 0;
  for (let i = 0; i < children.length; i++) {
    if (children[i].dataset.workBoundary || children[i].classList.contains('user-message')) start = i + 1;
  }
  const rows = children.slice(start).filter(node => node.classList.contains('entry') && (!cutoff || Number(node.dataset.eventTs || node.dataset.streamTs || 0) <= cutoff));
  const lastTool = rows.findLastIndex(node => node.classList.contains('tool-call') || node.classList.contains('work-activity'));
  const lastAnswer = rows.findLastIndex(node => node.classList.contains('assistant-text'));
  const failed = terminal.outcome === 'error' || terminal.outcome === 'stopped' || rows.some(node => node.classList.contains('prompt-error'));
  const answer = !failed && lastAnswer > lastTool ? rows[lastAnswer] : null;
  const runningIds = new Set(rows.filter(node => node.classList.contains('work-activity') && node.dataset.workState === 'running').map(node => node.dataset.workId));
  const previous = rows.filter(node => node !== answer && !node.classList.contains('prompt-error') && !node.classList.contains('operator-event') && !node.classList.contains('permission-denied') && !runningIds.has(node.dataset.workId || node.dataset.toolCallId));
  const updates = previous.filter(node => node.classList.contains('assistant-text') || node.classList.contains('work-activity')).length;
  if (updates) {
    const history = document.createElement('details');
    history.className = 'work-history';
    history.dataset.historyId = boundaryId;
    history.dataset.expanded = String(rec?.workHistoryExpanded?.has(boundaryId) || false);
    const summary = document.createElement('summary');
    summary.textContent = `${updates} previous update${updates === 1 ? '' : 's'}`;
    history.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'work-history-content';
    history.appendChild(body);
    history.addEventListener('toggle', () => {
      if (debugModeEl.checked || errorsOnlyEl.checked) return;
      history.dataset.expanded = String(history.open);
      if (rec) {
        rec.workHistoryExpanded ||= new Set();
        if (history.open) rec.workHistoryExpanded.add(boundaryId);
        else rec.workHistoryExpanded.delete(boundaryId);
      }
    });
    container.insertBefore(history, previous[0]);
    for (const node of previous) body.appendChild(node);
    applyWorkHistoryMode(history);
  }
  const boundary = document.createElement('span');
  boundary.hidden = true;
  boundary.dataset.workBoundary = boundaryId;
  container.appendChild(boundary);
}

function appendEntry(container, ev, rec) {
  if (ev.kind === 'result' && !ev.isError) return;
  if (ev.kind === 'work-turn-ended') {
    finishWorkActivities(rec || { el: container }, ev);
    compactCompletedWork(container, ev, rec);
    return;
  }
  if (rec?.independentSession) container.querySelector?.('.clippy-chat-welcome')?.remove();
  appendWorkActivity(container, ev, rec);
  const el = document.createElement('div');
  const kind = ev.kind;
  const classes = ['entry', kind];
  if (kind === 'tool-result' && ev.isError) classes.push('error');
  if (kind === 'operator-event' && ev.halted === true) classes.push('halt-event');
  if (kind === 'operator-event' && ev.halted === false) classes.push('resume-event');
  if (ev._optimistic) classes.push('optimistic');
  el.className = classes.join(' ');
  if (ev.id || ev.dashboardEventId) el.dataset.eventId = String(ev.id || ev.dashboardEventId);
  el.dataset.eventTs = String(transcriptEventMs(ev) || Date.now());
  if (ev.toolCallId || ev.toolUseId) el.dataset.toolCallId = String(ev.toolCallId || ev.toolUseId);
  // Stamp the owning agent so CSS can show "user/<agent>-input" and label the
  // assistant bubble with the agent's name ("glados", "webapp-recon", etc.).
  if (rec?.agentId) el.dataset.agent = rec.agentId;
  const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';

  if (kind === 'assistant-text') {
    // v4: markdown for assistant output (bold, code, links, lists, headers).
    el.innerHTML = `<span class="ts">${ts}</span>${renderMarkdown(displayTranscriptText(ev.text || ''))}`;
    enhanceMarkdownContent(el, { clippySources: rec?.agentId === 'pkg-clippy-intel--clippy' });
    addAskGladosAction(el, displayTranscriptText(ev.text || ''), rec);
  } else if (kind === 'thinking' || kind === 'user-message') {
    const displayText = kind === 'thinking' ? displayTranscriptText(ev.text || '') : (ev.text || '');
    el.innerHTML = `<span class="ts">${ts}</span>${renderCollapsible(displayText)}`;
    if (kind === 'user-message') {
      el.dataset.messageText = ev.text || '';
      el.dataset.operatorInitials = state.operatorProfile.initials || 'You';
      if (ev.clientId) el.dataset.clientId = ev.clientId;
      if (Array.isArray(ev.attachments) && ev.attachments.length) {
        const gallery = document.createElement('div');
        gallery.className = 'entry-attachments';
        for (const attachment of ev.attachments) {
          const figure = document.createElement('figure');
          const src = attachment.dataUrl || attachment.url;
          if (src) {
            const img = document.createElement('img');
            img.src = src;
            img.alt = attachment.name || 'Attached screenshot';
            img.loading = 'lazy';
            figure.appendChild(img);
          }
          const caption = document.createElement('figcaption');
          caption.textContent = attachment.name || 'Screenshot';
          figure.appendChild(caption);
          gallery.appendChild(figure);
        }
        el.appendChild(gallery);
      }
    }
    // v4: right-click a user message to retry. Only on surfaces that
    // registered a retrier (GLaDOS chat) — agent transcripts
    // don't have a retrier because they're not user-driven.
    const retryKey = rec?.tabId || rec?.agentId;
    if (kind === 'user-message' && retryKey && chatRetriers.has(retryKey)) {
      installChatRetryContextMenu(el, retryKey, ev.text || '');
    }
  } else if (kind === 'tool-call') {
    const args = ev.arguments !== undefined
      ? JSON.stringify(ev.arguments, null, 2)
      : (ev.toolInput !== undefined ? JSON.stringify(ev.toolInput, null, 2) : '');
    el.innerHTML = `<details class="tool-details" ${debugModeEl.checked ? 'open' : ''}><summary><span class="tool-name">→ ${escapeHtml(ev.toolName || '?')}</span><span class="ts">${ts}</span></summary><div class="tool-details-body">${renderCollapsible(args, 'args')}</div></details>`;
    const targetUrl = extractEventUrl(ev);
    if (targetUrl && rec?.agentId) {
      const traffic = document.createElement('button');
      traffic.type = 'button';
      traffic.className = 'entry-related-action';
      traffic.textContent = 'View related traffic';
      traffic.title = `Open proxy traffic for ${targetUrl}`;
      traffic.addEventListener('click', event => {
        event.stopPropagation();
        openRelatedTraffic(rec.agentId, ev, rec.sessionId || state.currentSessionId);
      });
      el.appendChild(traffic);
    }
  } else if (kind === 'tool-result') {
    const header = ev.isError ? '✗ error' : '← result';
    const extra = (ev.exitCode !== undefined ? ` exit=${ev.exitCode}` : '') +
                  (ev.durationMs !== undefined ? ` ${ev.durationMs}ms` : '');
    // v4: show an explicit "[body truncated]" affordance when the tool
    // result exceeds our 8KB preview cap instead of silently slicing. The
    // full text is held on the event; clicking the button re-renders with
    // the full string in place.
    const fullText = ev.text || '';
    const TRUNC_CAP = 8000;
    const isTruncated = fullText.length > TRUNC_CAP;
    const displayed = isTruncated ? fullText.slice(0, TRUNC_CAP) : fullText;
    const truncNote = isTruncated
      ? `<div class="truncation-note"><button class="truncation-load-btn" type="button">[body truncated at 8KB — click to load full ${fullText.length.toLocaleString()} chars]</button></div>`
      : '';
    el.innerHTML = `<details class="tool-details" ${debugModeEl.checked || (errorsOnlyEl.checked && ev.isError) ? 'open' : ''}><summary><span class="tool-name">${header} ${escapeHtml(ev.toolName || '?')}${extra}</span><span class="ts">${ts}</span></summary><div class="tool-details-body">${renderCollapsible(displayed, 'out')}${truncNote}</div></details>`;
    if (isTruncated) {
      const btn = el.querySelector('.truncation-load-btn');
      btn?.addEventListener('click', () => {
        // Find the collapsible pre we just rendered and swap in the full text.
        const pre = el.querySelector('pre.collapsible');
        if (!pre) return;
        pre.textContent = fullText;
        pre.classList.add('open');
        const toggle = el.querySelector('.expand-toggle');
        if (toggle) toggle.textContent = '▾ collapse';
        btn.parentElement?.remove();
      });
    }
  } else if (kind === 'meta') {
    el.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(JSON.stringify(ev))}`;
  } else if (kind === 'operator-event') {
    const label = ev.halted === true ? 'Operator halt' : (ev.halted === false ? 'Operator resume' : 'Operator action');
    el.innerHTML = `<span class="ts">${ts}</span><span class="operator-event-label">${label}</span>` +
      `<span>${escapeHtml(ev.text || '')}</span>`;
  } else if (kind === 'harness-init') {
    const serverText = Array.isArray(ev.mcpServers)
      ? ev.mcpServers.map(s => `${s.name}:${s.status || 'unknown'}`).join(' ')
      : '';
    el.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(ev.text || 'Agent SDK initialized')}` +
      (serverText ? `<pre>${escapeHtml(serverText)}</pre>` : '');
  } else if (kind === 'liveness') {
    el.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(ev.text || ev.state || 'liveness update')}`;
  } else if (kind === 'permission-denied') {
    el.innerHTML = `<span class="ts">${ts}</span><span class="tool-name">permission denied ${escapeHtml(ev.toolName || '')}</span>` +
      renderCollapsible(ev.text || ev.decisionReason || '', 'out');
  } else if (kind === 'session-start') {
    el.innerHTML = `<span class="ts">${ts}</span>session started (${escapeHtml(ev.cwd || '')})`;
  } else if (kind === 'prompt-error') {
    // Hard failure from the upstream LLM provider (idle timeout, auth error,
    // etc.). Without this, the transcript just stops producing events and
    // looks like an infinite hang. Show a loud red block explaining what
    // actually happened so the user can act.
    const hint = /idle timeout/i.test(ev.error || '')
      ? ' — upstream LLM proxy dropped the connection before Claude streamed a token. Fix on proxy side (raise idle/read timeout) or break the request into smaller turns.'
      : '';
    el.innerHTML = `<span class="ts">${ts}</span><span class="tool-name">✗ LLM PROMPT ERROR</span>` +
      `<pre style="white-space:pre-wrap; margin:4px 0 0;">${escapeHtml(ev.error || '')}${escapeHtml(hint)}\n\n` +
      `provider: ${escapeHtml(ev.provider || '?')}\nmodel: ${escapeHtml(ev.model || '?')}\napi: ${escapeHtml(ev.api || '?')}</pre>`;
  } else {
    el.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(JSON.stringify(ev))}`;
  }

  const toggle = el.querySelector('.expand-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const collapsibleTarget = el.querySelector('.md-content.collapsible, pre.collapsible');
      if (!collapsibleTarget) return;
      const isOpen = collapsibleTarget.classList.toggle('open');
      toggle.textContent = isOpen ? '▾ collapse' : `▸ expand (${(collapsibleTarget.textContent || '').length.toLocaleString()} chars)`;
    });
  }

  container.appendChild(el);
  if (kind === 'prompt-error') {
    finishWorkActivities(rec || { el: container }, ev);
    compactCompletedWork(container, workTurnBoundary(rec, ev), rec);
  }
  if (rec?.agentId && ['assistant-text', 'tool-call', 'tool-result', 'prompt-error', 'permission-denied'].includes(kind)) {
    const detail = kind === 'assistant-text' ? ''
      : kind === 'tool-call' ? `Used ${ev.toolName || 'a tool'}`
      : kind === 'tool-result' ? (ev.isError ? `Tool error: ${ev.toolName || 'unknown'}` : `Tool finished: ${ev.toolName || 'unknown'}`)
      : kind === 'permission-denied' ? 'Permission denied' : 'Prompt failed';
    noteAgentActivity(rec.agentId, detail, {
      status: state.active.has(rec.agentId) ? 'running' : 'done',
      at: ev.ts || Date.now(),
    });
    scheduleAgentActivityRefresh();
  }
  if (kind === 'tool-call' && state.provenanceFocus?.agentId === rec?.agentId) {
    setTimeout(() => focusTranscriptProvenance(rec), 0);
  }
  if (rec?.autoScroll !== false) scheduleStickyScroll(container, rec);
}

// Coalesce multiple appends in a single frame into one scroll — otherwise
// the rapid SSE backfill schedules dozens of rAFs and the final layout is
// settled after the last one, but scrollHeight lies mid-flight.
function scheduleStickyScroll(container, rec) {
  if (rec && rec._scrollQueued) return;
  if (rec) rec._scrollQueued = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (rec) rec._scrollQueued = false;
      if (!container.isConnected) return;
      if (rec?.autoScroll === false) return;
      container.scrollTop = container.scrollHeight;
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function logEvent(kind, text) {
  const el = document.createElement('div');
  el.className = 'event-line ' + kind;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  eventsEl.appendChild(el);
  while (eventsEl.children.length > 200) eventsEl.removeChild(eventsEl.firstChild);
  eventsEl.scrollTop = eventsEl.scrollHeight;
  if (ALERT_KINDS.has(kind)) {
    pushNotification(kind, text, { unread: true });
  }
}

// Proxy health banner. Startup only warns when the selected proxy backend
// reports a real problem.
const healthBannerState = { dismissedSig: null, lastSig: null, notifiedSig: null };
let dashboardRestartNotice = null;
async function fetchDashboardHealth() {
  try {
    const response = await fetch('/api/health/proxy', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (browserError) {
    if (!window.gladosDesktop?.getDashboardHealth) throw browserError;
    return window.gladosDesktop.getDashboardHealth();
  }
}
async function refreshHealthBanner() {
  const banner = document.getElementById('health-banner');
  const msg = document.getElementById('health-banner-msg');
  if (!banner || !msg) return;
  let data;
  try {
    data = await fetchDashboardHealth();
  } catch {
    banner.classList.remove('hidden');
    msg.textContent = dashboardRestartNotice || 'Dashboard cannot reach its own health endpoint';
    if (dashboardRestartNotice) return;
    if (healthBannerState.notifiedSig !== 'dashboard-health-unreachable') {
      healthBannerState.notifiedSig = 'dashboard-health-unreachable';
      pushNotification('offline', msg.textContent, { toast: true, label: 'System health' });
    }
    return;
  }

  if (data.healthy && !data.stale) {
    banner.classList.add('hidden');
    healthBannerState.lastSig = 'ok';
    healthBannerState.notifiedSig = null;
    return;
  }

  const issues = [];
  const backend = data.backend || 'proxy';
  if (data.error) issues.push(data.error);

  const sig = issues.join('|');
  healthBannerState.lastSig = sig;
  if (sig === healthBannerState.dismissedSig) return;

  msg.textContent = `Proxy health (${backend}): ${issues.join(' · ') || 'unknown failure'}`;
  banner.classList.remove('hidden');
  if (sig && healthBannerState.notifiedSig !== sig) {
    healthBannerState.notifiedSig = sig;
    pushNotification('offline', msg.textContent, { toast: true, label: 'Proxy health' });
  }
}

function setupHealthBanner() {
  const detailsBtn = document.getElementById('health-details-btn');
  const dismissBtn = document.getElementById('health-dismiss-btn');

  detailsBtn?.addEventListener('click', async () => {
    try {
      const data = await fetchDashboardHealth();
      await showDialog({ title: 'Proxy health details', message: JSON.stringify(data, null, 2), confirmLabel: 'Close', detail: true });
    } catch (e) { pushNotification('error', 'Health fetch failed: ' + e.message, { toast: true, label: 'Proxy health' }); }
  });

  dismissBtn?.addEventListener('click', () => {
    healthBannerState.dismissedSig = healthBannerState.lastSig;
    document.getElementById('health-banner')?.classList.add('hidden');
  });

  refreshHealthBanner();
  setInterval(refreshHealthBanner, 5_000);
}

if (window.gladosDesktop?.onDashboardExit) {
  window.gladosDesktop.onDashboardExit(info => {
    const delay = Math.max(1, Math.ceil(Number(info?.delayMs || 1000) / 1000));
    dashboardRestartNotice = info?.restarting
      ? `Dashboard worker stopped and will restart automatically in ${delay}s`
      : 'Dashboard worker stopped';
    const banner = document.getElementById('health-banner');
    const msg = document.getElementById('health-banner-msg');
    if (banner && msg) {
      msg.textContent = dashboardRestartNotice;
      banner.classList.remove('hidden');
    }
  });
}

// Lobby event stream — session-started / session-ended -> auto-open tab.
function subscribeLobby() {
  try { state._lobbySource?.close(); } catch {}
  const es = new EventSource(withSession('/api/agents/stream'));
  state._lobbySource = es;
  es.addEventListener('investigation-session-updated', async () => {
    try {
      await loadInvestigationSessions();
    } catch {}
  });
  es.addEventListener('investigation-projects-changed', () => refreshInvestigationNavigationSoon());
  es.addEventListener('investigation-session-deleted', async () => {
    try { await loadInvestigationSessions(); if (state.currentTab === 'glados-chat') renderPane(); } catch {}
  });
  es.addEventListener('investigation-session-changed', async () => {
    try { await loadInvestigationSessions(); } catch {}
  });
  es.addEventListener('agent-library-changed', async () => {
    try {
      await loadAgentTeams();
      await Promise.all([loadAgents(), refreshAgentLibraryCatalog()]);
      refreshDraftTeamOptions();
      const wrap = document.querySelector('.agent-library-pane');
      if (wrap && state.agentLibrary.view === 'collection') {
        const list = wrap.querySelector('[data-package-list]');
        if (list) { list.innerHTML = agentCollectionCards(state.agentLibrary.catalog); wirePackageCollection(list, wrap); }
        const count = wrap.querySelector('[data-package-count]');
        if (count) count.textContent = state.agentLibrary.catalog.packages.length || '';
      }
    } catch {}
  });
  es.addEventListener('agent-teams-changed', async () => {
    try { await loadAgentTeams(); await loadAgents(); syncPackageInvocationControls(); refreshDraftTeamOptions(); } catch {}
  });
  es.addEventListener('connectors-changed', async () => {
    try {
      const [catalog] = await Promise.all([fetchJson('/api/connectors'), loadAgents()]);
      state.connectorLibrary.catalog = catalog;
      if (state.agentLibrary.catalog) state.agentLibrary.catalog.connectors = catalog.connectors;
      syncPackageInvocationControls();
      state.clippyDashboard.repoOptions = null;
      state.clippyDashboard.repoOptionsAt = 0;
      if (state.currentTab === 'clippy') renderPane();
      const wrap = document.querySelector('.connectors-pane');
      if (wrap) drawConnectorCollection(wrap, catalog.connectors || [], async () => {
        const fresh = await fetchJson('/api/connectors');
        state.connectorLibrary.catalog = fresh;
        if (wrap.isConnected) drawConnectorCollection(wrap, fresh.connectors || [], () => renderPane());
      });
    } catch {}
  });
  es.addEventListener('snapshot', e => {
    if (!state.currentSessionId) return;
    const arr = JSON.parse(e.data);
    for (const a of arr) {
      if (a.investigationSessionId && a.investigationSessionId !== state.currentSessionId) continue;
      state.active.set(a.agentId, { sessionId: a.sessionId });
      if (state.agentActivity.get(a.agentId)?.status !== 'running') noteAgentActivity(a.agentId, 'Session active', { startedAt: a.startedAt });
      if (a.agentId !== activeCoordinatorId() && !state.openTabs.find(t => t.id === a.agentId)) {
        ensureAgentTab(a.agentId);
      }
    }
    renderAgentList();
  });
  es.addEventListener('session-started', e => {
    const info = JSON.parse(e.data);
    refreshInvestigationNavigationSoon();
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    state.active.set(info.agentId, { sessionId: info.sessionId });
    noteAgentActivity(info.agentId, 'Session started', { startedAt: info.startedAt });
    logEvent('started', `${info.agentId} session-started`);
    renderAgentList();
    if (info.agentId !== activeCoordinatorId() && !state.openTabs.find(t => t.id === info.agentId)) {
      ensureAgentTab(info.agentId);
    }
  });
  es.addEventListener('session-ended', e => {
    const info = JSON.parse(e.data);
    refreshInvestigationNavigationSoon();
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    state.active.delete(info.agentId);
    noteAgentActivity(info.agentId, 'Session finished', { status: 'done' });
    logEvent('ended', `${info.agentId} session-ended`);
    renderAgentList();
  });
  es.addEventListener('session-reset', e => {
    const info = JSON.parse(e.data);
    refreshInvestigationNavigationSoon();
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    if (!info.agentId) return;
    clearTranscriptTab(tabIdForAgent(info.agentId));
    state.active.delete(info.agentId);
    noteAgentActivity(info.agentId, 'Session reset', { status: 'done' });
    logEvent('ended', `${info.agentId} session-reset`);
    renderAgentList();
    if (state.currentTab === tabIdForAgent(info.agentId)) renderPane();
  });
  es.addEventListener('runtime-refresh', e => {
    let info = {};
    try { info = JSON.parse(e.data); } catch {}
    if (info.resetAll) clearRuntimeTranscriptState(info.agentIds || []);
    applyRuntimeSurfaceRefresh(info);
    logEvent('ended', 'runtime refreshed');
  });
  es.addEventListener('agent-liveness', e => {
    const info = JSON.parse(e.data);
    if (!info.agentId) return;
    refreshInvestigationNavigationSoon();
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    if (info.live) {
      state.active.set(info.agentId, { sessionId: info.sessionId || info.state || 'live' });
      if (state.agentActivity.get(info.agentId)?.status !== 'running') noteAgentActivity(info.agentId, 'Agent active', { startedAt: info.startedAt });
      if (info.agentId !== activeCoordinatorId() && !state.openTabs.find(t => t.id === info.agentId)) {
        ensureAgentTab(info.agentId);
      }
    } else {
      state.active.delete(info.agentId);
      noteAgentActivity(info.agentId, 'Agent finished', { status: 'done' });
    }
    renderAgentList();
  });
  es.addEventListener('halt', e => {
    const { agentId, reason, investigationSessionId } = JSON.parse(e.data);
    if (investigationSessionId && investigationSessionId !== state.currentSessionId) return;
    setAgentHaltedState(agentId, true);
    logEvent('ended', `HALT ${agentId}${reason ? ' — ' + reason : ''}`);
  });
  es.addEventListener('resume', e => {
    const { agentId, investigationSessionId } = JSON.parse(e.data);
    if (investigationSessionId && investigationSessionId !== state.currentSessionId) return;
    setAgentHaltedState(agentId, false);
    logEvent('started', `resume ${agentId}`);
  });
  es.addEventListener('chat-turn-started', e => {
    let data = {}; try { data = JSON.parse(e.data); } catch {}
    if (data.investigationSessionId && state.unreadCompletedSessionIds.delete(data.investigationSessionId)) persistUnreadCompletedSessions();
    refreshInvestigationNavigationSoon();
    if (data.investigationSessionId && data.investigationSessionId !== state.currentSessionId) return;
    const tabId = data.agentId === activeCoordinatorId() ? 'glados-chat' : null;
    if (!tabId) return;
    state.active.set(data.agentId, { sessionId: data.turnId || 'chat-turn' });
    noteAgentActivity(data.agentId, 'Thinking', { startedAt: data.startedAt });
    renderAgentList();
    syncAgentViewToolbars(data.agentId);
    const rec = state.transcripts.get(tabId);
    if (rec) {
      rec.sending = true;
      rec.activity = rec.activity || 'waiting';
      rec.turnStartedAt = data.startedAt || rec.turnStartedAt || Date.now();
      rec.turnAgeMs = null;
      rec.completedAt = null;
      updateSendingIndicator(tabId);
    }
    logEvent('started', `${data.agentId || 'agent'} turn started`);
  });
  es.addEventListener('chat-turn-ended', e => {
    let data = {}; try { data = JSON.parse(e.data); } catch {}
    if (isSessionCoordinatorEvent(data)) markBackgroundSessionCompleted(data.investigationSessionId);
    refreshInvestigationNavigationSoon();
    if (data.investigationSessionId && data.investigationSessionId !== state.currentSessionId) return;
    const tabId = data.agentId === activeCoordinatorId() ? 'glados-chat' : null;
    if (!tabId) return;
    state.active.delete(data.agentId);
    noteAgentActivity(data.agentId, 'Turn complete', { status: 'done' });
    renderAgentList();
    syncAgentViewToolbars(data.agentId);
    const rec = state.transcripts.get(tabId);
    if (rec?.sending) {
      rec.activity = 'finalizing';
      updateSendingIndicator(tabId);
      setTimeout(() => {
        if (rec.sending && rec.activity === 'finalizing') finishTranscriptTurn(rec, tabId);
      }, 2500);
    }
    logEvent('ended', `${data.agentId || 'agent'} turn ended`);
  });
  es.addEventListener('operator-profile-changed', e => {
    try { state.operatorProfile = JSON.parse(e.data); } catch { return; }
    if (state.currentTab === 'glados-chat' || state.agents.some(agent => state.currentTab === agent.id)) renderPane();
  });
  // v4 — Plan-approval workflow lifecycle events.
  for (const type of ['plan-pending','plan-approved','plan-rejected','plan-modified','plan-ended','plan-complete']) {
    es.addEventListener(type, e => {
      let data = {}; try { data = JSON.parse(e.data); } catch {}
      logEvent(type === 'plan-pending' ? 'started' : (type === 'plan-rejected' || type === 'plan-ended' ? 'ended' : 'ok'),
        `${type} ${data.id || data.new_id || data.old_id || ''}`);
      if (type === 'plan-pending') showToast('A plan is waiting for operator approval.', { kind: 'pending', label: 'Plan approval' });
      refreshPlansBadge();
    });
  }
  es.addEventListener('plan-replan-proposed', e => {
    let data = {}; try { data = JSON.parse(e.data); } catch {}
    logEvent('started', `replan proposed #${data.proposal_id || '?'} finding #${data.finding_id || '?'}`);
    refreshPlansBadge();
  });
  es.addEventListener('plan-replan-resolved', e => {
    let data = {}; try { data = JSON.parse(e.data); } catch {}
    logEvent(data.state === 'accepted' ? 'ok' : 'ended', `replan proposal #${data.proposal_id || '?'} -> ${data.state || '?'}`);
    refreshPlansBadge();
  });
  es.addEventListener('target-health', e => {
    const info = JSON.parse(e.data);
    logEvent(info.state === 'healthy' ? 'started' : 'ended',
      `probe ${info.target_url || '?'} → ${info.state} (${info.status})`);
  });
}

// --- Reports ---

async function renderReportsPane() {
  const wrap = document.createElement('div');
  wrap.className = 'reports-pane';
  wrap.innerHTML = `
    <aside class="reports-library">
      <div class="reports-library-header">
        <div class="reports-library-title-row">
          <div>
            <span class="reports-eyebrow">Workspace</span>
            <h1>Reports</h1>
            <p>Browse, edit, and organize deliverables.</p>
          </div>
          <button type="button" class="report-refresh" id="reports-refresh" title="Refresh report library" aria-label="Refresh report library">↻</button>
        </div>
        <div class="reports-library-summary" id="reports-summary" aria-live="polite">
          <span><strong>—</strong> records</span><span><strong>—</strong> categories</span>
        </div>
        <div class="report-search-field">
          <span class="report-search-icon" aria-hidden="true"></span>
          <input id="reports-search" type="search" placeholder="Search reports" autocomplete="off" aria-label="Search reports" />
          <button type="button" id="reports-search-clear" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <div class="report-source-tabs" role="tablist" aria-label="Report source">
          <button type="button" role="tab" data-report-scope="all"><span>All</span><b data-report-count="all">0</b></button>
          <button type="button" role="tab" data-report-scope="reports"><span>Published reports</span><b data-report-count="reports">0</b></button>
          <button type="button" role="tab" data-report-scope="security-reviews"><span>Security reviews</span><b data-report-count="security-reviews">0</b></button>
          <button type="button" role="tab" data-report-scope="investigations"><span>Investigations</span><b data-report-count="investigations">0</b></button>
        </div>
      </div>
      <div class="reports-tree" id="reports-tree"><div class="report-tree-loading">Loading reports...</div></div>
    </aside>
    <div class="report-viewer" id="report-viewer">
      <div class="report-empty report-empty-welcome"><span aria-hidden="true"></span><strong>Choose a report</strong><p>Select a file from the library to preview it here.</p></div>
    </div>`;
  paneEl.appendChild(wrap);

  const searchEl = wrap.querySelector('#reports-search');
  const clearEl = wrap.querySelector('#reports-search-clear');
  const refreshEl = wrap.querySelector('#reports-refresh');
  searchEl.value = state.reports.query;
  clearEl.hidden = !state.reports.query;
  refreshEl.addEventListener('click', () => renderPane());

  try {
    const j = await fetchJson('/api/reports/tree', { timeoutMs: 30000, retries: 1 });
    const treeEl = wrap.querySelector('#reports-tree');
    const summaryEl = wrap.querySelector('#reports-summary');
    const tree = j.tree || [];
    state.reports.tree = tree;
    const totalRecords = countReportRecords(tree);
    const totalCollections = tree.length;
    summaryEl.innerHTML = `<span><strong>${totalRecords.toLocaleString()}</strong> ${totalRecords === 1 ? 'record' : 'records'}</span><span><strong>${totalCollections}</strong> ${totalCollections === 1 ? 'category' : 'categories'}</span>`;
    wrap.querySelectorAll('[data-report-count]').forEach(counter => {
      const scope = counter.dataset.reportCount;
      const count = scope === 'all' ? totalRecords : countReportRecords(tree.filter(node => node.path === scope));
      counter.textContent = count.toLocaleString();
    });
    const renderTree = () => {
      const visibleTree = filterReportTree(tree, state.reports.query, state.reports.scope);
      treeEl.innerHTML = '';
      if (!visibleTree.length) {
        treeEl.innerHTML = '<div class="report-tree-empty">No matching files</div>';
        return;
      }
      const ul = document.createElement('ul');
      ul.className = 'report-tree-root';
      ul.appendChild(buildTreeNodes(visibleTree, { forceOpen: Boolean(state.reports.query) }));
      treeEl.appendChild(ul);
    };

    const syncScopeControls = () => {
      wrap.querySelectorAll('[data-report-scope]').forEach(button => {
        const active = button.dataset.reportScope === state.reports.scope;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    };

    searchEl.addEventListener('input', () => {
      state.reports.query = searchEl.value.trim();
      clearEl.hidden = !state.reports.query;
      renderTree();
    });
    clearEl.addEventListener('click', () => {
      state.reports.query = '';
      searchEl.value = '';
      clearEl.hidden = true;
      searchEl.focus();
      renderTree();
    });
    wrap.querySelectorAll('[data-report-scope]').forEach(button => {
      button.addEventListener('click', () => {
        state.reports.scope = button.dataset.reportScope;
        syncScopeControls();
        renderTree();
      });
    });

    syncScopeControls();
    renderTree();

    if (state.reports.selectedPath) {
      const selectedEl = [...treeEl.querySelectorAll('.file')]
        .find(el => el.dataset.path === state.reports.selectedPath || JSON.parse(el.dataset.formats || '[]').includes(state.reports.selectedPath));
      loadReport(state.reports.selectedPath, selectedEl);
    }
  } catch (e) {
    wrap.querySelector('#reports-tree').innerHTML = `<div class="report-tree-error">Could not load reports<br><span>${escapeHtml(e.message)}</span></div>`;
  }
}

function countReportFiles(nodes) {
  return nodes.reduce((total, node) => total + (node.type === 'file' ? 1 : countReportFiles(node.children || [])), 0);
}

function reportCollectionRecordCount(node) {
  if (!node || node.type !== 'dir') return 0;
  return (node.children || []).filter(child => child.path !== 'reports/REPORT-TEMPLATE.md').length;
}

function countReportRecords(nodes) {
  return (nodes || []).reduce((total, node) => total + reportCollectionRecordCount(node), 0);
}

function filterReportTree(nodes, query, scope = 'all') {
  const needle = String(query || '').trim().toLowerCase();
  const scoped = scope === 'all' ? nodes : nodes.filter(node => node.path === scope);

  function visit(node) {
    const ownMatch = !needle || `${node.name} ${node.displayName || ''} ${node.path || ''}`.toLowerCase().includes(needle);
    if (node.type === 'file') return ownMatch ? node : null;
    if (!needle || ownMatch) return node;
    const children = (node.children || []).map(visit).filter(Boolean);
    return children.length ? { ...node, children } : null;
  }

  return scoped.map(visit).filter(Boolean);
}

function reportFileType(node) {
  const fileName = node.fileName || node.path?.split('/').at(-1) || node.name || '';
  const ext = String(fileName).split('.').pop();
  if (!ext || ext === fileName) return 'FILE';
  return ext.slice(0, 4).toUpperCase();
}

function formatReportSize(bytes) {
  const size = Math.max(0, Number(bytes || 0));
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatReportDate(value) {
  const date = new Date(typeof value === 'string' && !/^\d+$/.test(value) ? value : Number(value || 0));
  if (!Number.isFinite(date.getTime()) || !value) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function reportEntryCanEdit(relPath) {
  const value = String(relPath || '');
  return /\.md$/i.test(value)
    && !value.startsWith('security-reviews/')
    && !/^investigations\/[^/]+\/security-review(?:\/|$)/.test(value);
}

function reportEntryCanMove(relPath) {
  const value = String(relPath || '');
  return /^(?:reports|investigations)\/.+/.test(value)
    && !/^investigations\/[^/]+$/.test(value)
    && !/^investigations\/[^/]+\/security-review(?:\/|$)/.test(value);
}

function reportMoveDestinations(sourcePath, type) {
  const key = String(sourcePath || '').split('/')[0];
  const currentParent = String(sourcePath || '').split('/').slice(0, -1).join('/');
  const options = [];
  const visit = (nodes, depth = 0) => {
    for (const node of nodes || []) {
      if (node.type !== 'dir' || !String(node.path || '').startsWith(`${key}`)) continue;
      const insideSource = type === 'dir' && (node.path === sourcePath || node.path.startsWith(`${sourcePath}/`));
      if (!insideSource && node.path !== currentParent) options.push({ path: node.path, name: node.name, depth });
      if (!insideSource) visit(node.children || [], depth + 1);
    }
  };
  visit(state.reports.tree.filter(node => node.path === key));
  return options;
}

function showReportMoveDialog(sourcePath, name, type) {
  const destinations = reportMoveDestinations(sourcePath, type);
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const options = destinations.map(item => `<option value="${escapeHtml(item.path)}">${escapeHtml(`${'  '.repeat(Math.max(0, item.depth))}${item.name}`)}</option>`).join('');
    backdrop.innerHTML = `<section class="app-modal report-move-modal" role="dialog" aria-modal="true" aria-labelledby="report-move-title">
      <header><div><h2 id="report-move-title">Move ${type === 'dir' ? 'folder' : 'report'}</h2><small>${escapeHtml(name)}</small></div><button type="button" data-modal-close aria-label="Close">×</button></header>
      <div class="app-modal-copy"><label class="report-move-field"><span>Destination</span><select aria-label="Move destination" ${destinations.length ? '' : 'disabled'}>${options || '<option>No other folders are available</option>'}</select></label><p>Items stay inside their current collection. Existing links to the previous path may need to be updated.</p></div>
      <footer><button type="button" data-modal-cancel>Cancel</button><button type="button" data-modal-confirm class="safe" ${destinations.length ? '' : 'disabled'}>Move</button></footer>
    </section>`;
    const finish = value => { backdrop.remove(); resolve(value); };
    backdrop.querySelector('[data-modal-close]').addEventListener('click', () => finish(null));
    backdrop.querySelector('[data-modal-cancel]').addEventListener('click', () => finish(null));
    backdrop.querySelector('[data-modal-confirm]').addEventListener('click', () => finish(backdrop.querySelector('select').value));
    backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(null); });
    root.replaceChildren(backdrop);
    (destinations.length ? backdrop.querySelector('select') : backdrop.querySelector('[data-modal-cancel]')).focus();
  });
}

async function moveReportEntry(relPath, name, type) {
  const destination = await showReportMoveDialog(relPath, name, type);
  if (!destination) return;
  const response = await fetch('/api/reports/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relPath, destination }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'move failed');
  if (state.reports.selectedPath === relPath || state.reports.selectedPath?.startsWith(`${relPath}/`)) {
    state.reports.selectedPath = `${body.path}${state.reports.selectedPath.slice(relPath.length)}`;
  }
  showToast(`${name} moved.`, { kind: 'success', label: 'Reports' });
  renderPane();
}

async function renameReportEntry(relPath, currentName) {
  const name = await showNameInput({
    title: 'Rename report entry', value: currentName, confirmLabel: 'Rename',
    label: 'File or folder name', placeholder: currentName,
  });
  if (!name || name === currentName) return;
  const response = await fetch('/api/reports/file', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relPath, name }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'rename failed');
  if (state.reports.selectedPath === relPath || state.reports.selectedPath?.startsWith(`${relPath}/`)) {
    state.reports.selectedPath = body.alias ? state.reports.selectedPath : `${body.path}${state.reports.selectedPath.slice(relPath.length)}`;
  }
  renderPane();
}

async function deleteReportEntry(relPath, name, type) {
  const collection = !String(relPath || '').includes('/');
  const securityReview = /^security-reviews\/[^/]+$/.test(relPath);
  const investigation = /^investigations\/[^/]+$/.test(relPath);
  const title = collection ? 'Clear report collection' : securityReview ? 'Delete security review' : investigation ? 'Delete investigation' : type === 'dir' ? 'Delete folder' : 'Delete report';
  const label = collection ? 'Clear collection' : securityReview ? 'Delete review' : investigation ? 'Delete investigation' : type === 'dir' ? 'Delete folder' : 'Delete report';
  const message = collection
    ? `Permanently delete every object in ${name}? The collection itself will remain available. This cannot be undone.`
    : `Permanently delete ${relPath}${type === 'dir' ? ' and every file inside it' : ''}? This cannot be undone.`;
  if (!await confirmAction({ title, message, confirmLabel: label, danger: true })) return;
  const response = await fetch('/api/reports/file?path=' + encodeURIComponent(relPath), { method: 'DELETE' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'delete failed');
  if (state.reports.selectedPath === relPath || state.reports.selectedPath?.startsWith(`${relPath}/`)) state.reports.selectedPath = null;
  renderPane();
}

function reportTreeActionMenu(node, type, openEntry) {
  const wrap = document.createElement('div');
  wrap.className = 'report-row-actions';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'report-row-menu-trigger';
  trigger.title = `Actions for ${node.name}`;
  trigger.setAttribute('aria-label', trigger.title);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.textContent = '•••';
  const menu = document.createElement('div');
  menu.className = 'report-row-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  const actions = [];
  if (type === 'file') actions.push(['open', 'Open']);
  if (type === 'file' && reportEntryCanEdit(node.path)) actions.push(['edit', 'Edit']);
  if (reportEntryCanMove(node.path)) actions.push(['move', 'Move to…']);
  actions.push(['rename', 'Rename'], ['delete', type === 'dir' ? 'Delete folder' : 'Delete']);
  for (const [kind, label] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind === 'delete' ? 'danger' : '';
    button.dataset.reportAction = kind;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<span aria-hidden="true">${kind === 'open' ? '↗' : kind === 'edit' ? '✎' : kind === 'move' ? '→' : kind === 'rename' ? 'Aa' : '×'}</span>${escapeHtml(label)}`;
    button.addEventListener('click', async event => {
      event.stopPropagation();
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      try {
        if (kind === 'open') await openEntry(false);
        else if (kind === 'edit') await openEntry(true);
        else if (kind === 'move') await moveReportEntry(node.path, node.name, type);
        else if (kind === 'rename') await renameReportEntry(node.path, node.name);
        else await deleteReportEntry(node.path, node.name, type);
      } catch (error) {
        pushNotification('error', `${label.replace('…', '')} failed: ${error.message}`, { toast: true, label: 'Reports' });
      }
    });
    menu.appendChild(button);
  }
  trigger.addEventListener('click', event => {
    event.stopPropagation();
    document.querySelectorAll('.report-row-menu:not([hidden])').forEach(other => {
      if (other !== menu) other.hidden = true;
    });
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => document.addEventListener('click', () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }, { once: true }), 0);
  });
  wrap.append(trigger, menu);
  return wrap;
}

function reportPresentationNodes(nodes) {
  const fullReport = nodes.filter(node => node.documentKey === 'full-report');
  const details = nodes.filter(node => node.technical || node.sourceData);
  const result = nodes.filter(node => !node.documentKey && !node.technical && !node.sourceData);
  if (fullReport.length) {
    const priority = { HTML: 0, MD: 1, PDF: 2 };
    const formats = [...fullReport].sort((a, b) => (priority[reportFileType(a)] ?? 3) - (priority[reportFileType(b)] ?? 3));
    result.push({ ...formats[0], displayName: formats[0].displayName || 'Full report', formats });
  }
  if (fullReport.length || details.length) {
    const priority = { 'Executive summary': 0, 'Full report': 1, Findings: 2 };
    result.sort((a, b) => (priority[a.displayName] ?? 3) - (priority[b.displayName] ?? 3));
  }
  if (details.length) result.push({ type: 'dir', name: 'Evidence & details', displayName: 'Evidence & details', virtualGroup: true, path: '__report_details', children: details.flatMap(node => node.sourceData ? node.children || [] : [node]) });
  return result;
}

function reportLineage(relPath, nodes = state.reports.tree) {
  for (const node of nodes) {
    if (node.path === relPath) return [node];
    if (node.children && relPath.startsWith(`${node.path}/`)) {
      const descendants = reportLineage(relPath, node.children);
      if (descendants.length) return [node, ...descendants];
    }
  }
  return [];
}

function buildTreeNodes(nodes, { depth = 0, forceOpen = false, groupDocuments = true } = {}) {
  const frag = document.createDocumentFragment();
  for (const n of groupDocuments ? reportPresentationNodes(nodes) : nodes) {
    const li = document.createElement('li');
    li.className = n.type === 'dir' ? 'report-dir-node' : 'report-file-node';
    if (n.type === 'dir') {
      const row = document.createElement('div');
      row.className = 'report-dir-row';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = `dir${depth === 0 ? ' collection' : ''}`;
      const itemCount = depth === 0 ? reportCollectionRecordCount(n) : countReportFiles(n.children || []);
      const reviewMeta = n.review ? [n.review.completedAt ? formatReportDate(n.review.completedAt) : '', n.review.branch || (n.review.revision ? n.review.revision.slice(0, 8) : ''), n.review.status].filter(Boolean).join(' · ') : '';
      head.innerHTML = `<span class="tree-caret" aria-hidden="true">›</span><span class="dir-copy"><span class="dir-name">${escapeHtml(n.displayName || n.name)}</span>${reviewMeta ? `<small>${escapeHtml(reviewMeta)}</small>` : ''}</span><span class="dir-count">${itemCount.toLocaleString()}</span>`;
      const childUl = document.createElement('ul');
      let populated = false;
      const populate = () => {
        if (populated) return;
        childUl.appendChild(buildTreeNodes(n.children || [], { depth: depth + 1, forceOpen, groupDocuments: !n.virtualGroup }));
        populated = true;
      };
      const initiallyOpen = depth === 0 || forceOpen;
      head.classList.toggle('open', initiallyOpen);
      head.setAttribute('aria-expanded', initiallyOpen ? 'true' : 'false');
      childUl.hidden = !initiallyOpen;
      if (initiallyOpen) populate();
      head.addEventListener('click', () => {
        const open = head.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        childUl.hidden = !open;
        if (open) populate();
      });
      const toggleDirectory = () => head.click();
      row.appendChild(head);
      if (!n.virtualGroup) row.appendChild(reportTreeActionMenu(n, 'dir', toggleDirectory));
      li.appendChild(row);
      li.appendChild(childUl);
    } else {
      const fileEl = document.createElement('button');
      fileEl.type = 'button';
      fileEl.className = `file${state.reports.selectedPath === n.path || n.formats?.some(format => format.path === state.reports.selectedPath) ? ' active' : ''}`;
      fileEl.dataset.path = n.path;
      if (n.formats) fileEl.dataset.formats = JSON.stringify(n.formats.map(format => format.path));
      fileEl.title = n.path;
      fileEl.innerHTML = `<span class="file-kind">${n.formats ? 'DOC' : escapeHtml(reportFileType(n))}</span><span class="file-copy"><span class="file-name">${escapeHtml(n.displayName || n.name)}</span><span class="file-details"><span>${escapeHtml(formatReportDate(n.mtime))}</span><span>${escapeHtml(formatReportSize(n.size))}</span></span></span>`;
      const openFile = async edit => {
        await loadReport(n.path, fileEl);
        if (edit) document.getElementById('report-edit')?.click();
      };
      fileEl.addEventListener('click', () => openFile(false));
      li.append(fileEl, reportTreeActionMenu(n, 'file', openFile));
      if (n.formats) {
        const formats = document.createElement('div');
        formats.className = 'report-format-actions';
        for (const format of n.formats) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = reportFileType(format) === 'MD' ? 'Markdown' : reportFileType(format);
          button.setAttribute('aria-label', `Open full report as ${button.textContent}`);
          button.onclick = () => loadReport(format.path, fileEl);
          formats.appendChild(button);
        }
        li.appendChild(formats);
      }
    }
    frag.appendChild(li);
  }
  return frag;
}

async function loadReport(relPath, clickedEl) {
  state.reports.selectedPath = relPath;
  document.querySelectorAll('.reports-tree .file.active').forEach(e => e.classList.remove('active'));
  if (clickedEl) clickedEl.classList.add('active');
  const viewer = document.getElementById('report-viewer');
  viewer.innerHTML = '<div class="report-empty report-loading"><span></span><strong>Opening report…</strong></div>';
  const isMd = /\.md$/i.test(relPath);
  const reviewMatch = relPath.match(/^security-reviews\/([^/]+)\//);
  const pathParts = relPath.split('/');
  const fileName = pathParts.at(-1);
  const lineage = reportLineage(relPath);
  const node = lineage.at(-1);
  const parentPath = lineage.length ? lineage.slice(0, -1).map(node => node.displayName || node.name).join(' / ') : pathParts.slice(0, -1).join(' / ');
  const header = `<div class="report-header">
    <div class="report-header-copy"><span>Report</span><strong>${escapeHtml(node?.displayName || fileName)}</strong><small>${escapeHtml(parentPath)}</small><details class="report-file-details"><summary>File details</summary><small>${escapeHtml(relPath)}</small></details></div>
    <div class="report-actions">
      <a class="report-action-button primary" href="/api/reports/raw?path=${encodeURIComponent(relPath)}" target="_blank" rel="noopener">Open file <span aria-hidden="true">↗</span></a>
      ${isMd && !reviewMatch ? `<button class="report-action-button" id="report-edit">Edit</button>` : ''}
      ${reportEntryCanMove(relPath) ? '<button class="report-action-button" id="report-move">Move</button>' : ''}
      ${reviewMatch && window.gladosDesktop?.exportSecurityReviewPdf ? '<button class="report-action-button" id="report-export-pdf">Export PDF</button>' : ''}
      <button class="report-action-button" id="report-rename">Rename</button>
      <button class="report-action-button danger" id="report-delete">Delete</button>
    </div></div>`;
  try {
    const j = await fetch('/api/reports/file?path=' + encodeURIComponent(relPath)).then(r => r.json());
    if (j.error) {
      viewer.innerHTML = header + `<div class="report-empty">error: ${escapeHtml(j.error)}</div>`;
      wireReportActions(relPath, {}, viewer);
      return;
    }
    const rawUrl = '/api/reports/raw?path=' + encodeURIComponent(relPath);
    let body;
    if (j.kind === 'markdown') {
      const displayMarkdown = formatReportMarkdownForDisplay(j.content);
      const rendered = window.marked ? marked.parse(displayMarkdown) : `<pre>${escapeHtml(j.content)}</pre>`;
      const safe = window.DOMPurify ? DOMPurify.sanitize(rendered) : rendered;
      body = `<article class="report-document ${reportPresentationClass(relPath)}">${safe}</article>`;
    } else if (j.kind === 'text') {
      body = `<pre class="code-view" data-ext="${escapeHtml(j.ext || '')}">${escapeHtml(j.content)}</pre>`;
    } else if (j.kind === 'image') {
      body = `<img class="report-image" src="${rawUrl}" alt="${escapeHtml(relPath)}" />`;
    } else if (j.kind === 'pdf') {
      body = `<object class="report-pdf" data="${rawUrl}" type="application/pdf" aria-label="${escapeHtml(relPath)} PDF preview"><div class="report-empty">PDF preview unavailable - <a href="${rawUrl}" target="_blank" rel="noopener">open PDF</a></div></object>`;
    } else {
      body = `<div class="report-empty">binary file — <a href="${rawUrl}" target="_blank" rel="noopener">download</a></div>`;
    }
    viewer.innerHTML = header + body;
    viewer.scrollTop = 0;
    wireReportActions(relPath, j, viewer);
  } catch (e) {
    viewer.innerHTML = `<div class="report-empty">error: ${escapeHtml(e.message)}</div>`;
  }
}

// Dradis imports require the compact #Section# markers to remain byte-for-byte
// in the report files. Convert them only in the viewer so the operator gets a
// polished hierarchy without breaking export compatibility.
function formatReportMarkdownForDisplay(content) {
  let fenced = false;
  return String(content || '').split(/\r?\n/).map(line => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const title = line.match(/^#(CWE-\d+\s*:\s*.+)#\s*$/i);
    if (title) return `# ${title[1]}`;
    const evidence = line.match(/^#Evidence\s+(\d+)\s*:\s*(.+)#\s*$/i);
    if (evidence) return `### Evidence ${evidence[1]}: ${evidence[2]}`;
    const section = line.match(/^#(Summary|Remediation|CVSS\s+3\.1\s+Score|Action|Result)#\s*$/i);
    if (section) return `## ${section[1]}`;
    const reportSection = line.match(/^#(Description|Recommendation|Confidence|SLASeverity|SLATiming|Reference|CVSSv3\.BaseSeverity|CVSSv3\.BaseScore|CVSSv3\.Vector)#\s*$/i);
    if (reportSection) return `## ${reportSection[1]}`;
    return line;
  }).join('\n');
}

function reportPresentationClass(relPath) {
  const match = String(relPath || '').match(/(?:^|\/)CWEs\/(Critical|High|Medium|Low)(?:\/|$)/i);
  if (match) return `severity-${match[1].toLowerCase()}`;
  return /(?:^|\/)RT(?:\/|$)/i.test(String(relPath || '')) ? 'report-red-team' : 'report-general';
}

function wireReportActions(relPath, fileMeta, viewer) {
  const reviewMatch = relPath.match(/^security-reviews\/([^/]+)\//);
  const exportButton = viewer.querySelector('#report-export-pdf');
  if (exportButton && reviewMatch) exportButton.addEventListener('click', async () => {
    try {
      const result = await window.gladosDesktop.exportSecurityReviewPdf({ engagementId: reviewMatch[1] });
      if (!result?.canceled) {
        showToast('Security review PDF exported.', { kind: 'success', label: 'Reports' });
        renderPane();
      }
    } catch (error) {
      pushNotification('error', `PDF export failed: ${error.message}`, { toast: true, label: 'Reports' });
    }
  });
  const delBtn = viewer.querySelector('#report-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    try { await deleteReportEntry(relPath, relPath.split('/').at(-1), 'file'); }
    catch (e) { pushNotification('error', 'Delete failed: ' + e.message, { toast: true, label: 'Reports' }); }
  });
  const renameBtn = viewer.querySelector('#report-rename');
  if (renameBtn) renameBtn.addEventListener('click', async () => {
    try { await renameReportEntry(relPath, relPath.split('/').at(-1)); }
    catch (error) { pushNotification('error', `Rename failed: ${error.message}`, { toast: true, label: 'Reports' }); }
  });
  const moveBtn = viewer.querySelector('#report-move');
  if (moveBtn) moveBtn.addEventListener('click', async () => {
    try { await moveReportEntry(relPath, relPath.split('/').at(-1), 'file'); }
    catch (error) { pushNotification('error', `Move failed: ${error.message}`, { toast: true, label: 'Reports' }); }
  });
  const editBtn = viewer.querySelector('#report-edit');
  if (editBtn && fileMeta.kind === 'markdown') editBtn.addEventListener('click', () => {
    const original = fileMeta.content;
    viewer.innerHTML = `<div class="report-header editing"><div class="report-header-copy"><span>Editing</span><strong>${escapeHtml(relPath.split('/').at(-1))}</strong><small>${escapeHtml(relPath.split('/').slice(0, -1).join(' / '))}</small></div>
        <div class="report-actions">
          <button class="report-action-button" id="report-cancel">Cancel</button>
          <button class="report-action-button primary" id="report-save">Save changes</button>
        </div></div>
      <textarea class="report-editor" spellcheck="false">${escapeHtml(original)}</textarea>`;
    const ta = viewer.querySelector('.report-editor');
    ta.focus();
    viewer.querySelector('#report-cancel').addEventListener('click', () => loadReport(relPath));
    viewer.querySelector('#report-save').addEventListener('click', async () => {
      try {
        const r = await fetch('/api/reports/file', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: relPath, content: ta.value }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'save failed');
        loadReport(relPath);
      } catch (e) { pushNotification('error', 'Save failed: ' + e.message, { toast: true, label: 'Reports' }); }
    });
  });
}

// --- Terminal ---

function appendUpdateLine(text, stream = 'info') {
  const line = { text: String(text || ''), stream, ts: Date.now() };
  state.update.lines.push(line);
  if (state.update.lines.length > 2000) state.update.lines.splice(0, state.update.lines.length - 2000);
  const pre = document.getElementById('update-log');
  if (pre) {
    const span = document.createElement('span');
    span.className = `update-line ${stream}`;
    span.textContent = line.text.endsWith('\n') ? line.text : `${line.text}\n`;
    pre.appendChild(span);
    pre.scrollTop = pre.scrollHeight;
  }
}

function updateBannerElements() {
  return {
    banner: document.getElementById('update-banner'),
    message: document.getElementById('update-banner-message'),
    action: document.getElementById('update-banner-action'),
  };
}

function renderDesktopUpdateBanner({ message = null, busy = false, error = false } = {}) {
  const { banner, message: messageElement, action } = updateBannerElements();
  if (!banner || !messageElement || !action) return;
  const version = state.update.availableVersion;
  if (!version || (!busy && state.update.dismissedVersion === version)) {
    banner.classList.add('hidden');
    return;
  }
  messageElement.textContent = message || `Version ${version} is ready to download and install.`;
  action.textContent = busy ? 'Updating…' : error ? 'Retry update' : 'Update GLaDOS';
  action.disabled = busy;
  banner.classList.toggle('busy', busy);
  banner.classList.toggle('error', error);
  banner.classList.remove('hidden');
}

async function applyPackagedUpdate() {
  if (state.update.running || !window.gladosDesktop?.applyUpdate) return;
  state.update.running = true;
  let handedOffToInstaller = false;
  renderDesktopUpdateBanner({ message: `Downloading GLaDOS ${state.update.availableVersion || 'update'}…`, busy: true });
  appendUpdateLine('[desktop] downloading and verifying signed update\n', 'cmd');
  try {
    const installed = await window.gladosDesktop.applyUpdate();
    handedOffToInstaller = Boolean(installed?.ok);
    if (installed?.snapshotDir) appendUpdateLine(`[desktop] preservation snapshot created: ${installed.snapshotDir}\n`, 'info');
  } catch (error) {
    appendUpdateLine(`[desktop] update failed: ${error.message}\n`, 'stderr');
    renderDesktopUpdateBanner({ message: error.message, error: true });
    pushNotification('error', error.message, { toast: true, label: 'GLaDOS update' });
  } finally {
    if (!handedOffToInstaller) state.update.running = false;
  }
}

function handleDesktopUpdateStatus(status = {}) {
  const version = status.version || state.update.availableVersion;
  if (status.type === 'available') {
    state.update.availableVersion = version;
    state.update.dismissedVersion = null;
    renderDesktopUpdateBanner();
    showToast(`GLaDOS ${version} is available.`, { kind: 'info', label: 'Update available', timeoutMs: 7000 });
    return;
  }
  if (status.type === 'not-available') {
    state.update.availableVersion = null;
    document.getElementById('update-banner')?.classList.add('hidden');
    return;
  }
  if (status.type === 'downloading') {
    state.update.availableVersion = version;
    renderDesktopUpdateBanner({ message: `Downloading GLaDOS ${version}…`, busy: true });
    return;
  }
  if (status.type === 'progress') {
    const percent = Number.isFinite(Number(status.percent)) ? Math.max(0, Math.min(100, Number(status.percent))) : 0;
    renderDesktopUpdateBanner({ message: `Downloading GLaDOS ${version || ''}… ${Math.round(percent)}%`, busy: true });
    return;
  }
  if (status.type === 'downloaded' || status.type === 'preparing') {
    state.update.availableVersion = version;
    renderDesktopUpdateBanner({ message: 'Update verified. Preserving your GLaDOS data…', busy: true });
    return;
  }
  if (status.type === 'installing') {
    renderDesktopUpdateBanner({ message: 'Installing update and restarting GLaDOS…', busy: true });
    return;
  }
  if (status.type === 'error') {
    state.update.running = false;
    if (version) state.update.availableVersion = version;
    if (state.update.availableVersion) renderDesktopUpdateBanner({ message: status.message || 'The update could not be installed.', error: true });
  }
}

function setupDesktopUpdateNotifications() {
  if (!window.gladosDesktop?.isPackaged) return;
  window.gladosDesktop.onUpdateStatus?.(handleDesktopUpdateStatus);
  document.getElementById('update-banner-action')?.addEventListener('click', applyPackagedUpdate);
  document.getElementById('update-banner-later')?.addEventListener('click', () => {
    state.update.dismissedVersion = state.update.availableVersion;
    document.getElementById('update-banner')?.classList.add('hidden');
  });
  window.gladosDesktop.getUpdateStatus?.().then(status => {
    if (status.available && status.version) handleDesktopUpdateStatus({ type: 'available', version: status.version });
  }).catch(() => {});
}

async function refreshUpdateStatus() {
  const el = document.getElementById('update-status');
  if (!el) return;
  try {
    if (window.gladosDesktop?.isPackaged) {
      const status = await window.gladosDesktop.getUpdateStatus();
      const run = document.getElementById('update-run');
      if (status.supported === false) {
        if (run) {
          run.disabled = false;
          run.textContent = 'View source releases';
        }
        el.textContent = `GLaDOS ${status.currentVersion} · Windows builds update from tagged source releases`;
        el.className = 'update-status ok';
        return;
      }
      if (run) {
        run.disabled = status.applying;
        run.textContent = status.available ? 'Update GLaDOS' : 'Check for updates';
      }
      el.textContent = status.available
        ? `GLaDOS ${status.version} is available`
        : `GLaDOS ${status.currentVersion} · automatic checks enabled`;
      el.className = status.available ? 'update-status warn' : 'update-status ok';
      return;
    }
    const r = await fetch('/api/update/status');
    const status = await r.json();
    const dirty = status.dirty ? `dirty (${status.dirtySummary.length} file entries)` : 'clean';
    const active = status.activeAgents ? `${status.activeAgents} active agent(s)` : 'no active agents';
    el.textContent = `${status.branch || 'unknown'} @ ${status.head || 'unknown'} · ${dirty} · ${active}`;
    el.className = status.dirty || status.activeAgents ? 'update-status warn' : 'update-status ok';
  } catch (e) {
    el.textContent = `status unavailable: ${e.message}`;
    el.className = 'update-status err';
  }
}

async function startInAppUpdate(force = false) {
  if (state.update.running) return;
  if (window.gladosDesktop?.isPackaged) {
    state.update.running = true;
    appendUpdateLine('[desktop] checking signed release feed\n', 'cmd');
    try {
      const status = await window.gladosDesktop.getUpdateStatus();
      if (status.supported === false) {
        appendUpdateLine(`[desktop] ${status.reason}. ${status.sourceUrl || ''}\n`, 'info');
        if (status.sourceUrl) window.open(status.sourceUrl, '_blank', 'noopener');
        return;
      }
      const result = await window.gladosDesktop.checkForUpdate();
      appendUpdateLine(`[desktop] current ${result.currentVersion || 'unknown'} · feed ${result.version || 'unknown'}\n`, 'info');
      if (!result.available) {
        appendUpdateLine('[desktop] GLaDOS is already up to date\n', 'info');
        return;
      }
      state.update.availableVersion = result.version;
      state.update.running = false;
      await applyPackagedUpdate();
    } catch (e) {
      appendUpdateLine(`[desktop] update failed: ${e.message}\n`, 'stderr');
    } finally {
      state.update.running = false;
    }
    return;
  }
  if (!force && !await confirmAction({ title: 'Update GLaDOS', message: 'Run scripts/update.sh now? Updates are pulled from the configured Git remote and will not modify local operator data.', confirmLabel: 'Run update' })) return;
  try { state.update.es?.close(); } catch {}
  state.update.running = true;
  appendUpdateLine(`$ scripts/update.sh --no-restart${force ? ' --force' : ''}\n`, 'cmd');
  const es = new EventSource(`/api/update/stream?force=${force ? '1' : '0'}`);
  state.update.es = es;
  const done = () => {
    state.update.running = false;
    refreshUpdateStatus();
  };
  es.addEventListener('status', e => {
    const s = JSON.parse(e.data);
    appendUpdateLine(`[status] branch=${s.branch || '?'} head=${s.head || '?'} dirty=${s.dirty} activeAgents=${s.activeAgents}\n`, 'info');
  });
  es.addEventListener('started', e => appendUpdateLine(`[started] ${e.data}\n`, 'info'));
  es.addEventListener('output', e => {
    const d = JSON.parse(e.data);
    appendUpdateLine(d.text || '', d.stream || 'stdout');
  });
  es.addEventListener('blocked', e => {
    appendUpdateLine(`[blocked] ${e.data}\n`, 'stderr');
    try { es.close(); } catch {}
    done();
  });
  es.addEventListener('error', e => {
    if (e.data) appendUpdateLine(`[error] ${e.data}\n`, 'stderr');
    try { es.close(); } catch {}
    done();
  });
  es.addEventListener('complete', e => {
    const d = JSON.parse(e.data);
    appendUpdateLine(`\n[complete] code=${d.code} ok=${d.ok} ${d.note || ''}\n`, d.ok ? 'info' : 'stderr');
    try { es.close(); } catch {}
    done();
  });
}

function renderUpdatePane() {
  const wrap = document.createElement('div');
  wrap.className = 'update-pane';
  const packaged = !!window.gladosDesktop?.isPackaged;
  wrap.innerHTML = `
    <div class="update-toolbar">
      <span id="update-status" class="update-status">checking...</span>
      <button id="update-run">${packaged ? 'Check for updates' : 'Run Update'}</button>
      ${packaged ? '' : '<button id="update-force" title="Continue despite active agents or dirty working tree">Force</button>'}
      <button id="update-clear">Clear Log</button>
    </div>
    <pre id="update-log" class="update-log"></pre>
  `;
  paneEl.appendChild(wrap);
  const pre = wrap.querySelector('#update-log');
  for (const line of state.update.lines) {
    const span = document.createElement('span');
    span.className = `update-line ${line.stream}`;
    span.textContent = line.text.endsWith('\n') ? line.text : `${line.text}\n`;
    pre.appendChild(span);
  }
  pre.scrollTop = pre.scrollHeight;
  wrap.querySelector('#update-run').addEventListener('click', () => startInAppUpdate(false));
  wrap.querySelector('#update-force')?.addEventListener('click', () => startInAppUpdate(true));
  wrap.querySelector('#update-clear').addEventListener('click', () => {
    state.update.lines = [];
    pre.innerHTML = '';
  });
  refreshUpdateStatus();
  if (state.update.autoStart) {
    state.update.autoStart = false;
    setTimeout(() => startInAppUpdate(false), 50);
  }
}

let _termInstance = null;
function renderTerminalPane() {
  const wrap = document.createElement('div');
  wrap.className = 'terminal-pane';
  wrap.innerHTML = `<div class="terminal-host" id="terminal-host"></div>`;
  paneEl.appendChild(wrap);
  if (!window.Terminal) {
    wrap.innerHTML = '<div class="pane-empty">xterm.js failed to load.</div>';
    return;
  }
  // Reuse one xterm instance across tab switches to preserve scrollback.
  if (!_termInstance) {
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: '#0a0a0a', foreground: '#e0e0e0' },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    _termInstance = { term, fit, ws: null };
  }
  const host = document.getElementById('terminal-host');
  _termInstance.term.open(host);
  _termInstance.fit.fit();

  // (Re)connect if no live socket.
  if (!_termInstance.ws || _termInstance.ws.readyState > 1) {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`);
    ws.onmessage = ev => _termInstance.term.write(ev.data);
    ws.onopen = () => {
      const { cols, rows } = _termInstance.term;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    };
    ws.onclose = () => _termInstance.term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n');
    _termInstance.term.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d })); });
    _termInstance.term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    _termInstance.ws = ws;
  }

  // Refit on window resize.
  const onResize = () => { try { _termInstance.fit.fit(); } catch {} };
  window.addEventListener('resize', onResize, { once: false });
  setTimeout(onResize, 50);
}

// --- Proxy: each tab keeps an explicit investigation-session identity. ---
function clearProxyClientState() {
  GladosProxyWorkspace.clear();
}

function renderProxyPane() {
  const tab = state.openTabs.find(item => item.id === state.currentTab);
  const sessionId = tab?.sessionId;
  if (!sessionId) {
    paneEl.innerHTML = '<div class="pane-empty">Open a session, then choose Proxy.</div>';
    return;
  }
  const session = state.investigationSessions.find(item => item.id === sessionId);
  const host = document.createElement('div');
  paneEl.appendChild(host);
  GladosProxyWorkspace.mount(host, {
    sessionId,
    sessionName: session?.name || tab.sessionName || sessionId,
    archived: session?.state === 'archived',
    onSession: id => activateInvestigationSession(id),
    onAgent: async row => {
      if (state.currentSessionId !== sessionId) await activateInvestigationSession(sessionId);
      openAgentProvenance(row);
    },
  });
}

function toCurl(r) {
  const m = (r.method || 'GET').toUpperCase();
  const flags = m === 'GET' ? '' : ` -X ${m}`;
  return `curl -sS${flags} '${(r.url || '').replace(/'/g, `'\\''`)}'`;
}

// --- Settings ---

function setupStateCard(label, complete, detail, { optional = false } = {}) {
  const tone = complete ? 'complete' : optional ? 'optional' : 'attention';
  const marker = complete ? '✓' : optional ? '—' : '!';
  return `<div class="setup-state-card ${tone}"><span>${marker}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function renderSetupSummary(root, status) {
  if (!root) return;
  if (!status) {
    root.innerHTML = '<div class="setup-summary-loading">Setup status unavailable.</div>';
    return;
  }
  const verification = status.lastVerification;
  root.innerHTML = [
    setupStateCard('LiteLLM key', status.llm?.configured, status.llm?.configured ? `Stored in ${status.llm.source}` : 'Required'),
    setupStateCard('Local credentials', status.localSecrets?.configured, status.localSecrets?.configured ? status.localSecrets.profiles.join(', ') : 'Optional', { optional: !status.localSecrets?.configured }),
    setupStateCard('Unique proxy CA', status.ca?.generated && status.ca?.trusted, status.ca?.trusted ? 'Trusted in login Keychain' : status.ca?.generated ? 'Generated; trust required' : 'Generation required'),
    setupStateCard('Live verification', Boolean(verification?.ok), verification?.ok ? `Passed for ${verification.model}` : 'Run the final check'),
  ].join('');
}

async function wireSetupAssistant(wrap) {
  const summary = wrap.querySelector('#setup-summary');
  const launch = wrap.querySelector('#launch-setup-assistant');
  const bridge = window.gladosDesktop;
  if (!bridge?.getSetupStatus) {
    renderSetupSummary(summary, null);
    launch.disabled = true;
    launch.title = 'The setup assistant is available inside the GLaDOS desktop app.';
    return;
  }
  let status = null;
  const refresh = async next => {
    status = next || await bridge.getSetupStatus();
    renderSetupSummary(summary, status);
    launch.textContent = status.ready && status.lastVerification?.ok ? 'Review Setup' : 'Open Setup Assistant';
    return status;
  };
  try { await refresh(); }
  catch (error) {
    summary.innerHTML = `<div class="setup-summary-loading error">${escapeHtml(error.message)}</div>`;
  }
  launch.addEventListener('click', async () => {
    try {
      status = status || await refresh();
      await openSetupAssistant(status, refresh);
    } catch (error) {
      pushNotification('error', `Setup assistant failed: ${error.message}`, { toast: true, label: 'Setup' });
    }
  });
}

async function wireFullAccessControl(wrap) {
  const card = wrap.querySelector('#full-access-card');
  const toggle = wrap.querySelector('#full-access-toggle');
  const status = wrap.querySelector('#full-access-status');
  if (!card || !toggle || !status) return;
  let current = null;
  let busy = false;

  const render = next => {
    current = next;
    const enabled = next?.enabled === true;
    const available = next?.available !== false;
    card.classList.toggle('enabled', enabled);
    card.classList.toggle('unavailable', !available);
    toggle.disabled = busy || !available;
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.innerHTML = `<span class="access-switch-track"><i></i></span><span>${enabled ? 'Full Access on' : 'Full Access off'}</span>`;
    status.className = `full-access-status ${enabled ? 'enabled' : 'restricted'}`;
    status.innerHTML = `<span></span><div><strong>${enabled ? 'Full Access enabled' : 'Restricted by default'}</strong><small>${enabled
      ? 'New GLaDOS turns can use host-wide tools without per-command prompts.'
      : (available ? 'Desktop control and unrestricted execution remain locked.' : 'Available only inside the GLaDOS macOS desktop app.')}</small></div>`;
  };

  const save = async enabled => {
    busy = true;
    render(current);
    try {
      const response = await fetch('/api/settings/full-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      current = body;
      showToast(enabled ? 'Full Access is enabled for new GLaDOS turns.' : 'Full Access is disabled.', {
        kind: enabled ? 'warning' : 'success',
        label: 'Computer use',
      });
    } catch (error) {
      pushNotification('error', error.message, { toast: true, label: 'Computer use' });
    } finally {
      busy = false;
      render(current);
    }
  };

  toggle.addEventListener('click', async () => {
    if (busy || !current?.available) return;
    if (current.enabled) {
      const approved = await confirmAction({
        title: 'Turn off Full Access?',
        message: 'Desktop control and unrestricted command execution will be locked again for new tool calls.',
        confirmLabel: 'Turn Off',
      });
      if (approved) await save(false);
      return;
    }
    const understood = await confirmAction({
      title: 'Enable Full Access?',
      message: 'GLaDOS will be able to control visible apps, capture connected displays, edit requested files, run shell commands without per-command prompts, and carry out destructive or external actions you explicitly request. macOS may still ask for Accessibility and Screen Recording permission.',
      confirmLabel: 'Enable Full Access',
      danger: true,
    });
    if (!understood) return;
    await save(true);
  });

  try { render(await fetchJson('/api/settings/full-access', { timeoutMs: 5000 })); }
  catch (error) {
    render({ enabled: false, available: false });
    status.querySelector('small').textContent = error.message;
  }
}

function setupResultRow(label, ok, message) {
  return `<div class="setup-result ${ok ? 'pass' : 'fail'}"><span>${ok ? '✓' : '×'}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(message)}</small></div></div>`;
}

function openSetupAssistant(initialStatus, onStatus) {
  return new Promise(resolve => {
    const bridge = window.gladosDesktop;
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    let status = initialStatus;
    let step = 0;
    let busy = false;
    const steps = ['LiteLLM', 'Local secrets', 'Proxy CA', 'Verify'];

    const close = () => {
      backdrop.remove();
      resolve(status);
    };
    const updateStatus = async next => {
      status = next;
      await onStatus?.(status);
      render();
    };
    const run = async (button, work, successMessage) => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      const prior = button.textContent;
      button.textContent = 'Working…';
      try {
        await updateStatus(await work());
        if (successMessage) showToast(successMessage, { kind: 'success', label: 'Setup' });
      } catch (error) {
        pushNotification('error', error.message, { toast: true, label: 'Setup' });
        button.disabled = false;
        button.textContent = prior;
      } finally {
        busy = false;
      }
    };

    const stepBody = () => {
      const isMac = status.platform === 'darwin';
      const isWindows = status.platform === 'win32';
      const workstationLabel = isMac ? 'Mac' : 'workstation';
      const credentialStore = isMac ? 'macOS Keychain' : 'the protected local GLaDOS credential store';
      const caTrustStore = isMac
        ? 'macOS Keychain'
        : isWindows ? 'Windows current-user Root store' : 'the system trust store';
      const caTrustPrompt = isMac
        ? 'macOS may ask for your login password or Touch ID.'
        : isWindows ? 'Windows installs this certificate for the current user only.' : 'Linux may request sudo access.';
      if (step === 0) {
        return `<div class="setup-step-copy"><h3>Connect GLaDOS to LiteLLM</h3><p>The key is written directly to ${credentialStore} and is never returned to this page. GLaDOS uses the configured corporate gateway below.</p></div>
          <div class="setup-readonly"><span>Gateway</span><code>${escapeHtml(status.gatewayUrl || 'not configured')}</code></div>
          <div class="setup-inline-status ${status.llm?.configured ? 'complete' : ''}"><span>${status.llm?.configured ? '✓' : '1'}</span><div><strong>${status.llm?.configured ? 'Key configured' : 'Key required'}</strong><small>${escapeHtml(status.llm?.configured ? `Stored in ${status.llm.source}` : 'Paste the LiteLLM key once. Existing keys can be replaced here.')}</small></div></div>
          <label class="setup-field" for="setup-litellm-key"><span>${status.llm?.configured ? 'Replace LiteLLM key' : 'LiteLLM key'}</span><input id="setup-litellm-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste key" /></label>
          <div class="setup-action-row"><button type="button" class="safe" data-setup-action="save-litellm">${status.llm?.configured ? 'Replace Key' : 'Save Key'}</button></div>`;
      }
      if (step === 1) {
        const profiles = status.localSecrets?.profiles || [];
        return `<div class="setup-step-copy"><h3>Optional local credentials</h3><p>Add Ford SSO and Dradis credentials only if this ${workstationLabel} needs those authorized workflows. They are stored in the local GLaDOS runtime secrets directory and never committed.</p></div>
          ${status.localSecrets?.configured ? `<div class="setup-inline-status complete"><span>✓</span><div><strong>Optional profiles configured</strong><small>${escapeHtml(profiles.join(', '))}</small></div></div>` : '<div class="setup-inline-status optional"><span>—</span><div><strong>Safe to skip</strong><small>Core GLaDOS and LiteLLM operation do not require these profiles.</small></div></div>'}
          <div class="setup-field-grid">
            <label class="setup-field"><span>Ford SSO username</span><input id="setup-ford-user" autocomplete="username" /></label>
            <label class="setup-field"><span>Ford SSO password</span><input id="setup-ford-pass" type="password" autocomplete="new-password" /></label>
          </div>
          <label class="setup-check"><input id="setup-reuse-ford" type="checkbox" /><span>Use the saved Ford SSO credentials for Dradis</span></label>
          <div class="setup-field-grid" id="setup-dradis-fields">
            <label class="setup-field"><span>Dradis username</span><input id="setup-dradis-user" autocomplete="username" /></label>
            <label class="setup-field"><span>Dradis password</span><input id="setup-dradis-pass" type="password" autocomplete="new-password" /></label>
          </div>
          <div class="setup-action-row"><button type="button" class="safe" data-setup-action="save-local">${status.localSecrets?.configured ? 'Replace Optional Profiles' : 'Save Optional Profiles'}</button></div>`;
      }
      if (step === 2) {
        const fingerprint = status.ca?.fingerprint || 'Not generated yet';
        return `<div class="setup-step-copy"><h3>Trust this ${workstationLabel}’s unique proxy CA</h3><p>GLaDOS generates a different interception CA on every workstation. Trusting its public certificate lets authorized proxy traffic work without TLS warnings. The private key never leaves this ${workstationLabel}.</p></div>
          <div class="setup-inline-status ${status.ca?.generated ? 'complete' : ''}"><span>${status.ca?.generated ? '✓' : '1'}</span><div><strong>${status.ca?.generated ? 'Unique CA generated' : 'Generate unique CA'}</strong><small>Private key permissions: ${status.ca?.privateKeyOwnerOnly === true ? 'owner only' : status.ca?.privateKeyOwnerOnly === false ? 'unsafe' : 'not available'}</small></div></div>
          <div class="setup-inline-status ${status.ca?.trusted ? 'complete' : ''}"><span>${status.ca?.trusted ? '✓' : '2'}</span><div><strong>${status.ca?.trusted ? `Trusted in ${caTrustStore}` : 'Trust is required'}</strong><small>${caTrustPrompt}</small></div></div>
          <div class="setup-readonly fingerprint"><span>SHA-256 fingerprint</span><code>${escapeHtml(fingerprint)}</code></div>
          <div class="setup-action-row">
            ${status.ca?.generated ? '' : '<button type="button" data-setup-action="generate-ca">Generate CA</button>'}
            <button type="button" class="safe" data-setup-action="trust-ca" ${status.ca?.trusted ? 'disabled' : ''}>${status.ca?.trusted ? 'CA Trusted' : 'Trust CA'}</button>
          </div>`;
      }
      const verification = status.lastVerification;
      const results = verification ? [
        setupResultRow('Model catalog', verification.models?.ok && verification.models?.modelAvailable, verification.models?.message || 'No result'),
        setupResultRow('Anthropic Messages', verification.messages?.ok, verification.messages?.message || 'No result'),
        setupResultRow('Proxy CA trust', verification.ca?.ok, verification.ca?.ok ? 'The unique CA is generated and trusted.' : 'Proxy CA trust is incomplete.'),
        setupResultRow('Bundled proxy', verification.proxy?.ok, verification.proxy?.message || 'No proxy result'),
      ].join('') : '<div class="setup-verification-empty">Run verification to test model discovery, a live four-token message, CA trust, and the bundled proxy.</div>';
      return `<div class="setup-step-copy"><h3>Verify the complete setup</h3><p>This makes one minimal live LiteLLM request. No key or response content is displayed or saved by the wizard.</p></div>
        <div class="setup-results">${results}</div>
        <div class="setup-action-row"><button type="button" class="safe" data-setup-action="verify">${verification ? 'Run Again' : 'Run Verification'}</button></div>`;
    };

    function render() {
      const verified = Boolean(status.lastVerification?.ok && status.lastVerification?.ca?.ok && status.lastVerification?.proxy?.ok);
      backdrop.innerHTML = `<section class="app-modal setup-assistant-modal" role="dialog" aria-modal="true" aria-labelledby="setup-assistant-title">
        <header><div><h2 id="setup-assistant-title">GLaDOS Setup Assistant</h2><small>Step ${step + 1} of ${steps.length}: ${escapeHtml(steps[step])}</small></div><button type="button" data-modal-close aria-label="Close">×</button></header>
        <ol class="setup-progress">${steps.map((label, index) => `<li class="${index === step ? 'active' : index < step ? 'complete' : ''}"><span>${index < step ? '✓' : index + 1}</span><small>${escapeHtml(label)}</small></li>`).join('')}</ol>
        <div class="app-modal-copy setup-assistant-copy">${stepBody()}</div>
        <footer><button type="button" data-setup-back ${step === 0 ? 'disabled' : ''}>Back</button><span></span>${step === 1 ? '<button type="button" data-setup-skip>Skip Optional</button>' : ''}<button type="button" class="safe" data-setup-next ${step === 0 && !status.llm?.configured ? 'disabled' : step === 2 && !status.ca?.trusted ? 'disabled' : step === 3 && !verified ? 'disabled' : ''}>${step === 3 ? 'Finish' : 'Next'}</button></footer>
      </section>`;
      root.replaceChildren(backdrop);
      backdrop.querySelector('[data-modal-close]').addEventListener('click', close);
      backdrop.querySelector('[data-setup-back]').addEventListener('click', () => { if (!busy && step > 0) { step--; render(); } });
      backdrop.querySelector('[data-setup-skip]')?.addEventListener('click', () => { if (!busy) { step++; render(); } });
      backdrop.querySelector('[data-setup-next]').addEventListener('click', () => {
        if (busy) return;
        if (step === 3) close();
        else { step++; render(); }
      });
      backdrop.addEventListener('click', event => { if (event.target === backdrop && !busy) close(); });

      const reuse = backdrop.querySelector('#setup-reuse-ford');
      reuse?.addEventListener('change', () => { backdrop.querySelector('#setup-dradis-fields').hidden = reuse.checked; });
      backdrop.querySelector('[data-setup-action="save-litellm"]')?.addEventListener('click', event => run(event.currentTarget, () => bridge.saveLiteLlmKey({ token: backdrop.querySelector('#setup-litellm-key').value }), `LiteLLM key saved to ${status.platform === 'darwin' ? 'macOS Keychain' : 'the local credential store'}.`));
      backdrop.querySelector('[data-setup-action="save-local"]')?.addEventListener('click', event => run(event.currentTarget, () => bridge.saveLocalSecrets({
        fordUsername: backdrop.querySelector('#setup-ford-user').value,
        fordPassword: backdrop.querySelector('#setup-ford-pass').value,
        useFordForDradis: backdrop.querySelector('#setup-reuse-ford').checked,
        dradisUsername: backdrop.querySelector('#setup-dradis-user')?.value || '',
        dradisPassword: backdrop.querySelector('#setup-dradis-pass')?.value || '',
      }), 'Optional local profiles saved with owner-only permissions.'));
      backdrop.querySelector('[data-setup-action="generate-ca"]')?.addEventListener('click', event => run(event.currentTarget, () => bridge.generateProxyCa(), 'A unique proxy CA was generated for this workstation.'));
      backdrop.querySelector('[data-setup-action="trust-ca"]')?.addEventListener('click', event => run(event.currentTarget, () => bridge.trustProxyCa(), 'The unique proxy CA is trusted.'));
      backdrop.querySelector('[data-setup-action="verify"]')?.addEventListener('click', event => run(event.currentTarget, () => bridge.verifySetup(), null));
    }

    render();
  });
}

async function wireDefaultTeamSettings(wrap) {
  const select = wrap.querySelector('[data-default-team]');
  const save = wrap.querySelector('[data-save-default-team]');
  const status = wrap.querySelector('[data-default-team-status]');
  let preference;
  const validChoice = () => preference?.teams?.some(team => team.id === select.value && team.available !== false);
  function render(result) {
    preference = result;
    const teams = result.teams || [];
    const missing = !teams.some(team => team.id === result.defaultTeamId);
    select.innerHTML = `${missing ? `<option value="${escapeHtml(result.defaultTeamId)}" selected disabled>Unavailable saved team</option>` : ''}${teams.map(team => `<option value="${escapeHtml(team.id)}"${team.id === result.defaultTeamId ? ' selected' : ''}${team.available === false ? ' disabled' : ''}>${escapeHtml(team.name)}${team.available === false ? ' (unavailable)' : ''}</option>`).join('')}`;
    select.disabled = false;
    save.disabled = true;
    status.textContent = result.fallback ? 'Your saved team is unavailable. New chats currently start with GLaDOS.' : 'Used when you open a new chat. You can choose another team for an individual chat.';
  }
  select.addEventListener('change', () => { save.disabled = !validChoice() || select.value === preference.defaultTeamId; });
  save.addEventListener('click', async () => {
    if (!validChoice()) return;
    save.disabled = true;
    select.disabled = true;
    try {
      const result = await packageApi('PATCH', '/api/settings/default-team', { defaultTeamId: select.value });
      state.defaultTeamPreference = result;
      if (!wrap.isConnected) return;
      render(result);
      const team = result.teams.find(team => team.id === result.effectiveTeamId);
      status.textContent = `Saved. New chats will start with ${team?.name || 'GLaDOS'}.`;
    } catch (error) {
      if (!wrap.isConnected) return;
      select.disabled = false;
      save.disabled = !validChoice();
      status.textContent = error.message;
    }
  });
  try {
    const result = await loadDefaultTeamPreference();
    if (wrap.isConnected) render(result);
  } catch (error) {
    if (wrap.isConnected) status.textContent = `Could not load the default team: ${error.message}`;
  }
}

async function renderSettingsPane() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-pane';
  wrap.innerHTML = `
    <h1>Settings</h1>
    <section class="settings-section setup-assistant-section">
      <div class="settings-section-heading"><div><h2>Setup Assistant</h2><p class="settings-section-copy">Configure the workstation from start to finish: LiteLLM, optional local credentials, the unique proxy CA, and live verification.</p></div><button id="launch-setup-assistant" type="button" class="safe">Open Setup Assistant</button></div>
      <div id="setup-summary" class="setup-summary"><div class="setup-summary-loading">Checking setup…</div></div>
    </section>
    <section class="settings-section default-team-section">
      <h2>New chats</h2>
      <p class="settings-section-copy">Choose the Agentic Team selected when you start a new chat. Existing chats keep their assigned team.</p>
      <div class="default-team-card">
        <label><span>Default Agentic Team</span><select data-default-team aria-label="Default Agentic Team" disabled><option>Loading teams…</option></select></label>
        <button type="button" class="safe" data-save-default-team disabled>Save default</button>
      </div>
      <p class="settings-section-copy" data-default-team-status role="status">Loading your default team…</p>
    </section>
    <section class="settings-section full-access-section">
      <div class="settings-section-heading"><div><h2>Computer Use</h2><p class="settings-section-copy">Choose whether GLaDOS stays inside its normal safety boundary or may operate this workstation directly when supported. Full Access is always off by default and requires an explicit confirmation.</p></div></div>
      <div id="full-access-card" class="full-access-card">
        <div class="full-access-card-head">
          <div id="full-access-status" class="full-access-status restricted"><span></span><div><strong>Checking access mode…</strong><small>Reading the local policy.</small></div></div>
          <button id="full-access-toggle" type="button" class="full-access-toggle" role="switch" aria-pressed="false" disabled><span class="access-switch-track"><i></i></span><span>Full Access off</span></button>
        </div>
        <div class="full-access-capabilities">
          <div><span>Files + shell</span><strong>Read, edit, and run approved work</strong></div>
          <div><span>Browser agents</span><strong>Coordinate isolated browser sessions</strong></div>
          <div><span>Desktop</span><strong>See and operate visible macOS apps</strong></div>
          <div><span>High impact</span><strong>Allow explicitly requested external or destructive actions</strong></div>
        </div>
        <p class="full-access-warning"><strong>Full Access removes per-command permission prompts.</strong> It does not grant itself macOS privacy consent, expand the scope of your request, or turn on automatically after an update.</p>
      </div>
    </section>
    <section class="settings-section operator-profile-section">
      <div class="settings-section-heading"><div><h2>Your chat identity</h2><p class="settings-section-copy">Enter your name once. GLaDOS shows your initials beside your messages instead of the Red Team logo.</p></div></div>
      <div class="operator-profile-card">
        <span id="operator-initials-preview" class="operator-initials-preview">${escapeHtml(state.operatorProfile.initials || 'You')}</span>
        <label for="operator-name"><span>Name</span><input id="operator-name" maxlength="80" value="${escapeHtml(state.operatorProfile.name || '')}" placeholder="Sam Costa" autocomplete="name" /></label>
        <button id="save-operator-profile" type="button" class="safe">Save name</button>
      </div>
    </section>
    <section class="settings-section appearance-settings">
      <h2>Appearance</h2>
      <p class="settings-section-copy">Choose how GLaDOS and agent workspaces are presented. Both themes keep the current dark blue color palette.</p>
      <div class="theme-options" role="group" aria-label="Dashboard theme">
        <button type="button" class="theme-option" data-dashboard-theme="quantum" aria-pressed="false">
          <span class="theme-preview quantum-preview" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>Quantum</strong><small>Focused, minimal agent workspace</small></span><b>Default</b>
        </button>
        <button type="button" class="theme-option" data-dashboard-theme="classic" aria-pressed="false">
          <span class="theme-preview classic-preview" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>Classic</strong><small>Original GLaDOS chamber interface</small></span>
        </button>
      </div>
    </section>
    <section class="settings-section">
      <h2>Operations</h2>
      <div class="settings-actions">
        <button id="update-app" title="Run scripts/update.sh with streamed progress">Update</button>
        <button id="refresh-runtime" title="Refresh local Agent SDK runtime state">Refresh runtime</button>
      </div>
    </section>
    <section class="settings-section"><h2>About</h2><div id="settings-version" class="settings-version">Version loading…</div></section>`;
  paneEl.appendChild(wrap);
  wireOperationControls(wrap);
  wireSetupAssistant(wrap);
  wireFullAccessControl(wrap);
  wireDefaultTeamSettings(wrap);
  const operatorName = wrap.querySelector('#operator-name');
  const operatorPreview = wrap.querySelector('#operator-initials-preview');
  const saveOperator = wrap.querySelector('#save-operator-profile');
  const previewInitials = value => {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'You';
    return `${words[0][0] || ''}${words.length > 1 ? words.at(-1)[0] || '' : words[0][1] || ''}`.toUpperCase().slice(0, 2) || 'You';
  };
  operatorName?.addEventListener('input', () => { operatorPreview.textContent = previewInitials(operatorName.value); });
  saveOperator?.addEventListener('click', async () => {
    saveOperator.disabled = true;
    try {
      const response = await fetch('/api/settings/operator-profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: operatorName.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
      state.operatorProfile = { name: body.name || '', initials: body.initials || 'You' };
      operatorName.value = state.operatorProfile.name;
      operatorPreview.textContent = state.operatorProfile.initials;
      showToast('Chat identity saved.', { kind: 'success', label: 'Settings' });
    } catch (error) {
      pushNotification('error', error.message, { toast: true, label: 'Chat identity' });
    } finally { saveOperator.disabled = false; }
  });
  wrap.querySelectorAll('[data-dashboard-theme]').forEach(button => {
    button.addEventListener('click', () => applyDashboardTheme(button.dataset.dashboardTheme));
  });
  applyDashboardTheme(state.theme, { persist: false });

  fetchJson('/api/version', { timeoutMs: 5000 }).then(renderSettingsVersion).catch(error => renderSettingsVersion({ error: error.message }));
}

function clippyConnectorMarkup() {
  return '<span class="clippy-logo" aria-hidden="true">C</span>';
}

function gladosTeamSettingsAgents(agents, { catalog = state.agentLibrary.catalog, teams = state.teamCatalog.teams } = {}) {
  const builtInIds = new Set((catalog?.builtInAgents || []).map(agent => agent.id));
  const assigned = new Set((teams || []).find(team => team.id === 'glados')?.assignedAgentIds || []);
  return (agents || []).filter(agent => assigned.has(agent.id) || (builtInIds.size ? builtInIds.has(agent.id) : !agent.packageId && !String(agent.id || '').startsWith('pkg-')));
}

function builtInAgentsMarkup({ teamName = 'GLaDOS', packageTeam = false } = {}) {
  return `    <section class="settings-section">
      <h2>Team agents</h2>
      <div id="settings-model-catalog" class="settings-version">LiteLLM model catalog loading…</div>
      <p class="settings-section-copy">Choose one model for the whole ${escapeHtml(teamName)} team, or adjust agents individually. Save Changes applies your pending assignments.</p>
      <label class="team-model-selector editor-field"><span>Model for all team agents</span><select data-all-agent-model disabled><option value="">Loading models…</option></select></label>
      <div class="settings-agent-controls">
        <input id="settings-agent-search" type="search" placeholder="Search agents or models…" aria-label="Search agent settings" />
        <div class="segmented" role="group" aria-label="Filter agent settings">
          <button type="button" data-settings-filter="all" class="active">All</button>
          <button type="button" data-settings-filter="enabled">Enabled</button>
          <button type="button" data-settings-filter="disabled">Disabled</button>
        </div>
      </div>
      <div class="settings-save-bar">
        <span id="settings-pending-models">No pending model changes</span>
        <div class="settings-model-actions"><button id="settings-discard-models" type="button" disabled>Discard model changes</button><button id="settings-save-models" type="button" class="safe" disabled>Save Changes</button></div>
      </div>
      <div class="agent-library-grid built-in-team-grid"><aside class="built-in-agent-roster" aria-label="${escapeHtml(teamName)} team agents"><div id="settings-list">loading…</div></aside><div class="agent-package-editor" data-built-in-editor${packageTeam ? ' data-package-editor' : ''}><div class="agent-editor-empty"><h2>Select an agent</h2><p>Edit its instruction documents and reasoning preference. Model changes use Save Changes above.</p></div></div></div>
    </section>`;
}

async function loadBuiltInAgentSettings(wrap, { teamId = 'glados', manifest = null, team = null, onEditAgent = null } = {}) {
  try {
    const [modelsResp, settingsResp] = await Promise.all([
      fetchJson('/api/models', { timeoutMs: 8000 }),
      fetchJson('/api/settings/agents', { timeoutMs: 8000 }),
    ]);
    if (!wrap.isConnected) return;
    const models = modelsResp.models || [];
    const modelCatalogEl = wrap.querySelector('#settings-model-catalog');
    if (modelsResp.available) {
      modelCatalogEl.innerHTML = `<span class="settings-version-label">LiteLLM Models</span><code>${models.length}</code><span class="settings-version-hint">live catalog</span>`;
    } else {
      modelCatalogEl.innerHTML = `<span class="settings-version-label">LiteLLM Models</span><code>unavailable</code><span class="settings-version-hint">${escapeHtml(modelsResp.message || 'model discovery failed')}</span>`;
    }
    const teamIds = teamId === 'glados' ? null : new Set(packageTeamModelAgentIds(manifest, team, (state.teamCatalog.teams || []).find(row => row.id === teamId)));
    const settingsAgents = teamIds ? (settingsResp.agents || []).filter(agent => teamIds.has(agent.id)) : gladosTeamSettingsAgents(settingsResp.agents || []);
    const visibleAgents = settingsAgents.filter(agent => teamId === 'glados' || agent.id !== teamId);
    const modelEditState = { dirty: false, saving: false };
    state.agentLibrary.teamModelEdits = modelEditState;
    const listEl = wrap.querySelector('#settings-list');
    const settingsSearch = wrap.querySelector('#settings-agent-search');
    const saveModels = wrap.querySelector('#settings-save-models');
    const pendingModels = wrap.querySelector('#settings-pending-models');
    const discardModels = wrap.querySelector('#settings-discard-models');
    const allAgentModel = wrap.querySelector('[data-all-agent-model]');
    allAgentModel.innerHTML = '<option value="">Keep individual models</option>' + models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
    allAgentModel.disabled = !modelsResp.available;
    const modelDrafts = new Map();
    let savingModels = false;

    const refreshModelSaveBar = () => {
      const count = modelDrafts.size;
      modelEditState.dirty = count > 0;
      modelEditState.saving = savingModels;
      pendingModels.textContent = count ? `${count} pending model change${count === 1 ? '' : 's'}` : 'No pending model changes';
      saveModels.disabled = !count || savingModels;
      if (discardModels) discardModels.disabled = !count || savingModels;
      allAgentModel.disabled = savingModels || !modelsResp.available;
      saveModels.textContent = savingModels ? 'Saving...' : `Save Changes${count ? ` (${count})` : ''}`;
    };

    const stageModelChange = (agentId, expectedModel, model, card, select) => {
      if (model === expectedModel) modelDrafts.delete(agentId);
      else modelDrafts.set(agentId, { agentId, expectedModel, model });
      if (card) card.dataset.model = model;
      card?.classList.toggle('model-dirty', modelDrafts.has(agentId));
      select?.classList.toggle('model-dirty', modelDrafts.has(agentId));
      card?.querySelector('[data-model-error]')?.remove();
      refreshModelSaveBar();
    };

    allAgentModel.addEventListener('change', () => {
      if (!allAgentModel.value) return;
      for (const agent of settingsAgents) {
        const card = listEl.querySelector(`.agent-card[data-agent-id="${CSS.escape(agent.id)}"]`);
        const select = card?.querySelector('[data-model-select]');
        if (select) select.value = allAgentModel.value;
        stageModelChange(agent.id, card?.dataset.committedModel ?? agent.model ?? '', allAgentModel.value, card, select);
      }
    });
    discardModels?.addEventListener('click', () => {
      if (savingModels) return;
      modelDrafts.clear();
      allAgentModel.value = '';
      listEl.querySelectorAll('.agent-card').forEach(card => {
        card.dataset.model = card.dataset.committedModel;
        card.classList.remove('model-dirty');
        const select = card.querySelector('[data-model-select]');
        if (select) { select.value = card.dataset.committedModel; select.classList.remove('model-dirty'); }
        card.querySelector('[data-model-error]')?.remove();
      });
      refreshModelSaveBar();
    });
    saveModels.addEventListener('click', async () => {
      const submitted = [...modelDrafts.values()].map(change => ({ ...change }));
      if (!submitted.length || savingModels) return;
      if (teamId !== 'glados' && state.agentLibrary.dirty) {
        showToast('Save your agent edits before changing team models.', { kind: 'warning', label: 'Agents' }); return;
      }
      if (state.agentLibrary.builtInEditor?.dirty) {
        showToast('Save your agent edits before changing team models.', { kind: 'warning', label: 'Agents' }); return;
      }
      savingModels = true;
      refreshModelSaveBar();
      try {
        const response = await fetch('/api/settings/agents/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes: submitted }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok && !Array.isArray(body.results)) throw new Error(body.error || `HTTP ${response.status}`);
        let saved = 0;
        let failed = 0;
        for (const result of body.results || []) {
          const currentDraft = modelDrafts.get(result.agentId);
          const submittedDraft = submitted.find(change => change.agentId === result.agentId);
          const card = listEl.querySelector(`.agent-card[data-agent-id="${CSS.escape(result.agentId)}"]`);
          const select = card?.querySelector('[data-model-select]');
          card?.querySelector('[data-model-error]')?.remove();
          if (result.ok) {
            saved++;
            const savedAgent = settingsAgents.find(agent => agent.id === result.agentId);
            if (savedAgent) savedAgent.model = result.newModel;
            const runtimeAgent = (state.teamCatalog.agents || []).find(agent => agent.id === result.agentId);
            if (runtimeAgent) runtimeAgent.model = result.newModel;
            const effectiveModel = wrap.querySelector(`[data-effective-agent-model="${CSS.escape(result.agentId)}"]`);
            if (effectiveModel) {
              if ('value' in effectiveModel) effectiveModel.value = result.newModel;
              else effectiveModel.textContent = result.newModel;
            }
            if (currentDraft?.model === submittedDraft?.model) modelDrafts.delete(result.agentId);
            else if (currentDraft) modelDrafts.set(result.agentId, { ...currentDraft, expectedModel: result.newModel });
            if (card) {
              card.dataset.committedModel = result.newModel;
              card.dataset.model = currentDraft && currentDraft.model !== submittedDraft.model ? currentDraft.model : result.newModel;
              card.classList.toggle('model-dirty', modelDrafts.has(result.agentId));
              const savedModel = card.querySelector('[data-saved-model]');
              if (savedModel) savedModel.textContent = result.newModel;
            }
            if (select) select.classList.toggle('model-dirty', modelDrafts.has(result.agentId));
            if (state.agentLibrary.builtInEditor?.agentId === result.agentId) {
              const displayedModel = wrap.querySelector('[data-built-in-model]');
              if (displayedModel) displayedModel.value = result.newModel;
            }
          } else {
            failed++;
            if (card) card.classList.add('model-dirty');
            if (select) {
              select.classList.add('model-dirty');
              select.insertAdjacentHTML('afterend', `<span data-model-error class="model-save-error">${escapeHtml(result.error || 'Save failed')}</span>`);
            }
          }
        }
        if (saved) {
          await loadAgents();
          showToast(`Saved ${saved} model assignment${saved === 1 ? '' : 's'}${failed ? `; ${failed} still need attention` : ''}.`, {
            kind: failed ? 'warning' : 'success',
            label: 'Agent models',
          });
        }
        if (!saved && failed) pushNotification('error', `${failed} model assignment${failed === 1 ? '' : 's'} could not be saved.`, { toast: true, label: 'Agent models' });
      } catch (error) {
        pushNotification('error', `Save failed: ${error.message}`, { toast: true, label: 'Agent models' });
      } finally {
        savingModels = false;
        refreshModelSaveBar();
      }
    });
    refreshModelSaveBar();
    let settingsFilter = 'all';
    const applySettingsFilter = () => {
      const query = settingsSearch.value.trim().toLowerCase();
      let visible = 0;
      listEl.querySelectorAll('.agent-card').forEach(card => {
        const enabled = card.dataset.enabled === 'true';
        const matchesState = settingsFilter === 'all' || (settingsFilter === 'enabled' ? enabled : !enabled);
        const matchesQuery = !query || `${card.dataset.agentId} ${card.dataset.name || ''} ${card.dataset.model || ''}`.toLowerCase().includes(query);
        card.hidden = !(matchesState && matchesQuery);
        if (!card.hidden) visible++;
      });
      listEl.querySelector('.settings-filter-empty')?.remove();
      if (!visible) listEl.insertAdjacentHTML('beforeend', '<div class="settings-filter-empty">No agents match this view.</div>');
    };
    settingsSearch.addEventListener('input', applySettingsFilter);
    wrap.querySelectorAll('[data-settings-filter]').forEach(button => button.addEventListener('click', () => {
      settingsFilter = button.dataset.settingsFilter;
      wrap.querySelectorAll('[data-settings-filter]').forEach(item => item.classList.toggle('active', item === button));
      applySettingsFilter();
    }));
    listEl.innerHTML = '';
    if (!settingsAgents.length) {
      listEl.innerHTML = '<div style="color:var(--fg-dim);">no agents found</div>';
      return;
    }
    for (const agent of visibleAgents) {
      const card = document.createElement('div');
      card.className = `agent-card settings-agent-row ${agent.enabled ? '' : 'disabled-agent'}`;
      card.dataset.agentId = agent.id;
      card.dataset.name = agent.name || agent.id;
      const selected = teamId !== 'glados' && agent.id === `pkg-${manifest.id}--${state.agentLibrary.selectedAgentId}`;
      card.classList.toggle('open', selected);
      card.dataset.enabled = String(!!agent.enabled);
      card.dataset.model = agent.model || '';
      card.dataset.committedModel = agent.model || '';
      const badges = [
        agent.enabled ? '<span class="agent-badge enabled">enabled</span>' : '<span class="agent-badge disabled">disabled</span>',
        agent.dispatch === 'conditional' ? '<span class="agent-badge conditional">conditional</span>' : '',
      ].filter(Boolean).join('');
      const modelChoices = [...new Set([agent.model, ...models].filter(Boolean))];
      const modelOptions = modelChoices.map(model => `<option value="${escapeHtml(model)}"${model === agent.model ? ' selected' : ''}>${escapeHtml(model)}</option>`).join('');
      card.innerHTML = `
        <div class="settings-agent-identity">
          <span class="settings-agent-dot ${agent.enabled ? 'enabled' : ''}"></span>
          <span><strong>${escapeHtml(agent.name || agent.id)}</strong><small>${escapeHtml(agent.id)}</small></span>
          <span class="agent-card-badges">${badges}</span>
        </div>
        <div class="settings-agent-model">
          <span>Model</span>
          <select data-model-select ${modelsResp.available ? '' : 'disabled'}>${modelOptions}</select>
          <small>Saved: <code data-saved-model>${escapeHtml(agent.model || '?')}</code></small>
        </div>
        <button type="button" class="settings-agent-details-toggle" data-agent-details-toggle aria-label="Edit ${escapeHtml(agent.name || agent.id)} agent" aria-expanded="${selected}">Edit agent</button>
        `;
      const inlineSelect = card.querySelector('[data-model-select]');
      inlineSelect.addEventListener('change', () => stageModelChange(agent.id, card.dataset.committedModel, inlineSelect.value, card, inlineSelect));
      card.querySelector('[data-agent-details-toggle]').addEventListener('click', async () => {
        if (!await confirmBuiltInEditorDiscard()) return;
        const markSelected = () => listEl.querySelectorAll('.agent-card').forEach(row => {
          row.classList.toggle('open', row === card);
          row.querySelector('[data-agent-details-toggle]').ariaExpanded = String(row === card);
        });
        markSelected();
        if (onEditAgent) { await onEditAgent(agent, models); return; }
        if (agent.packageId) {
          if (!await confirmAgentPackageDiscard()) return;
          const pane = wrap.closest('.agent-library-pane');
          await selectAgentPackage(agent.packageId, pane);
          const localId = agent.id.slice(`pkg-${agent.packageId}--`.length);
          if (state.agentLibrary.draft?.agents.some(row => row.id === localId)) {
            state.agentLibrary.selectedAgentId = localId;
            drawAgentsLibrary(pane);
          }
          return;
        }
        const body = wrap.querySelector('[data-built-in-editor]');
        await hydrateAgentCard(agent.id, body, models, { includeModel: false });
      });
      listEl.appendChild(card);
    }
    applySettingsFilter();
  } catch (e) {
    const list = wrap.querySelector('#settings-list');
    if (list) list.textContent = 'Could not load agents: ' + e.message;
  }
}

function renderSettingsVersion(info) {
  const el = document.getElementById('settings-version');
  if (!el) return;
  if (!info || info.error) {
    el.innerHTML = `<span class="settings-version-label">GLaDOS Version</span><code>unknown</code><span class="settings-version-hint">restart dashboard after update</span>`;
    return;
  }
  el.innerHTML = `
    <span class="settings-version-label">GLaDOS Version</span>
    <code>${escapeHtml(info.version || 'unknown')}</code>`;
}

function instructionDisabledTools(snapshot, fields) {
  const available = new Set(snapshot.availableTools || []);
  const unknown = (snapshot.disabledTools || []).filter(tool => !available.has(tool));
  return [...new Set([...unknown, ...fields.filter(field => !field.checked).map(field => field.value)])].sort();
}

function changedInstructionDocuments(snapshot, fields) {
  const changed = {};
  const normalize = value => String(value ?? '').replace(/\r\n?/g, '\n');
  for (const field of fields) {
    const original = snapshot.documents.find(doc => doc.name === field.dataset.instructionDocument);
    if (original && normalize(original.content) !== field.value) changed[original.name] = field.value;
  }
  return changed;
}

async function confirmBuiltInEditorDiscard() {
  const editor = state.agentLibrary.builtInEditor;
  if (editor?.saving) { showToast('Wait for the current save to finish.', { kind: 'warning', label: 'Agents' }); return false; }
  if (editor?.dirty && !await confirmAction({ title: 'Discard unsaved edits?', message: 'Your instruction and reasoning edits have not been saved.', confirmLabel: 'Discard edits' })) return false;
  state.agentLibrary.builtInEditor = null;
  return true;
}

async function hydrateAgentCard(agentId, body, models, { includeModel = false } = {}) {
  const generation = (state.agentLibrary.builtInGeneration || 0) + 1;
  state.agentLibrary.builtInGeneration = generation;
  body.innerHTML = '<p class="collection-loading">Loading agent editor…</p>';
  try {
    const [d, snapshot] = await Promise.all([
      fetchJson(`/api/agents/${encodeURIComponent(agentId)}/details`),
      fetchJson(`/api/agents/${encodeURIComponent(agentId)}/instructions`),
    ]);
    if (!body.isConnected || state.agentLibrary.builtInGeneration !== generation) return;
    if (d.error || snapshot.error) throw new Error(d.error || snapshot.error);
    const composer = d;
    const editorState = { agentId, dirty: false, saving: false };
    state.agentLibrary.builtInEditor = editorState;
    body.innerHTML = `<div class="package-editor-heading"><div><span class="collection-eyebrow">GLaDOS Agentic Team</span><h2>${escapeHtml(d.name || agentId)}</h2></div><button type="button" data-toggle-enabled${agentId === 'glados' ? ' disabled' : ''}>${d.enabled ? 'Disable' : 'Enable'}</button></div>
      <div class="editor-field-grid"><label class="editor-field"><span>Name</span><input readonly value="${escapeHtml(d.name || agentId)}" /></label><label class="editor-field"><span>Agent ID</span><input readonly value="${escapeHtml(agentId)}" /></label></div>
      <div class="editor-field-grid"><label class="editor-field"><span>Model</span><input readonly data-built-in-model value="${escapeHtml(d.model || '')}" /><small>Use the model controls above. Save Changes applies staged models.</small></label><label class="editor-field"><span>Reasoning</span><select data-built-in-effort>${(composer.effortLevels || []).map(value => `<option value="${escapeHtml(value)}"${value === composer.effort ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select><small>${escapeHtml(composer.effortNote || 'Saved for this agent’s next turn.')}</small></label></div>
      <h3>Instructions</h3><p class="field-note">These workspace documents load in their existing order: ${snapshot.loadOrder.map(escapeHtml).join(' → ')}. Saving applies only the documents you change. Saved changes affect future turns.</p>
      <div class="agent-instruction-documents">${snapshot.documents.map(doc => `<details class="agent-instruction-document"${doc.name === 'AGENTS.md' ? ' open' : ''}><summary>${escapeHtml(doc.name)}${doc.exists ? '' : ' · Not present'}</summary><label class="editor-field"><span class="sr-only">${escapeHtml(doc.name)}</span><textarea class="agent-instructions-input" data-instruction-document="${escapeHtml(doc.name)}" rows="14" spellcheck="false"></textarea></label></details>`).join('')}</div>
      <fieldset class="capability-fieldset"><legend>Connectors · MCP servers</legend><p class="field-note">Choose the tools this agent can use below. Server controls toggle all of that server’s tools. Connections are managed in Tools → Connectors.</p><div class="capability-choices">${[...new Set(snapshot.availableTools.filter(tool => tool.startsWith('mcp__')).map(tool => tool.split('__')[1]))].map(server => `<label class="capability-choice"><input type="checkbox" data-built-in-server="${escapeHtml(server)}" /><span>${escapeHtml(server)}</span></label>`).join('') || 'No MCP tools available for this role.'}</div></fieldset>
      <fieldset class="capability-fieldset"><legend>Tools</legend><p class="field-note">These choices can narrow the role’s existing permissions. TOOLS.md provides guidance. Save agent applies your changes to future turns.</p><details class="package-tool-group"><summary>Tool selections · ${snapshot.availableTools.length} available</summary><div class="built-in-tool-list">${snapshot.availableTools.map(tool => `<label class="capability-choice"><input type="checkbox" data-built-in-tool value="${escapeHtml(tool)}"${snapshot.disabledTools.includes(tool) ? '' : ' checked'} /><span>${escapeHtml(tool)}</span></label>`).join('')}</div></details></fieldset>
      <div class="package-save-bar"><span data-instruction-status role="status">No unsaved changes</span><div><button type="button" data-discard-instructions>Reload</button><button type="button" class="safe" data-save-instructions disabled>Save agent</button></div></div>
      <label class="editor-field"><span>Workspace</span><input readonly value="${escapeHtml(snapshot.workspace)}" /></label>`;
    const fields = [...body.querySelectorAll('[data-instruction-document]')];
    for (const field of fields) field.value = snapshot.documents.find(doc => doc.name === field.dataset.instructionDocument)?.content || '';
    const toolFields = [...body.querySelectorAll('[data-built-in-tool]')];
    const serverFields = [...body.querySelectorAll('[data-built-in-server]')];
    const syncServers = () => serverFields.forEach(field => {
      const tools = toolFields.filter(tool => (tool.value === `mcp__${field.dataset.builtInServer}` || tool.value.startsWith(`mcp__${field.dataset.builtInServer}__`)));
      field.checked = tools.length > 0 && tools.every(tool => tool.checked);
      field.indeterminate = tools.some(tool => tool.checked) && !field.checked;
    });
    syncServers();
    const effort = body.querySelector('[data-built-in-effort]');
    let savedEffort = composer.effort;
    const save = body.querySelector('[data-save-instructions]');
    const reload = body.querySelector('[data-discard-instructions]');
    const status = body.querySelector('[data-instruction-status]');
    const update = () => {
      editorState.dirty = Object.keys(changedInstructionDocuments(snapshot, fields)).length > 0 || effort.value !== savedEffort || JSON.stringify(instructionDisabledTools(snapshot, toolFields)) !== JSON.stringify([...snapshot.disabledTools].sort());
      save.disabled = !editorState.dirty || editorState.saving;
      reload.disabled = editorState.saving;
      status.textContent = editorState.saving ? 'Saving…' : editorState.dirty ? 'Unsaved changes' : 'No unsaved changes';
    };
    fields.forEach(field => field.addEventListener('input', update));
    effort.addEventListener('change', update);
    toolFields.forEach(field => field.addEventListener('change', () => { syncServers(); update(); }));
    serverFields.forEach(field => field.addEventListener('change', () => {
      toolFields.filter(tool => (tool.value === `mcp__${field.dataset.builtInServer}` || tool.value.startsWith(`mcp__${field.dataset.builtInServer}__`))).forEach(tool => { tool.checked = field.checked; });
      syncServers(); update();
    }));
    reload.addEventListener('click', async () => { if (await confirmBuiltInEditorDiscard()) await hydrateAgentCard(agentId, body, models); });
    save.addEventListener('click', async () => {
      if (editorState.saving || !editorState.dirty) return;
      const documents = changedInstructionDocuments(snapshot, fields);
      const disabledTools = instructionDisabledTools(snapshot, toolFields);
      editorState.saving = true;
      [...fields, ...toolFields, ...serverFields].forEach(field => { field.disabled = true; }); effort.disabled = true; update();
      let errorMessage = null;
      try {
        if (Object.keys(documents).length || JSON.stringify(disabledTools) !== JSON.stringify([...snapshot.disabledTools].sort())) {
          const result = await packageApi('PATCH', `/api/agents/${encodeURIComponent(agentId)}/instructions`, { expectedRevision: snapshot.revision, documents, disabledTools });
          Object.assign(snapshot, result);
        }
        if (effort.value !== savedEffort) {
          await packageApi('PATCH', `/api/settings/agents/${encodeURIComponent(agentId)}/effort`, { effort: effort.value });
          savedEffort = effort.value;
        }
        showToast('Agent saved. Future turns use your changes.', { kind: 'success', label: d.name || agentId });
      } catch (error) { errorMessage = error.message; }
      finally { editorState.saving = false; [...fields, ...toolFields, ...serverFields].forEach(field => { field.disabled = false; }); effort.disabled = false; update(); if (errorMessage) status.textContent = errorMessage; }
    });
    body.querySelector('[data-toggle-enabled]').addEventListener('click', async () => {
      if (!await confirmBuiltInEditorDiscard()) return;
      try {
        await packageApi('POST', `/api/agents/${encodeURIComponent(agentId)}/enabled`, { enabled: !d.enabled });
        await loadAgents();
        const row = body.closest('.collection-content')?.querySelector(`.agent-card[data-agent-id="${CSS.escape(agentId)}"]`);
        if (row) { row.dataset.enabled = String(!d.enabled); row.classList.toggle('disabled-agent', d.enabled); }
        await hydrateAgentCard(agentId, body, models);
      } catch (error) { showToast(error.message, { kind: 'warning', label: 'Agents' }); }
    });
  } catch (error) { if (body.isConnected && state.agentLibrary.builtInGeneration === generation) body.textContent = `Could not load agent editor: ${error.message}`; }
}

// --- Durable agent and connector collections ---

function newPackageDraft(kind = 'agent') {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const agentId = `agent-${token.slice(0, 8)}`;
  const agent = { id: agentId, name: '', description: '', instructions: '', model: '', effort: 'high', connectors: [], tools: [], deliverables: [], skills: [] };
  return {
    schemaVersion: 1, id: `custom-${token}`, version: '1.0.0', name: '', description: '', agents: [agent], resources: [],
    teams: kind === 'team' ? [{ id: `team-${token.slice(0, 8)}`, name: '', description: '', coordinator: agentId, members: [agentId] }] : [],
  };
}

function packageLineItems(value) {
  return [...new Set(String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
}

function agentPackageIssues(manifest, { allowInheritedModel = false } = {}) {
  const issues = [];
  if (!String(manifest?.name || '').trim()) issues.push('Give the package a name.');
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(manifest?.id || '') || manifest.id.length > 64) issues.push('Use a lowercase package ID with letters, numbers, and hyphens.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/.test(manifest?.version || '')) issues.push('Use a version such as 1.0.0.');
  if (!(manifest?.agents || []).length) issues.push('Add at least one agent.');
  const ids = new Set();
  for (const agent of manifest?.agents || []) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agent.id || '') || agent.id.length > 64) issues.push('Use lowercase letters, numbers, and hyphens for agent IDs.');
    if (ids.has(agent.id)) issues.push(`Each agent needs its own ID: ${agent.id}.`);
    ids.add(agent.id);
    if (!String(agent.name || '').trim()) issues.push('Give each agent a name.');
    if (!String(agent.instructions || '').trim()) issues.push(`Add instructions for ${agent.name || 'each agent'}.`);
    if (!allowInheritedModel && !String(agent.model || '').trim()) issues.push(`Choose a model for ${agent.name || 'each agent'}.`);
  }
  for (const team of manifest?.teams || []) {
    if (!String(team.name || '').trim()) issues.push('Give each team a name.');
    if (!ids.has(team.coordinator) || !(team.members || []).includes(team.coordinator)) issues.push('Choose a member of the team as its coordinator.');
    if (!(team.members || []).length || team.members.some(id => !ids.has(id))) issues.push('Choose team members from this package.');
  }
  return issues;
}

function agentPackageSummary(item) {
  const manifest = item?.manifest || item?.package || item || {};
  return {
    id: item?.id || manifest.id || '',
    name: item?.name || manifest.name || item?.id || 'Unnamed package',
    description: item?.description || manifest.description || '',
    version: item?.version || manifest.version || item?.latestVersion || '1.0.0',
    revision: item?.revision || item?.latestRevision || null,
    source: item?.source || item?.origin || 'custom',
    managedIntegration: item?.managedIntegration === true || item?.integrated === true || item?.source === 'integrated',
    editableIntegration: item?.editableIntegration === true,
    managedSource: item?.managedSource || '',
    enabled: item?.enabled !== false,
    active: item?.active || item?.activeVersion || null,
    agentCount: item?.agentCount ?? manifest.agents?.length ?? 0,
    teamCount: item?.teamCount ?? manifest.teams?.length ?? 0,
  };
}

function portablePackageManifest(details) {
  const candidate = details?.selectedManifest || details?.manifest || details?.portableManifest || details?.package?.manifest || details?.package || details;
  if (!candidate?.schemaVersion || !Array.isArray(candidate.agents)) throw new Error('This package does not include a readable agent manifest.');
  return JSON.parse(JSON.stringify(candidate));
}

async function packageApi(method, path, payload, { timeoutMs = 20000 } = {}) {
  const response = await fetchJson(path, {
    method, timeoutMs, headers: { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (response.ok === false) throw new Error(response.error || 'The request could not be completed.');
  return response;
}

async function refreshAgentLibraryCatalog() {
  const catalog = await fetchJson('/api/agent-packages', { timeoutMs: 10000 });
  state.agentLibrary.catalog = catalog;
  return catalog;
}

function fordAgenticTeamForPackage(value, catalog = state.agentLibrary.fordCatalog) {
  const pkg = typeof value === 'string'
    ? (state.agentLibrary.catalog?.packages || []).map(agentPackageSummary).find(item => item.id === value)
    : value ? agentPackageSummary(value) : null;
  if (!pkg?.managedIntegration) return null;
  const id = pkg.id;
  const team = (catalog?.teams || []).find(item => (item.packageId || item.id) === id)
    || (['herbie', 'jarvis', 'chappie'].includes(id) ? { id, packageId: id, name: `${id[0].toUpperCase()}${id.slice(1)} Agentic Team` } : null);
  return team && pkg.managedSource === `${team.id}.glados-agent.json` ? team : null;
}

function fordAgenticTeamTitle(team) {
  const name = team?.name || team?.id || 'Ford RT';
  return / Agentic Team$/i.test(name) ? name : `${name} Agentic Team`;
}

function customAgentPackages(catalog) {
  return (catalog?.packages || []).filter(item => !fordAgenticTeamForPackage(item));
}

function installedFordAgenticTeams(catalog = state.agentLibrary.catalog) {
  return (catalog?.packages || []).map(agentPackageSummary).map(item => {
    const team = fordAgenticTeamForPackage(item);
    return team ? { ...team, package: item } : null;
  }).filter(Boolean);
}

async function refreshFordAgenticTeams() {
  const catalog = await fetchJson('/api/ford-rt-teams', { timeoutMs: 15000 });
  if (catalog.ok === false) throw new Error(catalog.error || 'Ford RT Agentic Teams could not load.');
  state.agentLibrary.fordCatalog = catalog;
  return catalog;
}

function fordTeamDependencyReady(team) {
  return team?.dependency?.available === true || team?.dependency?.installed === true;
}

function fordAgenticTeamCatalogMarkup(catalog) {
  return (catalog?.teams || []).map(team => {
    const installation = team.installation || {};
    const busy = team.status === 'installing' || installation.state === 'installing';
    const comingSoon = team.comingSoon === true || team.status === 'coming-soon';
    const conflict = team.status === 'conflict' || team.conflictingPackage === true;
    const installed = team.installed === true;
    const ready = installed && fordTeamDependencyReady(team) && !busy && installation.state !== 'failed';
    const failure = installation.state === 'failed' || team.status === 'failed';
    const status = conflict ? team.error || 'A custom package already uses this team’s identity. Rename that package before installing this team.' : busy ? installation.message || 'Installing the team and its tools…' : failure ? installation.error || installation.message || 'Installation did not finish.' : ready ? `${team.agentCount || 0} agents installed${team.enabled === false ? ' · Disabled' : ''}. tshark is ready.` : installed ? 'The team is installed; tshark still needs setup.' : comingSoon ? 'Coming soon' : 'Available to install';
    const remediation = failure ? installation.remediation || team.dependency?.remediation : !comingSoon && team.dependency?.canInstall === false ? team.dependency?.remediation : '';
    const dependencyReason = !comingSoon && !busy && !failure && !fordTeamDependencyReady(team) ? team.dependency?.reason || '' : '';
    return `<article class="ford-team-card${failure || conflict ? ' installation-failed' : ''}" data-ford-team-card="${escapeHtml(team.id)}"><div class="ford-team-card-heading"><div><span class="collection-eyebrow">${comingSoon ? 'Future team' : 'Ford RT'}</span><h3>${escapeHtml(team.name)}</h3></div><span class="package-status${ready ? ' active' : ''}">${busy ? 'Installing' : ready ? 'Installed' : comingSoon ? 'Coming soon' : failure || conflict ? 'Needs attention' : 'Optional'}</span></div><p>${escapeHtml(team.description || '')}</p>${!comingSoon ? '<p class="field-note">Includes the team’s agents and local tshark for offline packet analysis.</p>' : ''}<p class="ford-team-installation-status${failure || conflict ? ' error' : ''}" role="status" aria-live="polite">${busy ? '<span class="ford-team-installation-spinner" aria-hidden="true"></span>' : ''}${escapeHtml(status)}</p>${dependencyReason ? `<p class="field-note">${escapeHtml(dependencyReason)}</p>` : ''}${remediation ? `<p class="ford-team-remediation">${escapeHtml(remediation)}</p>` : ''}<div class="ford-team-actions">${comingSoon ? '<button type="button" disabled>Coming soon</button>' : conflict ? '<button type="button" disabled>Resolve package conflict</button>' : ready ? `<button type="button" class="safe" data-open-ford-team="${escapeHtml(team.packageId || team.id)}">Open team</button>` : `<button type="button" class="safe" data-install-ford-team="${escapeHtml(team.id)}"${busy || team.canInstall === false ? ' disabled' : ''}>${busy ? 'Installing…' : failure ? 'Retry installation' : installed ? 'Set up tshark' : `Install ${escapeHtml(team.name.replace(/ Agentic Team$/i, ''))}`}</button>`}${installed && !busy ? `<button type="button" class="text-action danger-text" data-remove-ford-team="${escapeHtml(team.id)}">Uninstall team</button>` : ''}</div></article>`;
  }).join('');
}

function openFordAgenticTeams(wrap) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal ford-team-catalog-modal" role="dialog" aria-modal="true" aria-labelledby="ford-teams-title"><header><div><h2 id="ford-teams-title">Ford RT Agentic Teams</h2><small>Install the teams you want to use.</small></div><button type="button" data-ford-teams-close aria-label="Close team catalog">×</button></header><div class="app-modal-copy"><p class="collection-note">Teams are optional. Installing Herbie adds its agents and sets up tshark on this computer. You can edit the installed agents and add GLaDOS specialists or custom agents to their team.</p><div class="ford-team-catalog" data-ford-team-catalog>Loading available teams…</div><p class="package-editor-status" data-ford-team-status role="status" aria-live="polite"></p></div></div>`;
  document.getElementById('modal-root').appendChild(backdrop);
  let timer = null;
  let busy = false;
  let generation = 0;
  const requestedInstalls = new Set();
  const target = backdrop.querySelector('[data-ford-team-catalog]');
  const status = backdrop.querySelector('[data-ford-team-status]');
  const close = prepareCollectionDialog(backdrop, { onClose: () => { clearTimeout(timer); generation++; } });
  backdrop.querySelector('[data-ford-teams-close]').addEventListener('click', close);
  const updateLibrary = async () => {
    await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams(), loadAgents()]);
    if (wrap.isConnected) drawAgentsLibrary(wrap);
  };
  const show = catalog => {
    target.innerHTML = fordAgenticTeamCatalogMarkup(catalog);
    target.querySelectorAll('[data-open-ford-team]').forEach(button => button.addEventListener('click', async () => {
      if (!await confirmAgentPackageDiscard()) return;
      close();
      state.agentLibrary.view = `team:${button.dataset.openFordTeam}`;
      try { await selectAgentPackage(button.dataset.openFordTeam, wrap); }
      catch (error) { showToast(error.message, { kind: 'warning', label: 'Agents' }); }
    }));
    target.querySelectorAll('[data-install-ford-team]').forEach(button => button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      status.classList.remove('error');
      status.textContent = 'Starting installation…';
      try {
        requestedInstalls.add(button.dataset.installFordTeam);
        const team = catalog.teams.find(item => item.id === button.dataset.installFordTeam);
        const result = await packageApi('POST', `/api/ford-rt-teams/${encodeURIComponent(button.dataset.installFordTeam)}/install`, { ...(team?.revision ? { expectedRevision: team.revision } : {}) });
        if (!backdrop.isConnected) return;
        if (result.teams) { state.agentLibrary.fordCatalog = result; show(result); }
        status.textContent = 'Checking installation progress…';
        await refresh();
      } catch (error) {
        requestedInstalls.delete(button.dataset.installFordTeam);
        if (!backdrop.isConnected) return;
        status.textContent = error.message;
        status.classList.add('error');
        button.disabled = false;
      } finally { busy = false; }
    }));
    target.querySelectorAll('[data-remove-ford-team]').forEach(button => button.addEventListener('click', async () => {
      if (busy || !await confirmAgentPackageDiscard()) return;
      const team = catalog.teams.find(item => item.id === button.dataset.removeFordTeam);
      if (!await confirmAction({ title: `Uninstall ${team.name}?`, message: 'Remove this team from Agents? Its saved revisions stay recoverable. Shared tools such as tshark stay installed.', confirmLabel: 'Uninstall team', danger: true })) return;
      busy = true;
      button.disabled = true;
      try {
        const result = await packageApi('DELETE', `/api/ford-rt-teams/${encodeURIComponent(team.id)}`, { expectedRevision: team.revision });
        state.agentLibrary.fordCatalog = result;
        if (state.agentLibrary.selectedId === (team.packageId || team.id)) {
          Object.assign(state.agentLibrary, { view: 'built-in', selectedId: null, details: null, draft: null, dirty: false });
        }
        await updateLibrary();
        if (!backdrop.isConnected) return;
        show(result);
        status.textContent = 'Team uninstalled. Saved revisions remain recoverable.';
        status.classList.remove('error');
      } catch (error) { if (backdrop.isConnected) { status.textContent = error.message; status.classList.add('error'); button.disabled = false; } }
      finally { busy = false; }
    }));
  };
  const refresh = async () => {
    clearTimeout(timer);
    const current = ++generation;
    try {
      const previous = state.agentLibrary.fordCatalog;
      const catalog = await refreshFordAgenticTeams();
      if (!backdrop.isConnected || current !== generation) return;
      show(catalog);
      const completed = (catalog.teams || []).filter(team => team.installed && team.status === 'installed' && fordTeamDependencyReady(team) && (requestedInstalls.has(team.id) || (previous?.teams || []).find(item => item.id === team.id)?.status === 'installing'));
      const installedIds = new Set((state.agentLibrary.catalog?.packages || []).map(item => agentPackageSummary(item).id));
      const missingFromLibrary = (catalog.teams || []).some(team => team.installed && !installedIds.has(team.packageId || team.id));
      if (completed.length || missingFromLibrary) {
        await updateLibrary();
        if (!backdrop.isConnected || current !== generation) return;
        if (completed.length) {
          completed.forEach(team => requestedInstalls.delete(team.id));
          status.textContent = `${completed.map(team => team.name).join(', ')} installed. Open the team to review its agents.`;
          status.classList.remove('error');
        }
      }
      const running = (catalog.teams || []).some(team => team.status === 'installing' || team.installation?.state === 'installing');
      const failed = (catalog.teams || []).filter(team => requestedInstalls.has(team.id) && (team.status === 'failed' || team.installation?.state === 'failed'));
      if (failed.length) {
        failed.forEach(team => requestedInstalls.delete(team.id));
        status.textContent = failed.map(team => team.installation?.error || team.installation?.message || `${team.name} could not be installed.`).join(' ');
        status.classList.add('error');
      }
      if (running) {
        if (!failed.length) { status.textContent = 'Installation is running. You can close this window and return to check its progress.'; status.classList.remove('error'); }
        timer = setTimeout(refresh, 1500);
      }
    } catch (error) {
      if (!backdrop.isConnected || current !== generation) return;
      status.textContent = error.message;
      status.classList.add('error');
      target.innerHTML = '<button type="button" data-retry-ford-teams>Refresh team status</button>';
      target.querySelector('[data-retry-ford-teams]').addEventListener('click', refresh);
    }
  };
  refresh();
}

function agentCollectionCards(catalog) {
  const query = state.agentLibrary.query.trim().toLowerCase();
  const packages = customAgentPackages(catalog).map(agentPackageSummary).filter(item => !query || `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(query));
  if (!packages.length) return `<div class="collection-empty"><strong>${query ? 'No matching packages' : 'Your collection is ready'}</strong><p>${query ? 'Try another name or description.' : 'Create a specialist or upload an agent. Your collection stays with you when GLaDOS updates.'}</p></div>`;
  return packages.map(item => `<button type="button" class="agent-package-row${state.agentLibrary.selectedId === item.id ? ' selected' : ''}" data-package-open="${escapeHtml(item.id)}" aria-pressed="${state.agentLibrary.selectedId === item.id}">
    <span class="package-row-title"><strong>${escapeHtml(item.name)}</strong>${!item.enabled ? '<span class="package-status muted">Disabled</span>' : item.active ? '<span class="package-status active">Active</span>' : ''}</span>
    <span class="package-row-description">${escapeHtml(item.description || 'No description yet.')}</span>
    <span class="package-row-meta">${escapeHtml(item.managedIntegration ? 'Installed integration' : item.source === 'imported' ? 'Uploaded' : 'Custom')} · v${escapeHtml(item.version)}${item.teamCount ? ` · ${item.teamCount} team${item.teamCount === 1 ? '' : 's'}` : ` · ${item.agentCount || 1} agent${item.agentCount === 1 ? '' : 's'}`}</span>
  </button>`).join('');
}

async function renderAgentsLibraryPane() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-pane agent-library-pane collection-pane';
  wrap.innerHTML = `<div class="collection-page-heading"><div><span class="collection-eyebrow">Tools</span><h1>Agents</h1><p>Create specialists and teams, upload agents, and manage the tools they can use.</p></div><div class="collection-page-actions"><button type="button" data-ford-agentic-teams>Ford RT Agentic Teams</button><button type="button" data-import-package>Upload agent</button><button type="button" data-new-team>New team</button><button type="button" class="safe" data-new-agent>New agent</button></div></div>
    <div class="collection-tabs" role="tablist" aria-label="Agent collection" data-agent-library-tabs></div>
    <div class="collection-loading" data-library-content>Loading your collection…</div>`;
  paneEl.appendChild(wrap);
  const startDraft = async kind => {
    if (!await confirmAgentPackageDiscard()) return;
    state.agentLibrary.selectionGeneration++;
    state.agentLibrary.view = 'collection';
    state.agentLibrary.selectedId = null;
    state.agentLibrary.details = null;
    state.agentLibrary.draft = newPackageDraft(kind);
    state.agentLibrary.selectedAgentId = state.agentLibrary.draft.agents[0].id;
    state.agentLibrary.selectedTeamId = state.agentLibrary.draft.teams[0]?.id || null;
    resetAgentPackageTest();
    state.agentLibrary.dirty = false;
    drawAgentsLibrary(wrap);
    wrap.querySelector('[data-package-field="name"]')?.focus();
  };
  wrap.querySelector('[data-new-agent]').addEventListener('click', () => startDraft('agent'));
  wrap.querySelector('[data-new-team]').addEventListener('click', () => startDraft('team'));
  wrap.querySelector('[data-ford-agentic-teams]').addEventListener('click', () => openFordAgenticTeams(wrap));
  wrap.querySelector('[data-import-package]').addEventListener('click', async () => {
    if (!await confirmAgentPackageDiscard()) return;
    openAgentPackageImport(async (id, selector) => {
    await refreshAgentLibraryCatalog();
    if (!wrap.isConnected) return;
    state.agentLibrary.view = 'collection';
    await selectAgentPackage(id, wrap, selector);
    });
  });
  try {
    await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams(), refreshFordAgenticTeams().catch(() => null)]);
    if (wrap.isConnected) drawAgentsLibrary(wrap);
  } catch (error) {
    wrap.querySelector('[data-library-content]').innerHTML = `<div class="collection-empty"><strong>Your agent collection could not load.</strong><p>${escapeHtml(error.message)}</p><button type="button" data-retry-library>Try again</button></div>`;
    wrap.querySelector('[data-retry-library]').addEventListener('click', () => renderPane());
  }
}

function packageTeamModelAgentIds(manifest, team, runtimeTeam) {
  const members = new Set([team.coordinator, ...(team.members || [])]);
  return [...new Set([`pkg-${manifest.id}--${team.id}`,
    ...(manifest.agents || []).filter(agent => members.has(agent.id)).map(agent => `pkg-${manifest.id}--${agent.id}`),
    ...(runtimeTeam?.assignedAgentIds || [])])];
}

async function renderPackageTeamModels(target, manifest, team, details) {
  if (!target || !details || (details.selectedRevision || details.revision) !== details.activeRevision) return;
  const teamId = `pkg-${manifest.id}--${team.id}`;
  const runtimeTeam = (state.teamCatalog.teams || []).find(row => row.id === teamId);
  const ids = new Set(packageTeamModelAgentIds(manifest, team, runtimeTeam));
  target.innerHTML = '<p class="field-note">Loading team model controls…</p>';
  try {
    const [catalog, settings] = await Promise.all([fetchJson('/api/models'), fetchJson('/api/settings/agents')]);
    if (!target.isConnected) return;
    const agents = (settings.agents || []).filter(row => ids.has(row.id));
    target.innerHTML = `<h3>Team model</h3><label class="editor-field team-model-selector"><span>Model for all team agents</span><select data-package-team-model${catalog.available ? '' : ' disabled'}><option value="">Keep individual models</option>${(catalog.models || []).map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')}</select></label><p class="field-note">Includes the coordinator, disabled members, and additional assigned agents. Shared agents use the saved model in every team.</p><div class="package-save-bar"><span data-team-model-status role="status">No pending model changes</span><button class="safe" type="button" data-save-team-model disabled>Save team models</button></div>`;
    const field = target.querySelector('[data-package-team-model]');
    const save = target.querySelector('[data-save-team-model]');
    const status = target.querySelector('[data-team-model-status]');
    let changes = [];
    const stage = () => {
      changes = field.value ? agents.filter(row => row.model !== field.value).map(row => ({ agentId: row.id, expectedModel: row.model || '', model: field.value })) : [];
      save.disabled = !changes.length;
      status.textContent = changes.length ? `${changes.length} pending model changes` : 'No pending model changes';
    };
    field.addEventListener('change', stage);
    save.addEventListener('click', async () => {
      if (!changes.length || save.disabled) return;
      if (state.agentLibrary.dirty) { status.textContent = 'Save or discard your package edits before changing team models.'; return; }
      field.disabled = true; save.disabled = true;
      try {
        const result = await fetchJson('/api/settings/agents/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) });
        for (const row of result.results || []) if (row.ok) {
          const agent = agents.find(agent => agent.id === row.agentId);
          if (agent) agent.model = row.newModel;
          const displayedModel = target.closest?.('[data-package-editor]')?.querySelector(`[data-effective-agent-model="${CSS.escape(row.agentId)}"]`);
          if (displayedModel) displayedModel.textContent = row.newModel;
        }
        await Promise.all([loadAgentTeams(), loadAgents()]);
        stage();
        const failed = (result.results || []).filter(row => !row.ok);
        status.textContent = failed.length ? failed.map(row => `${row.agentId}: ${row.error}`).join('; ') : 'Team models saved. Instructions are unchanged.';
        showToast(failed.length ? 'Some team models need attention.' : 'Team models saved.', { kind: failed.length ? 'warning' : 'success', label: 'Agents' });
      } catch (error) { status.textContent = error.message; save.disabled = false; }
      finally { field.disabled = !catalog.available; }
    });
  } catch (error) { if (target.isConnected) target.textContent = `Could not load team models: ${error.message}`; }
}

function teamAssignableAgents(team, { agents = state.teamCatalog.agents } = {}) {
  const assigned = new Set(team?.assignedAgentIds || []);
  const baseMembers = new Set((team?.memberIds || []).filter(id => !assigned.has(id)));
  return (agents || []).filter(agent => agent.id !== 'glados' && !agent.teamCoordinator && agent.assignable !== false && !baseMembers.has(agent.id)
    && (team?.id !== 'glados' || agent.packageId || String(agent.id).startsWith('pkg-')));
}

function agentOriginLabel(agent) {
  const rtTeam = agent.packageId ? fordAgenticTeamForPackage(agent.packageId) : null;
  return rtTeam ? `${fordAgenticTeamTitle(rtTeam).replace(/ Agentic Team$/i, '')} · RT Agentic Team`
    : agent.packageId || String(agent.id).startsWith('pkg-') ? 'Custom agent' : 'GLaDOS agent';
}

function teamAssignmentsMarkup(team) {
  if (!team) return '<p class="field-note">Save this team before assigning additional specialists.</p>';
  const agents = teamAssignableAgents(team);
  const assigned = new Set(team.assignedAgentIds || []);
  return `<div class="settings-section-heading"><div><h2>${team.id === 'glados' ? 'Custom agents in the GLaDOS team' : 'Additional team agents'}</h2><p class="settings-section-copy">${team.id === 'glados' ? 'Assign custom specialists GLaDOS can use alongside its built-in team.' : 'Add GLaDOS specialists and custom agents from other packages. This changes this team’s roster while keeping each agent’s own capabilities.'}</p></div></div>
    ${agents.length ? `<label class="team-assignment-search"><span class="sr-only">Find an assignable agent</span><input type="search" data-assignment-search placeholder="Find an agent to assign…" /></label><div class="team-assignment-list">${agents.map(agent => `<label class="team-assignment-choice" data-assignment-name="${escapeHtml(`${agent.name || ''} ${agent.id} ${agentOriginLabel(agent)}`.toLowerCase())}" title="${escapeHtml(agent.id)}"><input type="checkbox" data-assigned-agent value="${escapeHtml(agent.id)}"${assigned.has(agent.id) ? ' checked' : ''}${agent.available === false && !assigned.has(agent.id) ? ' disabled' : ''} /><span><strong>${escapeHtml(agentDisplayName(agent))}</strong><small>${escapeHtml(agentOriginLabel(agent))}${agent.available === false ? ' · Disabled' : ''}</small></span></label>`).join('')}</div><div class="team-assignment-save"><span data-assignment-status role="status">${assigned.size} added agent${assigned.size === 1 ? '' : 's'}</span><button type="button" class="safe" data-save-team-assignments disabled>Save assignments</button></div>` : '<p class="field-note">No additional specialists are available. Create or import a custom agent to add one here.</p>'}`;
}

function renderTeamAssignments(target, teamId) {
  if (!target) return;
  const team = (state.teamCatalog.teams || []).find(item => item.id === teamId);
  target.innerHTML = teamAssignmentsMarkup(team);
  if (!team) return;
  const save = target.querySelector('[data-save-team-assignments]');
  const status = target.querySelector('[data-assignment-status]');
  if (!save || !status) return;
  const committed = [...(team.assignedAgentIds || [])].sort().join('\n');
  const selected = () => [...target.querySelectorAll('[data-assigned-agent]:checked')].map(field => field.value).sort();
  target.querySelectorAll('[data-assigned-agent]').forEach(field => field.addEventListener('change', () => {
    const draft = selected();
    save.disabled = draft.join('\n') === committed;
    status.textContent = save.disabled ? `${draft.length} assignment${draft.length === 1 ? '' : 's'}` : `${draft.length} selected · Unsaved changes`;
  }));
  target.querySelector('[data-assignment-search]')?.addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    target.querySelectorAll('[data-assignment-name]').forEach(label => { label.hidden = !label.dataset.assignmentName.includes(query); });
  });
  save.addEventListener('click', async () => {
    const assignedAgentIds = selected();
    save.disabled = true;
    status.textContent = 'Saving team assignments…';
    try {
      await packageApi('PATCH', `/api/agent-teams/${encodeURIComponent(teamId)}`, { assignedAgentIds, expectedRevision: team.revision });
      await loadAgentTeams();
      await loadAgents();
      if (target.isConnected) renderTeamAssignments(target, teamId);
      showToast('Team assignments saved.', { kind: 'success', label: 'Agents' });
    } catch (error) { status.textContent = error.message; save.disabled = false; }
  });
}

function drawAgentsLibrary(wrap) {
  if (!wrap.isConnected) return;
  const library = state.agentLibrary;
  const content = wrap.querySelector('[data-library-content]');
  content.className = 'collection-content';
  drawAgentLibraryTabs(wrap);
  if (library.view === 'built-in') {
    content.innerHTML = `<p class="collection-note">GLaDOS coordinates its built-in agents and the custom specialists you assign to this team.</p>${builtInAgentsMarkup()}<section class="team-assignments-section" data-built-in-team-assignments></section>`;
    renderTeamAssignments(content.querySelector('[data-built-in-team-assignments]'), 'glados');
    loadBuiltInAgentSettings(content);
    return;
  }
  if (library.view.startsWith('team:')) {
    const packageId = library.view.slice(5);
    const installed = installedFordAgenticTeams().find(team => team.package.id === packageId);
    if (!installed) { library.view = 'built-in'; drawAgentsLibrary(wrap); return; }
    if (library.selectedId !== packageId || !library.draft) {
      content.innerHTML = '<p class="collection-loading">Loading the team’s agents…</p>';
      selectAgentPackage(packageId, wrap).catch(error => { if (content.isConnected) content.textContent = error.message; });
      return;
    }
    const manifest = library.draft;
    const team = manifest.teams.find(row => row.id === library.selectedTeamId) || manifest.teams[0];
    const teamId = `pkg-${manifest.id}--${team.id}`;
    content.innerHTML = `<p class="collection-note">${escapeHtml(installed.description || installed.package.description)}</p>${builtInAgentsMarkup({ teamName: installed.name || manifest.name, packageTeam: true })}<section class="team-assignments-section" data-built-in-team-assignments></section>`;
    const editor = content.querySelector('[data-package-editor]');
    renderAgentPackageEditor(editor, wrap);
    renderTeamAssignments(content.querySelector('[data-built-in-team-assignments]'), teamId);
    loadBuiltInAgentSettings(content, { teamId, manifest, team, onEditAgent: async (agent, models) => {
      if (agent.packageId === packageId) {
        const localId = agent.id.slice(`pkg-${packageId}--`.length);
        if (!manifest.agents.some(row => row.id === localId)) return;
        library.selectedAgentId = localId;
        resetAgentPackageTest();
        renderAgentPackageEditor(editor, wrap);
      } else if (agent.packageId) {
        if (!await confirmAgentPackageDiscard()) return;
        await selectAgentPackage(agent.packageId, wrap);
        const localId = agent.id.slice(`pkg-${agent.packageId}--`.length);
        if (library.draft.agents.some(row => row.id === localId)) { library.selectedAgentId = localId; drawAgentsLibrary(wrap); }
      } else {
        if (library.dirty) { showToast('Save your team agent edits before opening a GLaDOS specialist.', { kind: 'warning', label: 'Agents' }); return; }
        await hydrateAgentCard(agent.id, editor, models);
      }
    } });
    return;
  }
  content.innerHTML = `<div class="agent-library-grid"><aside class="agent-collection-rail" aria-label="Your agent packages"><label class="collection-search"><span class="sr-only">Find an agent package</span><input type="search" data-package-search placeholder="Find a package…" value="${escapeHtml(library.query)}" /></label><div data-package-list>${agentCollectionCards(library.catalog)}</div></aside><div class="agent-package-editor" data-package-editor></div></div>`;
  const search = content.querySelector('[data-package-search]');
  search.addEventListener('input', () => {
    library.query = search.value;
    content.querySelector('[data-package-list]').innerHTML = agentCollectionCards(library.catalog);
    wirePackageCollection(content, wrap);
  });
  wirePackageCollection(content, wrap);
  renderAgentPackageEditor(content.querySelector('[data-package-editor]'), wrap);
}

function fordTeamAgentRosterMarkup(manifest, selectedId) {
  const coordinatorIds = new Set((manifest?.teams || []).map(team => team.coordinator));
  return (manifest?.agents || []).map(agent => `<button type="button" class="agent-package-row${selectedId === agent.id ? ' selected' : ''}" data-ford-roster-agent="${escapeHtml(agent.id)}" aria-pressed="${selectedId === agent.id}"><span class="package-row-title"><strong>${escapeHtml(agent.name || agent.id)}</strong>${coordinatorIds.has(agent.id) ? '<span class="package-status">Coordinator</span>' : ''}</span><span class="package-row-description">${escapeHtml(agent.description || '')}</span><span class="package-row-meta">${escapeHtml(agent.model || 'Use current model')} · ${escapeHtml(agent.effort || 'medium')} reasoning</span></button>`).join('');
}

function drawAgentLibraryTabs(wrap) {
  const library = state.agentLibrary;
  const target = wrap.querySelector('[data-agent-library-tabs]');
  if (!target) return;
  const teams = installedFordAgenticTeams();
  const count = customAgentPackages(library.catalog).length;
  target.innerHTML = `<button type="button" role="tab" data-library-view="built-in" aria-selected="${library.view === 'built-in'}">GLaDOS Agentic Team</button>${teams.map(team => `<button type="button" role="tab" data-library-view="team:${escapeHtml(team.package.id)}" aria-selected="${library.view === `team:${team.package.id}`}">${escapeHtml(fordAgenticTeamTitle(team))}</button>`).join('')}<button type="button" role="tab" data-library-view="collection" aria-selected="${library.view === 'collection'}">Custom Agents${count ? ` <span data-package-count>${count}</span>` : ''}</button>`;
  target.querySelectorAll('[data-library-view]').forEach(button => button.addEventListener('click', async () => {
    const view = button.dataset.libraryView;
    if (view === library.view || !await confirmAgentPackageDiscard()) return;
    if (library.dirty) {
      library.draft = library.details ? portablePackageManifest(library.details) : null;
      library.dirty = false;
      resetAgentPackageTest();
    }
    library.view = view;
    if (view === 'collection' && fordAgenticTeamForPackage(library.selectedId)) {
      Object.assign(library, { selectedId: null, details: null, draft: null, dirty: false });
    }
    drawAgentsLibrary(wrap);
  }));
}

function wirePackageCollection(content, wrap) {
  content.querySelectorAll('[data-package-open]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { if (await confirmAgentPackageDiscard()) await selectAgentPackage(button.dataset.packageOpen, wrap); }
    catch (error) { showToast(error.message, { kind: 'warning', label: 'Agents' }); }
    finally { button.disabled = false; }
  }));
}

async function selectAgentPackage(id, wrap, selector = null) {
  if (!id) { drawAgentsLibrary(wrap); return; }
  const generation = ++state.agentLibrary.selectionGeneration;
  const selectionQuery = selector ? `?version=${encodeURIComponent(selector.version)}&revision=${encodeURIComponent(selector.revision)}` : '';
  const details = await fetchJson(`/api/agent-packages/${encodeURIComponent(id)}${selectionQuery}`);
  if (!wrap.isConnected || generation !== state.agentLibrary.selectionGeneration) return;
  if (fordAgenticTeamForPackage(id)) state.agentLibrary.view = `team:${id}`;
  else if (state.agentLibrary.view.startsWith('team:')) state.agentLibrary.view = 'collection';
  state.agentLibrary.selectedId = id;
  state.agentLibrary.details = details.package || details;
  const previousAgentId = state.agentLibrary.selectedAgentId;
  const previousTeamId = state.agentLibrary.selectedTeamId;
  state.agentLibrary.draft = portablePackageManifest(state.agentLibrary.details);
  state.agentLibrary.selectedAgentId = state.agentLibrary.draft.agents.some(agent => agent.id === previousAgentId) ? previousAgentId : state.agentLibrary.draft.agents[0]?.id;
  state.agentLibrary.selectedTeamId = state.agentLibrary.draft.teams.some(team => team.id === previousTeamId) ? previousTeamId : state.agentLibrary.draft.teams[0]?.id || null;
  resetAgentPackageTest();
  state.agentLibrary.dirty = false;
  drawAgentsLibrary(wrap);
}

function packageCapabilityChoices(kind, selected, catalog) {
  const available = kind === 'connectors'
    ? (catalog?.connectors || []).map(item => ({ id: item.id || item.serverName, name: item.name || item.id || item.serverName, unavailable: item.available === false || item.enabled === false }))
    : (catalog?.tools || []).map(item => typeof item === 'string' ? { id: item, name: item } : { id: item.id || item.name, name: item.name || item.id });
  const known = new Set(available.map(item => item.id));
  for (const id of selected || []) if (!known.has(id)) available.push({ id, name: id, unavailable: true });
  if (!available.length) return `<p class="field-note">${kind === 'connectors' ? 'No connectors are available. Add them in Tools → Connectors.' : 'No tools are listed for this runtime.'}</p>`;
  return available.filter(item => item.id).map(item => `<label class="capability-choice"><input type="checkbox" data-capability="${kind}" value="${escapeHtml(item.id)}" ${(selected || []).includes(item.id) ? 'checked' : ''} /><span>${escapeHtml(item.name)}${item.unavailable ? '<small>Not connected</small>' : ''}</span></label>`).join('');
}

function packageToolsMarkup(agent, catalog) {
  const all = (catalog?.tools || []).map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean);
  const selected = new Set(agent.tools || []);
  const connectors = catalog?.connectors || [];
  const captured = new Set();
  const choices = (tools, enabled = true) => tools.map(tool => {
    captured.add(tool);
    return `<label class="capability-choice" data-tool-choice="${escapeHtml(tool.toLowerCase())}"><input type="checkbox" data-capability="tools" value="${escapeHtml(tool)}"${selected.has(tool) ? ' checked' : ''}${!enabled && !selected.has(tool) ? ' disabled' : ''} /><span>${escapeHtml(tool)}</span></label>`;
  }).join('');
  const core = all.filter(tool => !tool.startsWith('mcp__'));
  let groups = `<div class="package-core-tools">${choices(core)}</div>`;
  for (const connector of connectors) {
    const prefix = `mcp__${connector.serverName || connector.id}`;
    const tools = all.filter(tool => tool === prefix || tool.startsWith(`${prefix}__`));
    if (!tools.length) continue;
    const enabled = (agent.connectors || []).includes(connector.id);
    const selectedCount = tools.filter(tool => selected.has(tool)).length;
    groups += `<details class="package-tool-group"${selectedCount ? ' open' : ''}><summary>${escapeHtml(connector.name || connector.id)} <small>${selectedCount ? `${selectedCount} selected · ` : ''}${tools.length} choices</small></summary>${!enabled ? '<p class="field-note">Select this connector above to add its tools.</p>' : ''}<div class="package-connector-tools">${choices(tools, enabled)}</div></details>`;
  }
  const other = [...new Set([...all.filter(tool => !captured.has(tool)), ...(agent.tools || []).filter(tool => !captured.has(tool))])];
  if (other.length) groups += `<details class="package-tool-group" open><summary>Other selected tools</summary><div class="package-connector-tools">${choices(other)}</div></details>`;
  return `<label class="package-tool-search"><span class="sr-only">Find an available tool</span><input type="search" data-package-tool-search placeholder="Find a tool…" /></label>${groups}<p class="field-note">A server name such as mcp__clippy enables every advertised tool for that connector. Select individual tools for a narrower set.</p>`;
}

function wirePackageToolSearch(editor) {
  const field = editor.querySelector('[data-package-tool-search]');
  field?.addEventListener('input', () => {
    const query = field.value.trim().toLowerCase();
    const target = editor.querySelector('[data-package-tools]');
    target.querySelectorAll('[data-tool-choice]').forEach(label => { label.hidden = !label.dataset.toolChoice.includes(query); });
    target.querySelectorAll('.package-tool-group').forEach(group => {
      group.hidden = ![...group.querySelectorAll('[data-tool-choice]')].some(label => !label.hidden);
      if (query && !group.hidden) group.open = true;
    });
  });
}

function agentEditorMarkup(agent, catalog) {
  const models = [...new Set([agent.model, ...(catalog?.models || [])].filter(Boolean))];
  return `<div class="editor-field-grid"><label class="editor-field"><span>Name</span><input data-agent-field="name" maxlength="120" value="${escapeHtml(agent.name || '')}" placeholder="Agent name" /></label><label class="editor-field"><span>Agent ID</span><input data-agent-field="id" value="${escapeHtml(agent.id)}" spellcheck="false" /></label></div>
    <label class="editor-field"><span>Description</span><textarea data-agent-field="description" rows="2" placeholder="What does this agent help with?">${escapeHtml(agent.description || '')}</textarea></label>
    <label class="editor-field"><span>Instructions</span><textarea class="agent-instructions-input" data-agent-field="instructions" rows="8" placeholder="Describe the role, how it should work, and when it should ask for input.">${escapeHtml(agent.instructions || '')}</textarea></label>
    <div class="editor-field-grid"><label class="editor-field"><span>Model</span><input data-agent-field="model" list="package-model-options" value="${escapeHtml(agent.model || '')}" placeholder="Choose or enter a model" autocomplete="off" /><datalist id="package-model-options">${models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist></label><label class="editor-field"><span>Reasoning</span><select data-agent-field="effort">${['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => `<option value="${effort}"${agent.effort === effort ? ' selected' : ''}>${effort === 'max' ? 'Maximum' : effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}</option>`).join('')}</select></label></div>
    <fieldset class="capability-fieldset"><legend>Connectors</legend><div class="capability-choices">${packageCapabilityChoices('connectors', agent.connectors, catalog)}</div><button type="button" class="text-action" data-manage-connectors>Manage connectors</button></fieldset>
    <fieldset class="capability-fieldset"><legend>Tools</legend><div data-package-tools>${packageToolsMarkup(agent, catalog)}</div></fieldset>
    <label class="editor-field"><span>Expected deliverables</span><textarea data-agent-field="deliverables" rows="3" placeholder="One deliverable per line">${escapeHtml((agent.deliverables || []).join('\n'))}</textarea></label>
    <fieldset class="capability-fieldset package-skills"><legend>Skills</legend><div>${(agent.skills || []).map((skill, index) => `<div class="package-skill-row"><span><strong>${escapeHtml(typeof skill === 'string' ? skill : skill.name || skill.id)}</strong><small>${escapeHtml(typeof skill === 'string' ? `skills/${skill}/SKILL.md` : skill.path || '')}</small></span><button type="button" class="text-action" data-remove-package-skill="${index}">Remove</button></div>`).join('') || '<p class="field-note">Add a skill instruction file to teach this agent a repeatable workflow.</p>'}</div><label class="skill-file-upload text-action">Add skill file<input type="file" data-package-skill-file accept=".md,.markdown,text/markdown" /></label></fieldset>`;
}

function packageEditorCatalog(details, catalog, agent = null) {
  const limits = details?.editableIntegration && details.integrationCapabilities;
  if (!limits) return catalog;
  const tools = new Set(limits.agentTools && agent ? limits.agentTools[agent.id] || limits.defaultAgentTools || [] : limits.tools || []);
  const connectors = new Set(limits.connectors || []);
  return { ...catalog, tools: (catalog?.tools || []).filter(item => tools.has(typeof item === 'string' ? item : item.id || item.name)), connectors: (catalog?.connectors || []).filter(item => connectors.has(item.id || item.serverName)) };
}

function teamEditorMarkup(team, agents, { saved = false, disabled = false } = {}) {
  return `<section class="team-editor"><div class="editor-subsection-heading"><h3>Team</h3>${saved ? `<button type="button" class="text-action danger-text" data-delete-package-entry="team" data-delete-local-id="${escapeHtml(team.id)}"${disabled ? ' disabled' : ''}>Delete team</button>` : ''}</div><div class="editor-field-grid"><label class="editor-field"><span>Team name</span><input data-team-field="name" value="${escapeHtml(team.name || '')}" placeholder="Team name" /></label><label class="editor-field"><span>Coordinator</span><select data-team-field="coordinator">${agents.map(agent => `<option value="${escapeHtml(agent.id)}"${team.coordinator === agent.id ? ' selected' : ''}>${escapeHtml(agent.name || agent.id)}</option>`).join('')}</select></label></div><label class="editor-field"><span>Team description</span><textarea data-team-field="description" rows="2">${escapeHtml(team.description || '')}</textarea></label><fieldset class="capability-fieldset"><legend>Members</legend><div class="capability-choices">${agents.map(agent => `<label class="capability-choice"><input type="checkbox" data-team-member value="${escapeHtml(agent.id)}"${(team.members || []).includes(agent.id) ? ' checked' : ''} /><span>${escapeHtml(agent.name || agent.id)}</span></label>`).join('')}</div></fieldset></section>`;
}

function packageInvocationState(details, entry, { team = false, dirty = false, catalog = state.agentLibrary.catalog, agents = state.agents } = {}) {
  const id = details?.id && entry?.id ? `pkg-${details.id}--${entry.id}` : null;
  if (!details || !id) return { id, available: false, reason: 'Save this package before opening a conversation.' };
  if (dirty) return { id, available: false, reason: 'Save your changes before opening this version.' };
  if (details.enabled === false || entry.enabled === false) return { id, available: false, reason: 'Enable this package and agent first.' };
  const selectedRevision = details.selectedRevision || details.revision;
  if (selectedRevision !== (details.activeRevision || details.revision)) return { id, available: false, reason: 'Activate this saved revision first.' };
  const manifest = details.manifest || details.selectedManifest || {};
  const members = team ? (manifest.agents || []).filter(agent => (entry.members || []).includes(agent.id)) : [entry];
  const required = [...new Set(members.flatMap(agent => agent.requiredConnectors || agent.connectors || []))];
  const missing = required.filter(connectorId => {
    const connector = (catalog?.connectors || []).find(item => item.id === connectorId);
    return !connector || connector.available === false || connector.enabled === false;
  });
  if (missing.length) return { id, available: false, reason: `Connect the required connector${missing.length === 1 ? '' : 's'} first: ${missing.join(', ')}.` };
  const globalTeam = team ? (state.teamCatalog?.teams || []).find(item => item.id === id) : null;
  const runtime = [...(state.teamCatalog?.agents || []), ...agents].find(agent => agent.id === id);
  if ((team && globalTeam?.available === false) || (!runtime && !globalTeam) || runtime?.available === false || runtime?.enabled === false) return { id, available: false, reason: team ? 'This saved team is unavailable.' : 'Enable this agent before starting a direct conversation.' };
  return { id, available: true, reason: team ? 'Open this team’s conversation to give it a task.' : 'Open this agent’s conversation to give it a task.' };
}

function packageInvocationMarkup(details, agent, team) {
  if (!details) return '';
  const currentAgent = packageInvocationState(details, agent, { dirty: state.agentLibrary.dirty });
  const currentTeam = team ? packageInvocationState(details, team, { team: true, dirty: state.agentLibrary.dirty }) : null;
  return `<div class="package-invocation-actions">${team ? `<button type="button" data-package-team-enabled data-team-local-id="${escapeHtml(team.id)}"${state.agentLibrary.dirty || (details.selectedRevision || details.revision) !== details.activeRevision ? ' disabled' : ''}>${team.enabled === false ? 'Enable team' : 'Disable team'}</button>` : ''}<button type="button" data-invoke-package-agent data-invoke-local-id="${escapeHtml(agent.id)}" title="${escapeHtml(currentAgent.reason)}"${currentAgent.available ? '' : ' disabled'}>Chat with agent</button>${currentTeam ? `<button type="button" data-invoke-package-team data-invoke-local-id="${escapeHtml(team.id)}" title="${escapeHtml(currentTeam.reason)}"${currentTeam.available ? '' : ' disabled'}>Run team</button>` : ''}<button type="button" data-package-export>Export</button></div>`;
}

function syncPackageInvocationControls() {
  const library = state.agentLibrary;
  const details = library.details;
  if (!details) return;
  const manifest = library.draft || details.manifest;
  document.querySelectorAll('[data-invoke-package-agent], [data-invoke-package-team]').forEach(button => {
    const team = button.hasAttribute('data-invoke-package-team');
    const entry = (team ? manifest.teams : manifest.agents)?.find(item => item.id === button.dataset.invokeLocalId);
    const readiness = packageInvocationState(details, entry, { team, dirty: library.dirty });
    button.disabled = !readiness.available;
    button.title = readiness.reason;
  });
}

function arrangeTeamAgentEditor(editor, agent, effectiveAgent) {
  const advanced = document.createElement('details');
  advanced.className = 'team-package-settings package-identity';
  advanced.innerHTML = '<summary>Team settings and package history</summary>';
  const selectors = ['[data-package-field="name"]', '[data-package-field="description"]', '.package-identity', '.package-agent-switch', '[data-select-package-team]', '.team-editor'];
  for (const selector of selectors) {
    const field = editor.querySelector(selector);
    const block = selector === '[data-package-field="name"]' ? field?.closest('.editor-field-grid')
      : selector === '[data-package-field="description"]' || selector === '[data-select-package-team]' ? field?.closest('.editor-field') : field;
    if (block) advanced.appendChild(block);
  }
  editor.querySelector('[data-package-team-models]')?.remove();
  editor.querySelector('[data-custom-team-assignments]')?.remove();
  editor.querySelector('.package-managed-note')?.remove();
  const title = editor.querySelector('.package-editor-heading h2');
  if (title) title.textContent = agent.name || agent.id;
  const eyebrow = editor.querySelector('.package-editor-heading .collection-eyebrow');
  if (eyebrow) eyebrow.textContent = fordAgenticTeamTitle(fordAgenticTeamForPackage(state.agentLibrary.selectedId));
  const model = editor.querySelector('[data-agent-field="model"]');
  if (model) {
    model.value = effectiveAgent?.model || agent.model || '';
    model.readOnly = true;
    model.removeAttribute('data-agent-field');
    model.removeAttribute('list');
    model.dataset.effectiveAgentModel = `pkg-${state.agentLibrary.draft.id}--${agent.id}`;
    const note = document.createElement('small');
    note.textContent = 'Use the model controls above. Save Changes applies staged models.';
    model.closest('.editor-field').appendChild(note);
  }
  editor.querySelector('[data-effective-agent-model]:not(input)')?.closest('.field-note')?.remove();
  const form = editor.querySelector('.package-agent-form');
  const save = editor.querySelector('[data-save-package]');
  if (save) save.textContent = 'Save agent';
  const saveBar = save?.closest('.package-save-bar');
  const status = editor.querySelector('[data-package-status]');
  if (status) form.after(status);
  if (saveBar) (status || form).after(saveBar);
  if (saveBar) saveBar.after(advanced); else form.after(advanced);
  const test = editor.querySelector('.package-test');
  if (test) {
    const collapsedTest = document.createElement('details');
    collapsedTest.className = 'package-identity';
    collapsedTest.innerHTML = '<summary>Try a conversation</summary>';
    test.before(collapsedTest); collapsedTest.appendChild(test);
  }
}

function renderAgentPackageEditor(editor, wrap) {
  const library = state.agentLibrary;
  const draft = library.draft;
  if (!draft) {
    editor.innerHTML = `<div class="agent-editor-empty"><span class="collection-eyebrow">Your specialists</span><h2>Turn capabilities into an agent.</h2><p>Give it a role, choose the tools it can use, and try a conversation before saving. Create a team in GLaDOS or use an installed team integration.</p><div><button type="button" class="safe" data-empty-new>Create an agent</button><button type="button" data-empty-import>Upload an agent</button></div><p class="field-note">Built-in agents and your collection are managed separately. Saved versions and revisions stay available after updates.</p></div>`;
    editor.querySelector('[data-empty-new]').addEventListener('click', () => wrap.querySelector('[data-new-agent]').click());
    editor.querySelector('[data-empty-import]').addEventListener('click', () => wrap.querySelector('[data-import-package]').click());
    return;
  }
  const agent = draft.agents.find(item => item.id === library.selectedAgentId) || draft.agents[0];
  if (!agent) { editor.innerHTML = '<p>No agents are present in this package.</p>'; return; }
  library.selectedAgentId = agent.id;
  const details = library.details;
  const summary = details ? agentPackageSummary(details) : null;
  const revision = details?.selectedRevision || details?.revision || details?.latestRevision;
  const effectiveAgent = (state.teamCatalog.agents || []).find(row => row.id === `pkg-${draft.id}--${agent.id}`);
  const active = details?.active || details?.activeVersion;
  const revisions = details?.revisions || details?.versions || [];
  const team = draft.teams?.find(item => item.id === library.selectedTeamId) || draft.teams?.[0];
  editor.dataset.dirty = String(library.dirty);
  editor.innerHTML = `<div class="package-editor-heading"><div><span class="collection-eyebrow">${details ? summary.managedIntegration ? 'Installed integration' : summary.source === 'imported' ? 'Uploaded agent' : 'Custom package' : team ? 'New team' : 'New specialist'}</span><h2>${escapeHtml(draft.name || (team ? 'Create a team' : 'Create an agent'))}</h2></div>${packageInvocationMarkup(details, agent, team)}</div>
    ${summary?.managedIntegration ? `<p class="package-managed-note">${summary.editableIntegration ? 'Customize this integration’s instructions, model, reasoning, and tools. Saved revisions stay available and your changes are preserved when GLaDOS updates.' : `${team ? 'Enable a team above when you are ready to use it. ' : 'Enable this package when you are ready to use it. '}Its instructions and resources are managed by Codex. You can review them, manage enabled state, and choose additional team assignments.`}</p>` : ''}
    <div class="editor-field-grid"><label class="editor-field"><span>Package name</span><input data-package-field="name" maxlength="120" value="${escapeHtml(draft.name || '')}" placeholder="Name your specialist or team" /></label><label class="editor-field version-field"><span>Version</span><input data-package-field="version" value="${escapeHtml(draft.version)}" placeholder="1.0.0" spellcheck="false" /></label></div>
    <label class="editor-field"><span>Package description</span><textarea data-package-field="description" rows="2" placeholder="When should GLaDOS call on this package?">${escapeHtml(draft.description || '')}</textarea></label>
    <details class="package-identity"><summary>Package identity & history</summary><label class="editor-field"><span>Stable package ID</span><input data-package-field="id" value="${escapeHtml(draft.id)}"${details ? ' readonly' : ''} spellcheck="false" /></label><p class="field-note">${revision ? `Saved revision: ${escapeHtml(String(revision).slice(0, 10))}. ` : ''}Saving creates and selects a new revision. Imported updates wait for you to activate them; previous revisions stay available.</p>${revisions.length ? `<div class="package-history">${revisions.map(item => `<button type="button" class="text-action" data-package-revision="${escapeHtml(item.revision)}" data-package-version="${escapeHtml(item.version)}">v${escapeHtml(item.version || draft.version)} · ${escapeHtml(String(item.revision).slice(0, 10))}${item.active ? ' · Active' : item.staged ? ' · Imported, awaiting activation' : ''}</button>`).join('')}</div>` : ''}</details>
    ${draft.agents.length > 1 || team ? `<div class="package-agent-switch"><label class="editor-field"><span>Agent in this package</span><select data-select-package-agent>${draft.agents.map(item => `<option value="${escapeHtml(item.id)}"${item.id === agent.id ? ' selected' : ''}>${escapeHtml(item.name || item.id)}</option>`).join('')}</select></label><button type="button" data-add-package-agent>Add agent</button>${draft.agents.length > 1 ? '<button type="button" class="text-action" data-remove-package-agent>Remove from draft</button>' : ''}</div>` : ''}
    <section class="package-agent-form"><div class="editor-subsection-heading"><h3>${team ? 'Agent instructions & capabilities' : 'Instructions & capabilities'}</h3>${details ? `<button type="button" class="text-action danger-text" data-delete-package-entry="agent" data-delete-local-id="${escapeHtml(agent.id)}"${library.dirty || revision !== details.activeRevision ? ' disabled' : ''}>Delete agent</button>` : ''}</div>${agentEditorMarkup(agent, packageEditorCatalog(details, library.catalog, agent))}${effectiveAgent?.model ? `<p class="field-note">Current runtime model: <strong data-effective-agent-model="${escapeHtml(effectiveAgent.id)}">${escapeHtml(effectiveAgent.model)}</strong>. A saved team model override takes precedence for this revision.</p>` : ''}</section>
    ${draft.teams?.length > 1 ? `<label class="editor-field"><span>Team in this package</span><select data-select-package-team>${draft.teams.map(item => `<option value="${escapeHtml(item.id)}"${item === team ? ' selected' : ''}>${escapeHtml(item.name || item.id)}</option>`).join('')}</select></label>` : ''}${team ? '<section class="package-team-models" data-package-team-models></section>' : ''}${team ? teamEditorMarkup(team, draft.agents, { saved: !!details, disabled: library.dirty || revision !== details?.activeRevision }) : ''}${team ? '<section class="team-assignments-section" data-custom-team-assignments></section>' : ''}
    ${(draft.resources || []).length ? `<details class="package-resources"><summary>Supporting resources (${draft.resources.length})</summary><ul>${draft.resources.map(item => `<li><code>${escapeHtml(item.path)}</code><span>${String(item.text || '').length.toLocaleString()} characters</span></li>`).join('')}</ul></details>` : ''}
    <section class="package-test"><div class="package-test-heading"><div><h3>Try a conversation</h3><p>Test this agent’s instructions and response before saving. Tools stay off during the test.</p></div><button type="button" class="text-action" data-clear-package-test>Clear</button></div><div class="package-test-messages" data-package-test-messages role="log" aria-label="Agent test conversation"></div><div class="package-test-composer"><textarea data-package-test-prompt rows="2" placeholder="Give this agent a sample task…" aria-label="Sample task"></textarea><button type="button" data-run-package-test>Test agent</button></div><p class="field-note" data-package-test-status role="status"></p></section>
    <div class="package-editor-status" data-package-status role="status" aria-live="polite"></div>
    <div class="package-save-bar"><p>${details ? `Saved ${escapeHtml(draft.version)}${revision ? ` · revision ${escapeHtml(String(revision).slice(0, 10))}` : ''}${revision === details?.activeRevision ? ' · Active revision' : ' · Ready to activate'}` : 'Save to your personal collection and make it available to GLaDOS.'}</p><div>${details ? `<button type="button" class="text-action danger-text" data-delete-package${library.dirty ? ' disabled' : ''}>Delete package</button><button type="button" data-package-enabled${library.dirty ? ' disabled' : ''}>${summary.enabled ? 'Disable' : 'Enable'}</button>${revision !== details.activeRevision ? `<button type="button" data-package-activate${library.dirty ? ' disabled' : ''}>Activate this revision</button>` : ''}` : ''}<button type="button" class="safe" data-save-package>${details ? 'Save new revision' : 'Save package'}</button></div></div>`;
  if (summary?.managedIntegration && !summary.editableIntegration) makeManagedPackageReadOnly(editor);
  if (summary?.editableIntegration) {
    editor.querySelectorAll('[data-package-field="id"], [data-agent-field="id"]').forEach(field => { field.readOnly = true; });
    editor.querySelectorAll('[data-add-package-agent], [data-remove-package-agent], [data-delete-package-entry], [data-delete-package]').forEach(control => { control.hidden = true; });
  }
  const installedTeamView = library.view.startsWith('team:');
  if (installedTeamView) arrangeTeamAgentEditor(editor, agent, effectiveAgent);
  wireAgentPackageEditor(editor, wrap, agent, team);
  if (team && !installedTeamView) {
    renderPackageTeamModels(editor.querySelector('[data-package-team-models]'), draft, team, details);
    const assignments = editor.querySelector('[data-custom-team-assignments]');
    if (!details) assignments.innerHTML = '<p class="field-note">Save this team to assign additional specialists.</p>';
    else if (revision !== details.activeRevision) assignments.innerHTML = '<p class="field-note">Activate this revision to manage its team assignments.</p>';
    else renderTeamAssignments(assignments, `pkg-${draft.id}--${team.id}`);
  }
  renderPackageTestMessages(editor);
  loadComposerModels().then(catalog => {
    if (!editor.isConnected || library.selectedAgentId !== agent.id) return;
    library.catalog.models = catalog.models || [];
    const options = editor.querySelector('#package-model-options');
    if (options) options.innerHTML = [...new Set([agent.model, ...(catalog.models || [])].filter(Boolean))].map(model => `<option value="${escapeHtml(model)}"></option>`).join('');
  }).catch(() => {});
}

function makeManagedPackageReadOnly(editor) {
  editor.dataset.managedIntegration = 'true';
  editor.querySelectorAll('[data-package-field], [data-agent-field], [data-team-field], [data-capability], [data-team-member]').forEach(field => {
    if (field.tagName === 'SELECT' || field.type === 'checkbox') field.disabled = true;
    else field.readOnly = true;
  });
  editor.querySelectorAll('[data-save-package], [data-add-package-agent], [data-remove-package-agent], [data-remove-package-skill], .skill-file-upload').forEach(control => { control.hidden = true; });
}

function wireAgentPackageEditor(editor, wrap, agent, team) {
  const library = state.agentLibrary;
  const draft = library.draft;
  const status = editor.querySelector('[data-package-status]');
  const setStatus = (message, failed = false) => { status.textContent = message; status.classList.toggle('error', failed); };
  const markChanged = () => {
    library.dirty = true;
    syncPackageInvocationControls();
    resetAgentPackageTest();
    renderPackageTestMessages(editor);
    editor.dataset.dirty = 'true';
    setStatus('Unsaved changes');
    editor.querySelector('[data-package-activate]')?.setAttribute('disabled', '');
    editor.querySelector('[data-package-enabled]')?.setAttribute('disabled', '');
    editor.querySelector('[data-package-team-enabled]')?.setAttribute('disabled', '');
    editor.querySelector('[data-delete-package]')?.setAttribute('disabled', '');
    editor.querySelectorAll('[data-delete-package-entry]').forEach(button => { button.disabled = true; });
  };
  editor.querySelectorAll('[data-package-field]').forEach(field => field.addEventListener('input', () => {
    draft[field.dataset.packageField] = field.value;
    if (field.dataset.packageField === 'name' && draft.agents.length === 1 && !team && (!agent.name || agent.name === field.dataset.previousName)) {
      agent.name = field.value;
      editor.querySelector('[data-agent-field="name"]').value = field.value;
    }
    field.dataset.previousName = field.value;
    markChanged();
  }));
  editor.querySelectorAll('[data-agent-field]').forEach(field => field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => {
    const key = field.dataset.agentField;
    const oldId = agent.id;
    agent[key] = ['deliverables', 'skills'].includes(key) ? packageLineItems(field.value) : field.value;
    if (key === 'id') {
      library.selectedAgentId = agent.id;
      for (const currentTeam of draft.teams || []) {
        if (currentTeam.coordinator === oldId) currentTeam.coordinator = agent.id;
        currentTeam.members = (currentTeam.members || []).map(id => id === oldId ? agent.id : id);
      }
    }
    markChanged();
  }));
  const wireCapabilities = kind => {
    editor.querySelectorAll(`[data-capability="${kind}"]`).forEach(field => field.addEventListener('change', () => {
      agent[kind] = [...editor.querySelectorAll(`[data-capability="${kind}"]:checked`)].map(item => item.value);
      if (kind === 'connectors') {
        agent.requiredConnectors = [...agent.connectors];
        editor.querySelector('[data-package-tools]').innerHTML = packageToolsMarkup(agent, packageEditorCatalog(library.details, library.catalog, agent));
        wireCapabilities('tools');
        wirePackageToolSearch(editor);
      }
      markChanged();
    }));
  };
  wireCapabilities('connectors');
  wireCapabilities('tools');
  wirePackageToolSearch(editor);
  editor.querySelectorAll('[data-invoke-package-agent], [data-invoke-package-team]').forEach(button => button.addEventListener('click', () => {
    const isTeam = button.hasAttribute('data-invoke-package-team');
    const entry = (isTeam ? draft.teams : draft.agents).find(item => item.id === button.dataset.invokeLocalId);
    const readiness = packageInvocationState(library.details, entry, { team: isTeam, dirty: library.dirty });
    if (!readiness.available) { setStatus(readiness.reason, true); syncPackageInvocationControls(); return; }
    if (isTeam && (state.currentSessionId || state.currentTeamId !== readiness.id)) {
      createInvestigationSession({ teamId: readiness.id }).catch(error => setStatus(error.message, true));
    } else if (!isTeam) {
      createInvestigationSession({ teamId: `agent:${readiness.id}` }).catch(error => setStatus(error.message, true));
    } else openAgentTab(readiness.id);
  }));
  editor.querySelector('[data-manage-connectors]')?.addEventListener('click', () => openConnectors());
  editor.querySelectorAll('[data-package-revision]').forEach(button => button.addEventListener('click', async () => {
    if (!await confirmAgentPackageDiscard()) return;
    try { await selectAgentPackage(library.selectedId, wrap, { version: button.dataset.packageVersion, revision: button.dataset.packageRevision }); }
    catch (error) { setStatus(error.message, true); }
  }));
  editor.querySelectorAll('[data-remove-package-skill]').forEach(button => button.addEventListener('click', () => {
    agent.skills.splice(Number(button.dataset.removePackageSkill), 1);
    markChanged();
    renderAgentPackageEditor(editor, wrap);
  }));
  editor.querySelector('[data-package-skill-file]')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 512 * 1024) throw new Error('Choose a skill file smaller than 512 KB.');
      const text = await file.text();
      if (!text.trim()) throw new Error('The skill file is empty.');
      const heading = text.match(/^#\s+(.+)$/m)?.[1] || file.name.replace(/\.(?:md|markdown)$/i, '');
      const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
      const id = /^[a-z]/.test(slug) ? slug : `skill-${slug || Date.now()}`;
      if ((agent.skills || []).some(skill => (typeof skill === 'string' ? skill : skill.id) === id)) throw new Error('This agent already includes a skill with that name.');
      const path = `skills/${id}/SKILL.md`;
      const resource = draft.resources.find(item => item.path === path);
      if (resource && resource.text !== text) throw new Error('This package already has a different file for that skill. Give the skill a different heading.');
      if (!resource) draft.resources.push({ path, text });
      agent.skills.push({ id, name: heading, description: '', path });
      markChanged();
      renderAgentPackageEditor(editor, wrap);
    } catch (error) { setStatus(error.message, true); }
  });
  editor.querySelector('[data-select-package-team]')?.addEventListener('change', event => { library.selectedTeamId = event.target.value; renderAgentPackageEditor(editor, wrap); });
  editor.querySelector('[data-select-package-agent]')?.addEventListener('change', event => {
    library.selectedAgentId = event.target.value;
    resetAgentPackageTest();
    renderAgentPackageEditor(editor, wrap);
    if (library.view.startsWith('team:')) wrap.querySelectorAll('.agent-card').forEach(card => card.classList.toggle('open', card.dataset.agentId === `pkg-${draft.id}--${library.selectedAgentId}`));
  });
  editor.querySelector('[data-add-package-agent]')?.addEventListener('click', () => {
    const next = newPackageDraft().agents[0];
    draft.agents.push(next);
    if (team) team.members.push(next.id);
    library.selectedAgentId = next.id;
    resetAgentPackageTest();
    renderAgentPackageEditor(editor, wrap);
    library.dirty = true;
    syncPackageInvocationControls();
    editor.dataset.dirty = 'true';
    editor.querySelector('[data-package-activate]')?.setAttribute('disabled', '');
  });
  editor.querySelector('[data-remove-package-agent]')?.addEventListener('click', async () => {
    if (!await confirmAction({ title: 'Remove this agent?', message: `Remove ${agent.name || agent.id} from the draft package? Saved revisions stay available.`, confirmLabel: 'Remove agent' })) return;
    draft.agents = draft.agents.filter(item => item !== agent);
    for (const currentTeam of draft.teams || []) {
      currentTeam.members = (currentTeam.members || []).filter(id => id !== agent.id);
      if (currentTeam.coordinator === agent.id) currentTeam.coordinator = draft.agents[0].id;
    }
    library.selectedAgentId = draft.agents[0].id;
    resetAgentPackageTest();
    renderAgentPackageEditor(editor, wrap);
    library.dirty = true;
    syncPackageInvocationControls();
    editor.dataset.dirty = 'true';
    editor.querySelector('[data-package-activate]')?.setAttribute('disabled', '');
  });
  editor.querySelectorAll('[data-team-field]').forEach(field => field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => { team[field.dataset.teamField] = field.value; markChanged(); }));
  editor.querySelectorAll('[data-team-member]').forEach(field => field.addEventListener('change', () => { team.members = [...editor.querySelectorAll('[data-team-member]:checked')].map(item => item.value); markChanged(); }));
  editor.querySelector('[data-save-package]').addEventListener('click', async event => {
    if (library.teamModelEdits?.dirty || library.teamModelEdits?.saving) { setStatus('Save or discard pending model changes before saving agent instructions.', true); return; }
    const issues = agentPackageIssues(draft, { allowInheritedModel: library.details?.editableIntegration === true });
    if (issues.length) { setStatus(issues.join(' '), true); return; }
    const button = event.currentTarget;
    button.disabled = true;
    setStatus('Saving to your collection…');
    try {
      const method = library.selectedId ? 'PATCH' : 'POST';
      const path = library.selectedId ? `/api/agent-packages/${encodeURIComponent(library.selectedId)}` : '/api/agent-packages';
      const result = await packageApi(method, path, { package: draft, ...(library.details ? { expectedRevision: library.details.activeRevision || library.details.revision } : {}) });
      await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams()]);
      await loadAgents();
      if (!wrap.isConnected || library.draft !== draft) return;
      await selectAgentPackage(result.package?.id || result.id || draft.id, wrap);
      showToast('Agent package saved and available to GLaDOS. Previous revisions are preserved.', { kind: 'success', label: 'Agents' });
    } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  editor.querySelector('[data-package-activate]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await packageApi('POST', `/api/agent-packages/${encodeURIComponent(library.selectedId)}/activate`, { version: draft.version, revision: library.details.selectedRevision || library.details.revision, expectedRevision: library.details.activeRevision || library.details.revision });
      await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams()]);
      await loadAgents();
      if (wrap.isConnected && library.draft === draft) await selectAgentPackage(draft.id, wrap);
      showToast('This saved package is available to GLaDOS on new turns.', { kind: 'success', label: 'Agents' });
    } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  editor.querySelector('[data-package-team-enabled]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await packageApi('PATCH', `/api/agent-packages/${encodeURIComponent(draft.id)}/teams/${encodeURIComponent(team.id)}/enabled`, { enabled: team.enabled === false, expectedRevision: library.details.activeRevision || library.details.revision });
      await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams()]);
      await loadAgents();
      if (wrap.isConnected && library.draft === draft) await selectAgentPackage(draft.id, wrap);
      showToast(`Team ${team.enabled === false ? 'enabled' : 'disabled'}.`, { kind: 'success', label: 'Agents' });
    } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  editor.querySelector('[data-package-enabled]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await packageApi('PATCH', `/api/agent-packages/${encodeURIComponent(library.selectedId)}/enabled`, { enabled: library.details.enabled === false, expectedRevision: library.details.activeRevision || library.details.revision });
      await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams()]);
      await loadAgents();
      if (wrap.isConnected && library.draft === draft) await selectAgentPackage(draft.id, wrap);
    } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  const deleteSavedEntry = async (kind, localId, name) => {
    const message = kind === 'package' ? `Delete ${name} from your custom collection? Its saved versions stay recoverable.` : `Delete ${name} from this package? Team membership will update and saved revisions stay available.`;
    if (!await confirmAction({ title: `Delete ${kind}?`, message, confirmLabel: `Delete ${kind}`, danger: true })) return;
    setStatus(`Deleting ${kind}…`);
    try {
      const path = kind === 'package' ? `/api/agent-packages/${encodeURIComponent(draft.id)}` : `/api/agent-packages/${encodeURIComponent(draft.id)}/${kind}s/${encodeURIComponent(localId)}`;
      const result = await packageApi('DELETE', path, { expectedRevision: library.details.activeRevision || library.details.revision });
      await Promise.all([refreshAgentLibraryCatalog(), loadAgentTeams(), loadAgents().catch(() => false)]);
      if (!wrap.isConnected || library.draft !== draft) return;
      if (kind === 'package' || result.archived) {
        library.selectedId = null;
        library.details = null;
        library.draft = null;
        library.dirty = false;
        resetAgentPackageTest();
        drawAgentsLibrary(wrap);
      } else await selectAgentPackage(draft.id, wrap);
      showToast(`${kind === 'package' ? 'Package' : kind === 'team' ? 'Team' : 'Agent'} deleted. Saved revisions are preserved.`, { kind: 'success', label: 'Agents' });
    } catch (error) { setStatus(error.message, true); }
  };
  editor.querySelectorAll('[data-delete-package-entry]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.deletePackageEntry;
    const entry = (kind === 'team' ? draft.teams : draft.agents).find(item => item.id === button.dataset.deleteLocalId);
    deleteSavedEntry(kind, entry.id, entry.name || entry.id);
  }));
  editor.querySelector('[data-delete-package]')?.addEventListener('click', () => deleteSavedEntry('package', null, draft.name));
  editor.querySelector('[data-package-export]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const savedVersion = library.details.selectedVersion || library.details.version;
      const savedRevision = library.details.selectedRevision || library.details.revision;
      const response = await fetch(`/api/agent-packages/${encodeURIComponent(draft.id)}/export?version=${encodeURIComponent(savedVersion)}&revision=${encodeURIComponent(savedRevision)}`);
      if (!response.ok) throw new Error('Could not export this agent package.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${draft.id}-${savedVersion}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  editor.querySelector('[data-clear-package-test]').addEventListener('click', () => { resetAgentPackageTest(); renderPackageTestMessages(editor); });
  editor.querySelector('[data-run-package-test]').addEventListener('click', () => runAgentPackageTest(editor, agent));
}

function resetAgentPackageTest() {
  state.agentLibrary.testGeneration++;
  state.agentLibrary.testMessages = [];
  state.agentLibrary.testBusy = false;
}

async function confirmAgentPackageDiscard() {
  const models = state.agentLibrary.teamModelEdits;
  if (models?.saving) { showToast('Wait for the model save to finish.', { kind: 'warning', label: 'Agents' }); return false; }
  if (models?.dirty && !await confirmAction({ title: 'Discard pending model changes?', message: 'Your staged model assignments have not been saved.', confirmLabel: 'Discard changes' })) return false;
  if (!await confirmBuiltInEditorDiscard()) return false;
  if (state.agentLibrary.dirty && !await confirmAction({ title: 'Discard unsaved edits?', message: 'Save your package first to keep these edits as a revision. Saved packages and earlier revisions stay available.', confirmLabel: 'Discard edits' })) return false;
  state.agentLibrary.teamModelEdits = null;
  return true;
}

function renderPackageTestMessages(editor) {
  const testButton = editor.querySelector('[data-run-package-test]');
  if (testButton && !state.agentLibrary.testBusy) { testButton.disabled = false; testButton.textContent = 'Test agent'; }
  const target = editor.querySelector('[data-package-test-messages]');
  if (!target) return;
  target.innerHTML = state.agentLibrary.testMessages.map(message => `<div class="package-test-message ${message.role === 'user' ? 'user' : 'assistant'}"><strong>${message.role === 'user' ? 'You' : 'Agent'}</strong><p>${escapeHtml(message.content)}</p></div>`).join('');
  target.scrollTop = target.scrollHeight;
}

async function runAgentPackageTest(editor, agent) {
  const library = state.agentLibrary;
  const field = editor.querySelector('[data-package-test-prompt]');
  const button = editor.querySelector('[data-run-package-test]');
  const status = editor.querySelector('[data-package-test-status]');
  const prompt = field.value.trim();
  if (!prompt || library.testBusy) return;
  if (!agent.instructions.trim() || !agent.model.trim()) { status.textContent = 'Add instructions and choose a model first.'; return; }
  const generation = ++library.testGeneration;
  library.testBusy = true;
  button.disabled = true;
  button.textContent = 'Testing…';
  status.textContent = 'Running a conversation test. Nothing is saved or activated.';
  const snapshot = JSON.parse(JSON.stringify(agent));
  const messages = [...library.testMessages, { role: 'user', content: prompt }];
  library.testMessages = messages;
  field.value = '';
  renderPackageTestMessages(editor);
  try {
    const result = await packageApi('POST', '/api/agent-packages/test', { agent: snapshot, messages }, { timeoutMs: 180000 });
    if (library.selectedAgentId !== snapshot.id || generation !== library.testGeneration) return;
    library.testMessages.push({ role: 'assistant', content: result.reply || 'The agent returned no text.' });
    renderPackageTestMessages(editor);
    status.textContent = 'Test complete. Continue the conversation or save your package.';
  } catch (error) {
    if (generation !== library.testGeneration) return;
    status.textContent = `Test could not complete: ${error.message}`;
    if (library.testMessages === messages) library.testMessages = messages.slice(0, -1);
    renderPackageTestMessages(editor);
  } finally {
    if (generation === library.testGeneration) library.testBusy = false;
    button.disabled = false;
    button.textContent = 'Test agent';
  }
}

async function agentPackageImportPayload(files) {
  if (!files?.length) throw new Error('Choose an agent package JSON, a Markdown instruction file, or a package folder.');
  if (files.length > 251) throw new Error('Choose a package with no more than 251 files.');
  let total = 0;
  const rows = [];
  for (const file of files) {
    total += file.size || 0;
    if (total > 5 * 1024 * 1024) throw new Error('Choose a package smaller than 5 MB.');
    const content = await file.text();
    const path = file.webkitRelativePath || file.name;
    rows.push({ path, content });
  }
  if (rows.length === 1 && /\.json$/i.test(rows[0].path)) {
    let parsed;
    try { parsed = JSON.parse(rows[0].content); } catch { throw new Error('The selected JSON file could not be read.'); }
    return { package: requireAgentOnlyUpload(parsed.package || parsed.manifest || parsed) };
  }
  if (rows.length === 1 && /\.(?:md|markdown)$/i.test(rows[0].path)) return { format: 'markdown', filename: rows[0].path, text: rows[0].content };
  const manifestFile = rows.find(row => /(?:^|\/)(?:glados-agent|manifest)\.json$/.test(row.path) || row.path.endsWith('.glados-agent.json'));
  if (manifestFile) {
    try { requireAgentOnlyUpload(JSON.parse(manifestFile.content)); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('The folder manifest could not be read.'); throw error; }
  }
  return { files: rows };
}

function requireAgentOnlyUpload(manifest) {
  if (Array.isArray(manifest?.teams) && manifest.teams.length) throw new Error('Team uploads are not supported. Use New team to create a team in GLaDOS.');
  return manifest;
}

function openAgentPackageImport(onImported) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal package-import-modal" role="dialog" aria-modal="true" aria-labelledby="package-import-title"><header><div><h2 id="package-import-title">Upload an agent</h2><small>Review its instructions, resources, and connector requirements.</small></div><button type="button" data-import-close aria-label="Close upload">×</button></header><div class="app-modal-copy"><div class="package-import-choices"><label class="package-file-choice"><strong>Agent file</strong><span>Agent JSON or Markdown instructions</span><input type="file" data-import-file accept=".json,.md,.markdown,application/json,text/markdown" /></label><label class="package-file-choice"><strong>Agent folder</strong><span>Agent manifest and supporting files</span><input type="file" data-import-folder webkitdirectory multiple /></label></div><p class="field-note">Uploaded agents stay in your collection. Team uploads are not supported; use New team to create a team.</p><div data-import-preview></div><p class="package-editor-status" data-import-status role="status" aria-live="polite"></p></div><footer><button type="button" data-import-cancel>Cancel</button><button type="button" class="safe" data-import-confirm disabled>Upload agent</button></footer></div>`;
  root.appendChild(backdrop);
  const close = prepareCollectionDialog(backdrop);
  backdrop.querySelector('[data-import-close]').addEventListener('click', close);
  backdrop.querySelector('[data-import-cancel]').addEventListener('click', close);
  const target = backdrop.querySelector('[data-import-preview]');
  const status = backdrop.querySelector('[data-import-status]');
  const confirm = backdrop.querySelector('[data-import-confirm]');
  let payload = null;
  let packageId = null;
  let willStage = false;
  let importedSelector = null;
  let previewGeneration = 0;
  const previewFiles = async files => {
    const generation = ++previewGeneration;
    confirm.disabled = true;
    payload = null;
    target.innerHTML = '';
    status.textContent = 'Reading the package…';
    try {
      const nextPayload = await agentPackageImportPayload([...files]);
      const result = await packageApi('POST', '/api/agent-packages/import/preview', nextPayload);
      if (generation !== previewGeneration || !backdrop.isConnected) return;
      const preview = result.preview || result;
      const manifest = requireAgentOnlyUpload(preview.manifest || preview.package?.manifest || nextPayload.package || {});
      packageId = preview.id || manifest.id;
      willStage = preview.willStage === true;
      importedSelector = { version: preview.version || manifest.version, revision: preview.revision };
      payload = nextPayload;
      target.innerHTML = `<div class="package-import-preview"><div><span class="collection-eyebrow">Package preview</span><h3>${escapeHtml(preview.name || manifest.name || packageId)}</h3><p>${escapeHtml(preview.description || manifest.description || '')}</p></div><dl><div><dt>Identity</dt><dd><code>${escapeHtml(packageId || '')}</code></dd></div><div><dt>Version</dt><dd>${escapeHtml(preview.version || manifest.version || '')}</dd></div><div><dt>Provides</dt><dd>${preview.agentCount ?? preview.agents?.length ?? manifest.agents?.length ?? 0} agents · ${preview.resourceCount ?? preview.resources?.length ?? manifest.resources?.length ?? 0} resources</dd></div></dl><h4>Agents</h4><ul>${(manifest.agents || preview.agents || []).map(item => `<li><strong>${escapeHtml(item.name || item.id)}</strong>${item.description ? ` — ${escapeHtml(item.description)}` : ''}</li>`).join('')}</ul><h4>Required connectors</h4><ul>${(preview.requiredConnectors || preview.connectors || [...new Set((manifest.agents || []).flatMap(agent => agent.connectors || []))]).map(item => `<li>${escapeHtml(typeof item === 'string' ? item : item.name || item.id)}${(state.agentLibrary.catalog?.connectors || []).find(connector => connector.id === (typeof item === 'string' ? item : item.id))?.available ? ' — available' : ' — not connected'}</li>`).join('') || '<li>None required</li>'}</ul><h4>Tools</h4><p class="field-note">${escapeHtml((preview.tools || [...new Set((manifest.agents || []).flatMap(item => item.tools || []))]).join(', ') || 'No tools selected')}</p>${(manifest.resources || preview.resources || []).length ? `<details class="package-resources"><summary>Supporting resources</summary><ul>${(manifest.resources || preview.resources).map(item => `<li><code>${escapeHtml(item.path)}</code></li>`).join('')}</ul></details>` : ''}<details class="package-resources"><summary>Read agent instructions</summary>${(manifest.agents || []).map(item => `<h4>${escapeHtml(item.name || item.id)}</h4><pre>${escapeHtml(item.instructions || '')}</pre>`).join('')}</details>${(preview.warnings || []).length ? `<div class="import-review-notes">${preview.warnings.map(item => `<p>${escapeHtml(typeof item === 'string' ? item : item.message || '')}</p>`).join('')}</div>` : ''}</div>`;
      status.textContent = willStage ? 'This identity is already in your collection. The import will save a separate revision for you to review and activate; your current edits stay selected.' : 'Ready to add to your collection and make this package available to GLaDOS.';
      confirm.textContent = willStage ? 'Upload new revision' : 'Upload agent';
      confirm.disabled = false;
    } catch (error) { if (generation === previewGeneration) { status.textContent = error.message; status.classList.add('error'); } }
  };
  backdrop.querySelector('[data-import-file]').addEventListener('change', event => previewFiles(event.target.files));
  backdrop.querySelector('[data-import-folder]').addEventListener('change', event => previewFiles(event.target.files));
  confirm.addEventListener('click', async () => {
    if (!payload) return;
    confirm.disabled = true;
    status.textContent = 'Uploading to your collection…';
    try {
      const result = await packageApi('POST', '/api/agent-packages/import', payload);
      const id = result.package?.id || result.id || packageId;
      close();
      showToast(willStage ? 'New agent revision uploaded. Review it and activate when ready.' : 'Agent uploaded and ready for direct chat.', { kind: 'success', label: 'Agents' });
      await loadAgents();
      await onImported?.(id, willStage ? importedSelector : null);
    } catch (error) { status.textContent = error.message; status.classList.add('error'); confirm.disabled = false; }
  });
}

// --- Clippy intelligence workspace ---
const CLIPPY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];
let activeClippyView = null;
let activeClippySourcePreview = null;

function clippySourceReference(value, { allowRelative = false, source = null } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\\\0-\x1f\x7f]/.test(value)) return null;
  let raw = value.trim();
  // Never fetch a citation's host. Legacy localhost URLs only supply a path to
  // the connected Clippy reader; network URLs retain normal browser behavior.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) {
    const authority = raw.match(/^(?:https?:)?\/\/([^/?#]+)([^]*)$/i);
    if (!authority) return null;
    let url;
    try { url = new URL(`http://${authority[1]}/`); } catch { return null; }
    if (url.username || url.password || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    raw = authority[2] || '/';
  }
  const hashIndex = raw.indexOf('#');
  const fragment = hashIndex < 0 ? '' : raw.slice(hashIndex + 1);
  const withoutHash = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  const rawPath = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : withoutHash.slice(queryIndex + 1));
  let filename;
  let repo;
  const api = rawPath === '/api/clippy/file';
  if (api) {
    if ([...query.keys()].some(key => !['repo', 'path', 'offset', 'limit'].includes(key)) || query.getAll('repo').length !== 1 || query.getAll('path').length !== 1) return null;
    repo = query.get('repo');
    filename = query.get('path');
  } else {
    if (!allowRelative || queryIndex >= 0) return null;
    try { filename = decodeURIComponent(rawPath); } catch { return null; }
    if (!filename && source && /^L?\d+(?:-L?\d+)?$/i.test(fragment)) filename = source.path;
    else if (!filename.startsWith('/') && source?.repo && source?.path && !filename.startsWith(`${source.repo}/`)) {
      // Source documents may use ../ links, but they must stay inside the
      // current engagement repo. Standalone chat citations cannot traverse.
      const parts = source.path.split('/').slice(0, -1);
      for (const part of filename.split('/')) {
        if (part === '..') { if (parts.length <= 1) return null; parts.pop(); }
        else if (part && part !== '.') parts.push(part);
      }
      filename = parts.join('/');
    }
    filename = filename.replace(/^\//, '');
    repo = filename.split('/')[0];
  }
  if (typeof filename !== 'string' || filename.length > 2048 || typeof repo !== 'string' || !repo || repo.length > 255 || /[\\/\0-\x1f\x7f]/.test(repo)) return null;
  const parts = filename.split('/');
  if (parts.length < 2 || parts[0] !== repo || parts.some(part => !part || part === '.' || part === '..' || /[\\\0-\x1f\x7f?#:]|%(?:2e|2f|5c|00)/i.test(part))) return null;
  if (!api && (!/\.[a-z\d]{1,12}$/i.test(parts.at(-1)) || ['api', 'assets', 'node_modules'].includes(repo))) return null;
  const lineMatch = fragment.match(/^L?(\d+)(?:-L?\d+)?$/i);
  const line = Number(lineMatch?.[1] || (api ? query.get('offset') : '') || 1);
  if (!Number.isSafeInteger(line) || line < 1 || line > 10000000) return null;
  return { repo, path: filename, line };
}

function clippySourceHref(source) {
  return `/api/clippy/file?${new URLSearchParams({ repo: source.repo, path: source.path })}${source.line > 1 ? `#L${source.line}` : ''}`;
}

function clippySourcePathsFromText(text) {
  const paths = [];
  const seen = new Set();
  const add = href => {
    if (paths.length >= 6) return;
    const source = clippySourceReference(href, { allowRelative: true });
    if (!source || !/\/findings\/.+\.(?:md|markdown)$/i.test(source.path) || seen.has(source.path)) return;
    seen.add(source.path);
    paths.push(source.path);
  };
  // Inspect destinations separately so a foreign URL cannot be mistaken for a
  // repository path embedded inside that URL. Extraction never reads sources.
  let remaining = String(text || '').slice(0, 120000).replace(/\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g, (_link, angle, plain) => { add(angle || plain); return ' '; });
  remaining = remaining.replace(/(?:https?:\/\/|\/\/)[^\s<>"'`]+/gi, href => { add(href.replace(/[),.;]+$/, '')); return ' '; });
  const references = remaining.match(/(?:^|[\s`"'(\[])\/?[a-z\d][a-z\d_.-]*\/[^\s`"'<>()[\]?#]+\/findings\/[^\s`"'<>()[\]?#]+\.(?:md|markdown)(?:#L\d+(?:-L?\d+)?)?/gi) || [];
  for (const reference of references) add(reference.replace(/^[\s`"'(\[]+/, ''));
  // Findings can also live directly at the repository root.
  const direct = remaining.match(/(?:^|[\s`"'(\[])\/?[a-z\d][a-z\d_.-]*\/findings\/[^\s`"'<>()[\]?#]+\.(?:md|markdown)(?:#L\d+(?:-L?\d+)?)?/gi) || [];
  for (const reference of direct) add(reference.replace(/^[\s`"'(\[]+/, ''));
  return paths;
}

function openClippy() {
  if (!state.openTabs.some(tab => tab.id === 'clippy')) state.openTabs.push({ id: 'clippy', kind: 'clippy', label: 'Clippy' });
  setCurrentTab('clippy');
}

function disposeClippyPane() {
  if (!activeClippyView) return;
  activeClippyView.disposed = true;
  activeClippyView.controllers.forEach(controller => controller.abort());
  clearTimeout(activeClippyView.searchTimer);
  clearTimeout(activeClippyView.indexTimer);
  clearTimeout(activeClippyView.leadsTimer);
  activeClippyView.closeEvidence?.();
  activeClippyView.closeCoverage?.();
  const composer = activeClippyView.wrap.querySelector?.('[data-clippy-chat] textarea');
  const record = state.transcripts?.get('clippy-chat');
  if (record && composer) record.composerDraft = composer.value;
  activeClippyView = null;
}

function clippyViewAlive(view) {
  return !view.disposed && activeClippyView === view && view.wrap.isConnected;
}

async function clippyRead(view, endpoint, key = 'list') {
  view.controllers.get(key)?.abort();
  const controller = new AbortController();
  view.controllers.set(key, controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  try {
    const response = await fetch(`/api/clippy${endpoint}`, { signal: controller.signal });
    const result = await response.json();
    if (!clippyViewAlive(view) || view.controllers.get(key) !== controller) throw Object.assign(new Error('View changed'), { name: 'AbortError' });
    if (!response.ok || result.ok === false) throw new Error(result.error || `Clippy request failed (${response.status})`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError' && timedOut && clippyViewAlive(view) && view.controllers.get(key) === controller) throw new Error('Clippy took too long to respond. Try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (view.controllers.get(key) === controller) view.controllers.delete(key);
  }
}

function clippyCollection(result, key) {
  const rows = result?.[key] || result?.items || result?.results || (Array.isArray(result) ? result : []);
  return Array.isArray(rows) ? rows : [];
}

function clippySeverity(value) {
  const severity = String(value || 'unknown').toLowerCase();
  return severity === 'informational' ? 'info' : CLIPPY_SEVERITIES.includes(severity) ? severity : 'unknown';
}

function clippyFindingSeverityMarkup(finding) {
  if (finding.metadataPending) return '<span class="clippy-severity-badge pending" title="This finding has not been parsed in the optional local cache">Not parsed</span>';
  const severity = clippySeverity(finding.severity);
  return `<span class="clippy-severity-badge ${severity}">${severity === 'unknown' ? 'Unspecified' : severity}</span>`;
}

function clippyFindingCountScope(result) {
  if (result.browseSource === 'live') return 'Live search · parsed matches';
  if (!['indexed_findings', 'parsed_indexed_findings'].includes(result.countsScope)) return result.partial || result.countsScope === 'loaded_matches' ? 'Loaded matches' : 'Findings';
  const pending = Number(result.metadataPending ?? result.index?.metadataPending ?? 0);
  if (!pending) return 'Local cache';
  const parsed = Number(result.metadataLoaded ?? result.index?.metadataLoaded ?? 0);
  const total = Number(result.totalUnfiltered ?? result.index?.findings ?? parsed + pending);
  return `Local cache · ${parsed.toLocaleString()}/${total.toLocaleString()} parsed · ${pending.toLocaleString()} not parsed`;
}

function clippyRepoId(repo) {
  return typeof repo === 'string' ? repo : String(repo?.id || repo?.name || repo?.repo || '');
}

function clippyEmpty(title, copy, action = '') {
  return `<div class="clippy-empty"><span class="clippy-empty-mark" aria-hidden="true">⌁</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p>${action}</div>`;
}

function clippyError(target, error, retry) {
  target.innerHTML = clippyEmpty('Clippy could not load this', error.message, '<button type="button" data-clippy-retry>Try again</button>');
  target.querySelector('[data-clippy-retry]')?.addEventListener('click', retry);
}

let clippyAgentConsent = null;

async function offerClippyAgent(status = null) {
  const availability = status || await packageApi('GET', '/api/clippy/status');
  if (availability.agentAvailable === true) return availability;
  if (clippyAgentConsent) return clippyAgentConsent;
  clippyAgentConsent = (async () => {
    const exists = availability.agentExists === true;
    const approved = await confirmAction({
      title: exists ? 'Enable Clippy Agent?' : 'Create Clippy Agent?',
      message: exists
        ? 'Enable your saved Clippy Agent to query findings and help choose engagement starting points. Your instructions and settings will be preserved. It uses read-only Clippy tools. The connector and intelligence dashboard work without the agent.'
        : 'Add an optional Clippy Agent to query findings and help choose engagement starting points using read-only Clippy tools. You can edit it in Tools → Agents. The connector and intelligence dashboard work without the agent.',
      confirmLabel: exists ? 'Enable agent' : 'Create agent',
      cancelLabel: 'Not now',
    });
    if (!approved) return null;
    await packageApi('POST', '/api/clippy/agent/start', { createAgent: true });
    return { ...availability, agentExists: true, agentAvailable: true };
  })().finally(() => { clippyAgentConsent = null; });
  return clippyAgentConsent;
}

function renderClippyAgentPlaceholder(view, availability) {
  const exists = availability.agentExists === true;
  const target = view.wrap.querySelector('[data-clippy-chat]');
  target.innerHTML = clippyEmpty(exists ? 'Clippy Agent is disabled' : 'Add Clippy Agent when you need it', 'Browse findings and engagement repos now, or add an optional agent to query this intelligence. Agent setup is a separate choice from connecting Clippy.', `<button type="button" class="safe" data-clippy-create-agent>${exists ? 'Enable Clippy Agent' : 'Create Clippy Agent'}</button>`);
  wireClippyAgentButton(target.querySelector('[data-clippy-create-agent]'));
}

async function openClippyAgentChat(prompt = '', { askForAgent = true } = {}) {
  const view = activeClippyView;
  if (!view || !clippyViewAlive(view)) return;
  const dashboard = state.clippyDashboard;
  if (dashboard.view && dashboard.view !== 'leads') {
    dashboard.view = 'leads';
    renderClippyWorkspace(view);
  }
  dashboard.chatOpen = true;
  view.wrap.classList.add('clippy-chat-open');
  const panel = view.wrap.querySelector('[data-clippy-chat-panel]');
  panel.hidden = false;
  view.wrap.querySelector('[data-clippy-agent]')?.setAttribute('aria-expanded', 'true');
  const target = view.wrap.querySelector('[data-clippy-chat]');
  let availability = askForAgent || typeof view.status?.agentAvailable !== 'boolean'
    ? await packageApi('GET', '/api/clippy/status')
    : view.status;
  if (!clippyViewAlive(view)) return;
  if (availability.agentAvailable !== true) {
    renderClippyAgentPlaceholder(view, availability);
    if (!askForAgent) return;
    availability = await offerClippyAgent(availability);
    if (!availability || !clippyViewAlive(view)) return;
  }
  view.status = { ...view.status, ...availability };
  const editButton = view.wrap.querySelector('[data-clippy-edit-agent]');
  if (editButton) editButton.hidden = !availability.agentExists;
  if (!target.querySelector('.chat-pane')) {
    if (!view.chatOpening) view.chatOpening = (async () => {
      target.innerHTML = clippyEmpty('Opening Clippy Agent', 'Your conversation stays alongside the intelligence.');
      const result = await packageApi('POST', '/api/clippy/chat-session', {});
      if (!clippyViewAlive(view)) return;
      if (!result.sessionId || !result.agentId) throw new Error('Clippy did not return a conversation.');
      dashboard.chatSession = result;
      target.innerHTML = '';
      const chat = renderAgentChatSurface(result.agentId, 'clippy-chat', false, { container: target, sessionId: result.sessionId, viewTabId: 'clippy', label: 'Clippy Agent', hideToolbar: true });
      chat.classList.add('clippy-agent-chat');
      const record = state.transcripts.get('clippy-chat');
      if (!record.events.length) chat.querySelector('.transcript').innerHTML = '<div class="clippy-chat-welcome"><span>✦</span><h2>Find your next starting point.</h2><p>Investigate Clippy intelligence together. Ask for evidence, check Dradis coverage, and plan the next scoped verification.</p><small>Clippy can query the connected intelligence directly. A local index is optional.</small><button type="button" data-clippy-chat-starter>Help me find an actionable lead</button></div>';
      wireClippyAgentButton(chat.querySelector('[data-clippy-chat-starter]'), clippyLeadSearchPrompt());
    })().finally(() => { view.chatOpening = null; });
    await view.chatOpening;
  }
  if (!clippyViewAlive(view)) return;
  if (prompt) {
    const composer = target.querySelector('[data-chat-composer] textarea');
    if (composer && !composer.value.trim()) {
      composer.value = prompt;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.focus();
    } else if (composer) showToast('Your unsent question is preserved. Send or clear it before asking about another item.', { kind: 'info', label: 'Clippy Agent' });
  }
}

async function editClippyAgent() {
  if (!await confirmAgentPackageDiscard()) return;
  const status = await packageApi('GET', '/api/clippy/status');
  if (!status.agentExists && !await offerClippyAgent(status)) return;
  const packageId = 'clippy-intel';
  state.agentLibrary.view = 'collection';
  openAgentsLibrary();
  const wrap = paneEl.querySelector('.agent-library-pane');
  if (wrap) await selectAgentPackage(packageId, wrap);
}

function wireClippyAgentButton(button, prompt = '') {
  button?.addEventListener?.('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Opening Clippy…';
    try { await openClippyAgentChat(typeof prompt === 'function' ? prompt() : prompt); }
    catch (error) { showToast(error.message, { kind: 'warning', label: 'Clippy Agent' }); }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = label; } }
  });
}

function clippyLeadSearchPrompt(query = '') {
  return `Help me choose up to three actionable leads for an authorized assessment${query ? ` focused on ${query}` : ''}. Query the connected Clippy intelligence directly, including findings, repo evidence, domains, infrastructure, and assessment history as relevant. Do not restrict yourself to the local index. For each candidate cite the exact target and source, explain the vulnerability evidence and a specific safe next verification step, and check current Dradis report coverage. Exclude candidates with a matching report. If report coverage cannot be checked completely or is stale, withhold the candidate from recommendations and state what needs verification. Stop after a bounded evidence pass and return fewer leads when the evidence is insufficient. Do not launch an assessment.`;
}

async function syncClippyChatCandidates(rec, boundary) {
  const key = String(boundary.id || rec.turnStartedAt || '');
  if (rec.clippyLeadSyncedTurn === key) return;
  const answer = [...(rec.events || [])].reverse().find(event => event.kind === 'assistant-text'
    && (!rec.turnStartedAt || transcriptEventMs(event) >= rec.turnStartedAt - 1000));
  const paths = clippySourcePathsFromText(answer?.text || '');
  if (!paths.length) return;
  rec.clippyLeadSyncedTurn = key;
  try {
    await packageApi('POST', '/api/clippy/leads/from-sources', { paths });
    const view = activeClippyView;
    if (view && clippyViewAlive(view) && state.clippyDashboard.view === 'leads') await loadClippyLeads(view);
  } catch (error) {
    showToast(`The answer is saved, but its sources could not be added to lead review: ${error.message}`, { kind: 'warning', label: 'Clippy evidence' });
  }
}

async function renderClippyPane() {
  const wrap = document.createElement('div');
  wrap.className = 'clippy-pane';
  const dashboard = state.clippyDashboard;
  if (!['leads', 'findings', 'repos', 'maintenance'].includes(dashboard.view)) dashboard.view = 'leads';
  const view = { wrap, controllers: new Map(), disposed: false, selectedFinding: null, selectedRepo: null, selectedFile: null };
  activeClippyView = view;
  wrap.innerHTML = `<header class="clippy-page-heading"><div class="clippy-brand"><span class="clippy-logo" aria-hidden="true">C</span><div><span class="collection-eyebrow">Intelligence workspace</span><h1>Clippy</h1></div><span class="clippy-server-status" data-clippy-status role="status">Checking connection…</span></div><div class="clippy-heading-actions"><button type="button" data-clippy-refresh aria-label="Reload Clippy workspace">↻ Refresh</button><button type="button" class="clippy-chat-button" data-clippy-agent aria-expanded="true" disabled>✦ Ask Clippy</button></div></header><nav class="clippy-view-tabs clippy-primary-tabs" aria-label="Clippy views"><button type="button" data-clippy-view="leads">Workspace</button><button type="button" data-clippy-browse>Browse evidence</button></nav><div class="clippy-main-layout"><section class="clippy-chat-panel" data-clippy-chat-panel aria-label="Clippy Agent conversation"><header><div><strong>✦ Clippy Agent</strong><small>Explore the intelligence. Build a plan.</small></div><button type="button" class="text-action" data-clippy-focus-chat aria-pressed="false">Focus chat</button><button type="button" class="text-action" data-clippy-edit-agent hidden>Edit agent</button></header><div data-clippy-chat>${clippyEmpty('Connecting to Clippy', 'Your conversation will appear here.')}</div></section><section class="clippy-intelligence" aria-label="Clippy evidence and leads"><nav class="clippy-view-tabs clippy-browse-tabs" data-clippy-browse-tabs aria-label="Browse intelligence" hidden><button type="button" data-clippy-view="findings">Security findings</button><button type="button" data-clippy-view="repos">Engagement repos</button><button type="button" data-clippy-view="maintenance">Local cache</button></nav><div class="clippy-workspace" data-clippy-workspace>${clippyEmpty('Connecting to Clippy', 'Loading your intelligence workspace…')}</div></section></div>`;
  paneEl.appendChild(wrap);
  const agentButton = wrap.querySelector('[data-clippy-agent]');
  wireClippyAgentButton(agentButton);
  wrap.querySelector('[data-clippy-focus-chat]').addEventListener('click', event => {
    const focused = wrap.classList.toggle('clippy-chat-focused');
    event.currentTarget.setAttribute('aria-pressed', String(focused));
    event.currentTarget.textContent = focused ? 'Show leads' : 'Focus chat';
  });
  wrap.querySelector('[data-clippy-edit-agent]').addEventListener('click', () => editClippyAgent().catch(error => showToast(error.message, { kind: 'warning', label: 'Agents' })));
  const load = async () => {
    const target = wrap.querySelector('[data-clippy-workspace]');
    const indicator = wrap.querySelector('[data-clippy-status]');
    try {
      const status = await clippyRead(view, '/status', 'status');
      view.status = status;
      const connected = status.connected === true || (status.configured === true && status.enabled !== false);
      indicator.textContent = connected ? 'Connected' : 'Not connected';
      indicator.classList.toggle('connected', connected);
      agentButton.disabled = !connected;
      if (!connected) {
        wrap.querySelector('[data-clippy-chat-panel]').hidden = true;
        target.innerHTML = clippyEmpty('Connect Clippy to get started', status.message || 'Find evidence-backed starting points and investigate them with Clippy Agent.', '<button type="button" class="safe" data-clippy-connect>Connect Clippy</button>');
        target.querySelector('[data-clippy-connect]').addEventListener('click', () => openSmartConnectLibrary(async () => { if (clippyViewAlive(view)) await load(); }, { connect: true }));
        return;
      }
      renderClippyWorkspace(view);
      wrap.querySelector('[data-clippy-edit-agent]').hidden = status.agentExists !== true;
      if (dashboard.view === 'leads') openClippyAgentChat('', { askForAgent: false }).catch(error => clippyError(wrap.querySelector('[data-clippy-chat]'), error, () => openClippyAgentChat()));
    } catch (error) {
      if (!clippyViewAlive(view) || error.name === 'AbortError') return;
      indicator.textContent = 'Connection unavailable';
      clippyError(target, error, load);
    }
  };
  wrap.querySelector('[data-clippy-refresh]').addEventListener('click', load);
  wrap.querySelectorAll('[data-clippy-view]').forEach(button => button.addEventListener('click', () => {
    dashboard.view = button.dataset.clippyView;
    if (dashboard.view !== 'leads') dashboard.browseView = dashboard.view;
    if (view.status?.connected || (view.status?.configured && view.status?.enabled !== false)) {
      renderClippyWorkspace(view);
      if (dashboard.view === 'leads') openClippyAgentChat('', { askForAgent: false }).catch(error => showToast(error.message, { kind: 'warning', label: 'Clippy Agent' }));
    }
  }));
  wrap.querySelector('[data-clippy-browse]').addEventListener('click', () => {
    dashboard.view = dashboard.browseView || 'findings';
    if (view.status?.connected || (view.status?.configured && view.status?.enabled !== false)) renderClippyWorkspace(view);
  });
  await load();
}

function renderClippyWorkspace(view) {
  for (const [key, controller] of view.controllers) if (key !== 'status') { controller.abort(); view.controllers.delete(key); }
  clearTimeout(view.searchTimer);
  clearTimeout(view.indexTimer);
  clearTimeout(view.leadsTimer);
  view.selectedFinding = view.selectedRepo = view.selectedFile = null;
  const browsing = state.clippyDashboard.view !== 'leads';
  view.wrap.classList.toggle('clippy-browsing', browsing);
  view.wrap.querySelector('[data-clippy-chat-panel]').hidden = browsing;
  view.wrap.querySelector('[data-clippy-browse-tabs]').hidden = !browsing;
  view.wrap.querySelector('[data-clippy-browse]').setAttribute('aria-selected', String(browsing));
  view.wrap.querySelectorAll('[data-clippy-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.clippyView === state.clippyDashboard.view)));
  if (state.clippyDashboard.view === 'leads') renderClippyLeads(view);
  else if (state.clippyDashboard.view === 'repos') renderClippyRepos(view);
  else if (state.clippyDashboard.view === 'maintenance') renderClippyMaintenance(view);
  else renderClippyFindings(view);
}

function renderClippyMaintenance(view) {
  const target = view.wrap.querySelector('[data-clippy-workspace]');
  target.innerHTML = '<div class="clippy-maintenance"><span class="collection-eyebrow">Optional local cache</span><h2>Keep a local inventory for browsing.</h2><p>Lead discovery and Clippy Agent query the connected intelligence directly. They do not wait for this cache. Use indexing only when you want a local metadata inventory.</p><div class="clippy-index-status" data-clippy-index-status role="status">Loading cache status…</div></div>';
  refreshClippyIndex(view);
}

function clippyIndexSummary(index = {}) {
  const count = Number(index.findings ?? index.findingCount ?? 0).toLocaleString();
  const loaded = Number(index.metadataLoaded ?? 0).toLocaleString();
  const pending = Number(index.metadataPending ?? 0).toLocaleString();
  if (index.state === 'running' || index.running) return `Indexing intelligence · ${count} findings · ${loaded} parsed · ${pending} pending`;
  if (index.complete) return `${count} indexed findings · discovery complete`;
  return `${count} indexed findings · ${loaded} parsed · ${pending} pending · discovery incomplete`;
}

async function refreshClippyIndex(view) {
  clearTimeout(view.indexTimer);
  if (!clippyViewAlive(view)) return;
  const target = view.wrap.querySelector('[data-clippy-index-status]');
  if (!target) return;
  try {
    const response = await clippyRead(view, '/index', 'index');
    if (!target.isConnected || state.clippyDashboard.view !== 'maintenance') return;
    const index = response.index || response;
    const running = index.state === 'running' || index.running;
    const previous = view.index;
    view.index = index;
    target.innerHTML = `<div><span class="clippy-index-dot${running ? ' running' : ''}"></span><strong>${escapeHtml(clippyIndexSummary(index))}</strong><small>${escapeHtml(index.note || 'The local index discovers findings across engagement repos and pages through the combined results.')} Each indexing batch runs up to 100 lookups or two minutes. Continue indexing to load the remaining metadata.</small></div><button type="button" data-clippy-sync>${running ? 'Pause indexing' : index.complete ? 'Refresh index' : Number(index.findings || 0) > 0 ? 'Continue indexing' : 'Index intelligence'}</button>`;
    target.querySelector('[data-clippy-sync]').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        await packageApi('POST', running ? '/api/clippy/index/cancel' : '/api/clippy/index/sync', running ? {} : { maxCalls: 100, ...(index.complete ? { reset: true } : {}) });
        await refreshClippyIndex(view);
      } catch (error) { showToast(error.message, { kind: 'warning', label: 'Clippy index' }); event.currentTarget.disabled = false; }
    });
    if (previous && JSON.stringify(previous) !== JSON.stringify(index)) {
      if (state.clippyDashboard.view === 'findings') loadClippyFindings(view);
    }
    if (running && state.clippyDashboard.view === 'maintenance') view.indexTimer = setTimeout(() => refreshClippyIndex(view), 2500);
  } catch (error) {
    if (clippyViewAlive(view) && error.name !== 'AbortError') target.textContent = `Index status unavailable: ${error.message}`;
  }
}

function clippyLeadPrompt(item) {
  const coverage = item.reportCoverage || {};
  const source = item.targetKind === 'source';
  return `Help me plan the next scoped verification for this historical intelligence candidate. Query Clippy directly for related intelligence, beyond the local cache. Cite exact evidence, distinguish historical evidence from current exploitability, and recheck Dradis coverage before recommending assessment work. Attribute an analyst Dradis check to its recorded receipt, rather than claiming you performed it. Clippy MCP cannot establish complete current Dradis coverage: an authorized analyst must check Dradis directly and record the result. Do not launch an assessment.${source ? ' This is a source-code review candidate. Do not infer a live hostname or deployed service from its repository name; verify deployment and attacker prerequisites separately.' : ''}\n\nTarget: ${item.targetLabel || item.domain || item.repository || 'Unverified'}\nTarget kind: ${source ? 'Source code review; deployment unverified' : 'Network target'}\nExact scope: ${item.scope || item.domain || 'Unverified'}${item.repository ? `\nRepository: ${item.repository}` : ''}${item.commit ? `\nAssessed commit: ${item.commit}` : ''}\nLead: ${item.title || ''}\nWhy: ${item.why || ''}\nNext verification: ${item.nextStep || ''}\nEvidence: ${(item.evidence || []).map(source => [source.repo, source.path, source.line && `line ${source.line}`].filter(Boolean).join(' / ')).join('; ')}\nDradis coverage: ${coverage.label || 'Unverified'}\nChecked: ${coverage.checkedAt || 'Not checked'}\nCheck kind: ${coverage.kind || 'Unspecified'}\nDradis source: ${coverage.sourceUrl || 'Not recorded'}\nChecked scope: ${coverage.scope || 'Not recorded'}\nAnalyst notes: ${coverage.notes || 'Not recorded'}\nCheck expires: ${coverage.expiresAt || 'Not recorded'}\nEvidence digest: ${item.evidenceDigest || 'Not recorded'}. Missing cached matches do not establish the absence of a report.`;
}

function clippyKnownReportTie(coverage = {}) {
  return coverage.confirmedTie === true || coverage.status === 'tied_report' || (coverage.projectDispositions || []).some(project => project.disposition === 'tied');
}

function clippyCoverageMarkup(coverage = {}) {
  const status = coverage.status || 'unknown';
  const label = coverage.label || 'Report coverage not checked';
  const checked = coverage.checkedAt ? new Date(coverage.checkedAt).toLocaleString() : '';
  const age = coverage.cacheAgeSeconds == null ? '' : `Feed age ${Math.round(Number(coverage.cacheAgeSeconds) / 60)} min`;
  const projects = (coverage.projects || []).slice(0, 5).map(project => {
    const title = [project.name || 'Dradis project', project.status].filter(Boolean).join(' · ');
    return /^https?:\/\/[^\s]+$/i.test(String(project.url || '')) ? `<a href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)} ↗</a>` : `<span>${escapeHtml(title)}</span>`;
  }).join('');
  const evidence = (coverage.evidence || []).slice(0, 5).map(item => `<span>${escapeHtml([item.repo, item.path].filter(Boolean).join(' / '))}</span>`).join('');
  const receipt = coverage.kind === 'analyst_attestation' ? `${/^https:\/\/[^\s]+$/i.test(String(coverage.sourceUrl || '')) ? `<a href="${escapeHtml(coverage.sourceUrl)}" target="_blank" rel="noopener noreferrer">Recorded Dradis source ↗</a>` : ''}${coverage.notes ? `<span>${escapeHtml(coverage.notes)}</span>` : ''}${coverage.expiresAt ? `<span>Check expires ${escapeHtml(new Date(coverage.expiresAt).toLocaleString())}</span>` : ''}` : '';
  return `<span class="clippy-coverage-badge ${['reported', 'indexed_report_found'].includes(status) ? 'reported' : status === 'no_report_verified' ? 'verified' : 'unknown'}">${escapeHtml(label)}</span>${checked || age ? `<small>${escapeHtml([checked && `Checked ${checked}`, age].filter(Boolean).join(' · '))}</small>` : ''}${coverage.note ? `<small>${escapeHtml(coverage.note)}</small>` : ''}${projects || evidence || receipt ? `<div class="clippy-coverage-evidence">${projects}${evidence}${receipt}</div>` : ''}`;
}

function clippyLeadCollections(result = {}) {
  const supplied = clippyCollection(result, 'leads');
  const readyItem = item => item.reportCoverage?.status === 'no_report_verified' && !item.relatedTarget && !clippyKnownReportTie(item.reportCoverage);
  const ready = supplied.filter(readyItem).slice(0, 5);
  const seen = new Set(ready.map(item => item.id));
  const review = [...supplied.filter(item => !readyItem(item)), ...clippyCollection(result, 'review')].filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { ready, review };
}

function clippyLeadCard(item, index, { review = false, expanded = false } = {}) {
  const possibleReport = item.reportCoverage?.status === 'reported';
  const tied = clippyKnownReportTie(item.reportCoverage);
  const sourceReview = item.targetKind === 'source';
  const evidence = (item.evidence || []).slice(0, 6);
  const checkedAt = item.evidenceCheckedAt ? new Date(item.evidenceCheckedAt).toLocaleString() : '';
  const targetLabel = item.targetLabel || (sourceReview ? item.repository : item.domain) || 'Target unverified';
  return `<article class="clippy-lead-card${review ? ' clippy-lead-review' : ''}" data-clippy-lead-id="${escapeHtml(item.id)}"><div class="clippy-lead-title"><div><span class="clippy-lead-domain">${sourceReview ? 'Source review · ' : ''}${escapeHtml(targetLabel)}</span><h3>${escapeHtml(item.title || 'Evidence needs review')}</h3>${sourceReview ? `<small class="clippy-evidence-date">Assessed commit: ${escapeHtml(item.commit || 'Unverified')}<br>Deployment and current exploitability unverified.</small>` : ''}</div><span class="clippy-severity-badge ${clippySeverity(item.severity)}">${escapeHtml(clippySeverity(item.severity))}</span></div>${item.relatedTarget ? `<p class="clippy-lead-note">This source also lists ${escapeHtml(item.relatedTarget)}. This card’s exact scope is ${escapeHtml(item.scope || item.domain)}; refresh the searched hostname before recording its report coverage.</p>` : ''}<p class="clippy-lead-why">${escapeHtml(item.why || 'Inspect the cited evidence before planning work.')}</p>${item.nextStep ? `<div class="clippy-lead-next"><strong>Next verification</strong><p>${escapeHtml(item.nextStep)}</p></div>` : ''}${review ? `<p class="clippy-lead-withheld">${tied ? 'Excluded: an analyst identified a tied Dradis report.' : possibleReport ? 'Withheld: possible Dradis matches need a direct analyst check.' : 'Dradis coverage is unverified. Review the evidence, then record a direct analyst check.'}</p>` : ''}<details class="clippy-lead-details" data-clippy-lead-details="${escapeHtml(item.id)}"${expanded ? ' open' : ''}><summary>Evidence & report check${evidence.length ? ` · ${evidence.length} sources` : ''}</summary><div class="clippy-opportunity-coverage">${clippyCoverageMarkup(item.reportCoverage)}</div>${item.scope ? `<small class="clippy-evidence-date">Exact report-check scope: ${escapeHtml(item.scope)}</small>` : ''}${item.evidenceDate ? `<small class="clippy-evidence-date">Historical evidence date: ${escapeHtml(item.evidenceDate)}</small>` : ''}${checkedAt ? `<small class="clippy-evidence-date">Evidence retrieved ${escapeHtml(checkedAt)}. Source age may differ.</small>` : ''}${evidence.length ? `<ul class="clippy-lead-sources">${evidence.map((source, sourceIndex) => `<li><button type="button" data-clippy-lead-source="${index}:${sourceIndex}"${source.path && source.repo ? '' : ' disabled'}>${escapeHtml([source.repo, source.path, source.line && `line ${source.line}`].filter(Boolean).join(' / ') || 'Source details unavailable')} ↗</button></li>`).join('')}</ul>` : '<p class="field-note">No source references available.</p>'}</details><footer>${review ? tied || item.relatedTarget ? '' : `<button type="button" data-clippy-record-coverage="${index}">Record Dradis check</button>` : `<button type="button" data-clippy-save-lead="${index}" aria-pressed="${item.saved === true}">${item.saved ? '★ Saved' : '☆ Save lead'}</button>`}<button type="button" class="clippy-chat-button" data-clippy-ask-lead="${index}">${review ? 'Investigate with Clippy' : 'Plan with Clippy'} ↗</button></footer></article>`;
}

function renderClippyLeads(view) {
  view.leadSignature = null;
  const target = view.wrap.querySelector('[data-clippy-workspace]');
  target.innerHTML = `<section class="clippy-leads-heading"><span class="collection-eyebrow">Your next assessment</span><h2>A few solid starting points.</h2><p>Specific evidence. A clear next step. Dradis coverage checked before a lead makes the shortlist.</p><form class="clippy-lead-search" data-clippy-lead-search><label><span class="sr-only">Focus the lead search</span><input type="search" data-clippy-lead-query placeholder="Optional domain, technology, or engagement…" value="${escapeHtml(state.clippyDashboard.leadQuery || '')}" /></label><button type="submit" class="safe" data-clippy-find-leads>Find leads</button></form></section><div class="clippy-lead-status" data-clippy-lead-status role="status">Loading saved intelligence…</div><div class="clippy-leads-content" data-clippy-leads-content></div>`;
  target.querySelector('[data-clippy-lead-query]').addEventListener('input', event => { state.clippyDashboard.leadQuery = event.target.value; });
  target.querySelector('[data-clippy-lead-search]').addEventListener('submit', async event => {
    event.preventDefault();
    const button = target.querySelector('[data-clippy-find-leads]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await packageApi('POST', '/api/clippy/leads/search', { query: state.clippyDashboard.leadQuery || '' });
      await loadClippyLeads(view);
    } catch (error) { showToast(error.message, { kind: 'warning', label: 'Clippy leads' }); }
    finally { if (button.isConnected && view.leadResult?.search?.state !== 'running') button.disabled = false; }
  });
  loadClippyLeads(view);
}

async function loadClippyLeads(view) {
  clearTimeout(view.leadsTimer);
  if (!clippyViewAlive(view) || state.clippyDashboard.view !== 'leads') return;
  const content = view.wrap.querySelector('[data-clippy-leads-content]');
  if (!content) return;
  try {
    const result = await clippyRead(view, `/leads?query=${encodeURIComponent(state.clippyDashboard.leadQuery || '')}`, 'leads');
    if (!clippyViewAlive(view) || !content.isConnected) return;
    view.leadResult = result;
    const running = result.search?.state === 'running';
    const status = view.wrap.querySelector('[data-clippy-lead-status]');
    const calls = Number(result.search?.calls || 0);
    status.innerHTML = `<span${running ? ' class="clippy-lead-searching"' : ''}>${escapeHtml(result.search?.reason || (running ? 'Checking relevant intelligence and report coverage…' : 'Ready for an evidence search.'))}${running && calls ? ` · ${calls} lookups` : ''}</span>${running ? '<button type="button" class="text-action" data-clippy-cancel-leads>Stop search</button>' : ''}${!running && result.suggestions?.length ? `<div class="clippy-domain-suggestions"><span>Similar hostname found in source evidence:</span>${result.suggestions.map(domain => `<button type="button" class="text-action" data-clippy-suggested-domain="${escapeHtml(domain)}">Search ${escapeHtml(domain)}</button>`).join('')}</div>` : ''}${result.retainedElsewhere > 0 && (state.clippyDashboard.leadQuery || '').trim() ? `<small>${result.retainedElsewhere} earlier candidate${result.retainedElsewhere === 1 ? '' : 's'} outside this search ${result.retainedElsewhere === 1 ? 'is' : 'are'} hidden. <button type="button" class="text-action" data-clippy-clear-lead-focus>Show all saved evidence</button></small>` : ''}`;
    view.wrap.querySelector('[data-clippy-find-leads]').disabled = running;
    status.querySelectorAll?.('[data-clippy-suggested-domain]').forEach(button => button.addEventListener('click', () => {
      state.clippyDashboard.leadQuery = button.dataset.clippySuggestedDomain;
      view.wrap.querySelector('[data-clippy-lead-query]').value = button.dataset.clippySuggestedDomain;
      view.wrap.querySelector('[data-clippy-lead-search]').requestSubmit();
    }));
    status.querySelector('[data-clippy-clear-lead-focus]')?.addEventListener('click', () => {
      state.clippyDashboard.leadQuery = ''; view.wrap.querySelector('[data-clippy-lead-query]').value = ''; loadClippyLeads(view);
    });
    status.querySelector('[data-clippy-cancel-leads]')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try { await packageApi('POST', '/api/clippy/leads/cancel', {}); await loadClippyLeads(view); }
      catch (error) { showToast(error.message, { kind: 'warning', label: 'Clippy leads' }); if (event.currentTarget.isConnected) event.currentTarget.disabled = false; }
    });
    const { ready, review } = clippyLeadCollections(result);
    const signature = JSON.stringify({ ready, review, note: result.note, query: result.query });
    if (view.leadSignature !== signature) {
      view.leadSignature = signature;
      const expanded = state.clippyDashboard.expandedLeads ||= new Set();
      const items = [...ready, ...review];
      view.leadItems = items;
      const reviewOpen = view.reviewExpanded ?? ready.length === 0;
      content.innerHTML = `<div class="clippy-shortlist-heading"><strong>Ready to investigate</strong><span>${ready.length} / 5</span></div>${ready.length ? ready.map((item, index) => clippyLeadCard(item, index, { expanded: expanded.has(item.id) })).join('') : review.length ? '<p class="clippy-lead-note">Evidence found below. No verified ready leads yet: check the evidence and Dradis coverage before recommending assessment work.</p>' : clippyEmpty('No verified leads yet', 'Run a focused search to find evidence candidates. Clippy MCP cannot establish complete current Dradis coverage; an analyst must check Dradis directly before a candidate is ready.', '<button type="button" data-clippy-ask-search>Explore with Clippy</button>')}${review.length ? `<details class="clippy-review-list" data-clippy-review-list${reviewOpen ? ' open' : ''}><summary>Evidence to review <span>${review.length}</span></summary><p>Review these source-backed candidates with Clippy. They remain outside recommendations until their evidence is actionable and an analyst records a direct Dradis check. Possible project-name matches must each be resolved; tied reports exclude a candidate.</p>${review.map((item, index) => clippyLeadCard(item, index + ready.length, { review: true, expanded: expanded.has(item.id) })).join('')}</details>` : ''}${result.note ? `<p class="clippy-lead-note">${escapeHtml(result.note)}</p>` : ''}`;
      wireClippyAgentButton(content.querySelector('[data-clippy-ask-search]'), () => clippyLeadSearchPrompt(state.clippyDashboard.leadQuery || ''));
      content.querySelector('[data-clippy-review-list]')?.addEventListener('toggle', event => { view.reviewExpanded = event.currentTarget.open; });
      content.querySelectorAll('[data-clippy-lead-details]').forEach(details => details.addEventListener('toggle', () => {
        if (details.open) expanded.add(details.dataset.clippyLeadDetails);
        else expanded.delete(details.dataset.clippyLeadDetails);
      }));
      content.querySelectorAll('[data-clippy-ask-lead]').forEach(button => wireClippyAgentButton(button, () => clippyLeadPrompt(items[Number(button.dataset.clippyAskLead)])));
      content.querySelectorAll('[data-clippy-record-coverage]').forEach(button => button.addEventListener('click', () => openClippyCoverageCheck(view, items[Number(button.dataset.clippyRecordCoverage)])));
      content.querySelectorAll('[data-clippy-lead-source]').forEach(button => button.addEventListener('click', () => {
        const [itemIndex, sourceIndex] = button.dataset.clippyLeadSource.split(':').map(Number);
        openClippyLeadSource(view, items[itemIndex].evidence[sourceIndex]);
      }));
      content.querySelectorAll('[data-clippy-save-lead]').forEach(button => button.addEventListener('click', async () => {
        const item = items[Number(button.dataset.clippySaveLead)];
        button.disabled = true;
        try { await packageApi('POST', `/api/clippy/leads/${encodeURIComponent(item.id)}/save`, { saved: !item.saved }); await loadClippyLeads(view); }
        catch (error) { showToast(error.message, { kind: 'warning', label: 'Clippy leads' }); if (button.isConnected) button.disabled = false; }
      }));
    }
    if (running) view.leadsTimer = setTimeout(() => loadClippyLeads(view), 2500);
  } catch (error) {
    if (clippyViewAlive(view) && content.isConnected && error.name !== 'AbortError') {
      view.leadSignature = null;
      view.wrap.querySelector('[data-clippy-find-leads]').disabled = false;
      clippyError(content, error, () => loadClippyLeads(view));
    }
  }
}

function openClippyCoverageCheck(view, item) {
  if (clippyKnownReportTie(item.reportCoverage)) return;
  view.closeCoverage?.();
  const coverage = item.reportCoverage || {};
  const scope = item.scope || item.domain;
  const reportQuery = item.targetKind === 'source' ? String(item.repository || item.targetLabel || '').split('/').at(-1).split('@')[0] : item.domain || item.targetLabel || '';
  const dradisTabUrl = `https://dradistab.redteamstuff.com/?filter=${encodeURIComponent(reportQuery)}`;
  const projects = Array.isArray(coverage.projects) ? coverage.projects : [];
  const matches = projects.map((project, index) => {
    const url = /^https:\/\/[^\s]+$/i.test(String(project.url || '')) ? `<a href="${escapeHtml(project.url)}" target="_blank" rel="noopener noreferrer">Open project ↗</a>` : '';
    return `<fieldset class="clippy-project-disposition"><legend>${escapeHtml(project.name || 'Possible Dradis project match')}</legend><p>${escapeHtml(project.status || 'Status unknown')}${url ? ` · ${url}` : ''}</p><label class="editor-field"><span>Does this project or report cover the exact target?</span><select data-clippy-project-disposition="${index}" required><option value="" selected>Choose after checking Dradis…</option><option value="unrelated">Unrelated to this target</option><option value="tied">Tied to this target — exclude</option><option value="unknown">Unable to establish the relationship</option></select></label><label class="editor-field"><span>Evidence for this relationship</span><textarea data-clippy-project-notes="${index}" minlength="20" maxlength="2000" rows="3" placeholder="Record the project scope, report/finding records, and why this match is unrelated or tied…" required></textarea></label></fieldset>`;
  }).join('');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal clippy-coverage-modal" role="dialog" aria-modal="true" aria-labelledby="clippy-coverage-title"><header><h2 id="clippy-coverage-title">Record a Dradis check</h2><button type="button" data-clippy-close-coverage aria-label="Close Dradis check">×</button></header><div class="app-modal-copy"><p><strong class="clippy-coverage-scope">${escapeHtml(scope || 'Exact target unavailable')}</strong> · ${escapeHtml(item.title || '')}</p><p>Clippy MCP does not provide complete current Dradis report coverage. Check Dradis directly for this exact ${item.targetKind === 'source' ? 'repository and assessed commit, related deployment, source/finding IDs,' : 'target, its aliases,'} related projects, and reports. A missing Clippy search match is insufficient. This records your check for 24 hours; new evidence requires another check.</p><p><a href="${escapeHtml(dradisTabUrl)}" target="_blank" rel="noopener noreferrer">Open DradisTab for this scope ↗</a><br>This filtered page is a starting point. Check relevant aliases and the actual project/report records, then record the page you inspected below.</p>${coverage.partial ? '<p class="clippy-lead-withheld">The returned project feed is incomplete. A verified receipt cannot be recorded until the matching inventory can be rechecked completely.</p>' : ''}<form data-clippy-coverage-form>${matches ? `<p>Resolve each possible project-name match using its actual scope and reports. Nothing is marked unrelated automatically.</p>${matches}` : ''}<label class="editor-field"><span>Dradis URL you checked</span><input type="url" data-clippy-coverage-url value="${escapeHtml(dradisTabUrl)}" placeholder="https://dradis…/projects" required /></label><label class="editor-field"><span>What did you check?</span><textarea data-clippy-coverage-notes placeholder="Exact target, aliases or repository/commit, project and report inventory, and the result of your check…" minlength="20" maxlength="2000" rows="4" required></textarea></label><label class="clippy-coverage-confirm"><input type="checkbox" data-clippy-coverage-confirm required /><span>I checked Dradis for this exact scope and relevant aliases and found no tied report.</span></label><p class="package-editor-status" data-clippy-coverage-status role="status"></p><div class="smart-connect-form-actions"><button type="button" data-clippy-cancel-coverage>Cancel</button><button type="submit" class="safe" disabled>Record check</button></div></form></div></div>`;
  document.getElementById('modal-root').appendChild(backdrop);
  let busy = false;
  const close = prepareCollectionDialog(backdrop, { onClose: () => { view.closeCoverage = null; } });
  view.closeCoverage = close;
  backdrop.querySelector('[data-clippy-close-coverage]').addEventListener('click', close);
  backdrop.querySelector('[data-clippy-cancel-coverage]').addEventListener('click', close);
  const form = backdrop.querySelector('[data-clippy-coverage-form]');
  const submit = backdrop.querySelector('[type="submit"]');
  const status = backdrop.querySelector('[data-clippy-coverage-status]');
  const dispositions = () => projects.map((project, index) => ({ matchId: String(project.matchId ?? project.id ?? ''), disposition: backdrop.querySelector(`[data-clippy-project-disposition="${index}"]`).value, notes: backdrop.querySelector(`[data-clippy-project-notes="${index}"]`).value.trim() }));
  const update = () => {
    const rows = dispositions();
    const relationship = rows.some(project => ['tied', 'unknown'].includes(project.disposition));
    const unresolved = rows.some(project => !['unrelated', 'tied', 'unknown'].includes(project.disposition) || project.notes.length < 20 || project.notes.length > 2000 || !project.matchId);
    const confirmation = backdrop.querySelector('[data-clippy-coverage-confirm]');
    confirmation.disabled = relationship;
    if (relationship) confirmation.checked = false;
    submit.textContent = relationship ? 'Record relationship' : 'Record check';
    submit.disabled = busy || !scope || unresolved || (!relationship && (coverage.partial === true || !confirmation.checked));
    if (rows.some(project => project.disposition === 'tied')) status.textContent = 'A tied report excludes this candidate. Record this relationship to retain the exclusion; this does not attest that no report exists.';
    else if (rows.some(project => project.disposition === 'unknown')) status.textContent = 'Report coverage remains unknown. Record this relationship to retain the unresolved check; the candidate stays outside recommendations.';
    else if (!busy) status.textContent = '';
    return { rows, relationship };
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const { rows, relationship } = update();
    if (busy || submit.disabled || form.reportValidity?.() === false) return;
    busy = true;
    submit.disabled = true;
    status.textContent = relationship ? 'Saving the report relationship…' : 'Saving your Dradis check…';
    try {
      await packageApi('POST', `/api/clippy/leads/${encodeURIComponent(item.id)}/coverage`, { noReport: !relationship, sourceUrl: backdrop.querySelector('[data-clippy-coverage-url]').value.trim(), scope, notes: backdrop.querySelector('[data-clippy-coverage-notes]').value.trim(), evidenceDigest: item.evidenceDigest, matchDigest: coverage.matchDigest, projectDispositions: rows });
      busy = false;
      close();
      await loadClippyLeads(view);
    } catch (error) {
      busy = false;
      await loadClippyLeads(view);
      status.textContent = `${error.message} Close and reopen this check to review the latest evidence and matching projects.`;
      submit.disabled = true;
    }
  });
}

async function openClippyLeadSource(view, source) {
  return openClippySourcePreview(source, { view });
}

async function openClippySourcePreview(source, { view = null } = {}) {
  const reference = clippySourceReference(clippySourceHref(source));
  if (!reference) return;
  activeClippySourcePreview?.();
  view?.closeEvidence?.();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal clippy-source-modal" role="dialog" aria-modal="true" aria-labelledby="clippy-source-title"><header><div><small>${escapeHtml(reference.repo)}</small><h2 id="clippy-source-title">${escapeHtml(reference.path)}</h2></div><button type="button" data-clippy-close-source aria-label="Close evidence">×</button></header><div class="clippy-source-content" data-clippy-source-content role="status">${clippyEmpty('Loading source', 'Reading the cited evidence directly from Clippy…')}</div></div>`;
  document.getElementById('modal-root').appendChild(backdrop);
  let controller = null;
  let closed = false;
  const close = prepareCollectionDialog(backdrop, { onClose: () => {
    closed = true;
    controller?.abort();
    if (activeClippySourcePreview === close) activeClippySourcePreview = null;
    if (view?.closeEvidence === close) view.closeEvidence = null;
  } });
  activeClippySourcePreview = close;
  if (view) view.closeEvidence = close;
  backdrop.querySelector('[data-clippy-close-source]').addEventListener('click', close);
  const target = backdrop.querySelector('[data-clippy-source-content]');
  const alive = () => !closed && target.isConnected && (!view || clippyViewAlive(view));
  const read = async (offset = Math.max(1, reference.line - 8)) => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; request.abort(); }, 45000);
    target.innerHTML = clippyEmpty('Loading source', 'Reading this page directly from Clippy…');
    try {
      const response = await fetch(`/api/clippy/file?${new URLSearchParams({ repo: reference.repo, path: reference.path, offset: String(offset), limit: '200' })}`, { signal: request.signal });
      const result = await response.json();
      if (!alive() || controller !== request) return;
      if (!response.ok || result.ok === false) throw new Error(result.error || `Clippy request failed (${response.status})`);
      const file = result.file || result;
      if (file.is_text === false) { target.innerHTML = clippyEmpty('Binary evidence', 'A text preview is not available for this file.'); return; }
      const text = String(file.content || file.text || '');
      const pageSize = Math.min(1000, Math.max(1, Number(file.limit) || 200));
      const start = Math.max(1, Number(file.offset) || offset);
      const total = Math.max(0, Number(file.total_lines) || 0);
      const returnedLines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
      const end = start + Math.max(0, returnedLines - 1);
      const hasMore = total ? start + pageSize <= total : file.truncated === true;
      target.innerHTML = `<p class="clippy-data-note">Live Clippy source · lines ${start}–${end}${total ? ` of ${total.toLocaleString()}` : ''}${reference.line > 1 ? ` · citation at line ${reference.line}` : ''}. Additional pages load when opened.</p><pre>${escapeHtml(text || 'No text returned for this source.')}</pre><div class="clippy-file-pagination"><button type="button" data-clippy-source-prev${start > 1 ? '' : ' disabled'}>← Previous lines</button><button type="button" data-clippy-source-next${hasMore ? '' : ' disabled'}>Next lines →</button></div>`;
      target.querySelector('[data-clippy-source-prev]').addEventListener('click', () => read(Math.max(1, start - pageSize)));
      target.querySelector('[data-clippy-source-next]').addEventListener('click', () => read(start + pageSize));
    } catch (error) {
      if (!alive() || controller !== request) return;
      if (timedOut) clippyError(target, new Error('Clippy took too long to read this source. Try again.'), () => read(offset));
      else if (error.name !== 'AbortError') clippyError(target, error, () => read(offset));
    } finally { clearTimeout(timer); }
  };
  await read();
}

function renderClippyFindings(view) {
  const dashboard = state.clippyDashboard;
  dashboard.findingsSource = dashboard.findingsSource === 'cache' ? 'cache' : 'live';
  const target = view.wrap.querySelector('[data-clippy-workspace]');
  target.innerHTML = `<div class="clippy-findings-toolbar"><label>Source <select data-clippy-source aria-label="Finding source"><option value="live"${dashboard.findingsSource === 'live' ? ' selected' : ''}>Live Clippy</option><option value="cache"${dashboard.findingsSource === 'cache' ? ' selected' : ''}>Local cache</option></select></label><div class="clippy-severity-filters" role="group" aria-label="Filter by severity"><button type="button" class="clippy-severity-chip all" data-clippy-severity="" aria-pressed="${!dashboard.severity}">All <span data-clippy-count="all">—</span></button>${CLIPPY_SEVERITIES.map(severity => `<button type="button" class="clippy-severity-chip ${severity}" data-clippy-severity="${severity}" aria-pressed="${dashboard.severity === severity}">${severity === 'unknown' ? 'Unspecified' : severity}<span data-clippy-count="${severity}">—</span></button>`).join('')}</div><button type="button" class="text-action" data-clippy-clear>Clear filters</button></div><div class="clippy-search-row"><label class="clippy-search"><span class="sr-only">Search findings</span><input type="search" data-clippy-search placeholder="Search title, target, repo, ID…" value="${escapeHtml(dashboard.query)}" /></label><label><span class="sr-only">Filter findings by repository</span><select data-clippy-repo><option value="">All engagement repos</option>${dashboard.repo ? `<option value="${escapeHtml(dashboard.repo)}" selected>${escapeHtml(dashboard.repo)}</option>` : ''}</select></label><label><span class="sr-only">Filter findings by category</span><select data-clippy-category><option value="">All categories</option>${dashboard.category ? `<option value="${escapeHtml(dashboard.category)}" selected>${escapeHtml(dashboard.category)}</option>` : ''}</select></label></div><div class="clippy-data-note" data-clippy-note role="status" hidden></div><div class="clippy-findings-layout"><section class="clippy-results-panel" aria-label="Security findings"><div class="clippy-panel-heading"><strong data-clippy-count-scope>Findings</strong><span data-clippy-total>Loading…</span></div><div class="clippy-findings-list" data-clippy-findings role="list"></div><div class="clippy-pagination" data-clippy-pagination></div></section><section class="clippy-finding-detail" data-clippy-detail aria-label="Finding details">${clippyEmpty('Select a finding', 'Details, evidence, and remediation appear here.')}</section></div>`;
  target.querySelector('[data-clippy-source]').addEventListener('change', event => {
    dashboard.findingsSource = event.target.value;
    dashboard.offset = 0;
    dashboard.category = '';
    view.controllers.get('findings')?.abort();
    renderClippyWorkspace(view);
  });
  const search = target.querySelector('[data-clippy-search]');
  search.addEventListener('input', () => {
    dashboard.query = search.value;
    dashboard.offset = 0;
    clearTimeout(view.searchTimer);
    view.controllers.get('findings')?.abort();
    view.searchTimer = setTimeout(() => loadClippyFindings(view), 280);
  });
  target.querySelectorAll('[data-clippy-severity]').forEach(button => button.addEventListener('click', () => {
    dashboard.severity = button.dataset.clippySeverity;
    dashboard.offset = 0;
    target.querySelectorAll('[data-clippy-severity]').forEach(chip => chip.setAttribute('aria-pressed', String(chip === button)));
    loadClippyFindings(view);
  }));
  for (const [selector, key] of [['[data-clippy-repo]', 'repo'], ['[data-clippy-category]', 'category']]) target.querySelector(selector).addEventListener('change', event => {
    dashboard[key] = event.target.value;
    dashboard.offset = 0;
    loadClippyFindings(view);
  });
  target.querySelector('[data-clippy-clear]').addEventListener('click', () => {
    Object.assign(dashboard, { query: '', severity: '', repo: '', category: '', offset: 0 });
    renderClippyWorkspace(view);
  });
  loadClippyFindings(view);
  loadClippyRepoOptions(view);
}

async function loadClippyRepoOptions(view) {
  const dashboard = state.clippyDashboard;
  const select = view.wrap.querySelector('[data-clippy-repo]');
  try {
    if (!dashboard.repoOptions || Date.now() - dashboard.repoOptionsAt > 300000) {
      const result = await clippyRead(view, '/repos', 'repo-options');
      if (!clippyViewAlive(view) || !select.isConnected) return;
      dashboard.repoOptions = clippyCollection(result, 'repos');
      dashboard.repoOptionsAt = Date.now();
    }
    if (select.isConnected) updateClippyFilterOptions(select, dashboard.repoOptions, dashboard.repo, 'All engagement repos');
  } catch {}
}

function updateClippyFilterOptions(select, rows, selected, label) {
  const choices = new Map();
  for (const row of rows) {
    const value = typeof row === 'string' ? row : String(row.id || row.name || row.repo || '');
    if (value) choices.set(value, typeof row === 'string' ? row : row.name || value);
  }
  if (selected && !choices.has(selected)) choices.set(selected, selected);
  select.innerHTML = `<option value="">${label}</option>${[...choices].map(([value, name]) => `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}`;
}

async function loadClippyFindings(view) {
  if (!clippyViewAlive(view)) return;
  const target = view.wrap.querySelector('[data-clippy-findings]');
  if (!target) return;
  const dashboard = state.clippyDashboard;
  const query = new URLSearchParams({ source: dashboard.findingsSource || 'live', q: dashboard.query, severity: dashboard.severity, repo: dashboard.repo, category: dashboard.category, offset: String(dashboard.offset), limit: '25' });
  target.setAttribute('aria-busy', 'true');
  target.innerHTML = '<p class="clippy-list-message">Loading findings…</p>';
  view.wrap.querySelector('[data-clippy-total]').textContent = 'Loading…';
  view.wrap.querySelector('[data-clippy-pagination]').innerHTML = '';
  try {
    const result = await clippyRead(view, `/findings?${query}`, 'findings');
    if (!clippyViewAlive(view) || !target.isConnected) return;
    const findings = clippyCollection(result, 'findings');
    view.findings = findings;
    const total = Number(result.total ?? findings.length);
    view.wrap.querySelector('[data-clippy-total]').textContent = `${total.toLocaleString()}${result.partial ? total === 1 ? ' match' : ' matches' : ''}`;
    view.wrap.querySelector('[data-clippy-count-scope]').textContent = clippyFindingCountScope(result);
    const counts = result.counts || result.severityCounts || {};
    const allCount = result.totalUnfiltered ?? result.unfilteredTotal ?? (Object.keys(counts).length ? Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0) : total);
    view.wrap.querySelector('[data-clippy-count="all"]').textContent = Number(allCount).toLocaleString();
    for (const severity of CLIPPY_SEVERITIES) view.wrap.querySelector(`[data-clippy-count="${severity}"]`).textContent = counts[severity] == null ? '—' : Number(counts[severity]).toLocaleString();
    const note = view.wrap.querySelector('[data-clippy-note]');
    const pendingMetadata = result.browseSource === 'live' ? 0 : Number(result.metadataPending ?? result.index?.metadataPending ?? 0);
    note.hidden = !result.note && !result.partial && !pendingMetadata;
    note.textContent = [result.note || (result.partial ? 'Showing indexed matches available through Clippy. Counts reflect this result set.' : ''), pendingMetadata ? 'Not parsed describes local cache coverage, not Clippy Agent access. Unparsed paths remain available under All.' : ''].filter(Boolean).join(' ');
    updateClippyFilterOptions(view.wrap.querySelector('[data-clippy-repo]'), dashboard.repoOptions || result.repos || findings.map(item => item.repo).filter(Boolean), dashboard.repo, 'All engagement repos');
    updateClippyFilterOptions(view.wrap.querySelector('[data-clippy-category]'), result.categories || findings.map(item => item.category).filter(Boolean), dashboard.category, 'All categories');
    target.innerHTML = findings.length ? findings.map((finding, index) => `<button type="button" class="clippy-finding-row${view.selectedFinding === String(finding.id) ? ' selected' : ''}" data-clippy-finding="${index}" role="listitem"><div class="clippy-finding-row-top"><strong>${escapeHtml(finding.title || finding.name || finding.id || 'Untitled finding')}</strong>${clippyFindingSeverityMarkup(finding)}</div><p>${escapeHtml([finding.repo, finding.category].filter(Boolean).join(' · ') || finding.path || '')}</p>${finding.target ? `<small>${escapeHtml(finding.target)}</small>` : ''}</button>`).join('') : clippyEmpty('No matching findings', result.hasMore ? 'No matching parsed findings on this page. Try the next page or refine your search.' : dashboard.findingsSource === 'cache' ? 'Try Live Clippy to search the connected intelligence beyond the optional cache.' : 'Try another search, choose a repo, or clear your filters.');
    target.querySelectorAll('[data-clippy-finding]').forEach(button => button.addEventListener('click', () => selectClippyFinding(view, findings[Number(button.dataset.clippyFinding)])));
    const pagination = view.wrap.querySelector('[data-clippy-pagination]');
    const hasMore = result.hasMore === true || (result.hasMore !== false && dashboard.offset + findings.length < total);
    pagination.innerHTML = dashboard.offset || hasMore ? `<button type="button" data-clippy-prev${dashboard.offset ? '' : ' disabled'}>← Previous</button><span>Page ${Math.floor(dashboard.offset / 25) + 1} · ${findings.length} shown</span><button type="button" data-clippy-next${hasMore ? '' : ' disabled'}>Next →</button>` : '';
    pagination.querySelector('[data-clippy-prev]')?.addEventListener('click', () => { dashboard.offset = Math.max(0, dashboard.offset - 25); loadClippyFindings(view); });
    pagination.querySelector('[data-clippy-next]')?.addEventListener('click', () => { dashboard.offset = Number(result.nextOffset ?? dashboard.offset + 25); loadClippyFindings(view); });
  } catch (error) {
    if (clippyViewAlive(view) && target.isConnected && error.name !== 'AbortError') {
      view.wrap.querySelector('[data-clippy-total]').textContent = 'Unavailable';
      clippyError(target, error, () => loadClippyFindings(view));
    }
  } finally { if (target.isConnected) target.removeAttribute('aria-busy'); }
}

async function selectClippyFinding(view, finding) {
  const id = String(finding.id || finding.path || '');
  view.selectedFinding = id;
  view.wrap.querySelectorAll('[data-clippy-finding]').forEach(button => button.classList.toggle('selected', view.findings[Number(button.dataset.clippyFinding)] === finding));
  const detail = view.wrap.querySelector('[data-clippy-detail]');
  detail.innerHTML = clippyEmpty('Loading finding', finding.title || finding.path || id);
  try {
    const result = await clippyRead(view, `/findings/${encodeURIComponent(id)}`, 'detail');
    if (!clippyViewAlive(view) || !detail.isConnected || view.selectedFinding !== id) return;
    const item = { ...finding, ...(result.finding || result), metadataPending: false };
    const sections = ['description', 'summary', 'impact', 'evidence', 'remediation', 'recommendation'];
    detail.innerHTML = `<div class="clippy-detail-heading"><div><span class="clippy-severity-badge ${clippySeverity(item.severity)}">${clippySeverity(item.severity) === 'unknown' ? 'Unspecified' : clippySeverity(item.severity)}</span><h2>${escapeHtml(item.title || item.name || 'Finding')}</h2><p>${escapeHtml([item.repo, item.category, item.target].filter(Boolean).join(' · '))}</p></div><button type="button" data-clippy-ask>✦ Ask Clippy</button></div><dl class="clippy-detail-meta">${[['Finding ID', item.id], ['Repository', item.repo], ['File', item.path], ['Status', item.status]].filter(([, value]) => value).map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><div class="clippy-finding-body">${item.content ? renderMarkdown(item.content) : sections.filter(key => item[key]).map(key => `<section><h3>${key[0].toUpperCase() + key.slice(1)}</h3>${renderMarkdown(typeof item[key] === 'string' ? item[key] : JSON.stringify(item[key], null, 2))}</section>`).join('') || '<p class="field-note">No additional detail was returned for this finding.</p>'}</div>`;
    enhanceMarkdownContent(detail, { clippySources: true, source: { repo: item.repo, path: item.path } });
    wireClippyAgentButton(detail.querySelector('[data-clippy-ask]'), `Explain this Clippy finding, including its evidence, impact, and remediation.\n\nFinding: ${item.title || id}\nRepository: ${item.repo || ''}\nPath: ${item.path || ''}\nID: ${id}`);
  } catch (error) { if (clippyViewAlive(view) && detail.isConnected && error.name !== 'AbortError') clippyError(detail, error, () => selectClippyFinding(view, finding)); }
}

function renderClippyRepos(view) {
  const target = view.wrap.querySelector('[data-clippy-workspace]');
  target.innerHTML = `<div class="clippy-repos-toolbar"><div><h2>Engagement repos</h2><small>Read from connected Clippy; independent of the local cache.</small><span data-clippy-repos-total>Loading…</span></div><label class="clippy-search"><span class="sr-only">Filter repositories</span><input type="search" data-clippy-repo-search placeholder="Filter repos…" value="${escapeHtml(state.clippyDashboard.repoQuery)}" /></label></div><div class="clippy-repos-layout"><section class="clippy-repo-panel" aria-label="Engagement repositories"><div class="clippy-repo-list" data-clippy-repos></div></section><section class="clippy-files-panel" aria-label="Repository files"><div class="clippy-panel-heading"><strong>Files</strong><span data-clippy-files-total></span></div><div class="clippy-files-list" data-clippy-files>${clippyEmpty('Select a repo', 'Read the files available through connected Clippy. Local cache progress does not limit this view.')}</div></section><section class="clippy-file-detail" data-clippy-file-detail aria-label="File preview">${clippyEmpty('Select a file', 'Preview engagement notes and assessment evidence.')}</section></div>`;
  const input = target.querySelector('[data-clippy-repo-search]');
  input.addEventListener('input', () => {
    state.clippyDashboard.repoQuery = input.value;
    clearTimeout(view.searchTimer);
    view.controllers.get('repos')?.abort();
    view.searchTimer = setTimeout(() => loadClippyRepos(view), 280);
  });
  loadClippyRepos(view);
}

async function loadClippyRepos(view) {
  const target = view.wrap.querySelector('[data-clippy-repos]');
  if (!target) return;
  target.innerHTML = '<p class="clippy-list-message">Loading engagement repos…</p>';
  try {
    const result = await clippyRead(view, `/repos?${new URLSearchParams({ q: state.clippyDashboard.repoQuery })}`, 'repos');
    if (!clippyViewAlive(view) || !target.isConnected) return;
    const repos = clippyCollection(result, 'repos');
    view.repos = repos;
    view.wrap.querySelector('[data-clippy-repos-total]').textContent = `${Number(result.total ?? repos.length).toLocaleString()} repos`;
    let visible = 200;
    const draw = () => {
      target.innerHTML = repos.length ? repos.slice(0, visible).map((repo, index) => `<button type="button" class="clippy-repo-row${view.selectedRepo === clippyRepoId(repo) ? ' selected' : ''}" data-clippy-repo-item="${index}"><span class="clippy-repo-icon" aria-hidden="true">▤</span><span><strong>${escapeHtml(repo.name || clippyRepoId(repo))}</strong><small>${repo.files != null || repo.fileCount != null ? `${Number(repo.files ?? repo.fileCount).toLocaleString()} files` : 'Engagement repository'}</small></span></button>`).join('') : clippyEmpty('No matching repos', 'Try another repository name.');
      if (repos.length > visible) target.insertAdjacentHTML('beforeend', `<button type="button" class="clippy-load-more" data-clippy-more-repos>Show ${Math.min(200, repos.length - visible)} more repos</button>`);
      target.querySelector('[data-clippy-more-repos]')?.addEventListener('click', () => { visible += 200; draw(); });
      target.querySelectorAll('[data-clippy-repo-item]').forEach(button => button.addEventListener('click', () => selectClippyRepo(view, repos[Number(button.dataset.clippyRepoItem)])));
    };
    draw();
  } catch (error) { if (clippyViewAlive(view) && target.isConnected && error.name !== 'AbortError') clippyError(target, error, () => loadClippyRepos(view)); }
}

async function selectClippyRepo(view, repo) {
  const id = clippyRepoId(repo);
  view.selectedRepo = id;
  view.selectedFile = null;
  view.controllers.get('file')?.abort();
  view.controllers.delete('file');
  view.wrap.querySelectorAll('[data-clippy-repo-item]').forEach(button => button.classList.toggle('selected', clippyRepoId(view.repos[Number(button.dataset.clippyRepoItem)]) === id));
  const target = view.wrap.querySelector('[data-clippy-files]');
  target.innerHTML = '<p class="clippy-list-message">Loading files…</p>';
  view.wrap.querySelector('[data-clippy-files-total]').textContent = '';
  view.wrap.querySelector('[data-clippy-file-detail]').innerHTML = clippyEmpty('Select a file', `Browsing ${id}`);
  try {
    const result = await clippyRead(view, `/repos/${encodeURIComponent(id)}/files`, 'files');
    if (!clippyViewAlive(view) || !target.isConnected || view.selectedRepo !== id) return;
    const files = clippyCollection(result, 'files');
    view.files = files;
    view.wrap.querySelector('[data-clippy-files-total]').textContent = `${files.length.toLocaleString()}${result.partial ? '+' : ''}`;
    target.innerHTML = files.length ? `${result.partial ? '<p class="clippy-index-note">Clippy returned its limit of 500 files for this repo. This list may be incomplete; ask Clippy Agent for a focused search or known file path.</p>' : ''}<label class="clippy-file-search"><span class="sr-only">Filter returned files</span><input type="search" data-clippy-file-search placeholder="Find a file…" /></label><div data-clippy-file-rows>${files.map((file, index) => `<button type="button" class="clippy-file-row" data-clippy-file="${index}"><span aria-hidden="true">${file.is_text === false ? '▧' : '≡'}</span><span>${escapeHtml(file.path || file.name || String(file))}</span></button>`).join('')}</div>` : clippyEmpty('No files returned', 'Clippy returned no files for this repository.');
    target.querySelector('[data-clippy-file-search]')?.addEventListener('input', event => {
      const query = event.target.value.toLowerCase();
      target.querySelectorAll('[data-clippy-file]').forEach(button => { button.hidden = !String(files[Number(button.dataset.clippyFile)].path || files[Number(button.dataset.clippyFile)].name || '').toLowerCase().includes(query); });
    });
    target.querySelectorAll('[data-clippy-file]').forEach(button => button.addEventListener('click', () => selectClippyFile(view, files[Number(button.dataset.clippyFile)])));
  } catch (error) { if (clippyViewAlive(view) && target.isConnected && error.name !== 'AbortError') clippyError(target, error, () => selectClippyRepo(view, repo)); }
}

async function selectClippyFile(view, file, offset = 1) {
  const path = file.path || file.name || String(file);
  const repo = view.selectedRepo;
  view.selectedFile = path;
  view.wrap.querySelectorAll('[data-clippy-file]').forEach(button => button.classList.toggle('selected', (view.files[Number(button.dataset.clippyFile)].path || view.files[Number(button.dataset.clippyFile)].name) === path));
  const target = view.wrap.querySelector('[data-clippy-file-detail]');
  target.innerHTML = clippyEmpty('Loading file', path);
  try {
    const result = await clippyRead(view, `/file?${new URLSearchParams({ repo, path, offset: String(offset), limit: '500' })}`, 'file');
    if (!clippyViewAlive(view) || !target.isConnected || view.selectedFile !== path || view.selectedRepo !== repo) return;
    const content = result.file || result;
    const binary = content.is_text === false;
    const markdown = /\.(?:md|markdown)$/i.test(path);
    const rawText = content.content || content.text || '';
    const preview = markdown && content.lineNumbered ? String(rawText).replace(/^\d+: ?/gm, '') : rawText;
    const pageSize = Number(content.limit) || 500;
    const start = Number(content.offset) || offset;
    const totalLines = Number(content.total_lines) || 0;
    const hasMore = totalLines ? start + pageSize <= totalLines : content.truncated === true;
    target.innerHTML = `<div class="clippy-file-heading"><div><span class="collection-eyebrow">${escapeHtml(repo)}</span><h2>${escapeHtml(path)}</h2></div><button type="button" data-clippy-ask-file>✦ Ask Clippy</button></div>${content.truncated || start > 1 ? `<p class="clippy-data-note">Showing Clippy source lines ${start}–${totalLines ? Math.min(start + pageSize - 1, totalLines) : start + pageSize - 1}${totalLines ? ` of ${totalLines.toLocaleString()}` : ''}.</p>` : ''}${binary ? clippyEmpty('Binary file', 'A text preview is not available for this file.') : `<div class="clippy-file-body">${markdown ? renderMarkdown(preview) : `<pre>${escapeHtml(preview)}</pre>`}</div>`}`;
    if (!binary && (hasMore || start > 1)) {
      target.insertAdjacentHTML('beforeend', `<div class="clippy-file-pagination"><button type="button" data-clippy-file-prev${start > 1 ? '' : ' disabled'}>← Previous lines</button><button type="button" data-clippy-file-next${hasMore ? '' : ' disabled'}>Next lines →</button></div>`);
      target.querySelector('[data-clippy-file-prev]').addEventListener('click', () => selectClippyFile(view, file, Math.max(1, start - pageSize)));
      target.querySelector('[data-clippy-file-next]').addEventListener('click', () => selectClippyFile(view, file, start + pageSize));
    }
    enhanceMarkdownContent(target, { clippySources: true, source: { repo, path } });
    wireClippyAgentButton(target.querySelector('[data-clippy-ask-file]'), `Read and explain this Clippy engagement file directly from the connected MCP.\n\nRepository: ${repo}\nPath: ${path}`);
  } catch (error) { if (clippyViewAlive(view) && target.isConnected && error.name !== 'AbortError') clippyError(target, error, () => selectClippyFile(view, file, offset)); }
}

// The connector picker presents integrations before requesting credentials.
function openSmartConnectLibrary(onSaved, { connect = false } = {}) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal smart-connect-modal" role="dialog" aria-modal="true" aria-labelledby="smart-connect-title"><header><div><h2 id="smart-connect-title">Connectors</h2><small>Bring your security knowledge into GLaDOS.</small></div><button type="button" data-smart-close aria-label="Close connectors">×</button></header><div class="app-modal-copy" data-smart-content></div></div>`;
  root.appendChild(backdrop);
  let controller = new AbortController();
  let configured = false;
  let selected = 'available';
  let busy = false;
  const close = prepareCollectionDialog(backdrop, { onClose: () => {
    controller.abort();
    const key = backdrop.querySelector('[data-smart-key]');
    if (key) key.value = '';
  } });
  backdrop.querySelector('[data-smart-close]').addEventListener('click', close);
  const target = backdrop.querySelector('[data-smart-content]');
  const request = async (method, endpoint, token) => {
    const requestController = new AbortController();
    const cancel = () => requestController.abort();
    controller.signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; requestController.abort(); }, 45000);
    try {
      const response = await fetch(endpoint, { method, signal: requestController.signal, headers: { 'Content-Type': 'application/json' }, ...(token === undefined ? {} : { body: JSON.stringify({ token }) }) });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Clippy could not connect.');
      if (!backdrop.isConnected) throw Object.assign(new Error('Dialog closed'), { name: 'AbortError' });
      return result;
    } catch (error) {
      if (timedOut) throw new Error('Clippy took too long to respond. Try again.');
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
    }
  };
  const showKey = () => {
    backdrop.querySelector('#smart-connect-title').textContent = 'Connect Clippy';
    target.innerHTML = `<button type="button" class="text-action smart-connect-back" data-smart-back>← All connectors</button><div class="smart-connect-intro"><span class="clippy-logo" aria-hidden="true">C</span><h3>Clippy MCP</h3><p>Explore findings, browse engagement repositories, and query your security knowledge with Clippy Agent.</p></div><form data-smart-form><label class="editor-field"><span>Clippy API key</span><div class="smart-connect-key"><input type="password" data-smart-key placeholder="Paste your Clippy key" autocomplete="new-password" spellcheck="false" aria-describedby="smart-connect-privacy" required /><button type="button" data-smart-reveal aria-label="Show entered key">Show</button></div></label><p id="smart-connect-privacy" class="field-note">Your key is stored on this computer and its saved value is never displayed. GLaDOS uses read-only Clippy tools.</p><p class="package-editor-status" data-smart-status role="status" aria-live="polite"></p><div class="smart-connect-form-actions"><button type="button" data-smart-cancel>Cancel</button><button type="submit" class="safe" data-smart-submit disabled>Connect Clippy</button></div></form>`;
    const key = target.querySelector('[data-smart-key]');
    const submit = target.querySelector('[data-smart-submit]');
    const status = target.querySelector('[data-smart-status]');
    target.querySelector('[data-smart-back]').addEventListener('click', () => { if (!busy) { key.value = ''; showLibrary(); } });
    target.querySelector('[data-smart-cancel]').addEventListener('click', close);
    target.querySelector('[data-smart-reveal]').addEventListener('click', event => {
      const showing = key.type === 'text';
      key.type = showing ? 'password' : 'text';
      event.target.textContent = showing ? 'Show' : 'Hide';
      event.target.setAttribute('aria-label', showing ? 'Show entered key' : 'Hide entered key');
    });
    key.addEventListener('input', () => { submit.disabled = busy || !key.value.trim(); });
    target.querySelector('[data-smart-form]').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !key.value.trim()) return;
      busy = true;
      submit.disabled = true;
      key.disabled = true;
      target.querySelector('[data-smart-back]').disabled = true;
      status.textContent = 'Checking your Clippy connection…';
      try {
        await request('POST', '/api/settings/clippy/test', key.value.trim());
        status.textContent = 'Saving your connection…';
        await request('PUT', '/api/settings/clippy', key.value.trim());
        key.value = '';
        configured = true;
        close();
        showToast('Clippy is connected. Open Tools → Clippy to browse your knowledge.', { kind: 'success', label: 'Clippy MCP' });
        try { await offerClippyAgent(); }
        catch (error) { showToast(`Clippy is connected. Optional agent setup could not finish: ${error.message}`, { kind: 'warning', label: 'Clippy Agent' }); }
        await onSaved?.();
      } catch (error) {
        if (error.name !== 'AbortError' && backdrop.isConnected) status.textContent = error.message;
      } finally {
        busy = false;
        if (backdrop.isConnected) { key.disabled = false; submit.disabled = !key.value.trim(); target.querySelector('[data-smart-back]').disabled = false; }
      }
    });
    key.focus();
  };
  const showLibrary = () => {
    backdrop.querySelector('#smart-connect-title').textContent = 'Connectors';
    target.innerHTML = `<label class="smart-connect-search"><span aria-hidden="true">⌕</span><input type="search" data-smart-search aria-label="Search connectors" placeholder="Search" /></label><div class="smart-connect-segments" role="tablist" aria-label="Connector availability"><button type="button" role="tab" data-smart-tab="available" aria-selected="${selected === 'available'}">Available</button><button type="button" role="tab" data-smart-tab="connected" aria-selected="${selected === 'connected'}">Connected</button></div><div data-smart-results></div><p class="smart-connect-footnote">Need a custom server? <button type="button" class="text-action" data-smart-advanced>Advanced MCP setup</button></p>`;
    const draw = () => {
      const query = target.querySelector('[data-smart-search]').value.toLowerCase().trim();
      const matches = !query || 'clippy mcp security findings engagement repositories'.includes(query);
      const visible = matches && (selected === 'connected' ? configured : !configured);
      const results = target.querySelector('[data-smart-results]');
      results.innerHTML = visible ? `<div class="smart-connect-row"><span class="clippy-logo" aria-hidden="true">C</span><div><strong>Clippy MCP</strong><p>Security findings & engagement intelligence</p></div><button type="button" class="text-action" data-smart-connect>${configured ? 'Manage' : 'Connect'}</button></div><span class="collection-eyebrow smart-featured-label">${configured ? 'Connected knowledge' : 'Featured'}</span><button type="button" class="smart-connect-featured" data-smart-featured><span class="clippy-logo" aria-hidden="true">C</span><strong>Clippy</strong><p>Your assessment findings and engagement repos, ready for GLaDOS.</p><span>${configured ? 'Manage connection' : 'Connect your knowledge'} →</span></button>` : `<div class="smart-connect-empty"><strong>${query ? 'No matching connectors' : selected === 'connected' ? 'No connected integrations' : 'You’re all connected'}</strong><p>${query ? 'Try searching for Clippy.' : selected === 'connected' ? 'Connect Clippy from the Available tab.' : 'Clippy is available in the Connected tab.'}</p></div>`;
      const proceed = () => { if (configured) { close(); openConnectors(); } else showKey(); };
      results.querySelector('[data-smart-connect]')?.addEventListener('click', proceed);
      results.querySelector('[data-smart-featured]')?.addEventListener('click', proceed);
    };
    target.querySelector('[data-smart-search]').addEventListener('input', draw);
    target.querySelectorAll('[data-smart-tab]').forEach(button => button.addEventListener('click', () => {
      selected = button.dataset.smartTab;
      target.querySelectorAll('[data-smart-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
      draw();
    }));
    target.querySelector('[data-smart-advanced]').addEventListener('click', () => { close(); openConnectorEditor(null, onSaved); });
    draw();
  };
  target.innerHTML = '<p class="field-note">Loading connectors…</p>';
  request('GET', '/api/settings/clippy').then(result => {
    configured = Boolean(result.configured && result.enabled !== false);
    if (connect) showKey();
    else showLibrary();
  }).catch(error => {
    if (!backdrop.isConnected) return;
    target.innerHTML = `<p class="field-note">${escapeHtml(error.message)}</p><button type="button" data-smart-continue>Continue to Clippy</button>`;
    target.querySelector('[data-smart-continue]').addEventListener('click', showKey);
  });
}

async function renderConnectorsPane() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-pane connectors-pane collection-pane';
  wrap.innerHTML = `<div class="collection-page-heading"><div><span class="collection-eyebrow">Tools</span><h1>Connectors</h1><p>Connect the tools and knowledge your agents can use.</p></div><div class="collection-page-actions"><button type="button" class="text-action" data-import-connectors>Import MCP config</button><button type="button" class="safe" data-add-connector>＋ Add connector</button></div></div><section class="settings-section"><div class="settings-section-heading"><div><h2>Your connectors</h2><p class="settings-section-copy">Manage your connections. Built-in tools are maintained by GLaDOS.</p></div></div><div class="connector-grid" data-connector-list>Loading connectors…</div></section>`;
  paneEl.appendChild(wrap);
  const reload = async () => {
    const result = await fetchJson('/api/connectors', { timeoutMs: 10000 });
    if (!wrap.isConnected) return;
    state.connectorLibrary.catalog = result;
    if (state.agentLibrary.catalog) state.agentLibrary.catalog.connectors = result.connectors;
    drawConnectorCollection(wrap, result.connectors || [], reload);
  };
  wrap.querySelector('[data-add-connector]').addEventListener('click', () => openSmartConnectLibrary(reload));
  wrap.querySelector('[data-import-connectors]').addEventListener('click', () => openConnectorConfigImport(reload));
  try { await reload(); }
  catch (error) { if (wrap.isConnected) wrap.querySelector('[data-connector-list]').innerHTML = `<div class="collection-empty"><strong>Connectors could not load</strong><p>${escapeHtml(error.message)}</p></div>`; }
}

function connectorIsBuiltIn(item) {
  return item.builtIn === true || item.source === 'builtin' || item.source === 'built-in';
}

function connectorCardMarkup(item) {
  const builtin = connectorIsBuiltIn(item);
  const clippy = item.id === 'clippy' || item.serverName === 'clippy';
  const connected = item.enabled && item.available !== false;
  const configured = Boolean(item.configured || item.hasCredentials || connected);
  const editable = item.source === 'user' || item.source === 'custom' || item.source === 'imported' || item.editable;
  const disconnected = item.disconnected || (clippy && !configured);
  const label = connected ? 'Connected' : disconnected ? 'Not connected' : item.status === 'disabled by runtime' ? 'Disabled by runtime' : item.enabled ? 'Needs setup' : 'Disabled';
  return `<article class="connector-card${clippy ? ' connector-card-clippy' : ''}"><div class="connector-card-heading"><div class="connector-card-identity">${clippy ? clippyConnectorMarkup() : '<span class="connector-card-symbol" aria-hidden="true">⌘</span>'}<div><h3>${escapeHtml(item.name || item.id)}</h3><small>${builtin ? 'Built-in' : clippy ? 'Knowledge integration' : item.source === 'downloaded' ? 'Installed' : 'Custom connection'}</small></div></div><span class="package-status${connected ? ' active' : ' muted'}">${label}</span></div><p>${escapeHtml(item.description || item.url || item.command || item.serverName || '')}</p><details><summary>Tools & requirements</summary><div class="connector-detail"><strong>Selected tools</strong><p>${escapeHtml((item.tools || []).join(', ') || 'None selected yet')}</p>${(item.knownTools || []).length ? `<strong>Advertised tools</strong><p>${escapeHtml(item.knownTools.join(', '))}</p>` : ''}${(item.requiredEnv || []).length ? `<strong>Required credentials</strong><p>${escapeHtml(item.requiredEnv.join(', '))}</p>` : ''}${(item.configuredEnv || []).length || (item.configuredHeaders || []).length ? `<strong>Saved credential names</strong><p>${escapeHtml([...(item.configuredEnv || []), ...(item.configuredHeaders || [])].join(', '))}</p>` : ''}<strong>Connector ID</strong><p><code>${escapeHtml(item.id)}</code></p></div></details><div class="connector-card-actions">${builtin ? '<span class="field-note">Managed by GLaDOS</span>' : `${clippy ? `<button type="button" data-connect-clippy>${configured ? 'Update key' : 'Connect'}</button>${connected ? '<button type="button" data-open-clippy>Open Clippy</button>' : ''}` : editable ? `<button type="button" data-edit-connector="${escapeHtml(item.id)}">Configure</button>${!item.enabled && !item.disconnected ? `<button type="button" data-enable-connector="${escapeHtml(item.id)}">Enable</button>` : ''}` : ''}${!disconnected ? `<button type="button" data-test-connector="${escapeHtml(item.id)}">Check connection</button>` : ''}<button type="button" class="text-action connector-disconnect" data-disconnect-connector="${escapeHtml(item.id)}"${disconnected ? ' disabled' : ''}>Disconnect</button>`}</div></article>`;
}

function drawConnectorCollection(wrap, connectors, reload) {
  const list = wrap.querySelector('[data-connector-list]');
  if (!list || !wrap.isConnected) return;
  const collection = [...connectors].sort((a, b) => Number(b.id === 'clippy') - Number(a.id === 'clippy'));
  list.innerHTML = collection.length ? collection.map(connectorCardMarkup).join('') : '<div class="collection-empty"><strong>Connect your knowledge</strong><p>Add Clippy to browse findings and engagement repositories.</p><button type="button" data-connect-clippy>Connect Clippy</button></div>';
  list.querySelectorAll('[data-connect-clippy]').forEach(button => button.addEventListener('click', () => openSmartConnectLibrary(reload, { connect: true })));
  list.querySelectorAll('[data-open-clippy]').forEach(button => button.addEventListener('click', openClippy));
  list.querySelectorAll('[data-edit-connector]').forEach(button => button.addEventListener('click', () => openConnectorEditor(connectors.find(item => item.id === button.dataset.editConnector), reload)));
  list.querySelectorAll('[data-enable-connector]').forEach(button => button.addEventListener('click', async () => {
    const connector = connectors.find(item => item.id === button.dataset.enableConnector);
    button.disabled = true;
    try { await packageApi('PATCH', `/api/connectors/${encodeURIComponent(connector.id)}`, { connector: { enabled: true }, expectedRevision: connector.revision }); await reload(); }
    catch (error) { showToast(error.message, { kind: 'warning', label: 'Connectors' }); if (button.isConnected) button.disabled = false; }
  }));
  list.querySelectorAll('[data-test-connector]').forEach(button => button.addEventListener('click', async () => {
    const connector = connectors.find(item => item.id === button.dataset.testConnector);
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const endpoint = connector.id === 'clippy' ? '/api/settings/clippy/test' : `/api/connectors/${encodeURIComponent(connector.id)}/test`;
      const result = await packageApi('POST', endpoint, undefined, { timeoutMs: 60000 });
      await reload();
      showToast(`Connected. ${result.toolCount || 0} tools advertised.`, { kind: 'success', label: connector.name || connector.id });
    } catch (error) { showToast(error.message, { kind: 'warning', label: connector.name || connector.id }); }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = 'Check connection'; } }
  }));
  list.querySelectorAll('[data-disconnect-connector]').forEach(button => button.addEventListener('click', async () => {
    const connector = connectors.find(item => item.id === button.dataset.disconnectConnector);
    if (connectorIsBuiltIn(connector)) return;
    if (!await confirmAction({ title: `Disconnect ${connector.name || connector.id}?`, message: 'This removes its saved credentials and stops the connection from being used in new agent turns. You can reconnect later.', confirmLabel: 'Disconnect' })) return;
    button.disabled = true;
    button.textContent = 'Disconnecting…';
    try {
      await packageApi('POST', `/api/connectors/${encodeURIComponent(connector.id)}/disconnect`, connector.id === 'clippy' ? {} : { expectedRevision: connector.revision });
      await reload();
      showToast(`${connector.name || connector.id} disconnected.`, { kind: 'success', label: 'Connectors' });
    } catch (error) { showToast(error.message, { kind: 'warning', label: 'Connectors' }); if (button.isConnected) { button.disabled = false; button.textContent = 'Disconnect'; } }
  }));
}

function connectorFormPayload(values) {
  const type = values.type === 'stdio' ? 'stdio' : values.type === 'sse' ? 'sse' : 'http';
  const connector = { id: String(values.id || '').trim(), name: String(values.name || '').trim(), type, enabled: !!values.enabled, tools: packageLineItems(values.tools) };
  if (!connector.id || !connector.name) throw new Error('Enter a connector name and ID.');
  if (type === 'stdio') {
    connector.command = String(values.command || '').trim();
    if (!connector.command) throw new Error('Enter a command for this MCP server.');
    try { connector.args = JSON.parse(values.args || '[]'); } catch { throw new Error('Arguments must be a JSON array, such as ["--port", "3000"].'); }
    if (!Array.isArray(connector.args) || connector.args.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
  } else {
    connector.url = String(values.url || '').trim();
    try { const parsed = new URL(connector.url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
  }
  for (const key of ['env', 'headers']) if (String(values[key] || '').trim()) {
    try { connector[key] = JSON.parse(values[key]); } catch { throw new Error(`${key === 'env' ? 'Environment variables' : 'Headers'} must be a JSON object.`); }
    if (!connector[key] || Array.isArray(connector[key]) || typeof connector[key] !== 'object' || Object.values(connector[key]).some(value => typeof value !== 'string')) throw new Error(`${key === 'env' ? 'Environment variables' : 'Headers'} must contain text values.`);
  }
  return connector;
}

function openConnectorEditor(existing, onSaved) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal connector-editor-modal" role="dialog" aria-modal="true" aria-labelledby="connector-editor-title"><header><div><h2 id="connector-editor-title">${existing ? 'Configure connector' : 'Add connector'}</h2><small>Connect an HTTP endpoint or a local MCP command.</small></div><button type="button" data-connector-close aria-label="Close connector editor">×</button></header><div class="app-modal-copy"><label class="connector-import-input">Import configuration <input type="file" data-connector-import accept=".json,application/json" /></label><div class="editor-field-grid"><label class="editor-field"><span>Name</span><input data-connector-field="name" value="${escapeHtml(existing?.name || '')}" /></label><label class="editor-field"><span>Connector ID</span><input data-connector-field="id" value="${escapeHtml(existing?.id || '')}"${existing ? ' readonly' : ''} spellcheck="false" /></label></div><label class="editor-field"><span>Connection</span><select data-connector-field="type"><option value="http"${!existing?.type || existing.type === 'http' ? ' selected' : ''}>HTTP MCP server</option><option value="sse"${existing?.type === 'sse' ? ' selected' : ''}>SSE MCP server</option><option value="stdio"${existing?.type === 'stdio' ? ' selected' : ''}>Local command</option></select></label><div data-connector-http><label class="editor-field"><span>Server URL</span><input data-connector-field="url" value="${escapeHtml(existing?.url || '')}" placeholder="https://server.example/mcp" spellcheck="false" /></label></div><div data-connector-stdio><label class="editor-field"><span>Command</span><input data-connector-field="command" value="${escapeHtml(existing?.command || '')}" placeholder="/path/to/mcp-server" spellcheck="false" /></label><label class="editor-field"><span>Arguments (JSON)</span><textarea data-connector-field="args" rows="2">${escapeHtml(JSON.stringify(existing?.args || []))}</textarea></label></div><details class="connector-advanced"><summary>Credentials & tools</summary><label class="editor-field"><span>Environment variables (JSON)</span><textarea data-connector-field="env" rows="3" placeholder='{"API_TOKEN": "your token"}'></textarea></label><label class="editor-field"><span>HTTP headers (JSON)</span><textarea data-connector-field="headers" rows="3" placeholder='{"Authorization": "Bearer your token"}'></textarea></label><p class="field-note">Saved credentials stay on this computer. ${existing ? 'Leave these fields blank to keep existing values.' : 'Their values are hidden after saving.'}</p><label class="editor-field"><span>Available tools</span><textarea data-connector-field="tools" rows="3" placeholder="One tool name per line">${escapeHtml((existing?.tools || []).join('\n'))}</textarea>${existing?.knownTools?.length ? `<small>Advertised: ${escapeHtml(existing.knownTools.join(', '))}</small>` : '<small>Save, then check the connection to discover tool names.</small>'}</label></details><label class="capability-choice"><input type="checkbox" data-connector-field="enabled"${existing?.enabled ? ' checked' : ''} /><span>Enable for new agent turns</span></label><p class="package-editor-status" data-connector-editor-status role="status"></p></div><footer><button type="button" data-connector-cancel>Cancel</button><button type="button" class="safe" data-connector-save>Save connector</button></footer></div>`;
  root.appendChild(backdrop);
  const close = prepareCollectionDialog(backdrop);
  backdrop.querySelector('[data-connector-close]').addEventListener('click', close);
  backdrop.querySelector('[data-connector-cancel]').addEventListener('click', close);
  const status = backdrop.querySelector('[data-connector-editor-status]');
  const type = backdrop.querySelector('[data-connector-field="type"]');
  const applyType = () => { backdrop.querySelector('[data-connector-http]').hidden = type.value === 'stdio'; backdrop.querySelector('[data-connector-stdio]').hidden = type.value !== 'stdio'; };
  type.addEventListener('change', applyType);
  applyType();
  backdrop.querySelector('[data-connector-import]').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a configuration smaller than 1 MB.');
      const parsed = JSON.parse(await file.text());
      const servers = parsed.mcpServers ? Object.entries(parsed.mcpServers) : [];
      if (servers.length > 1) throw new Error('Import one connector at a time. Choose a configuration with a single MCP server.');
      const imported = parsed.connector || (servers.length ? { ...servers[0][1], id: servers[0][0], name: servers[0][0] } : parsed);
      for (const key of ['id', 'name', 'url', 'command', 'args', 'env', 'headers', 'tools']) {
        if (key === 'id' && existing) continue;
        const field = backdrop.querySelector(`[data-connector-field="${key}"]`);
        if (imported[key] !== undefined && field) field.value = key === 'tools' ? imported[key].join('\n') : ['args', 'env', 'headers'].includes(key) ? JSON.stringify(imported[key], null, 2) : imported[key];
      }
      type.value = imported.type === 'stdio' || imported.command ? 'stdio' : imported.type === 'sse' ? 'sse' : 'http';
      applyType();
      status.textContent = 'Configuration loaded. Review it before saving.';
    } catch (error) { status.textContent = `Could not import configuration: ${error.message}`; }
  });
  backdrop.querySelector('[data-connector-save]').addEventListener('click', async event => {
    const button = event.currentTarget;
    try {
      const values = {};
      backdrop.querySelectorAll('[data-connector-field]').forEach(field => { values[field.dataset.connectorField] = field.type === 'checkbox' ? field.checked : field.value; });
      const connector = connectorFormPayload(values);
      if (existing && connector.url === existing.url) delete connector.url;
      button.disabled = true;
      status.textContent = 'Saving connector…';
      await packageApi(existing ? 'PATCH' : 'POST', existing ? `/api/connectors/${encodeURIComponent(existing.id)}` : '/api/connectors', { connector, ...(existing ? { expectedRevision: existing.revision } : {}) });
      close();
      showToast('Connector saved for new agent turns.', { kind: 'success', label: 'Connectors' });
      await onSaved?.();
    } catch (error) { status.textContent = error.message; status.classList.add('error'); button.disabled = false; }
  });
}


function prepareCollectionDialog(backdrop, { onClose } = {}) {
  const previouslyFocused = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
    backdrop.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...backdrop.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(element => !element.closest('[hidden]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  backdrop.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  queueMicrotask(() => backdrop.querySelector('input, button')?.focus());
  return close;
}

function openConnectorConfigImport(onImported) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="app-modal package-import-modal" role="dialog" aria-modal="true" aria-labelledby="connector-import-title"><header><div><h2 id="connector-import-title">Import MCP connections</h2><small>Bring a standard MCP configuration into your connector collection.</small></div><button type="button" data-config-close aria-label="Close import">×</button></header><div class="app-modal-copy"><label class="package-file-choice"><strong>MCP configuration JSON</strong><span>Choose a file containing an mcpServers collection.</span><input type="file" data-config-file accept=".json,application/json" /></label><label class="editor-field connector-json-paste"><span>Or paste a configuration</span><textarea rows="7" data-config-text spellcheck="false" placeholder='{"mcpServers": {"server-name": {"command": "server", "args": []}}}'></textarea></label><button type="button" data-config-preview>Preview connections</button><div data-config-preview-content></div><p class="package-editor-status" data-config-status role="status" aria-live="polite"></p></div><footer><button type="button" data-config-cancel>Cancel</button><button type="button" class="safe" data-config-import disabled>Import connections</button></footer></div>`;
  root.appendChild(backdrop);
  const close = prepareCollectionDialog(backdrop);
  backdrop.querySelector('[data-config-close]').addEventListener('click', close);
  backdrop.querySelector('[data-config-cancel]').addEventListener('click', close);
  const field = backdrop.querySelector('[data-config-text]');
  const status = backdrop.querySelector('[data-config-status]');
  const previewButton = backdrop.querySelector('[data-config-preview]');
  const importButton = backdrop.querySelector('[data-config-import]');
  const target = backdrop.querySelector('[data-config-preview-content]');
  let config = null;
  let generation = 0;
  const invalidate = () => { generation++; config = null; importButton.disabled = true; target.innerHTML = ''; };
  field.addEventListener('input', invalidate);
  const preview = async () => {
    const requestGeneration = ++generation;
    previewButton.disabled = true;
    importButton.disabled = true;
    status.textContent = 'Checking connection configuration…';
    status.classList.remove('error');
    try {
      const input = JSON.parse(field.value);
      const result = await packageApi('POST', '/api/connectors/import/preview', { config: input });
      if (!backdrop.isConnected || requestGeneration !== generation) return;
      config = input;
      const details = result.preview || result;
      target.innerHTML = `<div class="package-import-preview"><h3>${details.connectors?.length || 0} connection${details.connectors?.length === 1 ? '' : 's'}</h3>${(details.connectors || []).map(connector => `<div class="connector-import-row"><strong>${escapeHtml(connector.name || connector.id)}</strong><span>${escapeHtml(connector.type === 'stdio' ? 'Local MCP command' : connector.type === 'sse' ? 'SSE MCP endpoint' : 'HTTP MCP endpoint')}</span><code>${escapeHtml(connector.command || connector.url || '')}</code></div>`).join('')}${(details.conflicts || []).length ? `<div class="import-review-notes"><p>${details.conflicts.length} connector${details.conflicts.length === 1 ? '' : 's'} already exist. The import will not replace their saved configurations.</p></div>` : ''}</div>`;
      status.textContent = 'Connections import as disabled. Review credentials and tools, then enable each connection when ready.';
      importButton.disabled = !details.connectors?.length || !!details.conflicts?.length;
    } catch (error) { if (requestGeneration === generation) { status.textContent = `Could not preview configuration: ${error.message}`; status.classList.add('error'); } }
    finally { previewButton.disabled = false; }
  };
  backdrop.querySelector('[data-config-file]').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    invalidate();
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a configuration smaller than 5 MB.');
      field.value = await file.text();
      await preview();
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  });
  previewButton.addEventListener('click', preview);
  importButton.addEventListener('click', async () => {
    if (!config) return;
    importButton.disabled = true;
    status.textContent = 'Importing connections…';
    try {
      const result = await packageApi('POST', '/api/connectors/import', { config });
      close();
      showToast(`Imported ${result.connectors?.length || 0} connection${result.connectors?.length === 1 ? '' : 's'}. Review and enable them when ready.`, { kind: 'success', label: 'Connectors' });
      await onImported?.();
    } catch (error) { status.textContent = error.message; status.classList.add('error'); importButton.disabled = false; }
  });
}

// --- Slash command menu ---

let slashCommands = [];
fetch('/api/slash-commands').then(r => r.json()).then(j => { slashCommands = j.commands || []; });

function attachSlashMenu(textarea, container, onRun) {
  let menu = null;
  let activeIdx = 0;
  let filtered = [];

  const close = () => { if (menu) menu.remove(); menu = null; filtered = []; };

  const render = () => {
    if (!menu) return;
    menu.innerHTML = filtered.map((c, i) =>
      `<div class="item${i === activeIdx ? ' active' : ''}" data-idx="${i}"><code>${escapeHtml(c.cmd)}</code><span class="desc">${escapeHtml(c.desc)}</span></div>`
    ).join('');
    menu.querySelectorAll('.item').forEach(el => {
      el.addEventListener('mouseenter', () => { activeIdx = Number(el.dataset.idx); render(); });
      el.addEventListener('click', () => accept());
    });
  };

  const accept = () => {
    const c = filtered[activeIdx];
    if (!c) return;
    // If the command takes an argument, keep the cursor after the command so
    // the operator can type the arg; otherwise run immediately.
    const base = c.cmd.split(' ')[0];
    if (c.cmd.includes('<')) {
      textarea.value = base + ' ';
      close();
      textarea.focus();
    } else {
      textarea.value = '';
      close();
      onRun(base);
    }
  };

  textarea.addEventListener('input', () => {
    const v = textarea.value;
    if (!v.startsWith('/')) { close(); return; }
    const q = v.slice(1).toLowerCase();
    filtered = slashCommands.filter(c => c.cmd.slice(1).toLowerCase().startsWith(q));
    if (!filtered.length) { close(); return; }
    activeIdx = 0;
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'slash-menu';
      container.appendChild(menu);
    }
    render();
  });

  textarea.addEventListener('keydown', ev => {
    if (!menu) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); activeIdx = Math.min(filtered.length - 1, activeIdx + 1); render(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); render(); }
    else if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); accept(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === 'Tab') { ev.preventDefault(); accept(); }
  });

  textarea.addEventListener('blur', () => setTimeout(close, 150));
}

async function runSlashCommand(raw, rec) {
  const chooser = raw.trim().match(/^\/security-review(?:\s+(--full))?$/i);
  if (chooser) {
    try {
      let selected = null;
      if (window.gladosDesktop?.chooseSecurityReviewDirectory) {
        const result = await window.gladosDesktop.chooseSecurityReviewDirectory({ full: !!chooser[1] });
        if (result?.canceled) return;
        selected = result?.path;
      } else {
        selected = await showNameInput({
          title: chooser[1] ? 'Full security review' : 'Expedited security review',
          confirmLabel: 'Start review', label: 'Repository folder', placeholder: '/path/to/repository',
        });
      }
      if (!selected) return;
      const quoted = String(selected).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      raw = `/security-review${chooser[1] ? ' --full' : ''} "${quoted}"`;
    } catch (error) {
      pushNotification('error', error.message, { toast: true, label: 'Security review' });
      return;
    }
  }
  const [cmd] = raw.trim().split(/\s+/);
  if (cmd === '/clear') {
    rec.events.length = 0;
    if (rec.el) rec.el.innerHTML = '';
    return;
  }

  const renderReturnedEvent = ev => {
    if (!ev) return;
    const inserted = insertTranscriptEvent(rec, ev);
    if (!inserted.added) {
      if (rec.el && rec.el.isConnected && inserted.index >= 0) renderTranscriptEvents(rec);
      return;
    }
    if (rec.el && rec.el.isConnected) {
      if (inserted.outOfOrder) renderTranscriptEvents(rec);
      else appendEntry(rec.el, ev, rec);
    }
  };

  try {
    const r = await fetch('/api/slash/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: raw, session_id: state.currentSessionId }),
    });
    const j = await r.json();
    if (j.action?.type === 'clear-local-transcript') {
      rec.events.length = 0;
      if (rec.el) rec.el.innerHTML = '';
      return;
    }
    for (const ev of j.events || []) renderReturnedEvent(ev);
    if (/^\/security-review\b/i.test(raw)) loadSecurityReviews();
    if (!r.ok && !(j.events || []).length) {
      renderReturnedEvent({ kind: 'assistant-text', text: 'error: ' + (j.error || r.statusText), ts: Date.now(), _optimistic: true });
    }
  } catch (e) {
    renderReturnedEvent({ kind: 'assistant-text', text: 'error: ' + e.message, ts: Date.now(), _optimistic: true });
  }
}

setInterval(loadAgents, 15000);
setInterval(loadSecurityReviews, 5000);
setInterval(updateSecurityReviewTimes, 1000);
setInterval(refreshVisibleChatTurnStatuses, 2500);

// v4 — Plan-approval workflow. Pending-plan badge + Plans pane.
const plansState = { list: [], selected: null, proposals: [] };

function clearPlanClientState() {
  plansState.list = [];
  plansState.selected = null;
  plansState.proposals = [];
  const badge = document.getElementById('plans-badge');
  if (badge) {
    badge.textContent = '0';
    badge.classList.add('hidden');
  }
}

async function refreshPlansBadge() {
  const badge = document.getElementById('plans-badge');
  if (!badge || !state.currentSessionId) return;
  try {
    const [plansRes, replanRes] = await Promise.all([
      fetch(withSession('/api/plans?state=pending_approval')),
      fetch(withSession('/api/replan-proposals')).catch(() => null),
    ]);
    if (!plansRes.ok) return;
    const { plans } = await plansRes.json();
    let proposals = [];
    if (replanRes && replanRes.ok) {
      try { proposals = (await replanRes.json()).proposals || []; } catch {}
    }
    const count = plans.length + proposals.length;
    if (count > 0) {
      badge.textContent = String(count);
      badge.title = `${plans.length} plan(s) pending approval, ${proposals.length} replan proposal(s)`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {}
}
setInterval(refreshPlansBadge, 5000);
refreshPlansBadge();

async function renderPlansPane() {
  if (!state.currentSessionId) {
    paneEl.innerHTML = '<div class="pane-empty">Open a conversation to review its plans.</div>';
    return;
  }
  paneEl.innerHTML = `
    <div class="plans-pane">
      <div class="plans-list">
        <div class="plans-list-head">
          <h3>Plans</h3>
          <select id="plans-filter">
            <option value="">All states</option>
            <option value="pending_approval" selected>Pending approval</option>
            <option value="approved">Approved</option>
            <option value="executing">Executing</option>
            <option value="complete">Complete</option>
            <option value="rejected">Rejected</option>
            <option value="superseded">Superseded</option>
          </select>
        </div>
        <div class="replan-panel" id="replan-panel">
          <div class="replan-panel-head">
            <span>Replan proposals</span>
            <button id="replan-refresh" type="button" title="Refresh replan proposals">Refresh</button>
          </div>
          <div id="replan-proposals" class="replan-proposals">
            <div class="empty">Loading proposals…</div>
          </div>
        </div>
        <ul id="plans-list-items"></ul>
      </div>
      <div class="plans-detail" id="plans-detail">
        <div class="pane-empty">Select a plan to review.</div>
      </div>
    </div>`;

  const filter = document.getElementById('plans-filter');
  filter.addEventListener('change', loadPlansList);
  document.getElementById('replan-refresh')?.addEventListener('click', loadReplanProposals);
  await Promise.all([loadPlansList(), loadReplanProposals()]);
}

async function loadReplanProposals() {
  const box = document.getElementById('replan-proposals');
  if (!box) return;
  try {
    const { proposals } = await fetchJson(withSession('/api/replan-proposals'), { timeoutMs: 20000, retries: 1 });
    plansState.proposals = proposals || [];
    renderReplanProposals(box, plansState.proposals);
  } catch (e) {
    box.innerHTML = `<div class="empty error">Could not load replan proposals: ${escapeHtml(e.message)}</div>`;
  }
}

function renderReplanProposals(box, proposals) {
  if (!proposals.length) {
    box.innerHTML = '<div class="empty">No open replan proposals.</div>';
    return;
  }
  box.innerHTML = proposals.map(p => {
    const vectors = Array.isArray(p.enables_vectors) ? p.enables_vectors : [];
    return `
      <div class="replan-card" data-proposal-id="${escapeHtml(p.id)}">
        <div class="replan-card-head">
          <span class="replan-title">Finding #${escapeHtml(p.finding_id)} ${p.cwe_id ? '· ' + escapeHtml(p.cwe_id) : ''}</span>
          <span class="replan-confidence">conf ${(Number(p.confidence_score) || 0).toFixed(2)}</span>
        </div>
        <div class="replan-meta">
          <span>${escapeHtml(p.engagement_id || '')}</span>
          ${p.current_plan_id ? `<span>current ${escapeHtml(p.current_plan_id)}</span>` : '<span>no approved plan</span>'}
        </div>
        <div class="replan-vectors">${vectors.length ? vectors.map(v => `<span>${escapeHtml(v)}</span>`).join('') : '<span>no vectors</span>'}</div>
        <div class="replan-actions">
          <button type="button" data-replan-action="accepted">Approve replan</button>
          <button type="button" data-replan-action="dismissed">Dismiss</button>
        </div>
      </div>`;
  }).join('');
  box.querySelectorAll('[data-replan-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.replan-card');
      resolveReplanProposal(card?.dataset.proposalId, btn.dataset.replanAction);
    });
  });
}

async function resolveReplanProposal(id, state) {
  if (!id) return;
  const verb = state === 'accepted' ? 'approve' : 'dismiss';
  if (!await confirmAction({ title: `${verb[0].toUpperCase() + verb.slice(1)} replan`, message: `${verb[0].toUpperCase() + verb.slice(1)} replan proposal #${id}?`, confirmLabel: verb[0].toUpperCase() + verb.slice(1), danger: state !== 'accepted' })) return;
  const r = await fetch(withSession(`/api/replan-proposals/${encodeURIComponent(id)}/resolve`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, resolved_by: 'operator' }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    pushNotification('error', `Replan ${verb} failed: ${err.error || r.status}`, { toast: true, label: 'Plans' });
    return;
  }
  logEvent(state === 'accepted' ? 'ok' : 'ended', `replan proposal #${id} -> ${state}`);
  await loadReplanProposals();
  refreshPlansBadge();
}

async function loadPlansList() {
  const filter = document.getElementById('plans-filter');
  const state_ = filter ? filter.value : 'pending_approval';
  const q = state_ ? `?state=${encodeURIComponent(state_)}` : '';
  const { plans } = await fetchJson(withSession('/api/plans' + q), { timeoutMs: 20000, retries: 1 });
  plansState.list = plans;
  const ul = document.getElementById('plans-list-items');
  if (!ul) return;
  ul.innerHTML = '';
  if (!plans.length) { ul.innerHTML = '<li class="empty">No plans in this state.</li>'; return; }
  for (const p of plans) {
    const li = document.createElement('li');
    li.className = 'plan-item plan-state-' + p.state;
    li.innerHTML = `
      <div class="plan-item-top">
        <span class="plan-id">${escapeHtml(p.id)}</span>
        <span class="plan-state">${escapeHtml(p.state)}</span>
      </div>
      <div class="plan-item-bot">
        <span>${escapeHtml(p.engagement_id)}</span>
        <span>v${p.version}</span>
        <span>${new Date(p.created_at + 'Z').toLocaleString()}</span>
      </div>`;
    li.addEventListener('click', () => selectPlan(p.id));
    ul.appendChild(li);
  }
}

async function selectPlan(id) {
  plansState.selected = id;
  const detail = document.getElementById('plans-detail');
  detail.innerHTML = '<div class="pane-empty">Loading…</div>';
  const r = await fetch(withSession('/api/plans/' + encodeURIComponent(id)));
  if (!r.ok) { detail.innerHTML = '<div class="pane-empty">Not found.</div>'; return; }
  const { plan, approvals } = await r.json();
  let planJson;
  try { planJson = JSON.parse(plan.plan_json); } catch { planJson = {}; }

  const canAct = plan.state === 'pending_approval';
  const vectorsHtml = (planJson.proposed_vectors || []).map(v => `
    <label class="vector-card risk-${escapeHtml(v.risk_to_target)}">
      <input type="checkbox" class="vector-check" data-cwe="${escapeHtml(v.cwe)}" ${canAct ? 'checked' : 'disabled'} />
      <div class="vector-head">
        <span class="vector-cwe">${escapeHtml(v.cwe)}</span>
        <span class="vector-name">${escapeHtml(v.name || '')}</span>
        <span class="vector-conf">conf ${(v.confidence_pre ?? 0).toFixed(2)}</span>
        <span class="vector-risk">risk ${escapeHtml(v.risk_to_target)}</span>
        <span class="vector-dur">${v.est_duration_min || '?'}m</span>
      </div>
      <div class="vector-rationale">${escapeHtml(v.rationale || '')}</div>
      <div class="vector-agents">agents: ${(v.agents || []).map(escapeHtml).join(', ')}</div>
    </label>`).join('');

  detail.innerHTML = `
    <div class="plan-detail-head">
      <h3>${escapeHtml(plan.id)} <small>v${plan.version} · ${escapeHtml(plan.state)}</small></h3>
      <div class="plan-meta">
        <span>engagement: ${escapeHtml(plan.engagement_id)}</span>
        ${plan.parent_plan_id ? `<span>replan of: ${escapeHtml(plan.parent_plan_id)}</span>` : ''}
        ${plan.replan_reason ? `<span class="plan-replan-reason">${escapeHtml(plan.replan_reason)}</span>` : ''}
      </div>
    </div>
    <div class="plan-section">
      <h4>Proposed vectors</h4>
      <div class="vector-list">${vectorsHtml || '<div class="pane-empty">No vectors.</div>'}</div>
    </div>
    <div class="plan-section">
      <h4>Agent chain</h4>
      <div class="agent-chain">${(planJson.agent_chain || []).map(a => `<span class="chain-pill">${escapeHtml(a)}</span>`).join(' → ')}</div>
    </div>
    ${planJson.notes ? `<div class="plan-section"><h4>Notes</h4><div>${escapeHtml(planJson.notes)}</div></div>` : ''}
    <div class="plan-section">
      <h4>Recon summary</h4>
      <pre class="plan-recon">${escapeHtml(JSON.stringify(planJson.recon_summary || {}, null, 2))}</pre>
    </div>
    ${canAct ? `
      <div class="plan-actions">
        <button id="plan-approve-all" class="primary">Approve all</button>
        <button id="plan-approve-selected">Approve selected</button>
        <button id="plan-modify">Request changes</button>
        <button id="plan-end" class="danger">End investigation</button>
      </div>
      <div class="plan-modify-row hidden" id="plan-modify-row">
        <textarea id="plan-modify-request" placeholder="Describe the exact changes. GLaDOS will send them to plan-synthesizer and return a new plan for approval."></textarea>
        <button id="plan-modify-confirm">Send changes to GLaDOS</button>
      </div>
    ` : ''}
    <div class="plan-section">
      <h4>Approval history</h4>
      <ul class="approval-log">
        ${approvals.length ? approvals.map(a => `
          <li><b>${escapeHtml(a.decision)}</b> by ${escapeHtml(a.operator)} ·
            ${new Date(a.created_at + 'Z').toLocaleString()}
            ${a.reason ? ' · ' + escapeHtml(a.reason) : ''}</li>`).join('')
          : '<li class="empty">No decisions yet.</li>'}
      </ul>
    </div>`;

  if (canAct) {
    document.getElementById('plan-approve-all').addEventListener('click', () => decidePlan(id, 'approve', {}));
    document.getElementById('plan-approve-selected').addEventListener('click', () => {
      const checked = [...detail.querySelectorAll('.vector-check:checked')].map(c => c.dataset.cwe);
      if (!checked.length) { showToast('Select at least one vector.', { kind: 'warning', label: 'Plan approval' }); return; }
      decidePlan(id, 'approve', { vectors: checked });
    });
    document.getElementById('plan-modify').addEventListener('click', () => {
      document.getElementById('plan-modify-row').classList.remove('hidden');
      document.getElementById('plan-modify-request').focus();
    });
    document.getElementById('plan-modify-confirm').addEventListener('click', () => {
      const changes = document.getElementById('plan-modify-request').value.trim();
      if (!changes) {
        showToast('Describe the requested plan changes first.', { kind: 'warning', label: 'Plan review' });
        return;
      }
      requestPlanChanges(id, changes);
    });
    document.getElementById('plan-end').addEventListener('click', () => endPlanInvestigation(id));
  }
}

async function requestPlanChanges(id, changes) {
  const message = [
    `Operator plan decision for ${id}: REQUEST CHANGES.`,
    'Do not execute or directly mutate the current plan.',
    `Dispatch plan-synthesizer with parent_plan_id=${id} and preserve these operator_modifications verbatim:`,
    changes,
    'Create a replacement plan in pending_approval and return it for operator review.',
  ].join('\n');
  const r = await fetch('/api/chat/glados', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, session_id: state.currentSessionId }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    pushNotification('error', `plan change request failed: ${body.error || r.status}`, { toast: true, label: 'Plans' });
    return;
  }
  showToast('Changes sent to GLaDOS. The replacement plan will require approval.', { kind: 'success', label: 'Plans' });
  await loadPlansList();
  refreshPlansBadge();
}

async function endPlanInvestigation(id) {
  const confirmed = await confirmAction({
    title: 'End investigation',
    message: 'End this investigation, cancel remaining tracked work, and do not start report generation?',
    confirmLabel: 'End investigation',
    danger: true,
  });
  if (!confirmed) return;
  const r = await fetch(withSession(`/api/plans/${encodeURIComponent(id)}/end`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'operator ended investigation from Plans tab' }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    pushNotification('error', `end investigation failed: ${body.error || r.status}`, { toast: true, label: 'Plans' });
    return;
  }
  showToast('Investigation ended. Report generation was not started.', { kind: 'success', label: 'Plans' });
  await loadPlansList();
  await selectPlan(id);
  refreshPlansBadge();
}

async function decidePlan(id, action, body) {
  const r = await fetch(withSession(`/api/plans/${encodeURIComponent(id)}/${action}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    pushNotification('error', `${action} failed: ${err.error || r.status}`, { toast: true, label: 'Plans' });
    return;
  }
  const result = await r.json().catch(() => ({}));
  if (action === 'approve') {
    if (result.execution_queued) {
      showToast('Plan approved. GLaDOS automatically queued the next phase.', { kind: 'success', label: 'Plans' });
    } else {
      pushNotification('error', `Plan was approved but automatic execution was not queued${result.execution_error ? `: ${result.execution_error}` : '.'}`, { toast: true, label: 'Plans' });
    }
  }
  await loadPlansList();
  await selectPlan(id);
  refreshPlansBadge();
}

// (escapeHtml defined earlier in this file)

document.getElementById('open-glados').addEventListener('click', ev => { ev.preventDefault(); openGladosChat(); });
document.getElementById('new-session').addEventListener('click', () => createInvestigationSession().catch(error => pushNotification('error', error.message, { toast: true, label: 'New session' })));
document.getElementById('open-plans').addEventListener('click', ev => { ev.preventDefault(); openPlans(); });
document.getElementById('open-reports').addEventListener('click', ev => { ev.preventDefault(); openReports(); });
document.getElementById('open-settings').addEventListener('click', ev => { ev.preventDefault(); openSettings(); });
document.getElementById('open-terminal').addEventListener('click', ev => { ev.preventDefault(); openTerminal(); });
document.getElementById('open-agent-library').addEventListener('click', ev => { ev.preventDefault(); openAgentsLibrary(); });
document.getElementById('open-clippy').addEventListener('click', ev => { ev.preventDefault(); openClippy(); });
document.getElementById('open-connectors').addEventListener('click', ev => { ev.preventDefault(); openConnectors(); });
document.getElementById('open-proxy').addEventListener('click', ev => { ev.preventDefault(); openProxy(); });
// Live-events footer: Clear wipes the on-screen feed (server keeps its own log).
document.getElementById('events-clear').addEventListener('click', () => {
  eventsEl.innerHTML = '';
});

document.getElementById('agent-search')?.addEventListener('input', event => {
  state.agentQuery = event.target.value;
  try { localStorage.setItem('glados-dash.agent-query', state.agentQuery); } catch {}
  renderAgentList();
});
document.getElementById('agent-search').value = state.agentQuery;
document.querySelectorAll('[data-agent-filter]').forEach(button => {
  button.classList.toggle('active', button.dataset.agentFilter === state.agentFilter);
  button.addEventListener('click', () => {
    state.agentFilter = button.dataset.agentFilter;
    try { localStorage.setItem('glados-dash.agent-filter', state.agentFilter); } catch {}
    document.querySelectorAll('[data-agent-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderAgentList();
  });
});

document.getElementById('notifications-toggle')?.addEventListener('click', () => {
  openNotificationDrawer(notificationDrawerEl?.getAttribute('aria-hidden') !== 'false');
});
document.getElementById('notifications-close')?.addEventListener('click', () => openNotificationDrawer(false));
document.getElementById('notifications-clear')?.addEventListener('click', () => {
  state.notifications = [];
  state.unreadNotifications = 0;
  persistNotifications();
  renderNotifications();
});

const commandPaletteEl = document.getElementById('command-palette');
const commandQueryEl = document.getElementById('command-query');
const commandResultsEl = document.getElementById('command-results');
let commandChoices = [];
let commandSelectedIndex = 0;
let commandReturnFocus = null;

function closeCommandPalette() {
  commandPaletteEl.classList.add('hidden');
  commandPaletteEl.setAttribute('aria-hidden', 'true');
  commandPaletteEl.inert = true;
  if (commandReturnFocus?.isConnected) commandReturnFocus.focus();
  else document.getElementById('sidebar-toggle')?.focus();
}

function commandItems() {
  return [
    { kind: 'chat', id: 'glados-chat', label: 'Chat', note: 'Current session' },
    ...state.investigationSessions.map(session => ({
      kind: 'session', id: session.id, label: session.name || session.id,
      note: session.id === state.currentSessionId ? 'Current session' : 'Session',
    })),
    ...state.agents.filter(agent => agent.id !== activeCoordinatorId()).map(agent => ({
      kind: 'agent', id: agent.id, label: agentDisplayName(agent),
      note: agentActivityView(agent.id).status || 'Agent',
    })),
  ];
}

function renderCommandResults() {
  const query = commandQueryEl.value.trim().toLocaleLowerCase();
  commandChoices = commandItems().filter(item => `${item.label} ${item.note} ${item.id}`.toLocaleLowerCase().includes(query)).slice(0, 35);
  commandSelectedIndex = Math.min(commandSelectedIndex, Math.max(0, commandChoices.length - 1));
  commandResultsEl.replaceChildren();
  if (!commandChoices.length) {
    const empty = document.createElement('p');
    empty.className = 'command-empty';
    empty.textContent = 'No matching sessions or agents';
    commandResultsEl.appendChild(empty);
    return;
  }
  commandChoices.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `command-result${index === commandSelectedIndex ? ' selected' : ''}`;
    button.setAttribute('role', 'option');
    if (item.kind === 'agent') button.title = item.id;
    button.setAttribute('aria-selected', String(index === commandSelectedIndex));
    const name = document.createElement('strong');
    name.textContent = item.label;
    const note = document.createElement('small');
    note.textContent = item.note;
    button.append(name, note);
    button.addEventListener('click', () => selectCommandItem(item));
    commandResultsEl.appendChild(button);
  });
}

async function selectCommandItem(item) {
  closeCommandPalette();
  try {
    if (item.kind === 'session') {
      await activateInvestigationSession(item.id);
      openGladosChat();
    } else if (item.kind === 'agent') openAgentTab(item.id);
    else openGladosChat();
  } catch (error) {
    pushNotification('error', `Could not open ${item.label}: ${error.message}`, { toast: true });
  }
}

function openCommandPalette() {
  commandReturnFocus = document.activeElement;
  commandQueryEl.value = '';
  commandSelectedIndex = 0;
  commandPaletteEl.classList.remove('hidden');
  commandPaletteEl.setAttribute('aria-hidden', 'false');
  commandPaletteEl.inert = false;
  renderCommandResults();
  commandQueryEl.focus();
}

document.getElementById('command-close')?.addEventListener('click', closeCommandPalette);
commandPaletteEl.addEventListener('click', event => { if (event.target === commandPaletteEl) closeCommandPalette(); });
commandQueryEl.addEventListener('input', () => { commandSelectedIndex = 0; renderCommandResults(); });
commandQueryEl.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (commandChoices.length) commandSelectedIndex = (commandSelectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandChoices.length) % commandChoices.length;
    renderCommandResults();
    commandResultsEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (commandChoices[commandSelectedIndex]) selectCommandItem(commandChoices[commandSelectedIndex]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeCommandPalette();
  }
});

document.addEventListener('keydown', event => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && !event.altKey && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    commandPaletteEl.classList.contains('hidden') ? openCommandPalette() : closeCommandPalette();
    return;
  }
  if (!commandPaletteEl.classList.contains('hidden')) return;
  const chat = paneEl.querySelector('.chat-visual-chamber');
  if (modifier && chat && !event.altKey) {
    if (event.code === 'Equal' || event.key === '+' || event.key === '=') {
      event.preventDefault();
      setChatTextScale(state.chatTextScale + 0.1);
    } else if (event.code === 'Minus' || event.key === '-') {
      event.preventDefault();
      setChatTextScale(state.chatTextScale - 0.1);
    } else if (event.code === 'Digit0' || event.key === '0') {
      event.preventDefault();
      setChatTextScale(1);
    } else if (event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      openChatFind(chat);
    }
  }
  if (event.key === 'Escape') {
    if (!commandPaletteEl.classList.contains('hidden')) closeCommandPalette();
    else if (chat && !chat.querySelector('.chat-find-bar')?.hidden) closeChatFind(chat);
  }
});

document.addEventListener('pointerdown', event => {
  document.querySelectorAll('.overview-session-menu[open], .sidebar-session-menu[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.overview-session-menu[open], .sidebar-session-menu[open]').forEach(menu => { menu.open = false; });
});
window.addEventListener('resize', queueSidebarSessionMenuPosition);
document.addEventListener('scroll', queueSidebarSessionMenuPosition, true);

function applyPersistentLayout() {
  const root = document.documentElement;
  const sidebarWidth = Math.max(190, Math.min(420, Number(localStorage.getItem('glados-dash.sidebar-width')) || 248));
  const eventsHeight = Math.max(34, Math.min(260, Number(localStorage.getItem('glados-dash.events-height')) || 96));
  const savedSidebarState = localStorage.getItem('glados-dash.sidebar-collapsed');
  const sidebarCollapsed = savedSidebarState === '1' || (savedSidebarState === null && window.innerWidth <= 760);
  const eventsCollapsed = localStorage.getItem('glados-dash.events-collapsed') !== '0';
  root.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  root.style.setProperty('--events-height', `${eventsHeight}px`);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  document.body.classList.toggle('events-collapsed', eventsCollapsed);
  document.getElementById('events-collapse').textContent = eventsCollapsed ? 'Expand' : 'Collapse';
  document.getElementById('events-collapse').title = eventsCollapsed ? 'Expand live events' : 'Collapse live events';
  document.getElementById('events-collapse').setAttribute('aria-expanded', String(!eventsCollapsed));
}

function wirePersistentLayout() {
  applyPersistentLayout();
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('glados-dash.sidebar-collapsed', collapsed ? '1' : '0');
  });
  document.getElementById('events-collapse')?.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('events-collapsed');
    document.body.classList.toggle('events-collapsed', collapsed);
    document.getElementById('events-collapse').textContent = collapsed ? 'Expand' : 'Collapse';
    document.getElementById('events-collapse').title = collapsed ? 'Expand live events' : 'Collapse live events';
    document.getElementById('events-collapse').setAttribute('aria-expanded', String(!collapsed));
    localStorage.setItem('glados-dash.events-collapsed', collapsed ? '1' : '0');
  });

  const bindDrag = (splitter, onMove) => {
    let dragging = false;
    splitter?.addEventListener('pointerdown', event => {
      dragging = true;
      splitter.setPointerCapture?.(event.pointerId);
      document.body.classList.add('layout-resizing');
    });
    splitter?.addEventListener('pointermove', event => { if (dragging) onMove(event); });
    splitter?.addEventListener('pointerup', event => {
      dragging = false;
      splitter.releasePointerCapture?.(event.pointerId);
      document.body.classList.remove('layout-resizing');
    });
  };
  bindDrag(document.getElementById('sidebar-splitter'), event => {
    if (document.body.classList.contains('sidebar-collapsed')) return;
    const width = Math.max(190, Math.min(420, event.clientX));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    localStorage.setItem('glados-dash.sidebar-width', String(width));
  });
  bindDrag(document.getElementById('events-splitter'), event => {
    if (document.body.classList.contains('events-collapsed')) return;
    const height = Math.max(50, Math.min(260, window.innerHeight - event.clientY));
    document.documentElement.style.setProperty('--events-height', `${height}px`);
    localStorage.setItem('glados-dash.events-height', String(height));
  });
}

// Sidebar sections: each heading is an independent collapse/expand toggle.
// State per section persists in localStorage so choices survive reload.
(() => {
  const sections = [
    { headingId: 'agents-heading',     bodyId: 'agents-section' },
    { headingId: 'sessions-heading',   bodyId: 'sessions-section' },
    { headingId: 'projects-heading',   bodyId: 'projects-section' },
    { headingId: 'workspace-heading',  bodyId: 'workspace-links' },
  ];
  for (const { headingId, bodyId } of sections) {
    const heading = document.getElementById(headingId);
    const body = document.getElementById(bodyId);
    if (!heading || !body) continue;
    const chevron = heading.querySelector('.collapsible-chevron');
    const KEY = `glados-dash.section-collapsed.${headingId}`;
    const apply = collapsed => {
      body.style.display = collapsed ? 'none' : '';
      if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
      heading.classList.toggle('collapsed', collapsed);
    };
    const savedCollapsed = localStorage.getItem(KEY);
    apply(savedCollapsed === '1' || (savedCollapsed === null && headingId === 'agents-heading'));
    heading.addEventListener('click', () => {
      const next = !heading.classList.contains('collapsed');
      localStorage.setItem(KEY, next ? '1' : '0');
      apply(next);
    });
  }
})();

Promise.all([loadInvestigationSessions(), loadOperatorProfile().catch(() => state.operatorProfile), loadAgentTeams().catch(() => state.teamCatalog), loadDefaultTeamPreference().catch(() => state.defaultTeamPreference)])
  .then(() => {
    if (!state.currentSessionId) state.currentTeamId = state.defaultTeamPreference.effectiveTeamId || 'glados';
    return Promise.all([loadAgents(), loadSecurityReviews()]);
  }).then(() => {
  const allowedStatic = new Set(['glados-chat', 'plans', 'reports', 'sessions', 'settings', 'terminal', 'agent-library', 'clippy', 'connectors', 'update']);
  const agentIds = new Set(state.agents.map(agent => agent.id).filter(id => id !== 'glados'));
  const savedTabs = storageGetJson('glados-dash.open-tabs', []);
  state.openTabs = Array.isArray(savedTabs)
    ? savedTabs.filter(tab => tab && (allowedStatic.has(tab.id) || agentIds.has(tab.id) || (tab.kind === 'proxy' && tab.sessionId && tab.id === `proxy:${tab.sessionId}` && state.investigationSessions.some(session => session.id === tab.sessionId))))
    : [];
  state.openTabs = [{ id: 'glados-chat', kind: 'chat', label: 'Chat' }, ...state.openTabs.filter(tab => tab.id !== 'glados-chat')];
  state.currentTab = 'glados-chat';
  renderTabs();
  renderAgentList();
  updateWorkspaceNav();
  renderPane();
  subscribeLobby();
  setupHealthBanner();
});

wirePersistentLayout();
setInterval(updateAgentActivityTimes, 10_000);
renderNotifications();
setupDesktopUpdateNotifications();
