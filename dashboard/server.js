const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { PORT, BLACKBOARD_DB, GLADOS_AGENT_WORKSPACES } = require('./lib/config');
const reports = require('./lib/reports');
const agentDetails = require('./lib/agent-details');
const { getVersionInfo } = require('./lib/version');
const { DashboardTranscriptStore, mergeTranscriptEvents, afterLastEventId, sseFrame } = require('./lib/transcript-store');
const { ControllerLite } = require('./lib/controller');
const slash = require('./lib/slash');
const updateRunner = require('./lib/update-runner');
const {
  streamAgentTurn,
  loadRegistry: loadHarnessRegistry,
  loadPolicy,
  agentEnabled,
  bareModelAlias,
} = require('./lib/harness/agent-sdk');
const { SdkSessionRegistry } = require('./lib/harness/session-registry');
const { proxyBackendConfig, startMitmproxy } = require('./lib/proxy/mitmproxy-runner');
const {
  proxyHistory,
  proxyDetail,
  proxyMetrics,
  watchProxyEvents,
  proxyHealth,
} = require('./lib/proxy/native-store');
const watchdogHealth = require('glados-watchdog/lib/health');
const watchdogHalt = require('glados-watchdog/lib/halt');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules', 'marked')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, 'node_modules', 'dompurify', 'dist')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', 'xterm-addon-fit')));

try {
  require('../scripts/lib/glados-local').ensureBlackboardDb({ blackboardDb: BLACKBOARD_DB });
} catch (e) {
  console.warn('[startup] could not initialize blackboard db:', e.message);
}

const transcriptStore = new DashboardTranscriptStore(BLACKBOARD_DB);
const sdkSessionRegistry = new SdkSessionRegistry();
let proxyRuntime = {
  status: 'stopped',
  child: null,
  pid: null,
  startedAt: null,
  error: null,
  stderr: '',
};

function startDesktopProxy() {
  const config = proxyBackendConfig(process.env);
  if (process.env.GLADOS_DESKTOP !== '1' || config.backend !== 'mitmproxy') return;
  const caScript = path.resolve(__dirname, '..', 'scripts', 'glados-ca.sh');
  const generated = require('node:child_process').spawnSync('/bin/bash', [caScript, 'generate'], {
    env: process.env,
    encoding: 'utf8',
  });
  if (generated.status !== 0) {
    proxyRuntime = {
      ...proxyRuntime,
      status: 'failed',
      error: generated.stderr?.trim() || `MITM CA bootstrap exited ${generated.status}`,
    };
    console.warn('[proxy] native proxy CA bootstrap failed:', proxyRuntime.error);
    return;
  }
  try {
    const runtime = startMitmproxy(config);
    proxyRuntime = {
      status: 'starting',
      child: runtime.child,
      pid: runtime.child.pid || null,
      startedAt: new Date().toISOString(),
      error: null,
      stderr: '',
    };
    runtime.child.stdout?.on('data', chunk => process.stdout.write(`[proxy] ${chunk}`));
    runtime.child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      proxyRuntime.stderr = `${proxyRuntime.stderr}${text}`.slice(-4000);
      process.stderr.write(`[proxy] ${text}`);
    });
    runtime.child.once('spawn', () => {
      proxyRuntime.status = 'running';
      proxyRuntime.pid = runtime.child.pid || null;
      console.log(`[proxy] native mitmproxy listening on ${config.listenHost}:${config.listenPort}`);
    });
    runtime.child.once('error', error => {
      proxyRuntime.status = 'failed';
      proxyRuntime.error = error.message;
      proxyRuntime.child = null;
      proxyRuntime.pid = null;
      console.warn('[proxy] native proxy failed:', error.message);
    });
    runtime.child.once('exit', (code, signal) => {
      if (proxyRuntime.status !== 'stopping') {
        proxyRuntime.status = 'failed';
        proxyRuntime.error = `mitmproxy exited (${signal || code})`;
      } else {
        proxyRuntime.status = 'stopped';
      }
      proxyRuntime.child = null;
      proxyRuntime.pid = null;
    });
  } catch (error) {
    proxyRuntime = { ...proxyRuntime, status: 'failed', child: null, pid: null, error: error.message };
    console.warn('[proxy] native proxy failed:', error.message);
  }
}

function stopDesktopProxy({ timeoutMs = 2500 } = {}) {
  const child = proxyRuntime.child;
  proxyRuntime.status = 'stopping';
  if (!child || child.exitCode != null) {
    proxyRuntime.status = 'stopped';
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      proxyRuntime.status = 'stopped';
      proxyRuntime.child = null;
      proxyRuntime.pid = null;
      resolve();
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      setTimeout(finish, 250).unref();
    }, timeoutMs);
    try { child.kill('SIGTERM'); } catch { finish(); }
  });
}

startDesktopProxy();

app.get('/api/version', (req, res) => {
  res.json(getVersionInfo());
});

// Per-agent ring buffer of recent events (for new SSE subscribers to backfill).
const BUFFER_LIMIT = 500;
const buffers = new Map(); // agentId -> array of events (newest last)
const sseClients = new Map(); // agentId -> Set<{ res, includeStream }>
const lobbyClients = new Set(); // /api/agents SSE subscribers
const activeChatTurns = new Map(); // agentId -> { turnId, startedAt, messagePreview }
const activeSubagentTurns = new Map(); // agentId -> { sessionId, startedAt, parentAgentId, parentTurnId, toolCallId }
const activeTaskToolIds = new Map(); // toolCallId -> agentId
let pendingGladosKickoff = null;
const BLACKBOARD_STATE_TABLES = [
  'controller_events',
  'controller_jobs',
  'controller_goals',
  'dashboard_transcript_events',
  'replan_proposals',
  'plan_approvals',
  'plans',
  'recon_steps',
  'baseline_recon',
  'tasks',
  'findings',
  'engagements',
];

function loadAgentRegistry() {
  const policy = loadPolicy();
  return loadHarnessRegistry()
    .filter(agent => agent?.id && agentEnabled(agent.id, { policy }))
    .map(agent => ({
      ...agent,
      model: bareModelAlias(agent.model, { fallback: policy.harness?.defaultModel || 'claude-sonnet-5' }),
      workspace: agent.workspace || path.join(GLADOS_AGENT_WORKSPACES, agent.id),
      runtime: 'agent-sdk',
    }));
}

function listAgentIds() {
  return loadAgentRegistry().map(agent => agent.id);
}

function currentSessionForAgent(agentId) {
  const turn = activeChatTurns.get(agentId);
  const subagent = activeSubagentTurns.get(agentId);
  if (!turn && !subagent) return null;
  if (subagent && !turn) {
    return {
      live: true,
      runtime: 'agent-sdk',
      sessionId: subagent.sessionId,
      sessionKey: `sdk:${agentId}:${subagent.sessionId}`,
      startedAt: new Date(subagent.startedAt).toISOString(),
      messagePreview: subagent.messagePreview || `subagent of ${subagent.parentAgentId || 'glados'}`,
      parentAgentId: subagent.parentAgentId || null,
      parentTurnId: subagent.parentTurnId || null,
      toolCallId: subagent.toolCallId || null,
    };
  }
  return {
    live: true,
    runtime: 'agent-sdk',
    sessionId: turn.turnId,
    sessionKey: `sdk:${agentId}:${turn.turnId}`,
    startedAt: new Date(turn.startedAt).toISOString(),
    messagePreview: turn.messagePreview,
  };
}

function isTaskDispatchToolName(name) {
  return name === 'Task' || name === 'Agent';
}

function targetAgentFromToolInput(input = {}) {
  return input.subagent_type
    || input.subagentType
    || input.agent
    || input.agentId
    || input.agent_id
    || input.name
    || input.type
    || null;
}

function isAllowedSubagentDispatch(parentAgentId, targetAgentId) {
  if (parentAgentId !== 'glados' || !targetAgentId || targetAgentId === 'glados') return false;
  return loadAgentRegistry().some(agent => agent.id === targetAgentId);
}

function startSubagentTurn(parentAgentId, targetAgent, { toolCallId = null, parentTurnId = null, messagePreview = '' } = {}) {
  if (!targetAgent || targetAgent === parentAgentId) return;
  const existing = activeSubagentTurns.get(targetAgent);
  if (toolCallId) activeTaskToolIds.set(toolCallId, targetAgent);
  if (existing?.live) return;
  const sessionId = toolCallId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  activeSubagentTurns.set(targetAgent, {
    live: true,
    sessionId,
    startedAt,
    parentAgentId,
    parentTurnId,
    toolCallId,
    messagePreview,
  });
  broadcastLobby('session-started', { agentId: targetAgent, sessionId, startedAt, parentAgentId, parentTurnId, toolCallId });
}

function finishSubagentTurn(targetAgent, { toolCallId = null, reason = null } = {}) {
  if (!targetAgent) return;
  const turn = activeSubagentTurns.get(targetAgent);
  if (!turn) {
    if (toolCallId) activeTaskToolIds.delete(toolCallId);
    return;
  }
  activeSubagentTurns.delete(targetAgent);
  if (toolCallId) activeTaskToolIds.delete(toolCallId);
  else if (turn.toolCallId) activeTaskToolIds.delete(turn.toolCallId);
  broadcastLobby('session-ended', { agentId: targetAgent, sessionId: turn.sessionId, toolCallId: turn.toolCallId, reason });
}

function finishSubagentsForTurn(parentAgentId, parentTurnId, reason = 'parent turn ended') {
  for (const [agentId, turn] of [...activeSubagentTurns.entries()]) {
    if (turn.parentAgentId === parentAgentId && (!parentTurnId || turn.parentTurnId === parentTurnId)) {
      finishSubagentTurn(agentId, { toolCallId: turn.toolCallId, reason });
    }
  }
}

function sendMessageToAgentTrackedRuntime(agentId, message) {
  return {
    child: null,
    promise: sendMessageToAgentRuntime(agentId, message),
  };
}

function pushBuffer(agentId, ev) {
  let buf = buffers.get(agentId);
  if (!buf) { buf = []; buffers.set(agentId, buf); }
  if (ev?.id && buf.some(existing => existing?.id === ev.id)) return;
  buf.push(ev);
  if (buf.length > BUFFER_LIMIT) buf.shift();
}

function broadcastTranscript(agentId, ev) {
  const set = sseClients.get(agentId);
  if (!set) return;
  for (const client of set) {
    const payload = sseFrame(ev, { includeStream: client.includeStream });
    if (payload) client.res.write(payload);
  }
}

function broadcastLobby(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of lobbyClients) res.write(payload);
}

function startChatTurn(agentId, message) {
  const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  activeChatTurns.set(agentId, {
    turnId,
    startedAt,
    messagePreview: String(message || '').slice(0, 160),
    abortController: new AbortController(),
    interrupt: null,
    stopRequested: false,
  });
  broadcastLobby('chat-turn-started', { agentId, turnId, startedAt });
  return turnId;
}

function attachChatTurnInterrupt(agentId, turnId, interrupt) {
  const turn = activeChatTurns.get(agentId);
  if (!turn || turn.turnId !== turnId) return;
  turn.interrupt = interrupt;
  if (turn.stopRequested && typeof interrupt === 'function') {
    Promise.resolve(interrupt('operator stop')).catch(() => {});
  }
}

function stopChatTurn(agentId, reason = 'operator stop') {
  const turn = activeChatTurns.get(agentId);
  if (!turn) return { ok: true, stopped: false, agentId, reason: 'no active turn' };
  turn.stopRequested = true;
  try {
    if (turn.abortController && !turn.abortController.signal.aborted) {
      turn.abortController.abort(reason);
    }
  } catch {}
  if (typeof turn.interrupt === 'function') {
    Promise.resolve(turn.interrupt(reason)).catch(() => {});
  }
  activeChatTurns.delete(agentId);
  finishSubagentsForTurn(agentId, turn.turnId, reason);
  broadcastLobby('chat-turn-ended', { agentId, turnId: turn.turnId, stopped: true, reason });
  transcriptEvent(agentId, 'meta', `Stopped current turn: ${reason}`, {
    sub: 'operator-stop',
    turnId: turn.turnId,
  });
  return { ok: true, stopped: true, agentId, turnId: turn.turnId, reason };
}

function finishChatTurn(agentId, turnId) {
  const current = activeChatTurns.get(agentId);
  if (!current || current.turnId !== turnId) return;
  activeChatTurns.delete(agentId);
  broadcastLobby('chat-turn-ended', { agentId, turnId });
}

function transcriptEvent(agentId, kind, text, extra = {}) {
  let ev = {
    agentId,
    kind,
    text,
    ts: new Date().toISOString(),
    id: `dashboard:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  };
  try {
    ev = transcriptStore.record(agentId, ev);
  } catch (e) {
    console.warn('[transcript-store] could not persist dashboard event:', e.message);
  }
  pushBuffer(agentId, ev);
  broadcastTranscript(agentId, ev);
  return ev;
}

function recordUserTranscript(agentId, text, extra = {}) {
  return transcriptEvent(agentId, 'user-message', text, {
    id: `dashboard-user:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  });
}

async function sendMessageToAgentRuntime(agentId, message, { turnId = null } = {}) {
  recordUserTranscript(agentId, message, { runtime: 'agent-sdk' });
  const turn = turnId ? activeChatTurns.get(agentId) : null;
  let events = [];
  try {
    events = await streamAgentTurn({
      agentId,
      prompt: message,
      store: transcriptStore,
      onEvent: ev => {
        const targetAgent = ev.agentId || agentId;
        if (targetAgent !== agentId && !isAllowedSubagentDispatch(agentId, targetAgent)) return;
        if (ev.kind === 'tool-call' && isTaskDispatchToolName(ev.toolName)) {
          const child = ev.targetAgentId || targetAgentFromToolInput(ev.toolInput);
          if (isAllowedSubagentDispatch(targetAgent, child)) {
            const childPrompt = String(ev.toolInput?.prompt || '').trim();
            startSubagentTurn(targetAgent, child, {
              toolCallId: ev.toolCallId,
              parentTurnId: turnId,
              messagePreview: ev.toolInput?.description || childPrompt || ev.text || '',
            });
            if (childPrompt) {
              recordUserTranscript(child, childPrompt, {
                id: `subagent-prompt:${ev.toolCallId}`,
                runtime: 'agent-sdk',
                parentAgentId: targetAgent,
                parentToolUseId: ev.toolCallId,
                sub: 'subagent-prompt',
              });
            }
          }
        } else if (ev.kind === 'tool-result' && ev.toolCallId && activeTaskToolIds.has(ev.toolCallId)) {
          finishSubagentTurn(activeTaskToolIds.get(ev.toolCallId), { toolCallId: ev.toolCallId });
        } else if (isAllowedSubagentDispatch(agentId, targetAgent) && (ev.kind === 'thinking-stream' || ev.kind === 'text-stream' || ev.kind === 'assistant-text' || ev.kind === 'tool-call')) {
          startSubagentTurn(agentId, targetAgent, {
            toolCallId: ev.parentToolUseId || ev.toolCallId || null,
            parentTurnId: turnId,
            messagePreview: ev.text || ev.toolName || '',
          });
        }
        pushBuffer(targetAgent, ev);
        broadcastTranscript(targetAgent, ev);
        if (ev.kind === 'liveness') {
          if (isAllowedSubagentDispatch(agentId, targetAgent)) {
            if (ev.live) startSubagentTurn(agentId, targetAgent, { toolCallId: ev.parentToolUseId || ev.toolCallId || null, parentTurnId: turnId, messagePreview: ev.text || ev.state || '' });
            else finishSubagentTurn(targetAgent, { toolCallId: ev.parentToolUseId || ev.toolCallId || null, reason: ev.state || 'liveness ended' });
          }
          broadcastLobby('agent-liveness', { agentId: targetAgent, live: ev.live, state: ev.state, sessionId: currentSessionForAgent(targetAgent)?.sessionId || null });
        }
      },
      options: {
        abortSignal: turn?.turnId === turnId ? turn.abortController?.signal : undefined,
        onInterruptReady: interrupt => attachChatTurnInterrupt(agentId, turnId, interrupt),
        resumeSessionId: sdkSessionRegistry.get(agentId),
        onSessionId: sessionId => sdkSessionRegistry.set(agentId, sessionId),
      },
    });
  } finally {
    finishSubagentsForTurn(agentId, turnId);
  }
  const finalText = events
    .filter(ev => ev.kind === 'result' || ev.kind === 'assistant-text')
    .map(ev => ev.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  return {
    runtime: 'agent-sdk',
    result: { payloads: [{ text: finalText || '', mediaUrl: null }] },
    events: events.length,
  };
}

const controller = new ControllerLite({
  dbPath: BLACKBOARD_DB,
  sendMessageToAgentTracked: sendMessageToAgentTrackedRuntime,
  currentSessionForAgent,
});
if (process.env.GLADOS_CONTROLLER_WORKER !== '0') controller.start();

function blackboardRowCounts() {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    const counts = {};
    for (const table of BLACKBOARD_STATE_TABLES) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    return counts;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function normalizeTarget(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`.,!?;:]+$/g, '')
    .replace(/\/+$/g, '');
}

function isFreshSessionQuestion(message) {
  const text = String(message || '').toLowerCase();
  return /\b(fresh|new|clean)\s+session\b/.test(text)
    || /\bis\s+this\s+(?:a\s+)?(?:fresh|new|clean)\b/.test(text);
}

function isKickoffApproval(message) {
  return /\b(continue|proceed|go ahead|approved?|yes|start|do it|looks good)\b/i.test(String(message || ''));
}

function isKickoffCancel(message) {
  return /\b(cancel|stop|halt|no|never mind|nevermind|do not proceed)\b/i.test(String(message || ''));
}

function resolveKickoffResources(message) {
  const text = String(message || '').toLowerCase();
  let resources = [
    { id: 'dradistab', label: 'Dradis Tab', url: 'https://dradistab.redteamstuff.com' },
    { id: 'dradis', label: 'Dradis', url: 'https://dradis.redteamstuff.com' },
    { id: 'domainsai', label: 'DomainsAI', url: 'https://domainsai.redteamstuff.com' },
  ];

  if (/\bonly\s+domainsai\b/.test(text)) {
    resources = resources.filter(r => r.id === 'domainsai');
  }
  const skipDradisPair = /\bskip\b[^.?!\n]*(dradistab\s*\/\s*dradis|dradis\s*\/\s*dradistab|dradistab\s+(?:and|&)\s+dradis|dradis\s+(?:and|&)\s+dradistab)/.test(text)
    || /\bskip\s+(?:the\s+)?dradis(?:tab)?\s+checks?\b/.test(text);
  if (skipDradisPair) {
    resources = resources.filter(r => r.id !== 'dradis' && r.id !== 'dradistab');
  } else {
    if (/\bskip\s+(?:the\s+)?dradistab\b/.test(text)) {
      resources = resources.filter(r => r.id !== 'dradistab');
    }
    if (/\bskip\s+(?:the\s+)?dradis\b/.test(text)) {
      resources = resources.filter(r => r.id !== 'dradis');
    }
  }
  if (/\bskip\s+(?:all\s+)?(?:internal\s+)?(?:resource|resources|lookups|checks)\b/.test(text)) {
    resources = [];
  }
  if (/\bdomainsai\s+first\b/.test(text)) {
    resources.sort((a, b) => (a.id === 'domainsai' ? -1 : b.id === 'domainsai' ? 1 : 0));
  }

  return resources;
}

function kickoffApprovalPrompt(target) {
  return [
    `Ok, I am going to proceed with the pre-assessment checks for \`${target}\` in this order:`,
    '',
    '1. DradisTab — check whether a prior or in-flight assessment exists.',
    '2. Dradis — if a matching project exists and belongs to the local operator profile, summarize the existing CWE coverage/findings.',
    '3. DomainsAI — search the target domain at https://domainsai.redteamstuff.com for asset/domain context.',
    '',
    'Would you like any changes before I proceed?'
  ].join('\n');
}

function createPendingGladosKickoff(target, originalMessage, extra = {}) {
  let goalId = extra.goalId || null;
  if (!goalId) {
    try {
      const goal = controller.createWebGoal(target, { source: extra.source || 'chat' });
      goalId = goal?.id || null;
    } catch (e) {
      console.warn('[controller] could not record web goal:', e.message);
    }
  }
  pendingGladosKickoff = {
    target,
    originalMessage,
    goalId,
    createdAt: Date.now(),
  };
  const ev = transcriptEvent('glados', 'assistant-text', kickoffApprovalPrompt(target), { gated: true });
  return {
    ok: true,
    gated: true,
    pending: pendingGladosKickoff,
    event: ev,
    result: { payloads: [{ text: ev.text, mediaUrl: null }] },
  };
}

function buildApprovedKickoffMessage(pending, operatorReply) {
  const resources = resolveKickoffResources(operatorReply);
  const resourceText = resources.length ? resources.map(r => `${r.label} (${r.url})`).join(', ') : 'none';
  const approvedIds = new Set(resources.map(r => r.id));
  const skipped = [
    { id: 'dradistab', label: 'Dradis Tab', url: 'https://dradistab.redteamstuff.com' },
    { id: 'dradis', label: 'Dradis', url: 'https://dradis.redteamstuff.com' },
    { id: 'domainsai', label: 'DomainsAI', url: 'https://domainsai.redteamstuff.com' },
  ].filter(r => !approvedIds.has(r.id));
  const skippedText = skipped.length ? skipped.map(r => `${r.label} (${r.url})`).join(', ') : 'none';
  const target = pending.target;
  return [
    `Begin the approved investigation kickoff for ${target}.`,
    '',
    'Operator approval gate has already completed in the dashboard.',
    `Approved pre-agent resources, in order: ${resourceText}.`,
    `Explicitly skipped resources: ${skippedText}.`,
    '',
    'Hard workflow rules:',
    '- Do not consult any unapproved resource.',
    '- If Dradis or Dradis Tab is skipped, do not read the dradis-workflow skill and do not browse dradistab.redteamstuff.com or dradis.redteamstuff.com.',
    '- For DomainsAI use exactly https://domainsai.redteamstuff.com; do not guess public lookalike domains.',
    '- When Dradis has a matching project, summarize whether it appears associated with the local operator profile and list existing CWE/finding coverage if available.',
    '- For Ford webapp targets that redirect to corp.sts.ford.com, treat corp.sts.ford.com only as an authentication dependency. Do not investigate, fuzz, enumerate, or report findings on that host.',
    '- Do not ask the operator for Ford ADFS credentials or IdP choice during this run. Use operator context: IdP = Active Directory, local auth profile = ford-sso, helper = glados-ops__adfs_active_directory_login.',
    '- Every webapp-recon or webapp-vuln dispatch must include this exact AUTHENTICATION BOUNDARY block:',
    '  AUTHENTICATION BOUNDARY — HARD RULE:',
    '  corp.sts.ford.com is Ford ADFS/SSO and is OUT OF SCOPE for testing.',
    '  If redirected there, select Active Directory and call glados-ops__adfs_active_directory_login with profile_id=ford-sso exactly once.',
    '  After the browser lands back on the approved target host, screenshot the landing page immediately and begin recon there.',
    '  If auth helper fails or MFA appears, stop and report to GLaDOS; do not investigate the SSO page.',
    '- First send one concise message: "Will do, starting with <target>..."',
    '- Then perform only the approved resource checks.',
    '- Consolidate resource-check results into one concise message.',
    '- Then announce one dispatch message for the core Phase 1 agents: "Deploying WEBAPP RECON and low-impact DNS/NET recon agents to do <specific tasks>..."',
    '- Do not dispatch OSINT unless the operator explicitly asks for OSINT/passive public-source recon. OSINT is manual-only and must never block plan-synthesizer after webapp-recon has finished.',
    '- Do not send separate chat bubbles for every internal tool call.',
    '- Do not dispatch exploitation agents before plan approval.',
    '',
    `Original operator request: ${pending.originalMessage}`,
    `Operator approval reply: ${operatorReply}`,
  ].join('\n');
}

function harnessResultError(result) {
  const payloads = result?.result?.payloads || [];
  const text = payloads.map(p => p?.text || '').join('\n').trim();
  if (/LLM request failed|LLM idle timeout|network connection error/i.test(text)) {
    return text || 'Agent SDK model request failed';
  }
  const stopReason = result?.result?.stopReason;
  const err = result?.result?.error || result?.error;
  if (stopReason === 'error' || err) return err || 'Agent SDK run stopped with error';
  return null;
}

function assessmentAgentIds() {
  const registryIds = loadAgentRegistry().map(a => a.id).filter(Boolean);
  const ids = registryIds.length ? registryIds : listAgentIds();
  return [...new Set(ids)];
}

function resetAgentSession(agentId) {
  const hadSession = !!currentSessionForAgent(agentId);
  const turn = activeChatTurns.get(agentId);
  if (turn) {
    turn.stopRequested = true;
    try {
      if (turn.abortController && !turn.abortController.signal.aborted) {
        turn.abortController.abort('session reset');
      }
    } catch {}
    if (typeof turn.interrupt === 'function') {
      Promise.resolve(turn.interrupt('session reset')).catch(() => {});
    }
  }
  activeChatTurns.delete(agentId);
  const subagent = activeSubagentTurns.get(agentId);
  if (subagent?.toolCallId) activeTaskToolIds.delete(subagent.toolCallId);
  activeSubagentTurns.delete(agentId);
  for (const [childId, child] of [...activeSubagentTurns.entries()]) {
    if (child.parentAgentId === agentId) {
      activeSubagentTurns.delete(childId);
      if (child.toolCallId) activeTaskToolIds.delete(child.toolCallId);
      broadcastLobby('session-ended', { agentId: childId, sessionId: child.sessionId, toolCallId: child.toolCallId, reason: 'session reset' });
    }
  }
  buffers.delete(agentId);
  sdkSessionRegistry.clear(agentId);
  broadcastLobby('session-reset', {
    agentId,
    runtime: 'agent-sdk',
    hadSession,
  });
  return {
    ok: true,
    agentId,
    runtime: 'agent-sdk',
    hadSession,
  };
}

function clearAllRuntimeSessions(reason = 'runtime restart') {
  const agentIds = new Set([
    'glados',
    ...assessmentAgentIds(),
    ...buffers.keys(),
    ...activeChatTurns.keys(),
    ...activeSubagentTurns.keys(),
  ]);
  for (const [agentId, turn] of activeChatTurns.entries()) {
    turn.stopRequested = true;
    try {
      if (turn.abortController && !turn.abortController.signal.aborted) turn.abortController.abort(reason);
    } catch {}
    if (typeof turn.interrupt === 'function') {
      Promise.resolve(turn.interrupt(reason)).catch(() => {});
    }
    broadcastLobby('chat-turn-ended', { agentId, turnId: turn.turnId, stopped: true, reason });
  }
  for (const [agentId, turn] of activeSubagentTurns.entries()) {
    broadcastLobby('session-ended', { agentId, sessionId: turn.sessionId, toolCallId: turn.toolCallId, reason });
  }
  activeChatTurns.clear();
  activeSubagentTurns.clear();
  activeTaskToolIds.clear();
  buffers.clear();
  pendingGladosKickoff = null;
  try { transcriptStore.clearAll(); } catch (e) { console.warn('[transcript-store] runtime clear failed:', e.message); }
  sdkSessionRegistry.clearAll();
  for (const agentId of agentIds) {
    broadcastLobby('session-reset', { agentId, runtime: 'agent-sdk', hadSession: true, reason });
  }
  return [...agentIds];
}

// Wipes the blackboard so a fresh GLaDOS session starts a clean investigation.
// Engagement records, findings, tasks, plans, and recon state are all cleared.
// Evidence files in ~/.glados/investigations/ and exported reports in
// ~/.glados/reports/ are filesystem artifacts and are not touched here.
function wipeBlackboard() {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(BLACKBOARD_DB);
  } catch (e) {
    return { ok: false, error: `open blackboard: ${e.message}` };
  }
  try {
    db.pragma('foreign_keys = OFF');
    const counts = {};
    const tx = db.transaction(() => {
      for (const t of BLACKBOARD_STATE_TABLES) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
        counts[t] = n;
        db.prepare(`DELETE FROM ${t}`).run();
      }
      db.prepare(`DELETE FROM sqlite_sequence`).run();
    });
    tx();
    db.pragma('foreign_keys = ON');
    return { ok: true, tablesCleared: BLACKBOARD_STATE_TABLES, rowsDeleted: counts };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { db.close(); } catch {}
  }
}

// Clears short-term workspace recall that can leak prior-investigation context
// into a fresh SDK harness session. The curated long-term MEMORY.md is
// intentionally preserved.
function wipeAgentMemories() {
  const fs = require('node:fs');
  const path = require('node:path');
  const workspaces = process.env.GLADOS_AGENT_WORKSPACES
    || GLADOS_AGENT_WORKSPACES;
  let dreamsCleared = 0;
  let agents = 0;
  const errors = [];

  let entries = [];
  try { entries = fs.readdirSync(workspaces, { withFileTypes: true }); } catch (e) {
    return { ok: false, error: `read workspaces: ${e.message}` };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    agents++;
    const dreamsDir = path.join(workspaces, ent.name, 'memory', '.dreams');
    if (!fs.existsSync(dreamsDir)) continue;
    try {
      for (const f of fs.readdirSync(dreamsDir)) {
        try { fs.rmSync(path.join(dreamsDir, f), { force: true, recursive: true }); dreamsCleared++; }
        catch (e) { errors.push(`dreams ${ent.name}/${f}: ${e.message}`); }
      }
    } catch (e) { errors.push(`dreams ${ent.name}: ${e.message}`); }
  }

  return {
    ok: errors.length === 0,
    agents,
    dreamsCleared,
    errors,
  };
}

function bufferedTranscriptEvents(agentId, lastEventId = null, options = {}) {
  let dashboardEvents = [];
  try {
    dashboardEvents = transcriptStore.list(agentId);
  } catch (e) {
    console.warn('[transcript-store] could not list dashboard events:', e.message);
  }
  const mergeOptions = { includeStream: options.includeStream !== false };
  const merged = mergeTranscriptEvents(
    { events: dashboardEvents, options: mergeOptions },
    { events: buffers.get(agentId) || [], options: mergeOptions }
  );
  return afterLastEventId(merged, lastEventId);
}

// --- REST ---

app.get('/api/agents', (req, res) => {
  const registry = loadAgentRegistry();
  const out = registry.map(a => {
    const snap = currentSessionForAgent(a.id);
    return {
      id: a.id,
      name: a.name,
      model: a.model,
      workspace: a.workspace,
      runtime: a.runtime || 'agent-sdk',
      active: !!(snap && snap.live),
      session: snap,
      halted: watchdogHalt.agentStatus(a.id).haltActive,
    };
  });
  res.json({ agents: out });
});

// Lobby event stream — session-started / session-ended.
app.get('/api/agents/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  lobbyClients.add(res);
  const registry = loadAgentRegistry();
  const snapshot = registry
    .map(a => ({ agentId: a.id, session: currentSessionForAgent(a.id) }))
    .filter(r => r.session && r.session.live)
    .map(r => ({ agentId: r.agentId, sessionId: r.session.sessionId }));
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  req.on('close', () => lobbyClients.delete(res));
});

// Per-agent transcript SSE. On connect, backfills recent buffer then streams live.
app.get('/api/agents/:id/transcript', (req, res) => {
  const agentId = req.params.id;
  const includeStream = req.query.stream === 'v4';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  // Backfill from the durable SDK transcript store plus the in-memory live ring.
  const lastEventId = req.get('Last-Event-ID') || req.query.lastEventId || null;
  for (const ev of bufferedTranscriptEvents(agentId, lastEventId, { includeStream })) {
    const payload = sseFrame(ev, { includeStream });
    if (payload) res.write(payload);
  }

  let set = sseClients.get(agentId);
  if (!set) { set = new Set(); sseClients.set(agentId, set); }
  const client = { res, includeStream };
  set.add(client);
  req.on('close', () => set.delete(client));
});

// GLaDOS chat — POST message; reply arrives via the normal transcript stream.
app.post('/api/chat/glados', async (req, res) => {
  const message = (req.body && req.body.message) || '';
  if (!message.trim()) return res.status(400).json({ error: 'message required' });

  if (pendingGladosKickoff) {
    recordUserTranscript('glados', message);
    if (isKickoffCancel(message)) {
      const cancelled = pendingGladosKickoff;
      pendingGladosKickoff = null;
      if (cancelled.goalId) controller.updateGoalStatus(cancelled.goalId, 'cancelled');
      const ev = transcriptEvent('glados', 'assistant-text', `Cancelled the pending investigation kickoff for \`${cancelled.target}\`. No resources were checked and no agents were dispatched.`);
      return res.json({ ok: true, gated: true, cancelled: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
    }

    if (!isKickoffApproval(message) && !/\b(skip|only|domainsai|dradis|dradistab)\b/i.test(message)) {
      const ev = transcriptEvent(
        'glados',
        'assistant-text',
        `I am still paused before starting \`${pendingGladosKickoff.target}\`. Reply with "continue", "skip DradisTab/Dradis and proceed with DomainsAI", or another explicit change before I check resources or dispatch agents.`
      );
      return res.json({ ok: true, gated: true, waiting: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
    }

    const approved = pendingGladosKickoff;
    pendingGladosKickoff = null;
    if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'running');
    const approvedMessage = buildApprovedKickoffMessage(approved, message);
    const turnId = startChatTurn('glados', approvedMessage);
    try {
      const result = await sendMessageToAgentRuntime('glados', approvedMessage, { turnId });
      const resultError = harnessResultError(result);
      if (resultError) {
        if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'failed');
        return res.status(502).json({ ok: false, error: resultError, result });
      }
      if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'complete');
      return res.json({ ok: true, gated: true, approved: true, result });
    } catch (e) {
      if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'failed');
      return res.status(500).json({
        ok: false,
        error: e.message,
        stderr: e.stderr,
        stdout: e.stdout,
      });
    } finally {
      finishChatTurn('glados', turnId);
    }
  }

  if (isFreshSessionQuestion(message)) {
    recordUserTranscript('glados', message);
    const counts = blackboardRowCounts();
    const rows = counts ? Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0) : null;
    const activeAgents = (() => {
      try {
        return loadAgentRegistry().filter(a => currentSessionForAgent(a.id)?.live).length;
      } catch { return 0; }
    })();
    const stateText = rows === 0 && activeAgents === 0
      ? 'Yes — this is a fresh GLaDOS session. No active agents are running, and the blackboard is clean.'
      : `Not completely fresh: ${activeAgents} active agent(s), ${rows ?? 'unknown'} blackboard row(s).`;
    const ev = transcriptEvent(
      'glados',
      'assistant-text',
      stateText
    );
    return res.json({ ok: true, gated: true, synthetic: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
  }

  const turnId = startChatTurn('glados', message);
  try {
    const result = await sendMessageToAgentRuntime('glados', message, { turnId });
    const resultError = harnessResultError(result);
    if (resultError) return res.status(502).json({ ok: false, error: resultError, result });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      stderr: e.stderr,
      stdout: e.stdout,
    });
  } finally {
    finishChatTurn('glados', turnId);
  }
});

app.post('/api/chat/:agent/stop', (req, res) => {
  const agentId = req.params.agent;
  const reason = String(req.body?.reason || 'operator stop').slice(0, 200);
  res.json(stopChatTurn(agentId, reason));
});

app.get('/api/chat/status/:agent', (req, res) => {
  const turn = activeChatTurns.get(req.params.agent);
  if (!turn) return res.json({ active: false, agentId: req.params.agent });
  res.json({
    active: true,
    agentId: req.params.agent,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    ageMs: Date.now() - turn.startedAt,
    messagePreview: turn.messagePreview,
  });
});

async function haltAgent(agentId, reason = 'dashboard halt', initiator = 'dashboard') {
  if (!assessmentAgentIds().includes(agentId)) throw new Error(`unknown GLaDOS agent: ${agentId}`);
  const result = await watchdogHalt.agentHalt(agentId, reason, { initiator });
  let interruptedParent = null;
  const direct = activeChatTurns.get(agentId);
  try { direct?.abortController?.abort(`${agentId} halted by operator`); } catch {}
  if (typeof direct?.interrupt === 'function') {
    await Promise.resolve(direct.interrupt(`${agentId} halted by operator`)).catch(() => {});
  }
  const subagent = activeSubagentTurns.get(agentId);
  if (subagent?.parentAgentId) {
    interruptedParent = subagent.parentAgentId;
    const parentTurn = activeChatTurns.get(interruptedParent);
    try { parentTurn?.abortController?.abort(`${agentId} halted by operator`); } catch {}
    if (typeof parentTurn?.interrupt === 'function') {
      await Promise.resolve(parentTurn.interrupt(`${agentId} halted by operator`)).catch(() => {});
    }
  }
  const notice = `Operator halted ${agentId}: ${reason}. ${interruptedParent ? `Its owning ${interruptedParent} turn was interrupted.` : 'Future tool calls are denied until this agent is resumed.'}`;
  transcriptEvent(agentId, 'operator-event', notice, { halted: true, initiator, isError: true });
  if (agentId !== 'glados') transcriptEvent('glados', 'operator-event', notice, { haltedAgentId: agentId, halted: true, initiator, isError: true });
  broadcastLobby('halt', { agentId, reason, interruptedParent, haltActive: true });
  return { ...result, interruptedParent };
}

async function resumeAgent(agentId, initiator = 'dashboard') {
  if (!assessmentAgentIds().includes(agentId)) throw new Error(`unknown GLaDOS agent: ${agentId}`);
  const result = await watchdogHalt.agentResume(agentId, { initiator });
  const notice = `Operator resumed ${agentId}. New turns and tool calls are permitted by the per-agent halt gate.`;
  transcriptEvent(agentId, 'operator-event', notice, { halted: false, initiator });
  if (agentId !== 'glados') transcriptEvent('glados', 'operator-event', notice, { haltedAgentId: agentId, halted: false, initiator });
  broadcastLobby('resume', { agentId, haltActive: false });
  return result;
}

async function probeTarget(targetUrl) {
  const result = await watchdogHealth.probe(targetUrl);
  broadcastLobby('target-health', result);
  return result;
}

function currentProxyConfig() {
  return proxyBackendConfig(process.env);
}

async function proxyRps() {
  const metrics = proxyMetrics({ windowSec: 10, config: currentProxyConfig() });
  return { backend: metrics.backend, rps: metrics.rps };
}

function configuredReplayProxyUrl() {
  const config = currentProxyConfig();
  if (process.env.GLADOS_REPLAY_PROXY) return process.env.GLADOS_REPLAY_PROXY;
  if (config.backend === 'mitmproxy') return `http://${config.listenHost}:${config.listenPort}`;
  return '';
}

function activeAgentStatus() {
  try {
    return loadAgentRegistry()
      .map(a => ({ agentId: a.id, session: currentSessionForAgent(a.id) }))
      .filter(a => a.session && a.session.live)
      .map(a => ({ agentId: a.agentId, sessionId: a.session.sessionId }));
  } catch {
    return [];
  }
}

function planSummary() {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT state, COUNT(*) AS n FROM plans GROUP BY state').all();
    const out = {};
    for (const row of rows) out[row.state] = row.n;
    return {
      pending: out.pending_approval || 0,
      approved: out.approved || 0,
      executing: out.executing || 0,
      complete: out.complete || 0,
      rejected: out.rejected || 0,
    };
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch {}
  }
}

function controllerStatusPayload() {
  return controller.status({
    pendingKickoff: pendingGladosKickoff ? {
      target: pendingGladosKickoff.target,
      goalId: pendingGladosKickoff.goalId || null,
      createdAt: pendingGladosKickoff.createdAt,
    } : null,
    activeAgents: activeAgentStatus(),
    targetHealth: watchdogHealth.listHealth(),
    plans: planSummary(),
  });
}

async function runSlash(raw) {
  const parsed = slash.parseSlashCommand(raw);
  const events = [];
  const emit = (text, kind = 'assistant-text', extra = {}) => {
    const ev = transcriptEvent('glados', kind, text, { slash: true, ...extra });
    events.push(ev);
    return ev;
  };

  const commandEvent = recordUserTranscript('glados', `$ ${String(raw || '').trim()}`, { slash: true });
  events.push(commandEvent);

  if (!parsed.ok) {
    emit(`${parsed.error} — try /help`);
    return { ok: false, events };
  }

  const { cmd, arg } = parsed;
  if (cmd === '/help') {
    emit(slash.helpText());
  } else if (cmd === '/agents') {
    const agents = loadAgentRegistry().map(a => ({ ...a, active: !!currentSessionForAgent(a.id)?.live }));
    emit(agents.map(a => `  ${a.active ? '●' : '○'} ${a.id.padEnd(18)} ${a.model || '?'}`).join('\n'));
  } else if (cmd === '/halt') {
    if (!arg) emit('usage: /halt <agent>');
    else emit(JSON.stringify(await haltAgent(arg, 'slash command', 'slash'), null, 2));
  } else if (cmd === '/resume') {
    if (!arg) emit('usage: /resume <agent>');
    else emit(JSON.stringify(await resumeAgent(arg, 'slash'), null, 2));
  } else if (cmd === '/probe') {
    if (!arg) emit('usage: /probe <url>');
    else emit(JSON.stringify(await probeTarget(arg), null, 2));
  } else if (cmd === '/status') {
    emit(slash.formatStatus(controllerStatusPayload()));
  } else if (cmd === '/goal' || cmd === '/investigate') {
    if (!arg) {
      emit(cmd === '/investigate' ? slash.investigateReadyPrompt() : slash.targetUsage(cmd));
    } else if (!slash.isUrlOrDomain(arg)) {
      emit(`${slash.targetUsage(cmd)}\nTarget must be a URL or domain.`);
    } else {
      const target = normalizeTarget(arg);
      const goal = controller.createWebGoal(target, { source: cmd });
      const kickoff = createPendingGladosKickoff(target, raw, { goalId: goal.id, source: 'slash' });
      if (kickoff.event) events.push(kickoff.event);
    }
  } else if (cmd === '/security-review') {
    if (!arg) {
      emit('usage: /security-review <url|domain|local-path>');
    } else if (slash.isExistingLocalPath(arg)) {
      const goal = controller.createSecurityReviewGoal(path.resolve(arg), { source: cmd, target_kind: 'local_path' });
      const job = controller.enqueueSecurityReviewPath(arg, { goalId: goal.id, engagementId: goal.engagement_id });
      emit(`Queued source-code security review for \`${job.target}\`.\nJob: ${job.id}`);
    } else if (slash.isUrlOrDomain(arg)) {
      const target = normalizeTarget(arg);
      const goal = controller.createGoal({
        type: 'security_review',
        target,
        status: 'pending_approval',
        metadata: { source: cmd, target_kind: 'url_or_domain' },
      });
      const kickoff = createPendingGladosKickoff(target, raw, { goalId: goal.id, source: 'slash-security-review' });
      if (kickoff.event) events.push(kickoff.event);
    } else {
      emit('usage: /security-review <url|domain|local-path>');
    }
  } else if (cmd === '/clear') {
    return { ok: true, events, action: { type: 'clear-local-transcript' } };
  }
  return { ok: true, events };
}

app.post('/api/slash/run', async (req, res) => {
  try {
    const command = String(req.body?.command || '');
    if (!command.trim()) return res.status(400).json({ ok: false, error: 'command required' });
    res.json(await runSlash(command));
  } catch (e) {
    const ev = transcriptEvent('glados', 'assistant-text', `error: ${e.message}`, { slash: true, isError: true });
    res.status(500).json({ ok: false, error: e.message, events: [ev] });
  }
});

app.get('/api/controller/status', (req, res) => {
  try { res.json({ ok: true, ...controllerStatusPayload() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/controller/events', (req, res) => {
  try { res.json({ ok: true, events: controller.eventsSince(req.query.since, req.query.limit) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/controller/goals', (req, res) => {
  try {
    const { type = 'webapp_goal', target, metadata = {} } = req.body || {};
    if (!target) return res.status(400).json({ ok: false, error: 'target required' });
    if (type === 'webapp_goal') return res.json({ ok: true, goal: controller.createWebGoal(target, metadata) });
    if (type === 'security_review') return res.json({ ok: true, goal: controller.createSecurityReviewGoal(target, metadata) });
    return res.status(400).json({ ok: false, error: 'unsupported goal type' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/controller/jobs/:id/cancel', (req, res) => {
  try { res.json(controller.cancelJob(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Halt controls (wired to watchdog lib) ---
app.post('/api/halt/:id', async (req, res) => {
  try {
    res.json(await haltAgent(req.params.id, req.body?.reason || 'dashboard halt', 'dashboard'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/resume/:id', async (req, res) => {
  try {
    res.json(await resumeAgent(req.params.id, 'dashboard'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Target health ---
app.post('/api/targets/probe', async (req, res) => {
  const { target_url } = req.body || {};
  if (!target_url) return res.status(400).json({ ok: false, error: 'target_url required' });
  try {
    res.json(await probeTarget(target_url));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/targets', (req, res) => {
  res.json({ targets: watchdogHealth.listHealth() });
});

// --- Proxy metrics ---
app.get('/api/proxy/rps', async (req, res) => {
  res.json(await proxyRps());
});

// --- Proxy API abstraction ---
app.get('/api/proxy/detail', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  const detail = proxyDetail(id, currentProxyConfig());
  if (!detail) return res.status(404).json({ error: 'not found' });
  res.json(detail);
});
app.get('/api/proxy/metrics', async (req, res) => {
  res.json(proxyMetrics({
    windowSec: Number(req.query.window || 10),
    config: currentProxyConfig(),
  }));
});
app.get('/api/proxy/history', async (req, res) => {
  res.json(proxyHistory({
    since: req.query.since,
    limit: req.query.limit,
    config: currentProxyConfig(),
  }));
});
// Request replay. Fires an HTTP request through the configured proxy so it
// lands in history with the provided agent tag; returns the response inline.
// Body: { method, url, headers: {..}, body?: string, agentTag?: string, timeoutMs? }
app.post('/api/proxy/replay', async (req, res) => {
  const { method = 'GET', url, headers = {}, body = null, agentTag = 'replay', timeoutMs = 15000 } =
    req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid http(s) url required' });
  // Forbid replay to loopback / localhost; prevents accidentally re-sending
  // dashboard/gateway/ollama traffic through the capture proxy and muddying
  // attribution.
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
      return res.status(400).json({ error: 'refusing replay to loopback' });
    }
  } catch { return res.status(400).json({ error: 'invalid url' }); }

  const undici = (() => { try { return require('undici'); } catch { return null; } })();
  const ProxyAgent = undici?.ProxyAgent;
  const proxyUrl = configuredReplayProxyUrl();
  const dispatcher = ProxyAgent && proxyUrl
    ? new ProxyAgent({
      uri: proxyUrl,
      // Replay intentionally talks through a local MITM proxy, which resigns
      // upstream TLS. Some operator shells do not export the local CA into
      // Node, so tolerate the interception cert for this endpoint.
      requestTls: { rejectUnauthorized: false },
    })
    : undefined;
  const replayFetch = dispatcher && undici?.fetch ? undici.fetch : fetch;

  const outHeaders = { ...headers, 'X-GLaDOS-Agent': agentTag, 'X-GLaDOS-Replay': '1' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000)));
  const started = Date.now();
  try {
    const init = { method: method.toUpperCase(), headers: outHeaders, signal: controller.signal };
    if (body != null && !['GET','HEAD'].includes(init.method)) init.body = body;
    if (dispatcher) init.dispatcher = dispatcher;
    const upstream = await replayFetch(url, init);
    const respHeaders = {};
    upstream.headers.forEach((v, k) => { respHeaders[k] = v; });
    const text = await upstream.text();
    const elapsedMs = Date.now() - started;
    res.json({
      ok: true, status: upstream.status, statusText: upstream.statusText,
      headers: respHeaders, body: text, elapsedMs, proxied: !!dispatcher, agentTag,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, aborted: controller.signal.aborted });
  } finally {
    clearTimeout(t);
  }
});

app.get('/api/proxy/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`: dashboard proxy stream open\n\n`);
  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed && !res.destroyed) res.write(`: dashboard heartbeat ${Date.now()}\n\n`);
  }, 15000);
  const closeWatch = watchProxyEvents({
    config: currentProxyConfig(),
    onEvent: row => {
      if (!closed && !res.destroyed) res.write(`data: ${JSON.stringify(row)}\n\n`);
    },
  });
  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    closeWatch();
  });
});

// --- Reports ---
app.get('/api/reports/tree', (req, res) => {
  try { res.json(reports.tree()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/reports/file', (req, res) => {
  try { res.json(reports.readFile(String(req.query.path || ''))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/reports/raw', (req, res) => {
  try { reports.sendRaw(String(req.query.path || ''), res); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/reports/file', (req, res) => {
  try { res.json(reports.deleteFile(String(req.query.path || ''))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/reports/file', (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    res.json(reports.writeMarkdown(String(p || ''), String(content || '')));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Serves the standalone Mermaid flow diagram for diagnostics.
app.get('/api/flow-diagram', (req, res) => {
  const p = path.resolve(__dirname, '..', 'glados-flow-diagram.html');
  res.sendFile(p, err => { if (err) res.status(404).send('flow diagram not found'); });
});

// Refreshes the local SDK runtime state. The v4 harness is in-process, so there
// is no external gateway daemon to restart.
app.post('/api/gateway/restart', (req, res) => {
  const agentIds = clearAllRuntimeSessions('runtime restart');
  broadcastLobby('runtime-refresh', { ok: true, runtime: 'agent-sdk', resetAll: true, agentIds });
  res.json({
    ok: true,
    runtime: 'agent-sdk',
    resetAll: true,
    resetCount: agentIds.length,
    message: 'Agent SDK runtime is in-process; no external gateway restart is required.',
  });
});

// Clears SDK transcript/liveness state so the next turn starts fresh. When
// agentId === 'glados', cascades to every assessment agent and wipes the
// blackboard. Evidence files and exported reports on disk are intentionally
// untouched.
app.post('/api/agents/:id/reset-session', (req, res) => {
  const agentId = req.params.id;
  try {
    const ids = agentId === 'glados' ? assessmentAgentIds() : [agentId];
    const results = ids.map(id => {
      try { return resetAgentSession(id); }
      catch (e) { return { ok: false, agentId: id, error: e.message }; }
    });
    const failed = results.filter(r => !r.ok);
    if (failed.length) return res.status(500).json({ ok: false, agentId, cascade: agentId === 'glados', results });
    try { transcriptStore.clearAgents(ids); } catch (e) { console.warn('[transcript-store] reset clear failed:', e.message); }

    let blackboard = null;
    let memories = null;
    if (agentId === 'glados') {
      pendingGladosKickoff = null;
      blackboard = wipeBlackboard();
      memories = wipeAgentMemories();
      broadcastLobby('blackboard-wiped', blackboard);
      broadcastLobby('memories-wiped', memories);
    }

    const primary = results.find(r => r.agentId === agentId) || results[0];
    res.json({
      ok: true,
      agentId,
      runtime: 'agent-sdk',
      cascade: agentId === 'glados',
      resetCount: results.length,
      results,
      hadSession: !!primary?.hadSession,
      blackboard,
      memories,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Agent details + model update (Settings) ---
app.get('/api/settings/agents', (req, res) => {
  try {
    res.json({ agents: agentDetails.listSettingsAgents() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/:id/details', (req, res) => {
  const d = agentDetails.agentDetails(req.params.id);
  if (!d) return res.status(404).json({ error: 'agent not found' });
  res.json(d);
});
app.get('/api/models', async (req, res) => {
  try {
    res.json({ models: await agentDetails.listKnownModels() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/agents/:id/model', (req, res) => {
  try {
    const result = agentDetails.updateAgentModel(req.params.id, String(req.body?.model || ''));
    broadcastLobby('agent-model-changed', result);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/agents/:id/enabled', (req, res) => {
  try {
    const result = agentDetails.updateAgentEnabled(req.params.id, !!req.body?.enabled);
    broadcastLobby('agent-enabled-changed', result);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// --- Slash commands metadata for the chat autocomplete ---
app.get('/api/slash-commands', (req, res) => {
  res.json({ commands: slash.SLASH_COMMANDS });
});

app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, runtime: 'agent-sdk', activeAgents: activeAgentStatus().length });
});

app.get('/api/update/status', (req, res) => {
  res.json(updateRunner.updateStatus({ activeAgents: activeAgentStatus().length }));
});

app.get('/api/update/stream', (req, res) => {
  updateRunner.startUpdateStream({
    res,
    force: /^(1|true|yes)$/i.test(String(req.query.force || '')),
    activeAgents: activeAgentStatus().length,
  });
});

app.get('/api/health/proxy', (req, res) => {
  const store = proxyHealth(currentProxyConfig());
  const supervised = process.env.GLADOS_DESKTOP === '1' && store.backend === 'mitmproxy';
  const processHealthy = !supervised || proxyRuntime.status === 'running';
  res.json({
    ...store,
    healthy: store.healthy && processHealthy,
    processStatus: supervised ? proxyRuntime.status : 'external',
    pid: supervised ? proxyRuntime.pid : null,
    startedAt: supervised ? proxyRuntime.startedAt : null,
    error: store.error || (!processHealthy ? proxyRuntime.error || 'native proxy is not running' : null),
    stderr: !processHealthy ? proxyRuntime.stderr : undefined,
  });
});

// v4 — Plan-approval workflow endpoints (see routes/plans.js).
app.use('/api/plans', require('./routes/plans')(broadcastLobby));

// v4.0.0 (Blocker E) — Replan-proposal watcher.
// Polls blackboard's replan_proposals table every 5s for state='open' rows.
// Broadcasts plan-replan-proposed once per (engagement_id, finding_id) tuple
// (in-memory dedup); operator approves/dismisses via /api/plans/replan-proposals.
// The dashboard Plans tab renders open proposals as cards.
(function startReplanWatcher() {
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const broadcastedKeys = new Set();
  const dbPath = BLACKBOARD_DB;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error('[replan-watcher] could not open blackboard.db:', e.message);
    return;
  }
  setInterval(() => {
    try {
      const rows = db.prepare(
        "SELECT id, engagement_id, finding_id, cwe_id, confidence_score, enables_vectors, current_plan_id, created_at FROM replan_proposals WHERE state = 'open' ORDER BY created_at DESC LIMIT 50"
      ).all();
      for (const r of rows) {
        const key = `${r.engagement_id}:${r.finding_id}:${r.id}`;
        if (broadcastedKeys.has(key)) continue;
        broadcastedKeys.add(key);
        // Cap memory: keep last 500 keys.
        if (broadcastedKeys.size > 500) {
          const arr = [...broadcastedKeys];
          arr.slice(0, arr.length - 500).forEach(k => broadcastedKeys.delete(k));
        }
        let vectors = null;
        try { vectors = JSON.parse(r.enables_vectors); } catch {}
        broadcastLobby('plan-replan-proposed', {
          proposal_id: r.id,
          engagement_id: r.engagement_id,
          finding_id: r.finding_id,
          cwe_id: r.cwe_id,
          confidence_score: r.confidence_score,
          enables_vectors: vectors,
          current_plan_id: r.current_plan_id,
          created_at: r.created_at,
        });
      }
    } catch (e) {
      console.error('[replan-watcher] poll error:', e.message);
    }
  }, 5_000);
})();

// REST surface for the dashboard Plans tab to list / resolve replan proposals.
app.get('/api/replan-proposals', (req, res) => {
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dbPath = BLACKBOARD_DB;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const where = []; const args = [];
    if (req.query.engagement_id) { where.push('engagement_id = ?'); args.push(req.query.engagement_id); }
    where.push("state = ?"); args.push(req.query.state || 'open');
    const rows = db.prepare(
      `SELECT * FROM replan_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`
    ).all(...args).map(r => ({ ...r, enables_vectors: safeJson(r.enables_vectors) }));
    res.json({ proposals: rows });
  } finally { db.close(); }
  function safeJson(s){ try { return s ? JSON.parse(s) : null; } catch { return null; } }
});
app.post('/api/replan-proposals/:id/resolve', express.json(), (req, res) => {
  const Database = require('better-sqlite3');
  const dbPath = BLACKBOARD_DB;
  const db = new Database(dbPath);
  try {
    const state = req.body?.state || 'dismissed';
    if (!['accepted','dismissed','superseded'].includes(state)) return res.status(400).json({ error: 'bad state' });
    const r = db.prepare(
      "UPDATE replan_proposals SET state = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?"
    ).run(state, req.body?.resolved_by || 'operator', req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'proposal not found' });
    broadcastLobby('plan-replan-resolved', { proposal_id: Number(req.params.id), state });
    res.json({ ok: true, state });
  } finally { db.close(); }
});

// --- Terminal (WebSocket PTY) ---
// Loopback-only; the HTTP server itself binds to 127.0.0.1 below.
const { WebSocketServer } = require('ws');
const { attachTerminal } = require('./lib/terminal');
const http = require('node:http');
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/terminal' });
wss.on('connection', ws => attachTerminal(ws));

function listen(port, { fallback = true } = {}) {
  server.once('error', err => {
    if (fallback && err?.code === 'EADDRINUSE' && Number(port) !== 0) {
      console.warn(`[startup] port ${port} in use; falling back to a dynamic loopback port`);
      listen(0, { fallback: false });
      return;
    }
    console.error('[startup] server listen failed:', err);
    process.exitCode = 1;
  });
  server.listen(Number(port) || 0, '127.0.0.1', () => {
    const actual = server.address()?.port || port;
    const url = `http://127.0.0.1:${actual}`;
    console.log(`GLaDOS Ops Dashboard on ${url}`);
    if (typeof process.send === 'function') process.send({ type: 'glados-dashboard-ready', url, port: actual });
  });
}

listen(PORT);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { server.close(); } catch {}
  await stopDesktopProxy();
  try { controller.close(); } catch {}
  try { transcriptStore.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
if (process.env.GLADOS_DESKTOP === '1') {
  process.on('disconnect', () => { shutdown().catch(() => process.exit(1)); });
}
