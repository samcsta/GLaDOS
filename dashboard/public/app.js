const ALERT_KINDS = new Set(['error', 'failed', 'offline', 'denied']);
const DASHBOARD_THEME_KEY = 'glados-dash.theme';
const DASHBOARD_THEMES = new Set(['quantum', 'classic']);

function savedDashboardTheme() {
  try {
    const saved = localStorage.getItem(DASHBOARD_THEME_KEY);
    return DASHBOARD_THEMES.has(saved) ? saved : 'quantum';
  } catch { return 'quantum'; }
}

const state = {
  agents: [],          // from /api/agents
  active: new Map(),   // agentId -> { sessionId }
  openTabs: [],        // [{ id: 'glados-chat' | agentId, kind: 'chat'|'agent', label }]
  currentTab: null,
  transcripts: new Map(), // tabId -> { es, el, events[], sending }
  agentsLoadedOnce: false,
  update: { lines: [], running: false, es: null, autoStart: false },
  reports: { query: '', scope: 'all', selectedPath: null },
  investigationSessions: [],
  currentSessionId: null,
  sessionGeneration: 0,
  overview: null,
  securityReviews: [],
  agentFilter: (() => { try { return localStorage.getItem('glados-dash.agent-filter') || 'all'; } catch { return 'all'; } })(),
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
  return `session_id=${encodeURIComponent(state.currentSessionId || 'legacy')}`;
}

function withSession(url) {
  return `${url}${url.includes('?') ? '&' : '?'}${sessionQuery()}`;
}

function closeSessionStreams() {
  state.sessionGeneration++;
  try { state._lobbySource?.close(); } catch {}
  state._lobbySource = null;
  for (const rec of state.transcripts.values()) {
    try { rec.es?.close(); } catch {}
  }
  state.transcripts.clear();
  state.active.clear();
}

async function loadInvestigationSessions() {
  const response = await fetch('/api/investigation-sessions');
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not load investigation sessions');
  state.investigationSessions = body.sessions || [];
  state.currentSessionId = body.activeId;
}

async function activateInvestigationSession(sessionId) {
  if (!sessionId || sessionId === state.currentSessionId) return;
  const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}/activate`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not activate investigation');
  closeSessionStreams();
  state.currentSessionId = body.session.id;
  state.investigationSessions = body.sessions || [];
  clearPlanClientState();
  persistWorkspaceState();
  await Promise.all([loadAgents(), loadSecurityReviews()]);
  renderPane();
  if (!state._lobbySource) subscribeLobby();
}

async function createInvestigationSession() {
  const current = state.investigationSessions.find(session => session.id === state.currentSessionId);
  if (current?.metadata?.unassigned) {
    showToast('The current session is already unassigned and ready for a new GLaDOS prompt.', { kind: 'info', label: 'Investigation session' });
    return current;
  }
  const response = await fetch('/api/investigation-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unassigned session', metadata: { unassigned: true } }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not create investigation');
  closeSessionStreams();
  state.currentSessionId = body.session.id;
  state.investigationSessions = body.sessions || [];
  clearPlanClientState();
  persistWorkspaceState();
  await Promise.all([loadAgents(), loadSecurityReviews()]);
  renderPane();
  if (!state._lobbySource) subscribeLobby();
  return body.session;
}

async function renameInvestigationSession(sessionId, name) {
  const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not rename investigation');
  state.investigationSessions = body.sessions || [];
  return body.session;
}

async function deleteInvestigationSession(sessionId) {
  const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || 'could not delete investigation');
  closeSessionStreams();
  state.currentSessionId = body.activeId;
  state.investigationSessions = body.sessions || [];
  clearPlanClientState();
  persistWorkspaceState();
  await Promise.all([loadAgents(), loadSecurityReviews()]);
  renderPane();
  subscribeLobby();
}

function showNameInput({ title, value = '', confirmLabel = 'Save' }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<section class="app-modal session-name-modal" role="dialog" aria-modal="true" aria-labelledby="session-name-title">
      <header><h2 id="session-name-title">${escapeHtml(title)}</h2><button type="button" data-modal-close aria-label="Close">×</button></header>
      <div class="app-modal-copy"><label for="session-name-input">Investigation name</label><input id="session-name-input" maxlength="120" value="${escapeHtml(value)}" /></div>
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

function confirmAction({ title, message, confirmLabel = 'Continue', danger = false }) {
  return showDialog({ title, message, confirmLabel, cancelLabel: 'Cancel', danger });
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
});

// Debug off = hide thinking + intermediate tool calls. Keep user input,
// tool results, and final assistant output visible.
function applyDebugMode() {
  document.body.classList.toggle('debug-off', !debugModeEl.checked);
}
debugModeEl.addEventListener('change', applyDebugMode);
applyDebugMode();

function setAgentHaltedState(agentId, halted) {
  const agent = state.agents.find(entry => entry.id === agentId);
  if (agent) agent.halted = !!halted;
  renderAgentList();
  syncAgentViewToolbars(agentId);
}

function syncAgentViewToolbars(agentId = null) {
  document.querySelectorAll('.agent-view-toolbar').forEach(toolbar => {
    const id = toolbar.dataset.agentId;
    if (agentId && id !== agentId) return;
    const agent = state.agents.find(entry => entry.id === id);
    const halted = !!agent?.halted;
    const active = state.active.has(id);
    const status = toolbar.querySelector('.agent-runtime-status');
    if (status) {
      status.className = `agent-runtime-status ${halted ? 'halted' : (active ? 'running' : 'idle')}`;
      status.textContent = halted ? 'Halted' : (active ? 'Running' : 'Idle');
    }
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
  const resetLabel = agentId === 'glados' ? 'Reset investigation' : 'Reset session';
  const label = agentId === 'glados' ? 'GLaDOS' : agentId;
  const role = agentId === 'glados' ? 'Coordinator' : 'Specialist agent';
  const avatar = agentId === 'glados'
    ? '<img class="agent-avatar glados-avatar" src="/assets/glados-mark.svg" alt="" />'
    : `<span class="agent-avatar" aria-hidden="true">${escapeHtml(label.slice(0, 1).toUpperCase())}</span>`;
  toolbar.innerHTML = `
    <div class="agent-view-identity">
      ${avatar}
      <span class="agent-view-title"><strong>${escapeHtml(label)}</strong><small>${role}</small></span>
      <span class="agent-runtime-status idle">Idle</span>
    </div>
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
    const result = await fetchJson('/api/halt/' + encodeURIComponent(agentId), {
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
    const result = await fetchJson('/api/resume/' + encodeURIComponent(agentId), {
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
  const resetLabel = agentId === 'glados' ? 'Reset conversations' : 'Reset session';
  const resetMsg = agentId === 'glados'
    ? 'Start fresh Agent SDK conversations for this investigation session? Existing transcript history, blackboard findings, plans, evidence, reports, and all other investigation sessions are preserved.'
    : `Clear the current transcript state for "${agentId}"? The next message starts fresh.`;
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
  const res = await fetch(withSession('/api/agents'));
  const j = await res.json();
  const previouslyActive = new Set(state.active.keys());
  state.agents = j.agents || [];
  state.active.clear();
  for (const a of state.agents) {
    if (a.active) state.active.set(a.id, { sessionId: a.session?.sessionId });
  }
  for (const a of state.agents) {
    if (!a.active || a.id === 'glados' ) continue;
    if (state.openTabs.find(t => t.id === a.id)) continue;
    // If the lobby SSE missed session-started, polling still creates the live
    // agent's tab. Durable transcript backfill catches it up when opened.
    if (!state.agentsLoadedOnce || !previouslyActive.has(a.id)) ensureAgentTab(a.id);
  }
  state.agentsLoadedOnce = true;
  renderAgentList();
  syncAgentViewToolbars();
}


function renderAgentList() {
  agentListEl.innerHTML = '';
  const query = state.agentQuery.trim().toLowerCase();
  const filtered = state.agents.filter(a => {
    if (a.id === 'glados') return false;
    if (query && !`${a.id} ${a.name || ''} ${a.model || ''}`.toLowerCase().includes(query)) return false;
    if (state.agentFilter === 'active' && !state.active.has(a.id)) return false;
    if (state.agentFilter === 'halted' && !a.halted) return false;
    return true;
  });
  const groups = [
    ['Needs attention', filtered.filter(a => a.halted)],
    ['Running', filtered.filter(a => state.active.has(a.id) && !a.halted)],
    ['Available', filtered.filter(a => !state.active.has(a.id) && !a.halted)],
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
    li.className = (state.active.has(a.id) ? 'live ' : '') + (a.halted ? 'halted ' : '') + (state.currentTab === a.id ? 'active' : '');
    li.innerHTML = `<span class="dot"></span><span class="agent-row-main"><span class="name">${escapeHtml(a.id)}</span><small>${escapeHtml(a.model || a.name || 'Ready')}</small></span>` +
      `<span class="agent-row-state">${a.halted ? 'halted' : (state.active.has(a.id) ? 'live' : '')}</span>`;
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

let securityReviewLoadPending = false;
async function loadSecurityReviews() {
  if (securityReviewLoadPending || !state.currentSessionId) return;
  securityReviewLoadPending = true;
  try {
    const response = await fetch(withSession('/api/controller/status'));
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || 'could not load security reviews');
    state.securityReviews = body.securityReviews || [];
    renderSecurityReviews();
  } catch {}
  finally { securityReviewLoadPending = false; }
}

function openOverview() {
  const id = 'overview';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.unshift({ id, kind: 'overview', label: 'Overview' });
  setCurrentTab(id);
}

function openGladosChat() {
  const id = 'glados-chat';
  if (!state.openTabs.find(t => t.id === id)) {
    state.openTabs.unshift({ id, kind: 'chat', label: 'GLaDOS Chat' });
  }
  setCurrentTab(id);
}

function openAgentTab(agentId) {
  if (agentId === 'glados') {
    openGladosChat();
    return;
  }
  ensureAgentTab(agentId);
  setCurrentTab(agentId);
}

// Runtime events may create a work tab, but must never steal focus from an
// operator reading Overview, Reports, Proxy, or another agent transcript.
function ensureAgentTab(agentId) {
  if (!agentId || agentId === 'glados' || state.openTabs.find(t => t.id === agentId)) return;
  state.openTabs.push({ id: agentId, kind: 'agent', label: agentId });
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
  return agentId === 'glados' ? 'glados-chat' : agentId;
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
  const ids = agentIds.length ? agentIds.map(tabIdForAgent) : [...state.transcripts.keys()];
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
    overview: 'open-overview',
    'glados-chat': 'open-glados',
    plans: 'open-plans',
    reports: 'open-reports',
    terminal: 'open-terminal',
    proxy: 'open-proxy',
    settings: 'open-settings',
  };
  document.querySelectorAll('.workspace-links a').forEach(link => link.classList.remove('nav-active'));
  document.getElementById(mapping[state.currentTab])?.classList.add('nav-active');
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of state.openTabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (state.currentTab === t.id ? ' active' : '');
    // All tabs except the sticky GLaDOS Chat are closable. No icons — cleaner.
    const closable = t.kind !== 'chat';
    el.innerHTML = `<span class="label">${t.label}</span>` +
      (closable ? `<span class="close" data-close="${t.id}">×</span>` : '');
    el.addEventListener('click', ev => {
      if (ev.target.dataset.close) {
        ev.stopPropagation();
        closeTab(t.id);
      } else {
        setCurrentTab(t.id);
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

function openTerminal() {
  const id = 'terminal';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'terminal', label: 'Terminal' });
  setCurrentTab(id);
}

function openProxy() {
  const id = 'proxy';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'proxy', label: 'Proxy' });
  setCurrentTab(id);
}

function openUpdatePane({ autoStart = false } = {}) {
  const id = 'update';
  state.update.autoStart = autoStart;
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'update', label: 'Update' });
  setCurrentTab(id);
}

function renderPane() {
  paneEl.innerHTML = '';
  const id = state.currentTab;
  if (!id) {
    paneEl.innerHTML = '<div class="pane-empty">Open Overview or start chatting with GLaDOS.</div>';
    return;
  }
  const tab = state.openTabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.kind === 'overview') renderOverviewPane();
  else if (tab.kind === 'chat') renderChatPane();
  else if (tab.kind === 'plans') renderPlansPane();
  else if (tab.kind === 'reports') renderReportsPane();
  else if (tab.kind === 'settings') renderSettingsPane();
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
  if (!usage?.available) {
    return `<section class="overview-section overview-usage">
      <div class="overview-section-head"><div><h2>LLM usage</h2><p>Last seven days from LiteLLM</p></div><span class="status-chip warning">Unavailable</span></div>
      <div class="usage-unavailable"><strong>Usage metrics unavailable</strong><span>${escapeHtml(usage?.message || 'No reporting data is available.')}</span></div>
    </section>`;
  }
  const totals = usage.totals || {};
  const daily = usage.daily || [];
  const maxDailySpend = Math.max(0, ...daily.map(day => Number(day.spend) || 0));
  const failureRate = totals.requests > 0 ? (totals.failedRequests / totals.requests) * 100 : 0;
  const fetchedAt = usage.fetchedAt ? new Date(usage.fetchedAt).toLocaleTimeString() : 'just now';
  return `<section class="overview-section overview-usage">
    <div class="overview-section-head">
      <div><h2>LLM usage</h2><p>${escapeHtml(usage.period?.startDate || '')} to ${escapeHtml(usage.period?.endDate || '')} · reporting key scope</p></div>
      <span class="overview-updated">Synced ${escapeHtml(fetchedAt)}</span>
    </div>
    <div class="overview-usage-summary">
      <div><span>Spend</span><strong>${formatUsageCurrency(totals.spend)}</strong><small>Seven-day gateway cost</small></div>
      <div><span>Tokens</span><strong>${formatUsageNumber(totals.totalTokens)}</strong><small>${formatUsageNumber(totals.promptTokens)} input · ${formatUsageNumber(totals.completionTokens)} output</small></div>
      <div><span>Requests</span><strong>${formatUsageInteger(totals.requests)}</strong><small>${formatUsageInteger(totals.successfulRequests)} successful</small></div>
      <div><span>Failures</span><strong>${formatUsageInteger(totals.failedRequests)}</strong><small>${failureRate.toFixed(1)}% of requests</small></div>
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
        <div class="usage-subhead">
          <strong>Model distribution</strong>
          <div class="usage-segments" role="tablist" aria-label="Model distribution metric">
            ${['spend', 'tokens', 'requests'].map(name => `<button type="button" role="tab" data-usage-share="${name}" aria-selected="${name === metric}" class="${name === metric ? 'active' : ''}">${name[0].toUpperCase()}${name.slice(1)}</button>`).join('')}
          </div>
        </div>
        <div data-usage-model-list>${renderUsageModelRows(usage, metric)}</div>
      </div>
    </div>
  </section>`;
}

function renderInvestigationSessionManager(sessionHost) {
  if (!sessionHost) return;
  const current = state.investigationSessions.find(session => session.id === state.currentSessionId) || state.investigationSessions[0];
  const sorted = [...state.investigationSessions].sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
  sessionHost.innerHTML = `<div class="overview-session-controls">
      <details class="overview-session-menu">
        <summary aria-label="Select investigation"><span class="session-state-dot ${current?.state || 'active'}"></span><span><strong>${escapeHtml(current?.name || 'Unassigned session')}</strong><small>${current?.metadata?.unassigned ? 'Waiting for the first GLaDOS prompt' : `${current?.engagementCount || 0} engagement${current?.engagementCount === 1 ? '' : 's'}`}</small></span></summary>
        <div class="overview-session-popover">
          <div class="overview-session-popover-head"><span>Investigations</span></div>
          <div class="overview-session-list">
            ${sorted.map(session => `<div class="overview-session-row${session.id === state.currentSessionId ? ' selected' : ''}">
              <button type="button" class="overview-session-option" data-session-select="${escapeHtml(session.id)}">
                <span class="session-state-dot ${session.state}"></span><span><strong>${escapeHtml(session.name)}</strong><small>${session.state === 'active' ? 'Active' : 'Archived'} · ${new Date(session.updatedAt).toLocaleDateString()} · ${session.engagementCount || 0} engagement${session.engagementCount === 1 ? '' : 's'}</small></span>${session.id === state.currentSessionId ? '<span class="session-current-mark">Current</span>' : ''}
              </button>
              ${session.id !== state.currentSessionId ? `<button type="button" class="session-row-delete" data-session-delete-id="${escapeHtml(session.id)}" title="Delete ${escapeHtml(session.name)}" aria-label="Delete ${escapeHtml(session.name)}">×</button>` : ''}
            </div>`).join('')}
          </div>
          <div class="overview-session-popover-actions">
            <button type="button" data-session-rename>Rename</button><button type="button" class="danger" data-session-delete>Delete current</button>
          </div>
        </div>
      </details>
      <button type="button" class="overview-new-session" data-session-new>New session</button>
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
  sessionHost.querySelectorAll('[data-session-delete-id]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    const session = state.investigationSessions.find(item => item.id === button.dataset.sessionDeleteId);
    if (!session || !await confirmAction({ title: 'Delete investigation session', message: `Permanently delete "${session.name}" and its blackboard records, plans, tasks, findings, and transcripts? Evidence and report files are preserved.`, confirmLabel: 'Delete session', danger: true })) return;
    try {
      const response = await fetch(`/api/investigation-sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || 'could not delete investigation');
      state.investigationSessions = body.sessions || [];
      details.open = false;
      renderInvestigationSessionManager(sessionHost);
    } catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  }));
  sessionHost.querySelector('[data-session-rename]')?.addEventListener('click', async () => {
    details.open = false;
    const name = await showNameInput({ title: 'Rename investigation', value: current?.name || '', confirmLabel: 'Rename' });
    if (!name || !current) return;
    try { await renameInvestigationSession(current.id, name); renderInvestigationSessionManager(sessionHost); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  });
  sessionHost.querySelector('[data-session-delete]')?.addEventListener('click', async () => {
    details.open = false;
    if (!current || !await confirmAction({ title: 'Delete investigation session', message: `Permanently delete "${current.name}" and its blackboard records, plans, tasks, findings, and transcripts? Evidence and report files are preserved.`, confirmLabel: 'Delete session', danger: true })) return;
    try { await deleteInvestigationSession(current.id); }
    catch (error) { pushNotification('error', error.message, { toast: true, label: 'Investigation session' }); }
  });
}

async function renderOverviewPane() {
  const wrap = document.createElement('div');
  wrap.className = 'overview-pane';
  wrap.innerHTML = '<div class="overview-content"><div class="overview-loading">Loading operational state…</div></div>';
  paneEl.appendChild(wrap);
  const content = wrap.querySelector('.overview-content');
  let usageShareMetric = 'spend';

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
      const data = await fetchJson(withSession(`/api/overview${forceUsage ? '?usage=refresh' : ''}`), {
        timeoutMs: 15000,
        retries: 1,
        cache: 'no-store',
      });
      state.overview = data;
      if (!wrap.isConnected) return;
      const engagement = data.engagement;
      const active = data.activeAgents || [];
      const halted = data.haltedAgents || [];
      const agentRows = [...halted, ...active.filter(agent => !agent.halted)];
      const targetState = data.targetHealth?.state || (engagement ? 'not probed' : 'standby');
      const assessmentMetering = data.assessmentMetrics?.metering || {};
      const assessmentTiming = data.assessmentMetrics?.timing || {};
      const assessmentCost = assessmentMetering.costAvailable
        ? formatUsageCurrency(assessmentMetering.costUsd)
        : 'Unavailable';
      const assessmentTokens = assessmentMetering.tokensAvailable
        ? formatUsageNumber(assessmentMetering.tokens?.totalTokens)
        : 'Unavailable';
      const canEndInvestigation = engagement
        && !['cancelled', 'complete', 'completed', 'closed'].includes(String(engagement.status || '').toLowerCase());
      const nextAction = data.pendingApprovals
        ? 'Review and approve the current attack plan before phase-gated tools can run.'
        : halted.length
          ? `Review ${halted.length} halted agent${halted.length === 1 ? '' : 's'} and resume only when the task is safe to continue.`
          : active.length
            ? 'Monitor active specialists and review their evidence as results arrive.'
            : engagement
              ? 'Send the next objective to GLaDOS or inspect the current plan.'
              : 'Start with /investigate <target> in GLaDOS Chat when an authorized engagement is ready.';
      content.innerHTML = `
        <header class="overview-header">
          <div>
            <span class="overview-eyebrow">Operational overview</span>
            <h1>${escapeHtml(engagement?.target || 'No active engagement')}</h1>
            <div class="overview-status-line">
              <span class="status-chip ${overviewStatusClass(data.phase)}">${escapeHtml(data.phase)}</span>
              <span class="status-chip ${overviewStatusClass(targetState)}">Target ${escapeHtml(targetState)}</span>
              <span class="overview-updated">Updated ${new Date(data.generatedAt).toLocaleTimeString()}</span>
            </div>
          </div>
          <div class="overview-header-actions">
            <button type="button" data-overview-chat>Open GLaDOS</button>
            <button type="button" data-overview-refresh title="Refresh operational state">Refresh</button>
            ${canEndInvestigation ? '<button type="button" class="danger" data-overview-end>End Investigation</button>' : ''}
          </div>
        </header>
        <section class="overview-metrics" aria-label="Engagement metrics">
          <div><span>Agents</span><strong>${active.filter(agent => agent.id !== 'glados').length}</strong><small>${halted.length ? `${halted.length} halted` : `${(data.agents || []).filter(agent => agent.id !== 'glados').length} available`}</small></div>
          <div><span>Approvals</span><strong>${data.pendingApprovals || 0}</strong><small>${data.plan?.state ? data.plan.state.replaceAll('_', ' ') : 'no plan'}</small></div>
          <div><span>Findings</span><strong>${data.findings?.total || 0}</strong><small>${data.findings?.critical || 0} critical · ${data.findings?.high || 0} high</small></div>
          <div><span>Assessment cost</span><strong class="metric-word">${escapeHtml(assessmentCost)}</strong><small>${escapeHtml(assessmentTiming.elapsedHuman || 'no active meter')}</small></div>
          <div><span>Assessment tokens</span><strong class="metric-word">${escapeHtml(assessmentTokens)}</strong><small>${assessmentMetering.tokensAvailable ? `${assessmentMetering.resultEvents || 0} completed agent turns` : 'updates as turns complete'}</small></div>
          <div><span>Proxy</span><strong class="metric-word ${overviewStatusClass(data.proxy?.healthy ? 'healthy' : 'offline')}">${data.proxy?.healthy ? 'Live' : 'Offline'}</strong><small>${escapeHtml(data.proxy?.backend || 'not configured')}</small></div>
        </section>
        ${renderLiteLlmUsage(data.llmUsage, usageShareMetric)}
        <div class="overview-columns">
          <section class="overview-section">
            <div class="overview-section-head"><div><h2>Agent activity</h2><p>Running work and operator interventions</p></div></div>
            <div class="overview-agent-list">
              ${agentRows.length ? agentRows.map(agent => `
                <button type="button" class="overview-agent-row" data-overview-agent="${escapeHtml(agent.id)}">
                  <span class="dot ${agent.halted ? 'halted' : 'live'}"></span>
                  <span><strong>${escapeHtml(agent.id)}</strong><small>${escapeHtml(agent.model || 'model not set')}</small></span>
                  <span class="status-chip ${agent.halted ? 'danger' : 'success'}">${agent.halted ? 'Halted' : 'Running'}</span>
                </button>`).join('') : '<div class="overview-empty">No agents are running. The team is ready for the next objective.</div>'}
            </div>
          </section>
          <section class="overview-section">
            <div class="overview-section-head"><div><h2>Next action</h2><p>${escapeHtml(data.goal?.status || 'operator controlled')}</p></div></div>
            <div class="overview-next-action">
              <p>${escapeHtml(nextAction)}</p>
              <div>
                ${data.pendingApprovals ? '<button type="button" data-overview-plans class="safe">Review plan</button>' : ''}
                <button type="button" data-overview-proxy>Inspect traffic</button>
              </div>
            </div>
          </section>
        </div>
        <section class="overview-section overview-operations">
          <div class="overview-section-head"><div><h2>Investigation status</h2><p>${escapeHtml(engagement?.id || 'No engagement ID')}</p></div></div>
          <div class="overview-operations-grid">
            <article class="overview-operation-card overview-top-findings">
              <div class="overview-card-head"><div><span>Priority view</span><h3>Top findings</h3></div><button type="button" data-overview-reports>View reports</button></div>
              ${renderOverviewFindings(data.topFindings)}
            </article>
            <article class="overview-operation-card">
              <div class="overview-card-head"><div><span>Current direction</span><h3>Plan</h3></div></div>
              ${renderOverviewPlan(data.plan)}
            </article>
            <article class="overview-operation-card">
              <div class="overview-card-head"><div><span>Task lifecycle</span><h3>Progress</h3></div></div>
              ${renderOverviewProgress(data.tasks, data.phase)}
            </article>
          </div>
        </section>`;
      content.querySelector('[data-overview-chat]')?.addEventListener('click', openGladosChat);
      content.querySelector('[data-overview-refresh]')?.addEventListener('click', () => load({ forceUsage: true }));
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
      content.querySelector('[data-overview-plans]')?.addEventListener('click', openPlans);
      content.querySelector('[data-overview-proxy]')?.addEventListener('click', openProxy);
      content.querySelectorAll('[data-overview-reports]').forEach(button => button.addEventListener('click', openReports));
      content.querySelectorAll('[data-overview-agent]').forEach(button => button.addEventListener('click', () => openAgentTab(button.dataset.overviewAgent)));
      content.querySelectorAll('[data-usage-share]').forEach(button => button.addEventListener('click', () => {
        usageShareMetric = button.dataset.usageShare;
        content.querySelectorAll('[data-usage-share]').forEach(candidate => {
          const active = candidate.dataset.usageShare === usageShareMetric;
          candidate.classList.toggle('active', active);
          candidate.setAttribute('aria-selected', String(active));
        });
        const list = content.querySelector('[data-usage-model-list]');
        if (list) list.innerHTML = renderUsageModelRows(data.llmUsage, usageShareMetric);
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
function ensureTranscript(tabId, agentId) {
  let rec = state.transcripts.get(tabId);
  if (rec) return rec;
  rec = {
    agentId,
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
  const generation = state.sessionGeneration;
  const sessionId = state.currentSessionId;
  const es = new EventSource(withSession(`/api/agents/${encodeURIComponent(agentId)}/transcript?stream=v4`));
  es.onmessage = e => {
    if (generation !== state.sessionGeneration || sessionId !== state.currentSessionId) return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    ev = normalizeIncomingTranscriptEvent(ev);
    if (!ev) return;

    // The SDK result object is control metadata. The assistant answer already
    // arrives as assistant-text, so success results should not become chat
    // bubbles. Error results are rendered as explicit prompt failures.
    if (ev.kind === 'result' && !ev.isError) {
      finalizeActiveStreamEntries(rec);
      if (rec.sending && eventBelongsToCurrentTurn(rec, ev)) finishTranscriptTurn(rec, tabId);
      return;
    }
    if (ev.kind === 'error' || (ev.kind === 'result' && ev.isError)) {
      ev = sdkResultToPromptError(ev);
    }

    // SDK partial deltas: don't buffer, don't push to events list, just update
    // the live entry. They arrive many-per-second and would blow out memory.
    if (ev.kind === 'thinking-stream' || ev.kind === 'text-stream') {
      const isText = ev.kind === 'text-stream';
      rec.firstTokenSeenAt ||= Date.now();
      markTranscriptActivity(rec, tabId, isText ? 'responding' : 'thinking');
      handleStreamDelta(rec, ev);
      if (isText && ev.evtType === 'text_end') finishTranscriptTurn(rec, tabId);
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
          finishTranscriptTurn(rec, tabId);
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
      if (rec.sending && (ev.kind === 'assistant-text' || ev.kind === 'prompt-error') && eventBelongsToCurrentTurn(rec, ev)) {
        rec.firstTokenSeenAt ||= Date.now();
        finishTranscriptTurn(rec, tabId);
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
    } else if (ev.kind === 'tool-result' && ev.isError && recentOperationalEvent) {
      pushNotification('error', `${rec.agentId}: ${ev.toolName || 'tool'} failed`, { toast: true, label: 'Tool error' });
    } else if (ev.kind === 'permission-denied' && recentOperationalEvent) {
      pushNotification('denied', `${rec.agentId}: ${ev.decisionReason || ev.text || 'tool use denied'}`, { toast: true, label: 'Safety gate' });
    }
    if (rec.sending) {
      if (ev.kind === 'assistant-text' || ev.kind === 'prompt-error') {
        if (eventBelongsToCurrentTurn(rec, ev)) {
          rec.firstTokenSeenAt ||= Date.now();
          finishTranscriptTurn(rec, tabId);
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
  if (ev.toolCallId) {
    const byTool = rec.events.findIndex(x => x.kind === ev.kind && x.toolCallId === ev.toolCallId);
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
          enhanceMarkdownContent(entry.el);
        } catch (_) { /* keep plain text on error */ }
      }
    }
    if (content && findEventIndexByText(rec, durableKind, content) < 0) {
      rec.events.push({
        kind: durableKind,
        text: content,
        ts: Date.now(),
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

function finishTranscriptTurn(rec, tabId) {
  if (!rec) return;
  rec.sending = false;
  rec.activity = null;
  rec.lastActivityTs = Date.now();
  rec.turnAgeMs = null;
  rec.completedAt = Date.now();
  updateSendingIndicator(tabId);
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
  rec.events[idx] = { ...ev, _optimistic: false, _acknowledgedClientId: old.clientId || null };
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
  if (!rec) return;
  try {
    const r = await fetch(withSession(`/api/chat/status/${encodeURIComponent(agentId)}`));
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
    }
  } catch {}
}

function refreshVisibleChatTurnStatuses() {
  const tab = state.openTabs.find(item => item.id === state.currentTab);
  if (!tab || !['chat', 'agent'].includes(tab.kind)) return;
  const agentId = tab.kind === 'chat' ? 'glados' : tab.id;
  refreshChatTurnStatus(tab.id, agentId);
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
        enhanceMarkdownContent(entry.el);
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
  inputRow.innerHTML = `
    <textarea id="chat-text" placeholder="Talk to GLaDOS (Enter to send, Shift+Enter for newline)…"></textarea>
    <button id="chat-send">Send</button>
    <button id="chat-stop" class="secondary" title="Stop the current response" disabled>Stop</button>
  `;
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
  const dispatch = (override) => {
    const ta = document.getElementById('chat-text');
    const msg = override !== undefined ? override : ta.value.trim();
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

    const clientId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      kind: 'user-message',
      text: msg,
      ts: Date.now(),
      _optimistic: true,
      clientId,
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
      body: JSON.stringify({ message: msg, client_id: clientId, session_id: state.currentSessionId }),
    }).then(r => r.json()).then(j => {
      if (!j.ok) {
        logEvent('error', 'chat error: ' + (j.error || 'unknown'));
        finishTranscriptTurn(rec, tabId);
      }
      // On success, the "sending" flag gets cleared by the SSE handler when
      // the first assistant/thinking/result event arrives (which is usually
      // before the POST resolves, since the CLI blocks until turn end).
    }).catch(e => {
      logEvent('error', 'chat exception: ' + e.message);
      finishTranscriptTurn(rec, tabId);
    });
  };
  const send = () => dispatch();
  const stop = () => stopChatTurnFromUi(tabId, 'glados');
  chatRetriers.set('glados', (msg) => dispatch(msg));
  document.getElementById('chat-send').addEventListener('click', send);
  document.getElementById('chat-stop').addEventListener('click', stop);
  const ta = document.getElementById('chat-text');
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

function renderAgentChatSurface(agentId, tabId, coordinator) {
  const label = agentId === 'glados' ? 'GLaDOS' : agentId;
  const chat = document.createElement('div');
  chat.className = 'chat-pane chat-visual-chamber';
  chat.dataset.agent = agentId;
  chat.style.setProperty('--agent-feed-label', `"${String(label).toUpperCase()} / CHAMBER FEED"`);
  const toolbar = createAgentViewToolbar(agentId);
  if (coordinator) {
    const sessionHost = document.createElement('div');
    sessionHost.className = 'investigation-session-host';
    toolbar.querySelector('.agent-actions').before(sessionHost);
    renderInvestigationSessionManager(sessionHost);
  }
  chat.appendChild(toolbar);

  const transcript = document.createElement('div');
  transcript.className = 'transcript';
  const sendingEl = document.createElement('div');
  sendingEl.className = 'sending-indicator';
  sendingEl.dataset.chatTab = tabId;
  sendingEl.style.display = 'none';
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input';
  inputRow.innerHTML = `
    <textarea data-chat-tab="${escapeHtml(tabId)}" placeholder="Talk to ${escapeHtml(label)} (Enter to send, Shift+Enter for newline)…"></textarea>
    <button type="button" data-chat-send data-chat-tab="${escapeHtml(tabId)}">Send</button>
    <button type="button" data-chat-stop data-chat-tab="${escapeHtml(tabId)}" class="secondary" title="Stop the current response" disabled>Stop</button>
  `;
  chat.append(transcript, sendingEl, inputRow);
  paneEl.appendChild(chat);
  syncAgentViewToolbars(agentId);

  const rec = ensureTranscript(tabId, agentId);
  rec.el = transcript;
  rec.autoScroll = true;
  attachScrollTracker(transcript, rec);
  for (const ev of rec.events) appendEntry(transcript, ev, rec);
  setTimeout(() => focusTranscriptProvenance(rec), 0);
  scrollToBottom(transcript, rec);
  updateSendingIndicator(tabId);
  refreshChatTurnStatus(tabId, agentId);

  const ta = chatElement(chat, 'textarea', tabId);
  const dispatch = override => {
    const msg = override !== undefined ? override : ta.value.trim();
    if (!msg) return;
    if (coordinator && msg.startsWith('/')) {
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
    pushChatHistory(agentId, msg);
    const clientId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = { kind: 'user-message', text: msg, ts: Date.now(), _optimistic: true, clientId };
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
      body: JSON.stringify({ message: msg, client_id: clientId, session_id: state.currentSessionId }),
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
  chatRetriers.set(agentId, msg => dispatch(msg));
  chat.querySelector('[data-chat-send]').addEventListener('click', () => dispatch());
  chat.querySelector('[data-chat-stop]').addEventListener('click', () => stopChatTurnFromUi(tabId, agentId));
  attachChatHistoryNav(ta, agentId);
  attachAutoGrow(ta, {});
  if (coordinator) attachSlashMenu(ta, inputRow, line => { ta.value = line; dispatch(); });
  ta.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); dispatch(); }
  });
}

function renderChatPane() {
  renderAgentChatSurface('glados', 'glados-chat', true);
}

async function stopChatTurnFromUi(tabId, agentId) {
  const rec = state.transcripts.get(tabId);
  if (!rec?.sending) return;
  rec.activity = 'stopping';
  updateSendingIndicator(tabId);
  const btn = document.querySelector(`[data-chat-stop][data-chat-tab="${CSS.escape(tabId)}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Stopping...';
  }
  try {
    const r = await fetch(withSession(`/api/chat/${encodeURIComponent(agentId)}/stop`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'dashboard stop button', session_id: state.currentSessionId }),
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
  if (state.currentTab !== tabId) return;
  const rec = state.transcripts.get(tabId);
  const stopBtn = document.querySelector(`[data-chat-stop][data-chat-tab="${CSS.escape(tabId)}"]`);
  if (!stopBtn) return;
  const stopping = rec?.activity === 'stopping';
  stopBtn.disabled = !rec?.sending || stopping;
  stopBtn.textContent = stopping ? 'Stopping...' : 'Stop';
}

function updateSendingIndicator(tabId) {
  if (state.currentTab !== tabId) return;
  const el = document.querySelector(`.sending-indicator[data-chat-tab="${CSS.escape(tabId)}"]`);
  if (!el) return;
  const rec = state.transcripts.get(tabId);
  el.style.display = rec?.sending ? 'block' : 'none';
  if (rec?.sending) el.textContent = transcriptStatusText(rec, rec.agentId === 'glados' ? 'GLaDOS' : rec.agentId);
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
  return `<pre class="collapsible ${extraClass}">${safe}</pre><span class="expand-toggle">▸ expand (${text.length.toLocaleString()} chars)</span>`;
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
    const cls = `md-content ${extraClass} ${long ? 'collapsible' : ''}`.trim();
    const toggle = long
      ? `<span class="expand-toggle">▸ expand (${src.length.toLocaleString()} chars)</span>`
      : '';
    return `<div class="${cls}">${clean}</div>${toggle}`;
  } catch (_) {
    return renderCollapsible(src, extraClass);
  }
}

// Post-process a rendered markdown container: open links in new tab,
// attach copy buttons to fenced code blocks. Idempotent — safe to re-run.
function enhanceMarkdownContent(container) {
  if (!container) return;
  container.querySelectorAll('a[href]').forEach(a => {
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
    chatRetriers.get('glados')?.(
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

function openRelatedTraffic(agentId, ev) {
  const url = extractEventUrl(ev);
  if (!url) return;
  let host = '';
  try { host = new URL(url).hostname; } catch { host = url; }
  _proxyState.filterAgent = agentId || '';
  _proxyState.filterText = host;
  _proxyState.pendingFocus = {
    agentId,
    url,
    ts: transcriptEventMs(ev) || Date.now(),
  };
  openProxy();
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
  if (agentId === 'glados') openGladosChat();
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

function appendEntry(container, ev, rec) {
  if (ev.kind === 'result' && !ev.isError) return;
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
    enhanceMarkdownContent(el);
    addAskGladosAction(el, displayTranscriptText(ev.text || ''), rec);
  } else if (kind === 'thinking' || kind === 'user-message') {
    const displayText = kind === 'thinking' ? displayTranscriptText(ev.text || '') : (ev.text || '');
    el.innerHTML = `<span class="ts">${ts}</span>${renderCollapsible(displayText)}`;
    if (kind === 'user-message') {
      el.dataset.messageText = ev.text || '';
      if (ev.clientId) el.dataset.clientId = ev.clientId;
    }
    // v4: right-click a user message to retry. Only on surfaces that
    // registered a retrier (GLaDOS chat) — agent transcripts
    // don't have a retrier because they're not user-driven.
    if (kind === 'user-message' && rec?.agentId && chatRetriers.has(rec.agentId)) {
      installChatRetryContextMenu(el, rec.agentId, ev.text || '');
    }
  } else if (kind === 'tool-call') {
    const args = ev.arguments !== undefined
      ? JSON.stringify(ev.arguments, null, 2)
      : (ev.toolInput !== undefined ? JSON.stringify(ev.toolInput, null, 2) : '');
    el.innerHTML = `<span class="ts">${ts}</span><span class="tool-name">→ ${escapeHtml(ev.toolName || '?')}</span>${renderCollapsible(args, 'args')}`;
    const targetUrl = extractEventUrl(ev);
    if (targetUrl && rec?.agentId) {
      const traffic = document.createElement('button');
      traffic.type = 'button';
      traffic.className = 'entry-related-action';
      traffic.textContent = 'View related traffic';
      traffic.title = `Open proxy traffic for ${targetUrl}`;
      traffic.addEventListener('click', event => {
        event.stopPropagation();
        openRelatedTraffic(rec.agentId, ev);
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
    el.innerHTML = `<span class="ts">${ts}</span><span class="tool-name">${header} ${escapeHtml(ev.toolName || '?')}${extra}</span>${renderCollapsible(displayed, 'out')}${truncNote}`;
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
async function refreshHealthBanner() {
  const banner = document.getElementById('health-banner');
  const msg = document.getElementById('health-banner-msg');
  if (!banner || !msg) return;
  let data;
  try {
    const r = await fetch('/api/health/proxy');
    data = await r.json();
  } catch {
    banner.classList.remove('hidden');
    msg.textContent = 'Dashboard cannot reach its own health endpoint';
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
      const r = await fetch('/api/health/proxy');
      const data = await r.json();
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

// Lobby event stream — session-started / session-ended -> auto-open tab.
function subscribeLobby() {
  try { state._lobbySource?.close(); } catch {}
  const es = new EventSource(withSession('/api/agents/stream'));
  state._lobbySource = es;
  es.addEventListener('investigation-session-updated', async () => {
    try {
      await loadInvestigationSessions();
      renderInvestigationSessionManager(document.querySelector('.investigation-session-host'));
    } catch {}
  });
  es.addEventListener('investigation-session-deleted', async () => {
    try { await loadInvestigationSessions(); if (state.currentTab === 'glados-chat') renderPane(); } catch {}
  });
  es.addEventListener('snapshot', e => {
    const arr = JSON.parse(e.data);
    for (const a of arr) {
      state.active.set(a.agentId, { sessionId: a.sessionId });
      if (a.agentId !== 'glados' && !state.openTabs.find(t => t.id === a.agentId)) {
        ensureAgentTab(a.agentId);
      }
    }
    renderAgentList();
  });
  es.addEventListener('session-started', e => {
    const info = JSON.parse(e.data);
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    state.active.set(info.agentId, { sessionId: info.sessionId });
    logEvent('started', `${info.agentId} session-started`);
    renderAgentList();
    if (info.agentId !== 'glados' && !state.openTabs.find(t => t.id === info.agentId)) {
      ensureAgentTab(info.agentId);
    }
  });
  es.addEventListener('session-ended', e => {
    const info = JSON.parse(e.data);
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    state.active.delete(info.agentId);
    logEvent('ended', `${info.agentId} session-ended`);
    renderAgentList();
  });
  es.addEventListener('session-reset', e => {
    const info = JSON.parse(e.data);
    if (info.investigationSessionId && info.investigationSessionId !== state.currentSessionId) return;
    if (!info.agentId) return;
    clearTranscriptTab(tabIdForAgent(info.agentId));
    state.active.delete(info.agentId);
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
    if (info.live) {
      state.active.set(info.agentId, { sessionId: info.sessionId || info.state || 'live' });
      if (info.agentId !== 'glados' && !state.openTabs.find(t => t.id === info.agentId)) {
        ensureAgentTab(info.agentId);
      }
    } else {
      state.active.delete(info.agentId);
    }
    renderAgentList();
  });
  es.addEventListener('halt', e => {
    const { agentId, reason } = JSON.parse(e.data);
    setAgentHaltedState(agentId, true);
    logEvent('ended', `HALT ${agentId}${reason ? ' — ' + reason : ''}`);
  });
  es.addEventListener('resume', e => {
    const { agentId } = JSON.parse(e.data);
    setAgentHaltedState(agentId, false);
    logEvent('started', `resume ${agentId}`);
  });
  es.addEventListener('chat-turn-started', e => {
    let data = {}; try { data = JSON.parse(e.data); } catch {}
    if (data.investigationSessionId && data.investigationSessionId !== state.currentSessionId) return;
    const tabId = data.agentId === 'glados' ? 'glados-chat' : null;
    if (!tabId) return;
    state.active.set(data.agentId, { sessionId: data.turnId || 'chat-turn' });
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
    if (data.investigationSessionId && data.investigationSessionId !== state.currentSessionId) return;
    const tabId = data.agentId === 'glados' ? 'glados-chat' : null;
    if (!tabId) return;
    state.active.delete(data.agentId);
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
            <h1>Report Library</h1>
            <p id="reports-summary">Loading index...</p>
          </div>
          <button type="button" class="report-refresh" id="reports-refresh" title="Refresh report library" aria-label="Refresh report library">↻</button>
        </div>
        <div class="report-search-field">
          <input id="reports-search" type="search" placeholder="Search reports" autocomplete="off" aria-label="Search reports" />
          <button type="button" id="reports-search-clear" title="Clear search" aria-label="Clear search">×</button>
        </div>
        <div class="report-source-tabs" role="tablist" aria-label="Report source">
          <button type="button" role="tab" data-report-scope="all">All</button>
          <button type="button" role="tab" data-report-scope="reports">Reports</button>
          <button type="button" role="tab" data-report-scope="investigations">Investigations</button>
        </div>
        <div class="report-index-notice" id="report-index-notice" hidden></div>
      </div>
      <div class="reports-tree" id="reports-tree"><div class="report-tree-loading">Loading reports...</div></div>
    </aside>
    <div class="report-viewer" id="report-viewer">
      <div class="report-empty"><strong>No report selected</strong></div>
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
    const noticeEl = wrap.querySelector('#report-index-notice');
    const tree = j.tree || [];
    const totalFiles = countReportFiles(tree);
    const totalCollections = tree.length;
    summaryEl.textContent = `${totalFiles.toLocaleString()} ${totalFiles === 1 ? 'file' : 'files'} in ${totalCollections} ${totalCollections === 1 ? 'collection' : 'collections'}`;
    if (j.truncated) {
      noticeEl.hidden = false;
      const limited = Array.isArray(j.truncatedRoots) && j.truncatedRoots.length
        ? j.truncatedRoots.join(' and ')
        : 'large collections';
      noticeEl.textContent = `${limited} limited to ${Number(j.maxEntries || 0).toLocaleString()} indexed items`;
    }

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
        .find(el => el.dataset.path === state.reports.selectedPath);
      loadReport(state.reports.selectedPath, selectedEl);
    }
  } catch (e) {
    wrap.querySelector('#reports-tree').innerHTML = `<div class="report-tree-error">Could not load reports<br><span>${escapeHtml(e.message)}</span></div>`;
  }
}

function countReportFiles(nodes) {
  return nodes.reduce((total, node) => total + (node.type === 'file' ? 1 : countReportFiles(node.children || [])), 0);
}

function filterReportTree(nodes, query, scope = 'all') {
  const needle = String(query || '').trim().toLowerCase();
  const scoped = scope === 'all' ? nodes : nodes.filter(node => node.path === scope);

  function visit(node) {
    const ownMatch = !needle || `${node.name} ${node.path || ''}`.toLowerCase().includes(needle);
    if (node.type === 'file') return ownMatch ? node : null;
    if (!needle || ownMatch) return node;
    const children = (node.children || []).map(visit).filter(Boolean);
    return children.length ? { ...node, children } : null;
  }

  return scoped.map(visit).filter(Boolean);
}

function reportFileType(node) {
  const ext = String(node.name || '').split('.').pop();
  if (!ext || ext === node.name) return 'FILE';
  return ext.slice(0, 4).toUpperCase();
}

function formatReportSize(bytes) {
  const size = Math.max(0, Number(bytes || 0));
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatReportDate(value) {
  const date = new Date(Number(value || 0));
  if (!Number.isFinite(date.getTime()) || !value) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function buildTreeNodes(nodes, { depth = 0, forceOpen = false } = {}) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    const li = document.createElement('li');
    li.className = n.type === 'dir' ? 'report-dir-node' : 'report-file-node';
    if (n.type === 'dir') {
      const head = document.createElement('button');
      head.type = 'button';
      head.className = `dir${depth === 0 ? ' collection' : ''}`;
      const fileCount = countReportFiles(n.children || []);
      head.innerHTML = `<span class="tree-caret" aria-hidden="true">›</span><span class="dir-name">${escapeHtml(n.name)}</span><span class="dir-count">${fileCount.toLocaleString()}</span>`;
      const childUl = document.createElement('ul');
      let populated = false;
      const populate = () => {
        if (populated) return;
        childUl.appendChild(buildTreeNodes(n.children || [], { depth: depth + 1, forceOpen }));
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
      li.appendChild(head);
      li.appendChild(childUl);
    } else {
      const fileEl = document.createElement('button');
      fileEl.type = 'button';
      fileEl.className = `file${state.reports.selectedPath === n.path ? ' active' : ''}`;
      fileEl.dataset.path = n.path;
      fileEl.title = n.path;
      fileEl.innerHTML = `<span class="file-kind">${escapeHtml(reportFileType(n))}</span><span class="file-copy"><span class="file-name">${escapeHtml(n.name)}</span><span class="file-details"><span>${escapeHtml(formatReportDate(n.mtime))}</span><span>${escapeHtml(formatReportSize(n.size))}</span></span></span>`;
      fileEl.addEventListener('click', () => loadReport(n.path, fileEl));
      li.appendChild(fileEl);
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
  viewer.innerHTML = '<div class="report-empty">loading…</div>';
  const isMd = /\.md$/i.test(relPath);
  const header = `<div class="report-header"><span>${escapeHtml(relPath)}</span>
    <span class="report-actions">
      ${isMd ? `<button class="btn-link" id="report-edit">edit</button>` : ''}
      <a href="/api/reports/raw?path=${encodeURIComponent(relPath)}" target="_blank" rel="noopener">open raw</a>
      <button class="btn-link danger" id="report-delete">delete</button>
    </span></div>`;
  try {
    const j = await fetch('/api/reports/file?path=' + encodeURIComponent(relPath)).then(r => r.json());
    if (j.error) { viewer.innerHTML = `<div class="report-empty">error: ${escapeHtml(j.error)}</div>`; return; }
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
      body = `<iframe class="report-pdf" src="${rawUrl}"></iframe>`;
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
    return line;
  }).join('\n');
}

function reportPresentationClass(relPath) {
  const match = String(relPath || '').match(/(?:^|\/)CWEs\/(Critical|High|Medium|Low)(?:\/|$)/i);
  if (match) return `severity-${match[1].toLowerCase()}`;
  return /(?:^|\/)RT(?:\/|$)/i.test(String(relPath || '')) ? 'report-red-team' : 'report-general';
}

function wireReportActions(relPath, fileMeta, viewer) {
  const delBtn = viewer.querySelector('#report-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!await confirmAction({ title: 'Delete report', message: `Delete ${relPath}? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
    try {
      const r = await fetch('/api/reports/file?path=' + encodeURIComponent(relPath), { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'delete failed');
      state.reports.selectedPath = null;
      renderPane();
    } catch (e) { pushNotification('error', 'Delete failed: ' + e.message, { toast: true, label: 'Reports' }); }
  });
  const editBtn = viewer.querySelector('#report-edit');
  if (editBtn && fileMeta.kind === 'markdown') editBtn.addEventListener('click', () => {
    const original = fileMeta.content;
    viewer.innerHTML = `<div class="report-header"><span>${escapeHtml(relPath)} <em>(editing)</em></span>
        <span class="report-actions">
          <button class="btn-link" id="report-save">save</button>
          <button class="btn-link" id="report-cancel">cancel</button>
        </span></div>
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

async function refreshUpdateStatus() {
  const el = document.getElementById('update-status');
  if (!el) return;
  try {
    if (window.gladosDesktop?.isPackaged) {
      const status = await window.gladosDesktop.getUpdateAccessStatus();
      const feedInput = document.getElementById('update-feed-url');
      if (feedInput && document.activeElement !== feedInput && status.feedUrl) feedInput.value = status.feedUrl;
      const run = document.getElementById('update-run');
      if (run) run.disabled = !status.configured;
      el.textContent = status.configured
        ? `private feed ready · ${status.source} · ${status.storageBackend}`
        : `private feed not ready · ${status.reason || 'configure access below'}`;
      el.className = status.configured ? 'update-status ok' : 'update-status warn';
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
    if (!await confirmAction({ title: 'Check for update', message: 'Check the signed GLaDOS release feed for an update? Operator data under ~/.glados is never part of the update payload.', confirmLabel: 'Check for update' })) return;
    state.update.running = true;
    appendUpdateLine('[desktop] checking signed release feed\n', 'cmd');
    try {
      const result = await window.gladosDesktop.checkForUpdate();
      appendUpdateLine(`[desktop] current ${result.currentVersion || 'unknown'} · feed ${result.version || 'unknown'}\n`, 'info');
      if (!result.available) {
        appendUpdateLine('[desktop] GLaDOS is already up to date\n', 'info');
        return;
      }
      await window.gladosDesktop.downloadUpdate();
      appendUpdateLine('[desktop] signed update downloaded and verified\n', 'info');
      if (await confirmAction({ title: 'Install verified update', message: 'The update is signed and verified. GLaDOS will refuse to install while agents are active, snapshot databases and model assignments, then restart. Reports and investigations remain in ~/.glados.', confirmLabel: 'Snapshot and install' })) {
        const installed = await window.gladosDesktop.installUpdate();
        appendUpdateLine(`[desktop] preservation snapshot created: ${installed.snapshotDir}\n`, 'info');
      }
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
      <button id="update-run">Run Update</button>
      ${packaged ? '' : '<button id="update-force" title="Continue despite active agents or dirty working tree">Force</button>'}
      <button id="update-clear">Clear Log</button>
    </div>
    ${packaged ? `<div class="update-access">
      <label><span>Authenticated HTTPS feed</span><input id="update-feed-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://updates.example.com/glados/macos"></label>
      <label><span>Access token</span><input id="update-access-token" type="password" autocomplete="new-password" placeholder="Not displayed after saving"></label>
      <button id="update-access-save">Save Access</button>
      <button id="update-access-clear" class="danger">Clear Access</button>
      <small>The token is encrypted by the OS credential store and never placed in the application bundle or dashboard API.</small>
    </div>` : ''}
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
  wrap.querySelector('#update-access-save')?.addEventListener('click', async () => {
    const feedUrl = wrap.querySelector('#update-feed-url').value;
    const tokenInput = wrap.querySelector('#update-access-token');
    try {
      const status = await window.gladosDesktop.saveUpdateAccess({ feedUrl, token: tokenInput.value });
      tokenInput.value = '';
      appendUpdateLine(`[desktop] private feed access saved using ${status.storageBackend}\n`, 'info');
      await refreshUpdateStatus();
    } catch (error) {
      appendUpdateLine(`[desktop] could not save update access: ${error.message}\n`, 'stderr');
    }
  });
  wrap.querySelector('#update-access-clear')?.addEventListener('click', async () => {
    if (!await confirmAction({ title: 'Clear update access', message: 'Remove the locally encrypted private-feed token?', confirmLabel: 'Clear access' })) return;
    await window.gladosDesktop.clearUpdateAccess();
    wrap.querySelector('#update-access-token').value = '';
    appendUpdateLine('[desktop] private feed access cleared\n', 'info');
    await refreshUpdateStatus();
  });
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

// --- Proxy ---
// One long-lived state object across tab switches so the table keeps scrollback
// and the EventSource isn't reopened on every render.
const _proxyState = {
  rows: [], es: null,
  filterText: '', filterStatus: '', filterAgent: '',
  maxRows: 2000, paused: false, selectedId: null, detailCache: new Map(),
  // v4 Tier 2 — click-to-sort column state, persisted in localStorage.
  sortKey: (() => { try { return localStorage.getItem('glados-dash.proxy.sortKey') || 'ts'; } catch { return 'ts'; } })(),
  sortDir: (() => { try { return localStorage.getItem('glados-dash.proxy.sortDir') || 'asc'; } catch { return 'asc'; } })(),
  // v4 Tier 3 #9 — multi-row selection for bulk export. `selectedId` still
  // tracks the single row that populates the detail panes (last click); the
  // set below covers Shift+click ranges and Cmd/Ctrl+click toggles.
  selectedIds: new Set(),
  lastClickedId: null, // anchor for Shift+click range selection
  pendingFocus: null,
  generation: 0,
};

function clearProxyClientState() {
  if (_proxyState.es) {
    try { _proxyState.es.close(); } catch {}
    _proxyState.es = null;
  }
  _proxyState.generation += 1;
  _proxyState.rows = [];
  _proxyState.filterText = '';
  _proxyState.filterStatus = '';
  _proxyState.filterAgent = '';
  _proxyState.paused = false;
  _proxyState.selectedId = null;
  _proxyState.selectedIds.clear();
  _proxyState.lastClickedId = null;
  _proxyState.pendingFocus = null;
  _proxyState.detailCache.clear();
}

function renderProxyPane() {
  const proxyGeneration = _proxyState.generation;
  const wrap = document.createElement('div');
  wrap.className = 'proxy-pane';
  wrap.innerHTML = `
    <div class="proxy-toolbar">
      <span class="proxy-status" id="proxy-connection">connecting…</span>
      <input type="text" id="proxy-filter-text" placeholder="URL contains…" />
      <select id="proxy-filter-status">
        <option value="">all statuses</option>
        <option value="2xx">2xx</option>
        <option value="3xx">3xx</option>
        <option value="4xx">4xx</option>
        <option value="5xx">5xx</option>
        <option value="429">429</option>
      </select>
      <input type="text" id="proxy-filter-agent" placeholder="agent tag…" />
      <button id="proxy-pause" title="Pause the live stream (keeps existing rows)">Pause</button>
      <button id="proxy-clear" title="Clear the table (does not affect captured traffic)">Clear</button>
      <span class="proxy-count" id="proxy-count">0 rows</span>
      <span class="proxy-multi-count" id="proxy-multi-count"></span>
      <button id="proxy-export-csv" title="Export CSV — selected rows if any, else all visible">CSV</button>
      <button id="proxy-export-har" title="Export HAR — selected rows if any, else all visible. Fetches detail for each.">HAR</button>
    </div>
    <div class="proxy-body">
      <div class="proxy-table-host">
        <table class="proxy-table proxy-table-sortable">
          <thead>
            <tr>
              <th class="col-time"   data-sort="ts">Time</th>
              <th class="col-method" data-sort="method">Method</th>
              <th class="col-url"    data-sort="url">URL</th>
              <th class="col-status" data-sort="status">Status</th>
              <th class="col-len"    data-sort="respLen">Len</th>
              <th class="col-mime"   data-sort="mime">MIME</th>
              <th class="col-agent"  data-sort="agentTag">Agent</th>
            </tr>
          </thead>
          <tbody id="proxy-tbody"></tbody>
        </table>
      </div>
      <aside class="proxy-agents-sidebar" id="proxy-agents-sidebar" title="Per-agent metrics — click an agent to filter">
        <div class="proxy-agents-head">Per-agent (10s)</div>
        <div class="proxy-agents-list" id="proxy-agents-list">
          <div class="proxy-agents-empty">no agent traffic yet</div>
        </div>
      </aside>
    </div>
    <div class="proxy-splitter" id="proxy-splitter" title="Drag to resize"></div>
    <div class="proxy-detail-row">
      <div class="proxy-detail-col">
        <div class="proxy-detail-head">
          <span class="proxy-detail-label">Request</span>
          <span class="proxy-detail-meta" id="proxy-req-meta"></span>
          <input type="search" class="proxy-detail-search" id="proxy-req-search" placeholder="find in request (Ctrl-F)" />
          <span class="proxy-detail-search-count" id="proxy-req-search-count"></span>
          <button class="proxy-detail-copy" id="proxy-open-agent" title="Open the related agent transcript" disabled>Agent</button>
          <button class="proxy-detail-copy" id="proxy-copy-req" title="Copy raw request">Copy</button>
          <button class="proxy-detail-copy" id="proxy-replay-btn" title="Replay this request through the configured proxy">Replay...</button>
        </div>
        <pre class="proxy-detail-body" id="proxy-req-body">Select a row above.</pre>
      </div>
      <div class="proxy-detail-col">
        <div class="proxy-detail-head">
          <span class="proxy-detail-label">Response</span>
          <span class="proxy-detail-meta" id="proxy-resp-meta"></span>
          <input type="search" class="proxy-detail-search" id="proxy-resp-search" placeholder="find in response (Ctrl-F)" />
          <span class="proxy-detail-search-count" id="proxy-resp-search-count"></span>
          <button class="proxy-detail-copy" id="proxy-copy-curl" title="Copy as curl command">curl</button>
        </div>
        <pre class="proxy-detail-body" id="proxy-resp-body"></pre>
      </div>
    </div>
  `;
  paneEl.appendChild(wrap);

  const tbody = wrap.querySelector('#proxy-tbody');
  const filterText = wrap.querySelector('#proxy-filter-text');
  const filterStatus = wrap.querySelector('#proxy-filter-status');
  const filterAgent = wrap.querySelector('#proxy-filter-agent');
  const pauseBtn = wrap.querySelector('#proxy-pause');
  const clearBtn = wrap.querySelector('#proxy-clear');
  const connEl = wrap.querySelector('#proxy-connection');
  const countEl = wrap.querySelector('#proxy-count');
  const reqMetaEl = wrap.querySelector('#proxy-req-meta');
  const respMetaEl = wrap.querySelector('#proxy-resp-meta');
  const reqBodyEl = wrap.querySelector('#proxy-req-body');
  const respBodyEl = wrap.querySelector('#proxy-resp-body');
  const copyReqBtn = wrap.querySelector('#proxy-copy-req');
  const copyCurlBtn = wrap.querySelector('#proxy-copy-curl');
  const openAgentBtn = wrap.querySelector('#proxy-open-agent');
  const splitter = wrap.querySelector('#proxy-splitter');
  const tableHost = wrap.querySelector('.proxy-table-host');
  const detailRow = wrap.querySelector('.proxy-detail-row');

  filterText.value = _proxyState.filterText;
  filterStatus.value = _proxyState.filterStatus;
  filterAgent.value = _proxyState.filterAgent;
  pauseBtn.textContent = _proxyState.paused ? 'Resume' : 'Pause';

  function proxyRowMatches(r) {
    if (_proxyState.filterText && !(r.url || '').toLowerCase().includes(_proxyState.filterText.toLowerCase())) return false;
    if (_proxyState.filterAgent && !(r.agentTag || '').toLowerCase().includes(_proxyState.filterAgent.toLowerCase())) return false;
    const f = _proxyState.filterStatus;
    if (!f) return true;
    if (f === '429') return r.status === 429;
    if (f === '2xx') return r.status >= 200 && r.status < 300;
    if (f === '3xx') return r.status >= 300 && r.status < 400;
    if (f === '4xx') return r.status >= 400 && r.status < 500;
    if (f === '5xx') return r.status >= 500 && r.status < 600;
    return true;
  }

  function statusClass(s) {
    if (!s) return '';
    if (s >= 500) return 's5xx';
    if (s === 429) return 's429';
    if (s >= 400) return 's4xx';
    if (s >= 300) return 's3xx';
    return 's2xx';
  }

  function paintRow(r) {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    if (_proxyState.selectedId === r.id) tr.classList.add('selected');
    if (_proxyState.selectedIds.has(r.id)) tr.classList.add('multi-selected');
    tr.innerHTML = `
      <td class="col-time">${new Date(r.ts).toLocaleTimeString()}</td>
      <td class="col-method">${escapeHtml(r.method || '')}</td>
      <td class="col-url" title="${escapeHtml(r.url || '')}">${escapeHtml(r.url || '')}</td>
      <td class="col-status ${statusClass(r.status)}">${r.status || '—'}</td>
      <td class="col-len">${r.respLen || 0}</td>
      <td class="col-mime">${escapeHtml(r.mime || '')}</td>
      <td class="col-agent">${escapeHtml(r.agentTag || '')}</td>
    `;
    tr.addEventListener('click', ev => handleRowClick(r, ev));
    return tr;
  }

  // v4 Tier 3 #9 — Shift+click = range select (across currently visible rows
  // under the active sort), Cmd/Ctrl+click = toggle, plain click = single.
  function handleRowClick(r, ev) {
    const visible = sortRows(_proxyState.rows.filter(proxyRowMatches));
    if (ev.shiftKey && _proxyState.lastClickedId != null) {
      const a = visible.findIndex(x => x.id === _proxyState.lastClickedId);
      const b = visible.findIndex(x => x.id === r.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        _proxyState.selectedIds.clear();
        for (let i = lo; i <= hi; i++) _proxyState.selectedIds.add(visible[i].id);
      }
    } else if (ev.metaKey || ev.ctrlKey) {
      if (_proxyState.selectedIds.has(r.id)) _proxyState.selectedIds.delete(r.id);
      else _proxyState.selectedIds.add(r.id);
    } else {
      _proxyState.selectedIds.clear();
    }
    _proxyState.lastClickedId = r.id;
    selectRow(r);
    // Re-paint only the multi-selected class state on visible rows (cheap).
    for (const el of tbody.querySelectorAll('tr')) {
      const id = Number(el.dataset.id);
      el.classList.toggle('multi-selected', _proxyState.selectedIds.has(id));
    }
    updateMultiCount();
  }

  function updateMultiCount() {
    const el = wrap.querySelector('#proxy-multi-count');
    if (!el) return;
    const n = _proxyState.selectedIds.size;
    el.textContent = n > 0 ? `· ${n} selected` : '';
  }

  function headersToString(h) {
    if (!h) return '';
    return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  function formatRequest(d, r) {
    const line = d?.requestLine || `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search} HTTP/1.1`;
    const headers = headersToString(d?.requestHeaders);
    const body = d?.requestBody || '';
    const truncated = d?.requestBodyTruncated ? `\n\n[... body truncated; full length ${d.requestBodyLen} bytes ...]` : '';
    return `${line}\n${headers}${body ? '\n\n' + body : ''}${truncated}`;
  }

  function formatResponse(d, r) {
    const line = d?.statusLine || `HTTP/1.1 ${r.status || '—'}`;
    const headers = headersToString(d?.responseHeaders);
    const body = d?.responseBody || '';
    const truncated = d?.responseBodyTruncated ? `\n\n[... body truncated; full length ${d.responseBodyLen} bytes ...]` : '';
    return `${line}\n${headers}${body ? '\n\n' + body : ''}${truncated}`;
  }

  function selectRow(r) {
    _proxyState.selectedId = r.id;
    for (const el of tbody.querySelectorAll('tr')) {
      el.classList.toggle('selected', Number(el.dataset.id) === r.id);
    }
    reqMetaEl.textContent = `${r.method} ${r.url}`;
    respMetaEl.textContent = `${r.status || '—'} · ${r.mime || ''} · ${r.respLen}B · ${r.agentTag ? 'agent=' + r.agentTag : 'no tag'}`;
    openAgentBtn.disabled = !r.agentTag;
    openAgentBtn.textContent = r.agentTag ? `Open ${r.agentTag}` : 'Agent';
    openAgentBtn.onclick = () => openAgentProvenance(r);
    reqBodyEl.textContent = 'loading…';
    respBodyEl.textContent = 'loading…';

    const cached = _proxyState.detailCache.get(r.id);
    if (cached) {
      reqBodyEl.textContent = formatRequest(cached, r);
      respBodyEl.textContent = formatResponse(cached, r);
      return;
    }

    fetch(`/api/proxy/detail?id=${encodeURIComponent(r.id)}`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error('detail fetch failed')))
      .then(d => {
        // Cap cache at 200 entries so long sessions don't bloat memory.
        if (_proxyState.detailCache.size > 200) {
          const firstKey = _proxyState.detailCache.keys().next().value;
          _proxyState.detailCache.delete(firstKey);
        }
        _proxyState.detailCache.set(r.id, d);
        if (_proxyState.selectedId !== r.id) return; // user moved on
        reqBodyEl.textContent = formatRequest(d, r);
        respBodyEl.textContent = formatResponse(d, r);
      })
      .catch(() => {
        if (_proxyState.selectedId !== r.id) return;
        reqBodyEl.textContent = formatRequest(null, r);
        respBodyEl.textContent = '(detail endpoint unavailable for the selected proxy backend)';
      });
  }

  function sortRows(rows) {
    const key = _proxyState.sortKey, dir = _proxyState.sortDir === 'asc' ? 1 : -1;
    const out = rows.slice();
    out.sort((a, b) => {
      let av = a?.[key], bv = b?.[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
    return out;
  }

  function refreshAll() {
    tbody.innerHTML = '';
    const visible = sortRows(_proxyState.rows.filter(proxyRowMatches));
    for (const r of visible) tbody.appendChild(paintRow(r));
    countEl.textContent = `${visible.length} / ${_proxyState.rows.length} rows`;
    paintSortIndicators();
  }

  function focusPendingTraffic() {
    const focus = _proxyState.pendingFocus;
    if (!focus || !_proxyState.rows.length) return;
    const host = (() => { try { return new URL(focus.url).hostname; } catch { return focus.url || ''; } })();
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestHasHost = false;
    for (const row of _proxyState.rows) {
      if (focus.agentId && row.agentTag !== focus.agentId) continue;
      const hasHost = !!(host && String(row.url || '').includes(host));
      const urlPenalty = hasHost ? 0 : 120_000;
      const rowTs = Number(row.ts) || Date.parse(row.ts || '') || 0;
      const timePenalty = rowTs && focus.ts ? Math.abs(rowTs - focus.ts) : 60_000;
      const score = urlPenalty + timePenalty;
      if (score < bestScore) { best = row; bestScore = score; bestHasHost = hasHost; }
    }
    if (!best || (!bestHasHost && bestScore > 300_000)) return;
    _proxyState.pendingFocus = null;
    selectRow(best);
    const rowEl = tbody.querySelector(`tr[data-id="${best.id}"]`);
    rowEl?.classList.add('provenance-focus');
    rowEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => rowEl?.classList.remove('provenance-focus'), 4500);
  }

  function paintSortIndicators() {
    wrap.querySelectorAll('thead th[data-sort]').forEach(th => {
      const k = th.dataset.sort;
      th.classList.toggle('sort-active', k === _proxyState.sortKey);
      th.classList.toggle('sort-asc',    k === _proxyState.sortKey && _proxyState.sortDir === 'asc');
      th.classList.toggle('sort-desc',   k === _proxyState.sortKey && _proxyState.sortDir === 'desc');
    });
  }

  // Click-to-sort column headers (persisted in localStorage).
  wrap.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (_proxyState.sortKey === k) {
        _proxyState.sortDir = _proxyState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _proxyState.sortKey = k;
        _proxyState.sortDir = (k === 'respLen' || k === 'status') ? 'desc' : 'asc';
      }
      try {
        localStorage.setItem('glados-dash.proxy.sortKey', _proxyState.sortKey);
        localStorage.setItem('glados-dash.proxy.sortDir', _proxyState.sortDir);
      } catch {}
      refreshAll();
    });
  });

  let _refreshAllQueued = false;
  function appendLive(r) {
    if (_proxyState.paused) return;
    _proxyState.rows.push(r);
    if (_proxyState.rows.length > _proxyState.maxRows) {
      _proxyState.rows.splice(0, _proxyState.rows.length - _proxyState.maxRows);
    }
    // Fast path: default chronological sort (ts asc) — append to bottom, autoscroll.
    // Any other sort: debounce a full refreshAll (sort-aware re-paint).
    const isDefault = _proxyState.sortKey === 'ts' && _proxyState.sortDir === 'asc';
    if (isDefault) {
      if (proxyRowMatches(r)) {
        tbody.appendChild(paintRow(r));
        countEl.textContent = `${tbody.children.length} / ${_proxyState.rows.length} rows`;
        if (tableHost.scrollTop + tableHost.clientHeight + 50 >= tableHost.scrollHeight) tableHost.scrollTop = tableHost.scrollHeight;
      }
    } else if (!_refreshAllQueued) {
      _refreshAllQueued = true;
      setTimeout(() => { _refreshAllQueued = false; refreshAll(); }, 120);
    }
    if (_proxyState.pendingFocus) focusPendingTraffic();
  }

  // Filter wiring
  const onFilterChange = () => {
    _proxyState.filterText = filterText.value;
    _proxyState.filterStatus = filterStatus.value;
    _proxyState.filterAgent = filterAgent.value;
    refreshAll();
  };
  filterText.addEventListener('input', onFilterChange);
  filterStatus.addEventListener('change', onFilterChange);
  filterAgent.addEventListener('input', onFilterChange);
  pauseBtn.addEventListener('click', () => {
    _proxyState.paused = !_proxyState.paused;
    pauseBtn.textContent = _proxyState.paused ? 'Resume' : 'Pause';
  });
  clearBtn.addEventListener('click', () => {
    _proxyState.rows = [];
    _proxyState.detailCache.clear();
    _proxyState.selectedIds.clear();
    _proxyState.lastClickedId = null;
    refreshAll();
    updateMultiCount();
  });

  // v4 Tier 3 #9 — Export helpers. If any rows are multi-selected, export
  // only those; otherwise export all currently-visible (filtered + sorted).
  function rowsForExport() {
    if (_proxyState.selectedIds.size > 0) {
      return _proxyState.rows.filter(r => _proxyState.selectedIds.has(r.id));
    }
    return sortRows(_proxyState.rows.filter(proxyRowMatches));
  }

  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
  }

  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    // RFC 4180: quote if contains quote/comma/newline; escape internal quotes.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  wrap.querySelector('#proxy-export-csv').addEventListener('click', () => {
    const rows = rowsForExport();
    if (!rows.length) return;
    const cols = ['id', 'ts', 'method', 'url', 'status', 'respLen', 'mime', 'agentTag'];
    const lines = [cols.join(',')];
    for (const r of rows) {
      lines.push(cols.map(c => {
        if (c === 'ts') return csvEscape(new Date(r.ts).toISOString());
        return csvEscape(r[c]);
      }).join(','));
    }
    downloadBlob(`glados-proxy-${Date.now()}.csv`, lines.join('\n'), 'text/csv');
  });

  wrap.querySelector('#proxy-export-har').addEventListener('click', async () => {
    const rows = rowsForExport();
    if (!rows.length) return;
    // Fetch details for rows not already in cache (in parallel, capped).
    const missing = rows.filter(r => !_proxyState.detailCache.has(r.id));
    if (missing.length) {
      const chunkSize = 8;
      for (let i = 0; i < missing.length; i += chunkSize) {
        const slice = missing.slice(i, i + chunkSize);
        await Promise.all(slice.map(r =>
          fetch(`/api/proxy/detail?id=${encodeURIComponent(r.id)}`)
            .then(res => res.ok ? res.json() : null)
            .then(d => { if (d) _proxyState.detailCache.set(r.id, d); })
            .catch(() => {})
        ));
      }
    }
    const entries = rows.map(r => {
      const d = _proxyState.detailCache.get(r.id) || {};
      const u = (() => { try { return new URL(r.url); } catch { return null; } })();
      const reqHeaders = Object.entries(d.requestHeaders || {}).map(([n, v]) => ({ name: n, value: String(v) }));
      const respHeaders = Object.entries(d.responseHeaders || {}).map(([n, v]) => ({ name: n, value: String(v) }));
      const queryString = u ? [...u.searchParams].map(([n, v]) => ({ name: n, value: v })) : [];
      return {
        startedDateTime: new Date(r.ts).toISOString(),
        time: 0,
        request: {
          method: r.method,
          url: r.url,
          httpVersion: 'HTTP/1.1',
          headers: reqHeaders,
          queryString,
          headersSize: -1,
          bodySize: r.reqLen || 0,
          cookies: [],
          postData: d.requestBody ? { mimeType: '', text: d.requestBody } : undefined,
        },
        response: {
          status: r.status || 0,
          statusText: (d.statusLine || '').split(' ').slice(2).join(' ') || '',
          httpVersion: 'HTTP/1.1',
          headers: respHeaders,
          cookies: [],
          content: {
            size: r.respLen || 0,
            mimeType: r.mime || '',
            text: d.responseBody || '',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: r.respLen || 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _gladosAgent: r.agentTag || '',
      };
    });
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'GLaDOS Dashboard', version: '3.1.04242026' },
        entries,
      },
    };
    downloadBlob(`glados-proxy-${Date.now()}.har`, JSON.stringify(har, null, 2), 'application/json');
  });

  copyReqBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(reqBodyEl.textContent || '').catch(() => {});
  });
  copyCurlBtn.addEventListener('click', () => {
    const id = _proxyState.selectedId;
    const row = _proxyState.rows.find(x => x.id === id);
    if (!row) return;
    const d = _proxyState.detailCache.get(id);
    navigator.clipboard.writeText(toCurl(row, d)).catch(() => {});
  });

  // v4 — In-detail search. Highlights matches in the <pre>; arrows cycle.
  function attachDetailSearch(preEl, inputEl, countEl) {
    let matches = [], cursor = 0, baseText = '';
    const originalTextOf = () => preEl.dataset.plain || preEl.textContent || '';

    function cacheBase() {
      if (preEl.dataset.plain === undefined) preEl.dataset.plain = preEl.textContent || '';
      baseText = preEl.dataset.plain;
    }
    function clear() {
      cacheBase();
      preEl.textContent = baseText;
      matches = []; cursor = 0;
      countEl.textContent = '';
    }
    function apply() {
      cacheBase();
      const q = inputEl.value;
      if (!q) { clear(); return; }
      const needle = q.toLowerCase();
      const hay = baseText.toLowerCase();
      matches = [];
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) { matches.push(i); i += Math.max(1, needle.length); }
      if (!matches.length) { preEl.textContent = baseText; countEl.textContent = '0'; return; }
      // Rebuild HTML with <mark> spans around each match.
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [idx, start] of matches.entries()) {
        if (start > pos) frag.appendChild(document.createTextNode(baseText.slice(pos, start)));
        const mark = document.createElement('mark');
        mark.className = 'proxy-detail-mark' + (idx === cursor ? ' current' : '');
        mark.textContent = baseText.slice(start, start + q.length);
        frag.appendChild(mark);
        pos = start + q.length;
      }
      if (pos < baseText.length) frag.appendChild(document.createTextNode(baseText.slice(pos)));
      preEl.innerHTML = '';
      preEl.appendChild(frag);
      cursor = Math.min(cursor, matches.length - 1);
      countEl.textContent = `${cursor + 1} / ${matches.length}`;
      const cur = preEl.querySelector('mark.current');
      cur?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    function step(dir) {
      if (!matches.length) return;
      cursor = (cursor + dir + matches.length) % matches.length;
      apply();
    }
    inputEl.addEventListener('input', () => { cursor = 0; apply(); });
    inputEl.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); step(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { inputEl.value = ''; clear(); }
    });
    return { clear, apply, invalidateBase: () => { delete preEl.dataset.plain; apply(); } };
  }

  const reqSearch  = attachDetailSearch(reqBodyEl,  wrap.querySelector('#proxy-req-search'),  wrap.querySelector('#proxy-req-search-count'));
  const respSearch = attachDetailSearch(respBodyEl, wrap.querySelector('#proxy-resp-search'), wrap.querySelector('#proxy-resp-search-count'));
  // Global Ctrl-F: when focus is inside the proxy pane, redirect to the nearer search box.
  wrap.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      wrap.querySelector('#proxy-req-search').focus();
    }
  });
  // When the selected row's text changes we must re-run search highlighting.
  const origSelectRow = selectRow;
  selectRow = function patchedSelectRow(r) {
    origSelectRow(r);
    setTimeout(() => { reqSearch.invalidateBase(); respSearch.invalidateBase(); }, 0);
  };

  // Replay modal. Opens with the selected row's method/url/headers/body
  // pre-filled, fires through the configured proxy with the row's agent tag,
  // and shows the response inline.
  wrap.querySelector('#proxy-replay-btn').addEventListener('click', () => openReplayModal());

  function openReplayModal() {
    const id = _proxyState.selectedId;
    const row = _proxyState.rows.find(x => x.id === id);
    if (!row) { showToast('Select a proxy row first.', { kind: 'warning', label: 'Replay' }); return; }
    const d = _proxyState.detailCache.get(id) || {};
    const headersText = d.requestHeaders
      ? Object.entries(d.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
      : '';
    const bodyText = d.requestBody || '';
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal replay-modal">
        <div class="modal-head">
          <span>Replay request</span>
          <button class="modal-close" title="Close">✕</button>
        </div>
        <div class="replay-form">
          <div class="replay-row">
            <select id="replay-method">
              ${['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']
                .map(m => `<option${m === (row.method || 'GET').toUpperCase() ? ' selected' : ''}>${m}</option>`).join('')}
            </select>
            <input id="replay-url" type="text" value="${escapeHtml(row.url || '')}" />
            <input id="replay-agent" type="text" value="${escapeHtml(row.agentTag || 'replay')}" title="X-GLaDOS-Agent tag for this replay" />
            <button class="primary" id="replay-send">Send</button>
          </div>
          <label>Headers (one per line, <code>Key: Value</code>)</label>
          <textarea id="replay-headers" spellcheck="false">${escapeHtml(headersText)}</textarea>
          <label>Body</label>
          <textarea id="replay-body" spellcheck="false">${escapeHtml(bodyText)}</textarea>
          <div class="replay-status" id="replay-status"></div>
          <label>Response</label>
          <pre class="replay-response" id="replay-response">(no response yet)</pre>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    backdrop.querySelector('.modal-close').addEventListener('click', close);
    window.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); }
    });

    backdrop.querySelector('#replay-send').addEventListener('click', async () => {
      const statusEl = backdrop.querySelector('#replay-status');
      const respEl = backdrop.querySelector('#replay-response');
      statusEl.textContent = 'sending…';
      respEl.textContent = '';
      const hdrsRaw = backdrop.querySelector('#replay-headers').value;
      const hdrs = {};
      for (const line of hdrsRaw.split(/\r?\n/)) {
        const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
        if (m) hdrs[m[1]] = m[2];
      }
      // Drop hop-by-hop / auto-managed headers — fetch() will set them itself.
      for (const k of ['host','content-length','connection','transfer-encoding','accept-encoding']) {
        Object.keys(hdrs).forEach(h => { if (h.toLowerCase() === k) delete hdrs[h]; });
      }
      const payload = {
        method: backdrop.querySelector('#replay-method').value,
        url: backdrop.querySelector('#replay-url').value,
        headers: hdrs,
        body: backdrop.querySelector('#replay-body').value || null,
        agentTag: backdrop.querySelector('#replay-agent').value || 'replay',
        timeoutMs: 15000,
      };
      try {
        const t0 = performance.now();
        const r = await fetch('/api/proxy/replay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        const elapsed = (performance.now() - t0).toFixed(0);
        if (!r.ok || data.ok === false) {
          statusEl.textContent = `error: ${data.error || r.status} (${elapsed}ms)`;
          respEl.textContent = JSON.stringify(data, null, 2);
          return;
        }
        statusEl.textContent = `${data.status} ${data.statusText || ''} · ${data.elapsedMs}ms${data.proxied ? ' · through proxy' : ' · direct'}`;
        const respHdrs = Object.entries(data.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
        respEl.textContent = `HTTP ${data.status} ${data.statusText || ''}\n${respHdrs}\n\n${data.body || ''}`;
      } catch (e) {
        statusEl.textContent = 'fetch failed: ' + e.message;
      }
    });
  }

  // Drag splitter for request/response bottom panel resize.
  let dragging = false;
  splitter.addEventListener('mousedown', () => { dragging = true; document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const paneRect = wrap.getBoundingClientRect();
    const bottomHeight = Math.max(120, Math.min(paneRect.bottom - e.clientY, paneRect.height - 180));
    detailRow.style.height = `${bottomHeight}px`;
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });

  // Initial backfill + live stream
  connEl.textContent = 'connecting…';
  connEl.className = 'proxy-status connecting';

  fetchJson('/api/proxy/history?limit=500', { timeoutMs: 20000, retries: 1 })
    .then(rows => {
      if (proxyGeneration !== _proxyState.generation) return;
      if (!Array.isArray(rows)) return;
      _proxyState.rows = rows;
      refreshAll();
      focusPendingTraffic();
    })
    .catch(() => {
      tbody.innerHTML = `<tr><td colspan="7" class="proxy-empty">No proxy traffic yet. Traffic will appear when the configured proxy backend is running.</td></tr>`;
    });

  if (_proxyState.es) { try { _proxyState.es.close(); } catch {} _proxyState.es = null; }
  const es = new EventSource('/api/proxy/stream');
  es.onopen = async () => {
    try {
      const health = await fetchJson('/api/health/proxy', { timeoutMs: 10000, retries: 1 });
      if (!health.healthy) {
        connEl.textContent = `offline — ${health.processStatus || 'proxy unavailable'}`;
        connEl.title = health.error || '';
        connEl.className = 'proxy-status offline';
        return;
      }
      connEl.textContent = 'live';
      connEl.title = '';
      connEl.className = 'proxy-status live';
    } catch {
      connEl.textContent = 'offline — health unavailable';
      connEl.className = 'proxy-status offline';
    }
  };
  es.onmessage = ev => {
    if (proxyGeneration !== _proxyState.generation) return;
    try {
      const r = JSON.parse(ev.data);
      appendLive(r);
    } catch {}
  };
  es.onerror = () => {
    connEl.textContent = 'offline — retrying…';
    connEl.className = 'proxy-status offline';
  };
  _proxyState.es = es;

  // v4 — per-agent metrics poll. Refreshes the sidebar every 2s.
  const sidebarList = wrap.querySelector('#proxy-agents-list');
  async function refreshAgentMetrics() {
    if (!sidebarList.isConnected) return; // pane was replaced
    try {
      const r = await fetch('/api/proxy/metrics?window=10');
      const data = await r.json();
      const agents = data.agents || [];
      if (!agents.length) {
        sidebarList.innerHTML = '<div class="proxy-agents-empty">no agent traffic (10s)</div>';
        return;
      }
      sidebarList.innerHTML = agents.map(a => {
        const isFiltered = _proxyState.filterAgent && a.agent.toLowerCase() === _proxyState.filterAgent.toLowerCase();
        const errClass = a.errorRate >= 0.1 ? 'hot' : a.errorRate >= 0.02 ? 'warn' : 'ok';
        return `<div class="proxy-agent-card ${isFiltered ? 'filtered' : ''}" data-agent="${escapeHtml(a.agent)}">
          <div class="proxy-agent-name">${escapeHtml(a.agent)}</div>
          <div class="proxy-agent-stats">
            <span class="proxy-agent-rps">${a.rps.toFixed(1)} rps</span>
            <span class="proxy-agent-err ${errClass}">${(a.errorRate * 100).toFixed(0)}% err</span>
            <span class="proxy-agent-count">${a.requests} req</span>
          </div>
        </div>`;
      }).join('');
      sidebarList.querySelectorAll('.proxy-agent-card').forEach(card => {
        card.addEventListener('click', () => {
          const agent = card.dataset.agent;
          // Toggle: click same agent to clear filter, different agent to replace.
          const newVal = (_proxyState.filterAgent === agent) ? '' : agent;
          _proxyState.filterAgent = newVal;
          filterAgent.value = newVal;
          refreshAll();
          refreshAgentMetrics();
        });
      });
    } catch { /* silent — healthy banner covers extension-down */ }
  }
  refreshAgentMetrics();
  const metricsTimer = setInterval(() => {
    if (!sidebarList.isConnected) { clearInterval(metricsTimer); return; }
    refreshAgentMetrics();
  }, 2000);
}

function toCurl(r) {
  const m = (r.method || 'GET').toUpperCase();
  const flags = m === 'GET' ? '' : ` -X ${m}`;
  return `curl -sS${flags} '${(r.url || '').replace(/'/g, `'\\''`)}'`;
}

// --- Settings ---

async function renderSettingsPane() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-pane';
  wrap.innerHTML = `
    <h1>Settings</h1>
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
    <section class="settings-section">
      <h2>Agents</h2>
      <div id="settings-version" class="settings-version">Version loading…</div>
      <div id="settings-model-catalog" class="settings-version">LiteLLM model catalog loading…</div>
      <p style="color:var(--fg-dim);">Open any agents you want to edit, choose their models, then save all staged assignments together. New turns pick up saved models automatically.</p>
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
        <button id="settings-save-models" type="button" class="safe" disabled>Save Changes</button>
      </div>
      <div id="settings-list">loading…</div>
    </section>`;
  paneEl.appendChild(wrap);
  wireOperationControls(wrap);
  wrap.querySelectorAll('[data-dashboard-theme]').forEach(button => {
    button.addEventListener('click', () => applyDashboardTheme(button.dataset.dashboardTheme));
  });
  applyDashboardTheme(state.theme, { persist: false });

  try {
    const [versionInfo, modelsResp, settingsResp] = await Promise.all([
      fetchJson('/api/version', { timeoutMs: 5000 }).catch(e => ({ error: e.message })),
      fetchJson('/api/models', { timeoutMs: 8000 }),
      fetchJson('/api/settings/agents', { timeoutMs: 8000 }),
    ]);
    renderSettingsVersion(versionInfo);
    const models = modelsResp.models || [];
    const modelCatalogEl = document.getElementById('settings-model-catalog');
    if (modelsResp.available) {
      modelCatalogEl.innerHTML = `<span class="settings-version-label">LiteLLM Models</span><code>${models.length}</code><span class="settings-version-hint">live catalog</span>`;
    } else {
      modelCatalogEl.innerHTML = `<span class="settings-version-label">LiteLLM Models</span><code>unavailable</code><span class="settings-version-hint">${escapeHtml(modelsResp.message || 'model discovery failed')}</span>`;
    }
    const settingsAgents = settingsResp.agents || [];
    const listEl = document.getElementById('settings-list');
    const settingsSearch = document.getElementById('settings-agent-search');
    const saveModels = document.getElementById('settings-save-models');
    const pendingModels = document.getElementById('settings-pending-models');
    const modelDrafts = new Map();
    let savingModels = false;

    const refreshModelSaveBar = () => {
      const count = modelDrafts.size;
      pendingModels.textContent = count ? `${count} pending model change${count === 1 ? '' : 's'}` : 'No pending model changes';
      saveModels.disabled = !count || savingModels;
      saveModels.textContent = savingModels ? 'Saving...' : `Save Changes${count ? ` (${count})` : ''}`;
    };

    const stageModelChange = (agentId, expectedModel, model, card, select) => {
      if (model === expectedModel) modelDrafts.delete(agentId);
      else modelDrafts.set(agentId, { agentId, expectedModel, model });
      card.dataset.model = model;
      card.classList.toggle('model-dirty', modelDrafts.has(agentId));
      select.classList.toggle('model-dirty', modelDrafts.has(agentId));
      card.querySelector('[data-model-error]')?.remove();
      refreshModelSaveBar();
    };

    saveModels.addEventListener('click', async () => {
      const submitted = [...modelDrafts.values()].map(change => ({ ...change }));
      if (!submitted.length || savingModels) return;
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
        const matchesQuery = !query || `${card.dataset.agentId} ${card.dataset.model || ''}`.toLowerCase().includes(query);
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
    for (const agent of settingsAgents) {
      const card = document.createElement('div');
      card.className = `agent-card ${agent.enabled ? '' : 'disabled-agent'}`;
      card.dataset.agentId = agent.id;
      card.dataset.enabled = String(!!agent.enabled);
      card.dataset.model = agent.model || '';
      card.dataset.committedModel = agent.model || '';
      const badges = [
        agent.enabled ? '<span class="agent-badge enabled">enabled</span>' : '<span class="agent-badge disabled">disabled</span>',
        agent.registered
          ? '<span class="agent-badge registered">registered</span>'
          : (agent.enabled ? '<span class="agent-badge pending">pending restart</span>' : '<span class="agent-badge pending">not loaded</span>'),
        agent.dispatch === 'conditional' ? '<span class="agent-badge conditional">conditional</span>' : '',
        agent.subagent === false ? '<span class="agent-badge separate">not subagent</span>' : '',
      ].filter(Boolean).join('');
      card.innerHTML = `
        <div class="agent-card-head">
          <span class="title">${escapeHtml(agent.id)}</span>
          <span class="agent-card-badges">${badges}</span>
          <span class="caret">▸</span>
        </div>
        <div class="agent-card-body" data-loaded="false">
          <div style="color:var(--fg-dim);">loading details…</div>
        </div>`;
      card.querySelector('.agent-card-head').addEventListener('click', async () => {
        const isOpen = card.classList.toggle('open');
        const body = card.querySelector('.agent-card-body');
        if (isOpen && body.dataset.loaded === 'false') {
          await hydrateAgentCard(agent.id, body, models, {
            draft: modelDrafts.get(agent.id),
            onModelChange: (expectedModel, model, select) => stageModelChange(agent.id, expectedModel, model, card, select),
          });
          body.dataset.loaded = 'true';
        }
      });
      listEl.appendChild(card);
    }
    applySettingsFilter();
  } catch (e) {
    document.getElementById('settings-list').textContent = 'error: ' + e.message;
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

async function hydrateAgentCard(agentId, body, models, { draft = null, onModelChange = null } = {}) {
  try {
    const d = await fetchJson(`/api/agents/${encodeURIComponent(agentId)}/details`, { timeoutMs: 8000 });
    if (d.error) { body.textContent = 'error: ' + d.error; return; }
    const liveModels = new Set(models || []);
    const selectedModel = draft?.model || d.model;
    const modelChoices = [...new Set([selectedModel, d.model, ...liveModels].filter(Boolean))];
    const modelOpts = modelChoices.map(m => {
      const unavailable = m === d.model && !liveModels.has(m);
      return `<option value="${escapeHtml(m)}"${m === selectedModel ? ' selected' : ''}>${escapeHtml(m)}${unavailable ? ' (unavailable on LiteLLM)' : ''}</option>`;
    }).join('');
    const skills = (d.skills || []).map(s =>
      `<div class="skill"><strong>${escapeHtml(s.name)}</strong>${s.description ? `<span class="desc">${escapeHtml(s.description.slice(0, 300))}${s.description.length > 300 ? '…' : ''}</span>` : ''}</div>`
    ).join('') || '<div style="color:var(--fg-dim);">no skills</div>';
    body.innerHTML = `
      <label>Agent State</label>
      <div class="agent-state-row">
        <span class="agent-state-copy">
          <strong>${d.enabled ? 'Enabled' : 'Disabled'}</strong>
          ${d.registered ? 'loaded by Agent SDK runtime' : (d.enabled ? 'enabled locally for next turn' : 'not loaded while disabled')}
          ${d.dispatch ? ` · ${escapeHtml(d.dispatch)}` : ''}
          ${d.subagent === false ? ' · not dispatchable as subagent' : ''}
        </span>
        <button data-toggle-enabled ${agentId === 'glados' ? 'disabled title="GLaDOS cannot be disabled from Settings"' : ''}>
          ${d.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      <label>Model (saved: <code data-saved-model>${escapeHtml(d.model || '?')}</code>)</label>
      <div class="model-row">
        <select data-model-select ${d.registered ? '' : 'disabled'}>${modelOpts}</select>
      </div>

      <label>Workspace</label>
      <div class="doc" style="max-height:none;font-size:11px;color:var(--fg-dim);">${escapeHtml(d.workspace || '')}</div>

      <label>MCP Servers</label>
      <div class="doc" style="max-height:none;">${(d.mcp || []).map(m => escapeHtml(m)).join(', ') || '(none)'}</div>

      <label>Skills (${(d.skills || []).length})</label>
      <div class="skill-list">${skills}</div>

      <label>AGENTS.md</label>
      <div class="doc">${escapeHtml(d.agentsDoc || '(missing)')}</div>

      <label>TOOLS.md</label>
      <div class="doc">${escapeHtml(d.toolsDoc || '(missing)')}</div>

      <label>RUNBOOK.md</label>
      <div class="doc">${escapeHtml(d.runbook || '(missing)')}</div>

      <label>IDENTITY.md</label>
      <div class="doc">${escapeHtml(d.identity || '(missing)')}</div>
    `;
    const modelSelect = body.querySelector('[data-model-select]');
    if (draft) modelSelect?.classList.add('model-dirty');
    modelSelect?.addEventListener('change', () => onModelChange?.(d.model, modelSelect.value, modelSelect));
    body.querySelector('[data-toggle-enabled]')?.addEventListener('click', async () => {
      const nextEnabled = !d.enabled;
      const action = nextEnabled ? 'enable' : 'disable';
      if (!await confirmAction({
        title: `${action[0].toUpperCase()}${action.slice(1)} agent`,
        message: `${action[0].toUpperCase()}${action.slice(1)} ${agentId}?\n\nThis updates its local agent.json. New Agent SDK turns pick it up automatically.`,
        confirmLabel: `${action[0].toUpperCase()}${action.slice(1)} ${agentId}`,
        danger: !nextEnabled,
      })) return;
      const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      }).then(r => r.json());
      if (r.ok) {
        logEvent('started', `${agentId} ${nextEnabled ? 'enabled' : 'disabled'}`);
        await loadAgents();
        renderPane();
      } else {
        pushNotification('error', 'Update failed: ' + (r.error || 'unknown'), { toast: true, label: agentId });
      }
    });
  } catch (e) {
    body.textContent = 'error: ' + e.message;
  }
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
  if (!badge) return;
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

document.getElementById('open-overview').addEventListener('click', ev => { ev.preventDefault(); openOverview(); });
document.getElementById('open-glados').addEventListener('click', ev => { ev.preventDefault(); openGladosChat(); });
document.getElementById('open-plans').addEventListener('click', ev => { ev.preventDefault(); openPlans(); });
document.getElementById('open-reports').addEventListener('click', ev => { ev.preventDefault(); openReports(); });
document.getElementById('open-settings').addEventListener('click', ev => { ev.preventDefault(); openSettings(); });
document.getElementById('open-terminal').addEventListener('click', ev => { ev.preventDefault(); openTerminal(); });
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

function applyPersistentLayout() {
  const root = document.documentElement;
  const sidebarWidth = Math.max(190, Math.min(420, Number(localStorage.getItem('glados-dash.sidebar-width')) || 248));
  const eventsHeight = Math.max(34, Math.min(260, Number(localStorage.getItem('glados-dash.events-height')) || 96));
  const savedSidebarState = localStorage.getItem('glados-dash.sidebar-collapsed');
  const sidebarCollapsed = savedSidebarState === '1' || (savedSidebarState === null && window.innerWidth <= 760);
  const eventsCollapsed = localStorage.getItem('glados-dash.events-collapsed') === '1';
  root.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  root.style.setProperty('--events-height', `${eventsHeight}px`);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  document.body.classList.toggle('events-collapsed', eventsCollapsed);
  document.getElementById('events-collapse').textContent = eventsCollapsed ? 'Expand' : 'Collapse';
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
    apply(localStorage.getItem(KEY) === '1');
    heading.addEventListener('click', () => {
      const next = !heading.classList.contains('collapsed');
      localStorage.setItem(KEY, next ? '1' : '0');
      apply(next);
    });
  }
})();

loadInvestigationSessions().then(() => Promise.all([loadAgents(), loadSecurityReviews()])).then(() => {
  const allowedStatic = new Set(['overview', 'glados-chat', 'plans', 'reports', 'settings', 'terminal', 'proxy', 'update']);
  const agentIds = new Set(state.agents.map(agent => agent.id).filter(id => id !== 'glados'));
  const savedTabs = storageGetJson('glados-dash.open-tabs', []);
  state.openTabs = Array.isArray(savedTabs)
    ? savedTabs.filter(tab => tab && (allowedStatic.has(tab.id) || agentIds.has(tab.id)))
    : [];
  if (!state.openTabs.some(tab => tab.id === 'glados-chat')) state.openTabs.push({ id: 'glados-chat', kind: 'chat', label: 'GLaDOS Chat' });
  if (!state.openTabs.some(tab => tab.id === 'overview')) state.openTabs.unshift({ id: 'overview', kind: 'overview', label: 'Overview' });
  const savedCurrent = localStorage.getItem('glados-dash.current-tab');
  state.currentTab = state.openTabs.some(tab => tab.id === savedCurrent) ? savedCurrent : 'overview';
  renderTabs();
  renderAgentList();
  updateWorkspaceNav();
  renderPane();
  subscribeLobby();
  setupHealthBanner();
});

wirePersistentLayout();
renderNotifications();
