const state = {
  agents: [],          // from /api/agents
  active: new Map(),   // agentId -> { sessionId }
  openTabs: [],        // [{ id: 'glados-chat' | agentId, kind: 'chat'|'agent', label }]
  currentTab: null,
  transcripts: new Map(), // tabId -> { es, el, events[], sending }
  agentsLoadedOnce: false,
};

const tabsEl = document.getElementById('tabs');
const paneEl = document.getElementById('pane');
const agentListEl = document.getElementById('agent-list');
const eventsEl = document.getElementById('events');
const errorsOnlyEl = document.getElementById('errors-only');
const debugModeEl = document.getElementById('debug-mode');
const haltOneBtn = document.getElementById('halt-one');
const haltAllBtn = document.getElementById('halt-all');

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

haltAllBtn.addEventListener('click', async () => {
  if (!confirm('HALT ALL agents now?')) return;
  const r = await fetch('/api/halt-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'dashboard halt-all' }),
  });
  const j = await r.json();
  logEvent('ended', `halt-all -> ${j.ok ? 'ok' : (j.error || 'error')}`);
});

haltOneBtn.addEventListener('click', async () => {
  if (!state.currentTab || state.currentTab === 'glados-chat') return;
  const r = await fetch('/api/halt/' + encodeURIComponent(state.currentTab), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'dashboard halt' }),
  });
  const j = await r.json();
  logEvent('ended', `halt ${state.currentTab} -> ${j.ok ? 'ok' : (j.error || 'error')}`);
});

async function loadAgents() {
  const res = await fetch('/api/agents');
  const j = await res.json();
  const previouslyActive = new Set(state.active.keys());
  state.agents = j.agents || [];
  state.active.clear();
  for (const a of state.agents) {
    if (a.active) state.active.set(a.id, { sessionId: a.session?.sessionId });
  }
  for (const a of state.agents) {
    if (!a.active || a.id === 'glados' || a.id === 'atlas') continue;
    if (state.openTabs.find(t => t.id === a.id)) continue;
    // If the lobby SSE missed session-started, polling still notices the live
    // agent and opens/subscribes to its transcript. First load also subscribes
    // to any already-running agents before GLaDOS becomes the active tab.
    if (!state.agentsLoadedOnce || !previouslyActive.has(a.id)) openAgentTab(a.id);
  }
  state.agentsLoadedOnce = true;
  renderAgentList();
}

// Agents not considered part of the GLaDOS red-team roster. Atlas is a personal
// assistant that lives under the ChatBot tab — it should NOT appear alongside
// osint, webapp-recon, etc. in the sidebar "Agents" list.
const HIDDEN_FROM_ROSTER = new Set(['atlas']);

function renderAgentList() {
  agentListEl.innerHTML = '';
  for (const a of state.agents) {
    if (HIDDEN_FROM_ROSTER.has(a.id)) continue;
    const li = document.createElement('li');
    li.dataset.id = a.id;
    li.className = (state.active.has(a.id) ? 'live ' : '') + (state.currentTab === a.id ? 'active' : '');
    li.innerHTML = `<span class="dot"></span><span class="name">${a.id}</span>`;
    li.addEventListener('click', () => openAgentTab(a.id));
    agentListEl.appendChild(li);
  }
}

function openGladosChat() {
  const id = 'glados-chat';
  if (!state.openTabs.find(t => t.id === id)) {
    state.openTabs.unshift({ id, kind: 'chat', label: 'GLaDOS Chat' });
  }
  setCurrentTab(id);
}

function openAgentTab(agentId) {
  if (agentId === 'atlas') {
    openChatBot();
    return;
  }
  const id = agentId;
  if (!state.openTabs.find(t => t.id === id)) {
    state.openTabs.push({ id, kind: 'agent', label: agentId });
  }
  setCurrentTab(id);
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
}

function setCurrentTab(id) {
  state.currentTab = id;
  const tab = state.openTabs.find(t => t.id === id);
  haltOneBtn.disabled = !tab || tab.kind !== 'agent';
  renderTabs();
  renderAgentList();
  renderPane();
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

function openSettings() {
  const id = 'settings';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'settings', label: 'Settings' });
  setCurrentTab(id);
}

function openAbout() {
  const id = 'about';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'about', label: 'About' });
  setCurrentTab(id);
}

function openGettingStarted(anchor) {
  const id = 'getting-started';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'getting-started', label: 'Getting Started' });
  setCurrentTab(id);
  if (anchor) {
    // Defer one frame so the pane has rendered before we scrollIntoView.
    requestAnimationFrame(() => {
      const target = document.getElementById(anchor);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (anchor === 'troubleshooting' || anchor === 'install' || anchor === 'engagement') {
        try { history.replaceState(null, '', `#${anchor}`); } catch {}
      }
    });
  }
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

function openChatBot() {
  const id = 'chatbot';
  if (!state.openTabs.find(t => t.id === id)) state.openTabs.push({ id, kind: 'chatbot', label: 'ChatBot' });
  setCurrentTab(id);
}

function renderPane() {
  paneEl.innerHTML = '';
  const id = state.currentTab;
  if (!id) {
    paneEl.innerHTML = '<div class="pane-empty">Select an agent tab or start chatting with GLaDOS.</div>';
    return;
  }
  const tab = state.openTabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.kind === 'chat') renderChatPane();
  else if (tab.kind === 'chatbot') renderChatBotPane();
  else if (tab.kind === 'reports') renderReportsPane();
  else if (tab.kind === 'settings') renderSettingsPane();
  else if (tab.kind === 'about') renderAboutPane();
  else if (tab.kind === 'getting-started') renderGettingStartedPane();
  else if (tab.kind === 'terminal') renderTerminalPane();
  else if (tab.kind === 'proxy') renderProxyPane();
  else renderAgentPane(id);
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
    // Live-streaming state (from raw-stream.jsonl deltas). Each runId gets its
    // own growing entry per kind. After the stream ends we remember the final
    // text briefly so we can suppress the duplicate JSONL event that lands
    // moments later (same content, arriving through the session log).
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
  const es = new EventSource(`/api/agents/${encodeURIComponent(agentId)}/transcript`);
  es.onmessage = e => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }

    // Raw-stream deltas: don't buffer, don't push to events list, just update
    // the live entry. They arrive many-per-second and would blow out memory.
    if (ev.kind === 'thinking-stream' || ev.kind === 'text-stream') {
      const isText = ev.kind === 'text-stream';
      rec.firstTokenSeenAt ||= Date.now();
      markTranscriptActivity(rec, tabId, isText ? 'responding' : 'thinking');
      handleStreamDelta(rec, ev);
      if (isText && ev.evtType === 'text_end') finishTranscriptTurn(rec, tabId);
      return;
    }

    // Suppress the JSONL thinking/assistant-text entry if we just finished
    // streaming the same content live. Keeps the UI clean.
    if (ev.kind === 'thinking' || ev.kind === 'assistant-text') {
      const matchKind = ev.kind === 'thinking' ? 'thinking' : 'text';
      if (wasRecentlyStreamed(rec, matchKind, ev.text)) {
        reconcileStreamedEvent(rec, ev);
        if (ev.kind === 'assistant-text' && rec.sending && eventBelongsToCurrentTurn(rec, ev)) {
          rec.firstTokenSeenAt ||= Date.now();
          finishTranscriptTurn(rec, tabId);
        }
        return;
      }
    }

    // Ack the durable JSONL user-message against the optimistic local bubble
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

function stripOpenClawControlTags(value) {
  return String(value || '')
    .replace(/\[\[\s*\/?reply_to_current\s*\]\]\s*/gi, '')
    .replace(/\[\s*\/?reply_to_current\s*\]\s*/gi, '')
    .replace(/\[\[?\s*\/?reply_to_current\b\s*/gi, '')
    .replace(/\b\/?reply_to_current\]?\]?\s*/gi, '');
}

function displayTranscriptText(value) {
  return stripOpenClawControlTags(value);
}

function normalizeTranscriptText(value) {
  return stripOpenClawControlTags(stripSessionTimestampPrefix(value))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// Rough equality — OpenClaw sometimes appends a trailing newline or strips
// leading whitespace when finalizing a message, so we compare normalized content.
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
    const r = await fetch(`/api/chat/status/${encodeURIComponent(agentId)}`);
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
  if (state.transcripts.has('glados-chat')) refreshChatTurnStatus('glados-chat', 'glados');
  if (state.transcripts.has('chatbot')) refreshChatTurnStatus('chatbot', 'atlas');
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

  // Raw thinking can arrive as one-token scratch fragments, especially when the
  // gateway replays/compacts a turn. Those fragments are status signal, not
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
    // v3.1: upgrade finalized assistant-text from plain text to rendered markdown.
    // Thinking blocks stay plain (they're notes, not formatted output).
    if (!isThinking && entry.textNode && entry.textNode.parentNode) {
      try {
        const ts = entry.el.querySelector('.ts')?.outerHTML || '';
        entry.el.innerHTML = `${ts}${renderMarkdown(entry.content || '')}`;
        enhanceMarkdownContent(entry.el);
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
      rec.events.push({
        kind: durableKind,
        text: entry.content,
        ts: ev.ts || Date.now(),
        runId: ev.runId,
        _streamed: true,
      });
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
  const wrap = document.createElement('div');
  wrap.className = 'transcript';
  paneEl.appendChild(wrap);

  const rec = ensureTranscript(agentId, agentId);
  rec.el = wrap;
  rec.autoScroll = true;
  attachScrollTracker(wrap, rec);
  for (const ev of rec.events) appendEntry(wrap, ev, rec);
  scrollToBottom(wrap, rec);
}

// v3.1 — Chat input history + retry.
// Per-chat ring buffer of user messages, persisted to localStorage. Arrow-up /
// Arrow-down in an empty textarea (or one whose value matches the currently
// recalled entry) scrolls back/forward through history. Separate keys per chat
// surface so GLaDOS history doesn't bleed into Atlas.
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
// v3.1 Tier 3 #10 — auto-growing textarea. Grows up to `maxVh` viewport height
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

// v3.1 — Retry: re-post a prior user message. Both chat surfaces register a
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

function renderChatPane() {
  const chat = document.createElement('div');
  chat.className = 'chat-pane';
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
    <textarea id="chat-text" placeholder="Talk to GLaDOS (Cmd+Enter to send)…"></textarea>
    <button id="chat-send">Send</button>
  `;
  chat.appendChild(transcript);
  chat.appendChild(sendingEl);
  chat.appendChild(inputRow);
  paneEl.appendChild(chat);

  const tabId = 'glados-chat';
  const rec = ensureTranscript(tabId, 'glados');
  rec.el = transcript;
  rec.autoScroll = true;
  attachScrollTracker(transcript, rec);
  for (const ev of rec.events) appendEntry(transcript, ev, rec);
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

    // Fire-and-forget. The assistant's response streams back via SSE as soon
    // as openclaw writes it to the JSONL — we do not need to await the POST.
    fetch('/api/chat/glados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    }).then(r => r.json()).then(j => {
      if (!j.ok) {
        logEvent('ended', 'chat error: ' + (j.error || 'unknown'));
        finishTranscriptTurn(rec, tabId);
      }
      // On success, the "sending" flag gets cleared by the SSE handler when
      // the first assistant/thinking/result event arrives (which is usually
      // before the POST resolves, since the CLI blocks until turn end).
    }).catch(e => {
      logEvent('ended', 'chat exception: ' + e.message);
      finishTranscriptTurn(rec, tabId);
    });
  };
  const send = () => dispatch();
  chatRetriers.set('glados', (msg) => dispatch(msg));
  document.getElementById('chat-send').addEventListener('click', send);
  const ta = document.getElementById('chat-text');
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send(); }
  });
  attachChatHistoryNav(ta, 'glados');
  attachAutoGrow(ta, {});
  attachSlashMenu(ta, inputRow, line => { ta.value = line; send(); });
}

// --- ChatBot (Atlas) pane --------------------------------------------------
// Personal assistant on local Ollama. Same streaming transcript as the other
// agent tabs, plus a model picker (ollama only), clear-session, and an
// image-upload button. Posts to /api/chat/atlas; responses arrive over the
// same SSE transcript stream as every other agent.
function renderChatBotPane() {
  const tabId = 'chatbot';
  const chat = document.createElement('div');
  chat.className = 'chat-pane';

  // Header: title + model selector + clear
  const header = document.createElement('div');
  header.className = 'chatbot-header';
  header.innerHTML = `
    <div class="chatbot-title">
      <span class="chatbot-name">Atlas</span>
      <span class="chatbot-hint">assistant · <span id="chatbot-model-label">—</span></span>
    </div>
    <div class="chatbot-controls">
      <select id="chatbot-model" title="Switch model (restarts the gateway — takes ~3s)"></select>
      <select id="chatbot-thinking" title="Reasoning level (restarts the gateway — takes ~3s). Lower = faster replies."></select>
      <button id="chatbot-clear" title="Archive the current Atlas session and start fresh">Clear</button>
    </div>
  `;

  const transcript = document.createElement('div');
  transcript.className = 'transcript';

  const sendingEl = document.createElement('div');
  sendingEl.className = 'sending-indicator';
  sendingEl.id = 'chatbot-sending';
  sendingEl.style.display = 'none';
  sendingEl.textContent = 'Atlas is thinking…';

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input chatbot-input';
  inputRow.innerHTML = `
    <textarea id="chatbot-text" placeholder="Talk to Atlas (Cmd+Enter to send)…"></textarea>
    <div class="chatbot-input-actions">
      <input id="chatbot-image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" />
      <button id="chatbot-attach" title="Attach image" class="icon-btn">📎</button>
      <button id="chatbot-send">Send</button>
    </div>
    <div id="chatbot-attached" class="chatbot-attached"></div>
  `;

  chat.appendChild(header);
  chat.appendChild(transcript);
  chat.appendChild(sendingEl);
  chat.appendChild(inputRow);
  paneEl.appendChild(chat);

  const rec = ensureTranscript(tabId, 'atlas');
  rec.el = transcript;
  rec.autoScroll = true;
  attachScrollTracker(transcript, rec);
  for (const ev of rec.events) appendEntry(transcript, ev, rec);
  scrollToBottom(transcript, rec);
  updateChatBotSendingIndicator();
  refreshChatTurnStatus(tabId, 'atlas');

  // --- Model selector: fetch known models + current atlas model ---
  const modelSel = document.getElementById('chatbot-model');
  const modelLabel = document.getElementById('chatbot-model-label');
  const thinkingSel = document.getElementById('chatbot-thinking');
  async function populateModels() {
    try {
      const [models, details] = await Promise.all([
        fetch('/api/models').then(r => r.json()),
        fetch('/api/agents/atlas/details').then(r => r.json()),
      ]);
      const displayModel = m => String(m || '')
        .replace(/^ollama-local\//, '')
        .replace(/^custom-llmapi-redteamstuff-com\//, '');
      modelSel.innerHTML = (models.models || [])
        .map(m => `<option value="${escapeHtml(m)}">${escapeHtml(displayModel(m))}</option>`)
        .join('');
      const current = details?.model || 'ollama-local/glm-4.7-flash:latest';
      modelSel.value = current;
      modelLabel.textContent = displayModel(current);

      // Reasoning level dropdown (defaults to minimal).
      const levels = details?.thinkingLevels || ['off', 'minimal', 'low', 'medium', 'high'];
      thinkingSel.innerHTML = levels
        .map(l => `<option value="${escapeHtml(l)}">🧠 ${escapeHtml(l)}</option>`)
        .join('');
      thinkingSel.value = details?.thinking || 'minimal';
    } catch (e) { modelLabel.textContent = '(model list unavailable)'; }
  }
  populateModels();

  thinkingSel.addEventListener('change', async () => {
    const level = thinkingSel.value;
    if (!level) return;
    thinkingSel.disabled = true;
    const prev = modelLabel.textContent;
    try {
      const r = await fetch('/api/agents/atlas/thinking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'reasoning change failed');
      // Like model changes, the gateway caches config in-memory — restart to apply.
      modelLabel.textContent = 'restarting gateway…';
      const rr = await fetch('/api/gateway/restart', { method: 'POST' });
      const rj = await rr.json();
      if (!rj.ok) throw new Error(rj.error || 'gateway restart failed');
      modelLabel.textContent = prev;
    } catch (e) {
      alert('Reasoning change failed: ' + e.message);
    } finally {
      thinkingSel.disabled = false;
    }
  });

  modelSel.addEventListener('change', async () => {
    const newModel = modelSel.value;
    if (!newModel) return;
    modelSel.disabled = true;
    const origLabel = modelLabel.textContent;
    modelLabel.textContent = 'switching…';
    try {
      const r = await fetch('/api/agents/atlas/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: newModel }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'model change failed');
      // Model change requires a gateway restart to take effect (openclaw caches
      // agent config in-memory). Restart now — takes ~3s.
      modelLabel.textContent = 'restarting gateway…';
      const rr = await fetch('/api/gateway/restart', { method: 'POST' });
      const rj = await rr.json();
      if (!rj.ok) throw new Error(rj.error || 'gateway restart failed');
      modelLabel.textContent = newModel
        .replace(/^ollama-local\//, '')
        .replace(/^custom-llmapi-redteamstuff-com\//, '');
    } catch (e) {
      alert('Model switch failed: ' + e.message);
      modelLabel.textContent = origLabel;
    } finally {
      modelSel.disabled = false;
    }
  });

  // --- Clear session ---
  document.getElementById('chatbot-clear').addEventListener('click', async () => {
    if (!confirm('Clear Atlas session? This archives the current conversation and starts fresh.')) return;
    try {
      const r = await fetch('/api/agents/atlas/reset-session', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'reset failed');
      const rec2 = state.transcripts.get(tabId);
      if (rec2) { try { rec2.es && rec2.es.close(); } catch {} state.transcripts.delete(tabId); }
      renderPane();
    } catch (e) { alert('clear failed: ' + e.message); }
  });

  // --- Image upload ---
  // Staged image paths accumulate here until the next send, then get appended
  // to the outgoing message as "Attached: <path>" lines so Atlas can read them.
  const stagedImages = [];
  const attachedEl = document.getElementById('chatbot-attached');
  function renderAttached() {
    attachedEl.innerHTML = stagedImages.length
      ? stagedImages.map((p, i) => `<span class="attached-chip" data-i="${i}">📎 ${p.split('/').pop()} <span class="remove" data-remove="${i}">×</span></span>`).join('')
      : '';
  }
  attachedEl.addEventListener('click', ev => {
    const i = ev.target.dataset?.remove;
    if (i !== undefined) { stagedImages.splice(Number(i), 1); renderAttached(); }
  });
  document.getElementById('chatbot-attach').addEventListener('click', () => {
    document.getElementById('chatbot-image-file').click();
  });
  document.getElementById('chatbot-image-file').addEventListener('change', async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    ev.target.value = '';
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await fetch('/api/chat/atlas/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result, filename: file.name }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'upload failed');
        stagedImages.push(j.path);
        renderAttached();
      } catch (e) { alert('Image upload failed: ' + e.message); }
    };
    reader.readAsDataURL(file);
  });

  // --- Send ---
  const dispatch = (override) => {
    const ta = document.getElementById('chatbot-text');
    let msg = override !== undefined ? override : ta.value.trim();
    if (!msg && stagedImages.length === 0 && override === undefined) return;
    // Local slash commands still work inside the chatbot pane.
    if (msg.startsWith('/')) {
      if (override === undefined) { ta.value = ''; ta.focus(); }
      runSlashCommand(msg, rec);
      return;
    }
    if (override === undefined && stagedImages.length) {
      const list = stagedImages.map(p => `- ${p}`).join('\n');
      msg = (msg ? msg + '\n\n' : '') + `Sam attached ${stagedImages.length} image(s) — use the read tool or your vision capability to inspect them:\n${list}`;
      stagedImages.length = 0;
      renderAttached();
    }
    if (override === undefined) {
      ta.value = '';
      ta.focus();
      ta._gladosHistoryReset?.();
      ta._gladosAutoGrow?.();
    }
    pushChatHistory('atlas', msg);

    const clientId = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = { kind: 'user-message', text: msg, ts: Date.now(), _optimistic: true, clientId };
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
    updateChatBotSendingIndicator();

    fetch('/api/chat/atlas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    }).then(r => r.json()).then(j => {
      if (!j.ok) {
        logEvent('ended', 'atlas chat error: ' + (j.error || 'unknown'));
        finishTranscriptTurn(rec, tabId);
      }
    }).catch(e => {
      logEvent('ended', 'atlas chat exception: ' + e.message);
      finishTranscriptTurn(rec, tabId);
    });
  };
  const send = () => dispatch();
  chatRetriers.set('atlas', (msg) => dispatch(msg));
  document.getElementById('chatbot-send').addEventListener('click', send);
  const taEl = document.getElementById('chatbot-text');
  taEl.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send(); }
  });
  attachChatHistoryNav(taEl, 'atlas');
  attachAutoGrow(taEl, {});
}

function updateChatBotSendingIndicator() {
  const el = document.getElementById('chatbot-sending');
  if (!el) return;
  const rec = state.transcripts.get('chatbot');
  el.style.display = rec?.sending ? 'block' : 'none';
  if (rec?.sending) el.textContent = transcriptStatusText(rec, 'Atlas');
}

function updateSendingIndicator(tabId) {
  // Atlas has its own indicator element with a different id; route based on
  // tabId so the SSE-driven sending-clear works for both chat surfaces.
  if (tabId === 'chatbot') return updateChatBotSendingIndicator();
  if (state.currentTab !== tabId) return;
  const el = document.getElementById('sending-indicator');
  if (!el) return;
  const rec = state.transcripts.get(tabId);
  el.style.display = rec?.sending ? 'block' : 'none';
  if (rec?.sending) el.textContent = transcriptStatusText(rec, 'GLaDOS');
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

// v3.1: Markdown rendering for assistant-text entries.
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

function appendEntry(container, ev, rec) {
  const el = document.createElement('div');
  const kind = ev.kind;
  const classes = ['entry', kind];
  if (kind === 'tool-result' && ev.isError) classes.push('error');
  if (ev._optimistic) classes.push('optimistic');
  el.className = classes.join(' ');
  // Stamp the owning agent so CSS can show "user/<agent>-input" and label the
  // assistant bubble with the agent's name ("glados", "atlas", etc.).
  if (rec?.agentId) el.dataset.agent = rec.agentId;
  const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';

  if (kind === 'assistant-text') {
    // v3.1: markdown for assistant output (bold, code, links, lists, headers).
    el.innerHTML = `<span class="ts">${ts}</span>${renderMarkdown(displayTranscriptText(ev.text || ''))}`;
    enhanceMarkdownContent(el);
  } else if (kind === 'thinking' || kind === 'user-message') {
    const displayText = kind === 'thinking' ? displayTranscriptText(ev.text || '') : (ev.text || '');
    el.innerHTML = `<span class="ts">${ts}</span>${renderCollapsible(displayText)}`;
    if (kind === 'user-message') {
      el.dataset.messageText = ev.text || '';
      if (ev.clientId) el.dataset.clientId = ev.clientId;
    }
    // v3.1: right-click a user message to retry. Only on surfaces that
    // registered a retrier (glados chat, atlas chat) — agent transcripts
    // don't have a retrier because they're not user-driven.
    if (kind === 'user-message' && rec?.agentId && chatRetriers.has(rec.agentId)) {
      installChatRetryContextMenu(el, rec.agentId, ev.text || '');
    }
  } else if (kind === 'tool-call') {
    const args = ev.arguments !== undefined ? JSON.stringify(ev.arguments, null, 2) : '';
    el.innerHTML = `<span class="ts">${ts}</span><span class="tool-name">→ ${escapeHtml(ev.toolName || '?')}</span>${renderCollapsible(args, 'args')}`;
  } else if (kind === 'tool-result') {
    const header = ev.isError ? '✗ error' : '← result';
    const extra = (ev.exitCode !== undefined ? ` exit=${ev.exitCode}` : '') +
                  (ev.durationMs !== undefined ? ` ${ev.durationMs}ms` : '');
    // v3.1: show an explicit "[body truncated]" affordance when the tool
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
}

// v3.1 — Burp / patch-integrity health banner.
// Polls /api/health/burp every 5s; shows a red banner on failure with
// actionable fix buttons. Dismissed state persists only until the next
// distinct failure signature.
const healthBannerState = { dismissedSig: null, lastSig: null };
async function refreshHealthBanner() {
  const banner = document.getElementById('health-banner');
  const msg = document.getElementById('health-banner-msg');
  if (!banner || !msg) return;
  let data;
  try {
    const r = await fetch('/api/health/burp');
    data = await r.json();
  } catch {
    banner.classList.remove('hidden');
    msg.textContent = 'Dashboard cannot reach its own health endpoint';
    return;
  }

  if (data.healthy && !data.stale) {
    banner.classList.add('hidden');
    healthBannerState.lastSig = 'ok';
    return;
  }

  const issues = [];
  if (data.stale) issues.push('stale-sentinel');
  if (data.burpProxy && !data.burpProxy.ok) issues.push('burp-proxy-down:8080');
  if (data.burpExtApi && !data.burpExtApi.ok) issues.push('burp-ext-down:1338');
  if (data.patchAls && !data.patchAls.ok) issues.push('als-patch-missing');
  if (data.patchSsrf && !data.patchSsrf.ok) issues.push('ssrf-patch-missing');
  if (data.error) issues.push(data.error);

  const sig = issues.join('|');
  healthBannerState.lastSig = sig;
  if (sig === healthBannerState.dismissedSig) return;

  msg.textContent = `Burp health: ${issues.join(' · ') || 'unknown failure'}`;
  banner.classList.remove('hidden');
}

function setupHealthBanner() {
  const reapplyBtn = document.getElementById('health-reapply-btn');
  const detailsBtn = document.getElementById('health-details-btn');
  const dismissBtn = document.getElementById('health-dismiss-btn');
  const msg = document.getElementById('health-banner-msg');

  reapplyBtn?.addEventListener('click', async () => {
    reapplyBtn.disabled = true;
    reapplyBtn.textContent = 'Applying…';
    try {
      const r = await fetch('/api/health/burp/reapply-patches', { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        msg.textContent = 'Patches re-applied — restart gateway to load (or it will self-correct within 60s).';
        logEvent('ok', 'patches re-applied via dashboard');
      } else {
        msg.textContent = `Re-apply failed: ${data.error || 'unknown'}`;
      }
    } catch (e) {
      msg.textContent = `Re-apply request failed: ${e.message}`;
    } finally {
      reapplyBtn.disabled = false;
      reapplyBtn.textContent = 'Re-apply patches';
    }
  });

  detailsBtn?.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/health/burp');
      const data = await r.json();
      alert(JSON.stringify(data, null, 2));
    } catch (e) { alert('health fetch failed: ' + e.message); }
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
  const es = new EventSource('/api/agents/stream');
  es.addEventListener('snapshot', e => {
    const arr = JSON.parse(e.data);
    for (const a of arr) {
      state.active.set(a.agentId, { sessionId: a.sessionId });
      if (a.agentId !== 'glados' && a.agentId !== 'atlas' && !state.openTabs.find(t => t.id === a.agentId)) {
        openAgentTab(a.agentId);
      }
    }
    renderAgentList();
  });
  es.addEventListener('session-started', e => {
    const info = JSON.parse(e.data);
    state.active.set(info.agentId, { sessionId: info.sessionId });
    logEvent('started', `${info.agentId} session-started`);
    renderAgentList();
    if (info.agentId === 'atlas') {
      if (!state.openTabs.find(t => t.id === 'chatbot')) {
        state.openTabs.push({ id: 'chatbot', kind: 'chatbot', label: 'ChatBot' });
      }
      if (state.currentTab === 'atlas') setCurrentTab('chatbot');
      else renderTabs();
    } else if (info.agentId !== 'glados' && !state.openTabs.find(t => t.id === info.agentId)) {
      openAgentTab(info.agentId);
    }
  });
  es.addEventListener('session-ended', e => {
    const info = JSON.parse(e.data);
    state.active.delete(info.agentId);
    logEvent('ended', `${info.agentId} session-ended`);
    renderAgentList();
  });
  es.addEventListener('halt', e => {
    const { agentId, reason } = JSON.parse(e.data);
    logEvent('ended', `HALT ${agentId}${reason ? ' — ' + reason : ''}`);
  });
  es.addEventListener('resume', e => {
    const { agentId } = JSON.parse(e.data);
    logEvent('started', `resume ${agentId}`);
  });
  es.addEventListener('halt-all', e => {
    const { reason } = JSON.parse(e.data);
    logEvent('ended', `HALT ALL${reason ? ' — ' + reason : ''}`);
  });
  es.addEventListener('breaker-trip', e => {
    const info = JSON.parse(e.data);
    logEvent('ended', `BREAKER TRIPPED on ${info.host} (${info.samples?.length || '?'} fails)`);
    refreshIndicators();
  });
  es.addEventListener('patches-reapplied', () => {
    logEvent('ok', 'openclaw patches re-applied');
    refreshHealthBanner();
  });
  es.addEventListener('chat-turn-started', e => {
    let data = {}; try { data = JSON.parse(e.data); } catch {}
    const tabId = data.agentId === 'atlas' ? 'chatbot'
      : data.agentId === 'glados' ? 'glados-chat'
      : null;
    if (!tabId) return;
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
    const tabId = data.agentId === 'atlas' ? 'chatbot'
      : data.agentId === 'glados' ? 'glados-chat'
      : null;
    if (!tabId) return;
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
  // v3.1 — Plan-approval workflow lifecycle events.
  for (const type of ['plan-pending','plan-approved','plan-rejected','plan-modified','plan-complete']) {
    es.addEventListener(type, e => {
      let data = {}; try { data = JSON.parse(e.data); } catch {}
      logEvent(type === 'plan-pending' ? 'started' : (type === 'plan-rejected' ? 'ended' : 'ok'),
        `${type} ${data.id || data.new_id || data.old_id || ''}`);
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
    refreshIndicators();
  });
}

// --- Indicators ---
const healthPill = document.getElementById('target-health');
const rpsPill = document.getElementById('burp-rps');

async function refreshIndicators() {
  try {
    const [t, r] = await Promise.all([
      fetch('/api/targets').then(r => r.json()),
      fetch('/api/burp/rps').then(r => r.json()),
    ]);
    const worst = worstState((t.targets || []).map(x => x.state));
    healthPill.textContent = worst || '—';
    healthPill.className = 'pill ' + stateClass(worst);
    rpsPill.textContent = r.rps == null ? '—' : r.rps.toFixed(2);
    rpsPill.className = 'pill ' + (r.rps == null ? 'muted' : 'ok');
  } catch {
    healthPill.className = 'pill muted';
    rpsPill.className = 'pill muted';
  }
}
function stateClass(s) {
  if (s === 'healthy') return 'ok';
  if (s === 'degraded') return 'warn';
  if (s === 'down' || s === 'paused') return 'err';
  return 'muted';
}
function worstState(states) {
  const rank = { down: 4, paused: 3, degraded: 2, healthy: 1, unknown: 0 };
  return states.reduce((a, b) => (rank[b] || 0) > (rank[a] || 0) ? b : a, null);
}

// --- Reports ---

async function renderReportsPane() {
  const wrap = document.createElement('div');
  wrap.className = 'reports-pane';
  wrap.innerHTML = `
    <div class="reports-tree" id="reports-tree">loading…</div>
    <div class="report-viewer" id="report-viewer">
      <div class="report-empty">Select a report from the tree.</div>
    </div>`;
  paneEl.appendChild(wrap);

  try {
    const j = await fetch('/api/reports/tree').then(r => r.json());
    const treeEl = document.getElementById('reports-tree');
    treeEl.innerHTML = `<div style="color:var(--fg-dim);font-size:10px;margin-bottom:8px;">${escapeHtml(j.root || '')}</div>`;
    const ul = document.createElement('ul');
    ul.appendChild(buildTreeNodes(j.tree || []));
    treeEl.appendChild(ul);
  } catch (e) {
    document.getElementById('reports-tree').textContent = 'error loading tree: ' + e.message;
  }
}

function buildTreeNodes(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    const li = document.createElement('li');
    if (n.type === 'dir') {
      const head = document.createElement('div');
      head.className = 'dir';
      head.textContent = n.name;
      const childUl = document.createElement('ul');
      childUl.style.display = 'none';
      childUl.appendChild(buildTreeNodes(n.children || []));
      head.addEventListener('click', () => {
        const open = head.classList.toggle('open');
        childUl.style.display = open ? 'block' : 'none';
      });
      li.appendChild(head);
      li.appendChild(childUl);
    } else {
      const fileEl = document.createElement('div');
      fileEl.className = 'file';
      fileEl.dataset.path = n.path;
      const kb = Math.max(1, Math.round((n.size || 0) / 1024));
      fileEl.innerHTML = `${escapeHtml(n.name)}<span class="meta">${kb}K</span>`;
      fileEl.addEventListener('click', () => loadReport(n.path, fileEl));
      li.appendChild(fileEl);
    }
    frag.appendChild(li);
  }
  return frag;
}

async function loadReport(relPath, clickedEl) {
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
      body = window.marked ? marked.parse(j.content) : `<pre>${escapeHtml(j.content)}</pre>`;
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

function wireReportActions(relPath, fileMeta, viewer) {
  const delBtn = viewer.querySelector('#report-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete ${relPath}? This cannot be undone.`)) return;
    try {
      const r = await fetch('/api/reports/file?path=' + encodeURIComponent(relPath), { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'delete failed');
      viewer.innerHTML = '<div class="report-empty">deleted — reload tree</div>';
      renderReportsPane();
    } catch (e) { alert('delete failed: ' + e.message); }
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
      } catch (e) { alert('save failed: ' + e.message); }
    });
  });
}

// --- Terminal ---

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

// --- Proxy (GLaDOS Burp extension on :1338) ---
// One long-lived state object across tab switches so the table keeps scrollback
// and the EventSource isn't reopened on every render.
const _proxyState = {
  rows: [], es: null,
  filterText: '', filterStatus: '', filterAgent: '',
  maxRows: 2000, paused: false, selectedId: null, detailCache: new Map(),
  // v3.1 Tier 2 — click-to-sort column state, persisted in localStorage.
  sortKey: (() => { try { return localStorage.getItem('glados-dash.proxy.sortKey') || 'ts'; } catch { return 'ts'; } })(),
  sortDir: (() => { try { return localStorage.getItem('glados-dash.proxy.sortDir') || 'asc'; } catch { return 'asc'; } })(),
  // v3.1 Tier 3 #9 — multi-row selection for bulk export. `selectedId` still
  // tracks the single row that populates the detail panes (last click); the
  // set below covers Shift+click ranges and Cmd/Ctrl+click toggles.
  selectedIds: new Set(),
  lastClickedId: null, // anchor for Shift+click range selection
};

function renderProxyPane() {
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
      <button id="proxy-clear" title="Clear the table (does not affect Burp)">Clear</button>
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
          <button class="proxy-detail-copy" id="proxy-copy-req" title="Copy raw request">Copy</button>
          <button class="proxy-detail-copy" id="proxy-replay-btn" title="Replay this request through Burp">Replay…</button>
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

  // v3.1 Tier 3 #9 — Shift+click = range select (across currently visible rows
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
        respBodyEl.textContent = '(detail endpoint unreachable — install / rebuild the Burp extension)';
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

  // v3.1 Tier 3 #9 — Export helpers. If any rows are multi-selected, export
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

  // v3.1 — In-detail search. Highlights matches in the <pre>; arrows cycle.
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

  // v3.1 — Replay modal. Opens with the selected row's method/url/headers/body
  // pre-filled, fires through Burp with the row's agent tag, shows response inline.
  wrap.querySelector('#proxy-replay-btn').addEventListener('click', () => openReplayModal());

  function openReplayModal() {
    const id = _proxyState.selectedId;
    const row = _proxyState.rows.find(x => x.id === id);
    if (!row) { alert('Select a row first.'); return; }
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
        statusEl.textContent = `${data.status} ${data.statusText || ''} · ${data.elapsedMs}ms${data.proxied ? ' · through Burp' : ' · DIRECT (Burp unreachable)'}`;
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

  fetch('/api/proxy/history?limit=500')
    .then(r => r.ok ? r.json() : Promise.reject(new Error('history fetch failed')))
    .then(rows => {
      if (!Array.isArray(rows)) return;
      _proxyState.rows = rows;
      refreshAll();
    })
    .catch(() => {
      tbody.innerHTML = `<tr><td colspan="7" class="proxy-empty">No connection to Burp extension at :1338 — install glados-proxy-api-1.0.0-all.jar in Burp (see About tab).</td></tr>`;
    });

  if (_proxyState.es) { try { _proxyState.es.close(); } catch {} _proxyState.es = null; }
  const es = new EventSource('/api/proxy/stream');
  es.onopen = () => { connEl.textContent = 'live'; connEl.className = 'proxy-status live'; };
  es.onmessage = ev => {
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

  // v3.1 — per-agent metrics poll. Refreshes the sidebar every 2s.
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

// --- Getting Started ---
// Operator-facing setup + day-to-day checklists. Moved here from About so the
// About tab can stay focused on what the system IS rather than how to run it.

function renderGettingStartedPane() {
  const wrap = document.createElement('div');
  wrap.className = 'about-pane getting-started-pane';
  wrap.innerHTML = `
    <div class="about-checklist">
      <h1>Getting Started <span class="gs-progress" id="gs-progress">0 / 0 done</span></h1>
      <p style="color:var(--fg-dim);">Three phases: local bootstrap, start-of-engagement checklist,
        and what to do when something gets wedged. GLaDOS code comes from Git, but every operator's
        agents, reports, evidence, sessions, blackboard, and keys live locally under <code>~/.glados</code>
        and <code>~/.openclaw</code>.</p>
      <div class="gs-actions">
        <button id="gs-run-all-validations">Run all validations</button>
        <button id="gs-reset-progress" title="Clear checklist progress">Reset progress</button>
        <a href="#troubleshooting" class="gs-jump" id="gs-jump-trouble">jump to troubleshooting ↓</a>
      </div>

      <h2 id="install">1 — One-time install</h2>
      <ol class="gs-checklist" data-section="install">
        <li data-step="install-1.1"><b>Clone GLaDOS</b> anywhere on the workstation. The repo is app code and upstream seed templates; runtime data is local-only.</li>
        <li data-step="install-1.2"><b>Create local config</b>: copy <code>.env.example</code> to <code>.env</code> and add this operator's own LLM API key. Do not share <code>.env</code>.</li>
        <li data-step="install-1.3"><b>Run bootstrap</b> from the repo root:
          <pre>scripts/bootstrap-macos.sh</pre>
          This installs deps, creates <code>~/.glados</code>, copies default agent seeds once into <code>~/.glados/workspaces/agents</code>, creates local DBs, and points OpenClaw at the user-owned agent copies.</li>
        <li data-step="install-1.4" data-validate="burp-ca"><b>Install Burp Pro</b>. Trust Burp's CA once — from Burp: Proxy → Proxy settings →
          Import / export CA certificate → <i>Certificate in DER format</i> → save as
          <code>~/Desktop/burp-ca.der</code>. Then in Terminal:
          <pre>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Desktop/burp-ca.der</pre>
          Without this, every HTTPS request from an agent fails cert verification.</li>
        <li data-step="install-1.5" data-validate="burp-rest"><b>Enable Burp REST API</b>: Settings → Suite → REST API → enabled at
          <code>127.0.0.1:1337</code> → "Allow access without API key (loopback)".
          Persists across temp projects.</li>
        <li data-step="install-1.6" data-validate="burp-ext"><b>Build + install the GLaDOS Burp extension</b> — Burp's built-in REST doesn't
          expose proxy history, so the dashboard Proxy tab and circuit breaker rely on this:
          <pre>cd tools/burp-ext-glados-proxy-api
./gradlew shadowJar</pre>
          In Burp: Extensions → Installed → <b>Add</b> → Extension type: Java →
          select <code>build/libs/glados-proxy-api-1.0.0-all.jar</code>. Output tab should
          print <code>[glados-proxy-api] listening on http://127.0.0.1:1338</code>.
          Verify with the <b>Validate</b> button or the <a href="#" data-open-tab="proxy">Proxy tab</a>.</li>
        <li data-step="install-1.7" data-validate="watchdog-mcp"><b>Confirm MCP registration</b> (bootstrap writes this into <code>~/.openclaw/openclaw.json</code>):
          <pre>openclaw mcp list</pre>
          should include <code>watchdog</code>, <code>blackboard</code>, and <code>glados-ops</code>.</li>
        <li data-step="install-1.8" data-validate="patches"><b>Apply the openclaw bundle patch</b> for per-agent Burp tagging:
          <pre>bash tools/patch-openclaw-bundle.sh</pre>
          This wraps openclaw's tool executor in AsyncLocalStorage so every red-team agent's
          outbound HTTP request carries <code>X-GLaDOS-Agent: &lt;agent-id&gt;</code> — Burp's GLaDOS
          extension reads that header to attribute history per-agent. Re-run this after every
          <code>npm install -g openclaw</code> upgrade.</li>
        <li data-step="install-1.9"><b>Run doctor</b>:
          <pre>scripts/glados-doctor.sh</pre>
          Doctor confirms local runtime paths are outside the repo and OpenClaw agents point at <code>~/.glados/workspaces/agents</code>.</li>
      </ol>

      <h2 id="engagement">2 — Start-of-engagement checklist</h2>
      <ol class="gs-checklist" data-section="engagement">
        <li data-step="eng-2.1" data-validate="burp-proxy"><b>Launch Burp Pro</b>. Temp project is fine. Proxy defaults to <code>:8080</code>.
          Confirm <b>Proxy → Intercept</b> is <i>off</i> — otherwise agents block waiting
          for you to click Forward.</li>
        <li data-step="eng-2.2" data-validate="burp-ext"><b>Confirm the GLaDOS extension is loaded</b>: Extensions → Installed → check
          <code>GLaDOS Proxy API</code> has no errors.</li>
        <li data-step="eng-2.3"><b>Apply the resource pool</b> from <code>tools/burp-redteam-defaults.json</code>:
          Settings → Project → Resource pools → Import. 3 concurrent per host, 500ms min interval.</li>
        <li data-step="eng-2.4" data-validate="gateway"><b>Confirm gateway is running</b>: <code>openclaw daemon status</code> should report
          <code>running</code>. If not, click <b>Restart gateway</b> in the top bar.</li>
        <li data-step="eng-2.5" data-validate="tag-injector"><b>Verify tag-injector health sentinel</b> — confirms the gateway preload is active and Burp is reachable from inside the agent runtime.</li>
        <li data-step="eng-2.6" data-validate="dashboard"><b>Start the dashboard</b>: <code>cd dashboard &amp;&amp; npm start</code>,
          then open <a href="http://localhost:4280" target="_blank" rel="noopener">http://localhost:4280</a>.</li>
        <li data-step="eng-2.7"><b>Proxy sanity check</b>: open the <a href="#" data-open-tab="proxy">Proxy tab</a>. Run
          <code>curl -x http://127.0.0.1:8080 https://example.com &gt; /dev/null</code>
          in the <a href="#" data-open-tab="terminal">Terminal</a> — the request should appear in both the dashboard Proxy tab
          and Burp's Proxy → HTTP history within 1–2 seconds.</li>
        <li data-step="eng-2.8"><b>Chat with GLaDOS</b>: open the <a href="#" data-open-tab="glados">GLaDOS chat</a> and send a message. Watch
          thinking / tool calls / tool results stream in live.</li>
        <li data-step="eng-2.9"><b>Customize local agents as needed</b>: edit <code>~/.glados/workspaces/agents/&lt;agent-id&gt;/</code>. Updates report upstream seed changes, but never overwrite local edits, deletions, custom agents, reports, evidence, or sessions.</li>
      </ol>

      <h2 id="troubleshooting">3 — If something gets wedged</h2>
      <div class="gs-symptom-picker">
        <label>I see…
          <select id="gs-symptom">
            <option value="">(pick a symptom)</option>
            <option value="agent-stalled">Agent stopped responding</option>
            <option value="no-agents">Dashboard shows no agents / SSE dead</option>
            <option value="rps-dash">Burp RPS stuck at —</option>
            <option value="none-tag">Burp history shows (none) instead of agent tag</option>
            <option value="proxy-1338">Proxy tab: "No connection to Burp extension at :1338"</option>
            <option value="cert-err">HTTPS requests failing with cert errors</option>
            <option value="halt-stuck">HALT ALL doesn't stop in-flight browser tool call</option>
            <option value="wedged">Completely wedged</option>
          </select>
        </label>
      </div>
      <ol class="gs-checklist gs-trouble" data-section="trouble">
        <li data-step="t-agent-stalled" data-symptom="agent-stalled"><b>Agent stops responding</b>: click <b>Reset session</b> in the top bar —
          archives the current JSONL and starts a fresh session on the next turn. If that
          doesn't help, click <b>Restart gateway</b>.</li>
        <li data-step="t-gw-hang" data-symptom="agent-stalled"><b>Restart gateway hangs or agents never reconnect</b>:
          <pre>openclaw daemon stop
openclaw daemon start
openclaw daemon status</pre>
          If <code>status</code> still says not running, kill stale processes:
          <code>pkill -f "openclaw gateway"</code>, then start again.</li>
        <li data-step="t-no-agents" data-symptom="no-agents"><b>Dashboard shows no agents / SSE dead</b> after a gateway restart: reload the
          browser tab. The SSE connection is per-page; a gateway bounce doesn't invalidate
          it, but a fs.watch reset can.</li>
        <li data-step="t-rps-dash" data-symptom="rps-dash" data-validate="burp-ext"><b>Burp RPS stuck at <code>—</code></b>: the GLaDOS Burp extension isn't running.
          If <code>:1338</code> returns JSON but RPS still reads <code>—</code>, no traffic has
          hit Burp yet — run <code>curl -x http://127.0.0.1:8080 https://example.com</code>
          to confirm proxying works.</li>
        <li data-step="t-none-tag" data-symptom="none-tag" data-validate="patches"><b>Burp history shows agent traffic as <code>(none)</code></b>: the openclaw bundle patch has been overwritten (usually by <code>npm install -g openclaw</code>).
          Re-run <code>bash tools/patch-openclaw-bundle.sh</code>, then
          <b>Restart gateway</b>.</li>
        <li data-step="t-1338" data-symptom="proxy-1338" data-validate="burp-ext"><b>Proxy tab shows "No connection to Burp extension at :1338"</b>: install/rebuild
          the extension per <a href="#install">step 1.6</a>.</li>
        <li data-step="t-cert" data-symptom="cert-err" data-validate="burp-ca"><b>HTTPS requests failing with cert errors</b>: Burp CA is not trusted on this
          machine. Redo <a href="#install">step 1.4</a>.</li>
        <li data-step="t-halt" data-symptom="halt-stuck"><b>HALT ALL doesn't stop an in-flight browser tool call</b>: expected. OpenClaw
          has no <code>sessions_interrupt</code>. The kill switch fires within one turn
          (next tool call is denied). Close the Chromium tab manually if you need it gone now.</li>
        <li data-step="t-wedged" data-symptom="wedged"><b>Completely wedged</b>: <code>openclaw daemon restart</code> + reload the
          dashboard tab. Burp keeps its history, blackboard keeps its findings — nothing
          is lost.</li>
        <li data-step="t-update"><b>Updating GLaDOS</b>: run <code>git pull</code>, then
          <code>scripts/update-macos.sh</code>, then <code>scripts/glados-doctor.sh</code>.
          Upstream agent template changes are shown as optional updates in <code>~/.glados/upstream-agent-status.json</code>.</li>
      </ol>
    </div>`;
  paneEl.appendChild(wrap);
  hydrateGettingStarted(wrap);
}

// v3.1 Tier 2 — Getting Started interactive checklist hydration.
// Adds: per-step checkboxes (persisted), Validate buttons wired to /api/validate/*,
// copy buttons on <pre>, cross-link data-open-tab handlers, symptom-keyed dropdown.
function hydrateGettingStarted(wrap) {
  const storeKey = 'glados-dash.gs.checked-v1';
  const loadChecked = () => { try { return JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch { return {}; } };
  const saveChecked = (obj) => { try { localStorage.setItem(storeKey, JSON.stringify(obj)); } catch {} };
  const checked = loadChecked();

  const allSteps = wrap.querySelectorAll('li[data-step]');
  const progressEl = wrap.querySelector('#gs-progress');
  const updateProgress = () => {
    const total = allSteps.length;
    let done = 0;
    for (const li of allSteps) if (li.classList.contains('done')) done++;
    if (progressEl) progressEl.textContent = `${done} / ${total} done`;
  };

  for (const li of allSteps) {
    const step = li.dataset.step;
    const row = document.createElement('span');
    row.className = 'gs-step-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'gs-check';
    cb.checked = !!checked[step];
    if (cb.checked) li.classList.add('done');
    cb.addEventListener('change', () => {
      li.classList.toggle('done', cb.checked);
      const map = loadChecked();
      if (cb.checked) map[step] = Date.now(); else delete map[step];
      saveChecked(map);
      updateProgress();
    });
    row.appendChild(cb);
    li.prepend(row);

    if (li.dataset.validate) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gs-validate-btn';
      btn.textContent = 'Validate';
      btn.dataset.validate = li.dataset.validate;
      const result = document.createElement('span');
      result.className = 'gs-validate-result';
      btn.addEventListener('click', () => runValidate(btn, result));
      li.appendChild(document.createTextNode(' '));
      li.appendChild(btn);
      li.appendChild(result);
    }
  }

  // Copy buttons on <pre> blocks.
  for (const pre of wrap.querySelectorAll('pre')) {
    if (pre.querySelector('.gs-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gs-copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(pre.textContent || '').then(
        () => { btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); },
        () => { btn.textContent = '✗ failed'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); }
      );
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }

  // Cross-links: data-open-tab="proxy|terminal|glados|chatbot|reports".
  for (const a of wrap.querySelectorAll('a[data-open-tab]')) {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      const tab = a.dataset.openTab;
      if (tab === 'proxy') openProxy();
      else if (tab === 'terminal') openTerminal();
      else if (tab === 'glados') openGladosChat();
      else if (tab === 'chatbot') openChatBot();
      else if (tab === 'reports') openReports();
    });
  }

  // Symptom-keyed filter: dims rows that don't match, scrolls to first match.
  const symptomSel = wrap.querySelector('#gs-symptom');
  const troubleUl  = wrap.querySelector('ol.gs-trouble');
  if (symptomSel && troubleUl) {
    symptomSel.addEventListener('change', () => {
      const s = symptomSel.value;
      let first = null;
      for (const li of troubleUl.querySelectorAll('li[data-symptom]')) {
        const match = !s || li.dataset.symptom === s;
        li.classList.toggle('gs-dim', !match);
        if (match && !first) first = li;
      }
      if (first && s) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // Top-level action buttons.
  wrap.querySelector('#gs-run-all-validations').addEventListener('click', async () => {
    const btns = wrap.querySelectorAll('.gs-validate-btn');
    for (const btn of btns) {
      const result = btn.nextSibling?.classList?.contains('gs-validate-result') ? btn.nextSibling : btn.parentElement.querySelector('.gs-validate-result');
      await runValidate(btn, result);
    }
  });
  wrap.querySelector('#gs-reset-progress').addEventListener('click', () => {
    if (!confirm('Reset all checklist progress?')) return;
    saveChecked({});
    for (const li of allSteps) li.classList.remove('done');
    for (const cb of wrap.querySelectorAll('.gs-check')) cb.checked = false;
    updateProgress();
  });

  updateProgress();

  // Honor URL hash (#install, #engagement, #troubleshooting) on initial render.
  const hash = location.hash?.slice(1);
  if (hash) {
    const anchor = wrap.querySelector('#' + CSS.escape(hash));
    anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function runValidate(btn, resultEl) {
  const step = btn.dataset.validate;
  btn.disabled = true;
  resultEl.textContent = ' · checking…';
  resultEl.className = 'gs-validate-result checking';
  try {
    const r = await fetch('/api/validate/' + encodeURIComponent(step));
    const data = await r.json();
    resultEl.className = 'gs-validate-result ' + (data.ok ? 'ok' : 'fail');
    resultEl.textContent = (data.ok ? ' ✓ ' : ' ✗ ') + (data.detail || '');
    if (!data.ok && data.hint) {
      const hint = document.createElement('span');
      hint.className = 'gs-validate-hint';
      hint.textContent = ' · hint: ' + data.hint;
      resultEl.appendChild(hint);
    }
  } catch (e) {
    resultEl.className = 'gs-validate-result fail';
    resultEl.textContent = ' ✗ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// --- About ---
// What GLaDOS is, how the pieces fit, and the "you need to know this" operator
// notes. Day-to-day setup and troubleshooting live in Getting Started.

function renderAboutPane() {
  const wrap = document.createElement('div');
  wrap.className = 'about-pane';
  wrap.innerHTML = `
    <div class="about-checklist">
      <h1>About GLaDOS Ops</h1>
      <p>GLaDOS is a multi-agent red-team framework built on OpenClaw. The dashboard
        you're looking at is the operator surface: live transcripts for each subagent,
        a chat pane to GLaDOS herself, Burp proxy visibility, and kill-switch controls.
        Agents do the offensive work; Burp Pro mediates every outbound request; this
        dashboard gives you eyes and brakes.</p>

      <h2>Architecture in one paragraph</h2>
      <p>One long-lived OpenClaw gateway process (launchd-managed) runs all agents.
        A small Node preload (<code>tools/tag-injector.js</code>) installs an
        <code>AsyncLocalStorage</code> that propagates the current agent's id through
        every tool call. Two patches inside openclaw's bundled <code>dist/</code> files
        (applied by <code>tools/patch-openclaw-bundle.sh</code>) wire ALS into the tool
        executor and route direct-mode fetches through Burp with per-request
        <code>X-GLaDOS-Agent</code> headers. Burp's GLaDOS extension reads those
        headers and attributes history per-agent, which the dashboard Proxy tab
        consumes. Out-of-scope agents (glados, atlas, report-*, ai-specialist) and
        localhost traffic bypass Burp entirely.</p>

      <h2>Re-apply patches after openclaw upgrades</h2>
      <p><b>Any time you run <code>npm install -g openclaw</code></b> (or otherwise upgrade
        the CLI) the bundle patches get overwritten, per-agent Burp tags stop working,
        and history entries revert to <code>(none)</code>. Re-run the patch script:</p>
      <pre>bash tools/patch-openclaw-bundle.sh</pre>
      <p>The script is idempotent (checks for <code>GLADOS_ALS_PATCH_V1</code> /
        <code>GLADOS_SSRF_ROUTE_V1</code> markers before applying), keeps
        <code>.pre-glados.bak</code> backups, and runs <code>node --check</code> on the
        result. After it finishes, click <b>Restart gateway</b> in the top bar so the
        new bundle gets loaded.</p>

      <h2>Kill-switches</h2>
      <ul>
        <li><b>HALT ALL</b> (top bar) — flips Burp scope to <code>exclude ^.*$</code> and
          writes deny rules to <code>~/.openclaw/exec-approvals.json</code>. Next tool
          call from any agent fails within one turn.</li>
        <li><b>Halt agent</b> — same mechanism scoped to a single agent.</li>
        <li><code>tools/burp-gate.sh halt-all</code> — the same kill path
          from a terminal if the dashboard is unreachable.</li>
        <li><code>GLADOS_DISABLE_BURP_ROUTE=1</code> in the gateway plist — reverts the
          SSRF patch's direct-mode fetches to unproxied. Emergency use only; agents lose
          Burp visibility.</li>
      </ul>
      <p style="color:var(--fg-dim);">Already-in-flight browser tool calls are <i>not</i>
        cancellable — OpenClaw has no <code>sessions_interrupt</code>. The kill switch
        denies the <i>next</i> tool call.</p>
    </div>
    <div class="about-diagram">
      <h2>Flow diagram</h2>
      <iframe src="/api/flow-diagram" title="GLaDOS flow diagram"></iframe>
    </div>`;
  paneEl.appendChild(wrap);
}

// --- Settings ---

async function renderSettingsPane() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-pane';
  wrap.innerHTML = '<h1>Agent Settings</h1><p style="color:var(--fg-dim);">Click an agent to expand. Model changes edit <code>~/.openclaw/openclaw.json</code> atomically with a backup.</p><div id="settings-list">loading…</div>';
  paneEl.appendChild(wrap);

  try {
    const models = (await fetch('/api/models').then(r => r.json())).models || [];
    const listEl = document.getElementById('settings-list');
    listEl.innerHTML = '';
    for (const agent of state.agents) {
      const card = document.createElement('div');
      card.className = 'agent-card';
      card.innerHTML = `
        <div class="agent-card-head">
          <span class="title">${escapeHtml(agent.id)}</span>
          <span class="caret">▸</span>
        </div>
        <div class="agent-card-body" data-loaded="false">
          <div style="color:var(--fg-dim);">loading details…</div>
        </div>`;
      card.querySelector('.agent-card-head').addEventListener('click', async () => {
        const isOpen = card.classList.toggle('open');
        const body = card.querySelector('.agent-card-body');
        if (isOpen && body.dataset.loaded === 'false') {
          await hydrateAgentCard(agent.id, body, models);
          body.dataset.loaded = 'true';
        }
      });
      listEl.appendChild(card);
    }
  } catch (e) {
    document.getElementById('settings-list').textContent = 'error: ' + e.message;
  }
}

async function hydrateAgentCard(agentId, body, models) {
  try {
    const d = await fetch(`/api/agents/${encodeURIComponent(agentId)}/details`).then(r => r.json());
    if (d.error) { body.textContent = 'error: ' + d.error; return; }
    const modelOpts = models.map(m => `<option${m === d.model ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
    const skills = (d.skills || []).map(s =>
      `<div class="skill"><strong>${escapeHtml(s.name)}</strong>${s.description ? `<span class="desc">${escapeHtml(s.description.slice(0, 300))}${s.description.length > 300 ? '…' : ''}</span>` : ''}</div>`
    ).join('') || '<div style="color:var(--fg-dim);">no skills</div>';
    body.innerHTML = `
      <label>Model (current: <code>${escapeHtml(d.model || '?')}</code>)</label>
      <div class="model-row">
        <select id="model-${agentId}">${modelOpts}</select>
        <button data-save="${agentId}">Save</button>
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
    body.querySelector(`[data-save="${agentId}"]`).addEventListener('click', async () => {
      const sel = body.querySelector(`#model-${agentId}`);
      const newModel = sel.value;
      if (!confirm(`Change ${agentId}'s model to ${newModel}?\n\nThis edits ~/.openclaw/openclaw.json. A .bak file will be written.\nThe next agent session will pick up the new model.`)) return;
      const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: newModel }),
      }).then(r => r.json());
      if (r.ok) {
        logEvent('started', `${agentId} model → ${newModel}`);
        await loadAgents();
        body.dataset.loaded = 'false';
        body.innerHTML = '<div style="color:var(--fg-dim);">reloading…</div>';
        await hydrateAgentCard(agentId, body, models);
        body.dataset.loaded = 'true';
      } else {
        alert('Save failed: ' + (r.error || 'unknown'));
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
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  const arg = rest.join(' ');
  const echo = (text, kind = 'assistant-text') => {
    const ev = { kind, text, ts: Date.now(), _optimistic: true };
    if (ev.kind === 'tool-call') removeRecentStreamedPreToolText(rec, ev.ts);

	    rec.events.push(ev);
    if (rec.el && rec.el.isConnected) appendEntry(rec.el, ev, rec);
  };
  echo(`$ ${raw}`, 'user-message');

  try {
    if (cmd === '/help') {
      echo(slashCommands.map(c => `  ${c.cmd.padEnd(22)} ${c.desc}`).join('\n'));
    } else if (cmd === '/agents') {
      const j = await fetch('/api/agents').then(r => r.json());
      const lines = (j.agents || []).map(a => `  ${a.active ? '●' : '○'} ${a.id.padEnd(18)} ${a.model || '?'}`);
      echo(lines.join('\n'));
    } else if (cmd === '/halt') {
      if (!arg) return echo('usage: /halt <agent>');
      const r = await fetch('/api/halt/' + encodeURIComponent(arg), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'slash command' }),
      }).then(r => r.json());
      echo(JSON.stringify(r, null, 2));
    } else if (cmd === '/halt-all') {
      const r = await fetch('/api/halt-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'slash command' }),
      }).then(r => r.json());
      echo(JSON.stringify(r, null, 2));
    } else if (cmd === '/resume') {
      if (!arg) return echo('usage: /resume <agent>');
      const r = await fetch('/api/resume/' + encodeURIComponent(arg), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).then(r => r.json());
      echo(JSON.stringify(r, null, 2));
    } else if (cmd === '/probe') {
      if (!arg) return echo('usage: /probe <url>');
      const r = await fetch('/api/targets/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_url: arg }),
      }).then(r => r.json());
      echo(JSON.stringify(r, null, 2));
    } else if (cmd === '/breaker') {
      const r = await fetch('/api/burp/rps').then(r => r.json());
      echo(`Burp RPS: ${r.rps ?? 'n/a'}\n(Circuit breaker polls /v0.1/proxy/http_history every 5s; tripping threshold = 3× 5xx/429 in 60s.)`);
    } else if (cmd === '/clear') {
      rec.events.length = 0;
      if (rec.el) rec.el.innerHTML = '';
    } else {
      echo(`unknown command: ${cmd} — try /help`);
    }
  } catch (e) {
    echo('error: ' + e.message);
  }
}

setInterval(refreshIndicators, 5000);
setInterval(loadAgents, 15000);
setInterval(refreshVisibleChatTurnStatuses, 2500);

// v3.1 — Plan-approval workflow. Pending-plan badge + Plans pane.
const plansState = { list: [], selected: null, proposals: [] };

async function refreshPlansBadge() {
  const badge = document.getElementById('plans-badge');
  if (!badge) return;
  try {
    const [plansRes, replanRes] = await Promise.all([
      fetch('/api/plans?state=pending_approval'),
      fetch('/api/replan-proposals').catch(() => null),
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
    const r = await fetch('/api/replan-proposals');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { proposals } = await r.json();
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
  if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} replan proposal #${id}?`)) return;
  const r = await fetch(`/api/replan-proposals/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, resolved_by: 'operator' }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(`replan ${verb} failed: ${err.error || r.status}`);
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
  const r = await fetch('/api/plans' + q);
  const { plans } = await r.json();
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
  const r = await fetch('/api/plans/' + encodeURIComponent(id));
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
        <button id="plan-reject" class="danger">Reject</button>
      </div>
      <div class="plan-reject-row hidden" id="plan-reject-row">
        <input id="plan-reject-reason" placeholder="Reason for rejection" />
        <button id="plan-reject-confirm" class="danger">Confirm reject</button>
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
      if (!checked.length) { alert('Select at least one vector.'); return; }
      decidePlan(id, 'approve', { vectors: checked });
    });
    document.getElementById('plan-reject').addEventListener('click', () => {
      document.getElementById('plan-reject-row').classList.remove('hidden');
    });
    document.getElementById('plan-reject-confirm').addEventListener('click', () => {
      const reason = document.getElementById('plan-reject-reason').value.trim() || 'no reason given';
      decidePlan(id, 'reject', { reason });
    });
  }
}

async function decidePlan(id, action, body) {
  const r = await fetch(`/api/plans/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(`${action} failed: ${err.error || r.status}`);
    return;
  }
  await loadPlansList();
  await selectPlan(id);
  refreshPlansBadge();
}

// (escapeHtml defined earlier in this file)

document.getElementById('open-glados').addEventListener('click', ev => { ev.preventDefault(); openGladosChat(); });
document.getElementById('open-chatbot').addEventListener('click', ev => { ev.preventDefault(); openChatBot(); });
document.getElementById('open-reports').addEventListener('click', ev => { ev.preventDefault(); openReports(); });
document.getElementById('open-settings').addEventListener('click', ev => { ev.preventDefault(); openSettings(); });
document.getElementById('open-about').addEventListener('click', ev => { ev.preventDefault(); openAbout(); });
document.getElementById('open-getting-started').addEventListener('click', ev => {
  ev.preventDefault();
  // Support deep-linking via href="#install" | "#engagement" | "#troubleshooting"
  // on the sidebar entry or any caller that sets the href hash.
  const href = ev.currentTarget?.getAttribute('href') || '';
  const anchor = href.startsWith('#') ? href.slice(1) : null;
  openGettingStarted(anchor);
});
// Allow any element in the app to deep-link into Getting Started via
// <a data-gs-anchor="install|engagement|troubleshooting">…</a>. Used by
// health-banner "Re-apply patches" hint and Proxy tab error states.
document.addEventListener('click', ev => {
  const el = ev.target?.closest?.('[data-gs-anchor]');
  if (!el) return;
  ev.preventDefault();
  openGettingStarted(el.getAttribute('data-gs-anchor'));
});
// Initial hash navigation: dashboard URL ending in #install /#engagement
// /#troubleshooting opens Getting Started and scrolls to that section.
(() => {
  const h = (location.hash || '').replace(/^#/, '');
  if (h === 'install' || h === 'engagement' || h === 'troubleshooting') {
    // Defer so the main render completes first.
    requestAnimationFrame(() => openGettingStarted(h));
  }
})();
document.getElementById('open-terminal').addEventListener('click', ev => { ev.preventDefault(); openTerminal(); });
document.getElementById('open-proxy').addEventListener('click', ev => { ev.preventDefault(); openProxy(); });

// Live-events footer: Clear wipes the on-screen feed (server keeps its own log).
document.getElementById('events-clear').addEventListener('click', () => {
  eventsEl.innerHTML = '';
});

// Sidebar sections: each heading is an independent collapse/expand toggle.
// State per section persists in localStorage so choices survive reload.
(() => {
  const sections = [
    { headingId: 'agents-heading',     bodyId: 'agent-list' },
    { headingId: 'workspace-heading',  bodyId: 'workspace-links' },
    { headingId: 'indicators-heading', bodyId: 'indicators-group' },
    { headingId: 'help-heading',       bodyId: 'help-links' },
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

document.getElementById('restart-gateway').addEventListener('click', async () => {
  if (!confirm('Restart the OpenClaw Gateway? Any in-flight agent turns will disconnect.')) return;
  const btn = document.getElementById('restart-gateway');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Restarting…';
  try {
    const r = await fetch('/api/gateway/restart', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'restart failed');
    btn.textContent = 'Restarted ✓';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
  } catch (e) {
    alert('gateway restart failed: ' + e.message);
    btn.textContent = orig; btn.disabled = false;
  }
});

document.getElementById('reset-session').addEventListener('click', async () => {
  const tabId = state.currentTab;
  const tab = state.openTabs.find(t => t.id === tabId);
  const agentId = tab?.kind === 'chat' ? 'glados'
    : tab?.kind === 'chatbot' ? 'atlas'
    : (tab?.kind === 'agent' ? tab.id : null);
  if (!agentId) { alert('Select an agent or GLaDOS chat tab first.'); return; }
  const resetMsg = agentId === 'glados'
    ? 'Archive the current GLaDOS session and every assessment agent session, wipe the blackboard (engagements, findings, tasks, plans, recon state), AND clear short-term memory caches (memory/.dreams/) for every agent? Curated MEMORY.md, evidence files, and exported reports are kept. Atlas is left alone. The next message starts a fresh investigation.'
    : `Archive the current session for "${agentId}"? The next message starts a fresh session.`;
  if (!confirm(resetMsg)) return;
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/reset-session`, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'reset failed');
    // Drop local transcript and re-subscribe.
    const rec = state.transcripts.get(tabId);
    if (rec) {
      try { rec.es && rec.es.close(); } catch {}
      state.transcripts.delete(tabId);
    }
    renderPane();
  } catch (e) { alert('reset-session failed: ' + e.message); }
});

loadAgents().then(() => {
  openGladosChat();
  subscribeLobby();
  refreshIndicators();
  setupHealthBanner();
});
