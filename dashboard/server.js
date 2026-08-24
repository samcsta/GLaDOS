const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { PORT, BLACKBOARD_DB, WATCHDOG_DB, GLADOS_AGENT_WORKSPACES, GLADOS_INVESTIGATIONS_DIR, GLADOS_RUNTIME_DIR } = require('./lib/config');
const reports = require('./lib/reports');
const agentDetails = require('./lib/agent-details');
const { getVersionInfo } = require('./lib/version');
const {
  DashboardTranscriptStore,
  compactTranscriptEventForTransport,
  mergeTranscriptEvents,
  afterLastEventId,
  sseFrame,
} = require('./lib/transcript-store');
const { ControllerLite } = require('./lib/controller');
const {
  discoveryWorkerIdFromPrompt,
  finalizeDiscoveryWorker,
  projectSecurityReviewLedgers,
  reconcileActiveSecurityReviewWorkers,
  reconcileCompletedDiscoveryWorker,
} = require('./lib/security-review/deep-scan');
const { fetchLiteLlmAttestation, observationId } = require('./lib/litellm-attestation');
const { LiteLlmResponseRelay } = require('./lib/litellm-relay');
const { activeTurnConflict } = require('./lib/chat-turn-admission');
const { isKickoffApproval, isKickoffCancel, isNetReconRequested, resolveKickoffResources } = require('./lib/kickoff-intent');
const { getLiteLlmUsage } = require('./lib/litellm-usage');
const { sdkUsageForPeriod } = require('./lib/sdk-usage');
const { cleanupLooseInvestigationArtifacts, resetMutableAgentStatus } = require('./lib/runtime-reset');
const { readFullAccessState, writeFullAccessState } = require('./lib/full-access');
const {
  EFFORT_LEVELS,
  effortForAgent,
  operatorInitials,
  readChatPreferences,
  writeChatPreferences,
} = require('./lib/chat-preferences');
const {
  MIME_EXTENSIONS,
  attachmentPath,
  attachmentsRoot,
  publicAttachment,
  storeChatAttachments,
} = require('./lib/chat-attachments');
const { engagementMetrics } = require('../tools/glados-ops-mcp/lib/engagement-metrics');
const { normalizeActionTarget } = require('../tools/glados-ops-mcp/lib/operator-action-approval');
const slash = require('./lib/slash');
const updateRunner = require('./lib/update-runner');
const { createUpdatePreservationSnapshot } = require('./lib/update-preservation');
const planRoutes = require('./routes/plans');
const { endInvestigationForEngagement } = planRoutes;
const {
  streamAgentTurn,
  loadRegistry: loadHarnessRegistry,
  loadPolicy,
  agentEnabled,
  bareModelAlias,
  resolveSdkWorkingDirectory,
} = require('./lib/harness/agent-sdk');
const { SdkSessionRegistry } = require('./lib/harness/session-registry');
const { InvestigationSessionStore } = require('./lib/investigation-session-store');
const { proxyBackendConfig, startMitmproxy } = require('./lib/proxy/mitmproxy-runner');
const { ResumeCoordinator } = require('./lib/harness/resume-coordinator');
const {
  proxyHistory,
  proxyDetail,
  proxyMetrics,
  clearProxyTraffic,
  watchProxyEvents,
  proxyHealth,
  combineProxyRuntimeHealth,
} = require('./lib/proxy/native-store');
const watchdogHealth = require('glados-watchdog/lib/health');
const watchdogHalt = require('glados-watchdog/lib/halt');

const app = express();
app.use('/api/chat', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules', 'marked')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, 'node_modules', 'dompurify', 'dist')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', 'xterm-addon-fit')));

try {
  require('../scripts/lib/glados-local').bootstrap();
} catch (e) {
  console.warn('[startup] could not initialize durable GLaDOS runtime:', e.message);
}

const transcriptStore = new DashboardTranscriptStore(BLACKBOARD_DB);
const investigationSessions = new InvestigationSessionStore(BLACKBOARD_DB);
const sdkSessionRegistry = new SdkSessionRegistry();
const liteLlmResponseRelay = new LiteLlmResponseRelay({ env: process.env });
if (!process.env.GLADOS_LITELLM_UPSTREAM_BASE_URL) {
  process.env.GLADOS_LITELLM_UPSTREAM_BASE_URL = liteLlmResponseRelay.upstream;
}
const investigationActivationGenerations = new Map();
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

app.get('/api/settings/full-access', (req, res) => {
  try {
    const { file: _file, ...state } = readFullAccessState(process.env);
    res.json({
      ok: true,
      available: process.platform === 'darwin' && process.env.GLADOS_DESKTOP === '1',
      platform: process.platform,
      ...state,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/settings/full-access', (req, res) => {
  try {
    if (process.platform !== 'darwin' || process.env.GLADOS_DESKTOP !== '1') {
      return res.status(409).json({ ok: false, error: 'Full Access can only be changed from the GLaDOS macOS desktop app.' });
    }
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be true or false' });
    const { file: _file, ...state } = writeFullAccessState(enabled, { env: process.env });
    broadcastLobby('full-access-changed', { enabled: state.enabled, updatedAt: state.updatedAt });
    return res.json({ ok: true, available: true, platform: process.platform, ...state });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

function investigationNavigationPayload() {
  const runningBySession = new Map();
  const add = (sessionId, agentId) => {
    if (!sessionId || !agentId) return;
    const agents = runningBySession.get(sessionId) || new Set();
    agents.add(agentId);
    runningBySession.set(sessionId, agents);
  };
  for (const turn of activeChatTurns.values()) add(turn.sessionId, turn.agentId);
  for (const turn of activeSubagentTurns.values()) add(turn.investigationSessionId, turn.agentId);
  const sessions = investigationSessions.list().map(session => {
    const agents = [...(runningBySession.get(session.id) || [])].sort();
    return {
      ...session,
      runningAgents: agents,
      runningCount: Math.max(Number(session.runningCount || 0), agents.length),
    };
  });
  return {
    activeId: activeInvestigationSession().id,
    projects: investigationSessions.listProjects(),
    sessions,
  };
}

app.get('/api/investigation-sessions', (req, res) => {
  res.json({ ok: true, ...investigationNavigationPayload() });
});

app.post('/api/investigation-projects', (req, res) => {
  try {
    const project = investigationSessions.createProject(req.body?.name);
    broadcastLobby('investigation-projects-changed', { project });
    res.status(201).json({ ok: true, project, ...investigationNavigationPayload() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.patch('/api/investigation-projects/:id', (req, res) => {
  try {
    const project = investigationSessions.renameProject(req.params.id, req.body?.name);
    broadcastLobby('investigation-projects-changed', { project });
    res.json({ ok: true, project, ...investigationNavigationPayload() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/investigation-projects/:id', (req, res) => {
  try {
    const project = investigationSessions.deleteProject(req.params.id);
    broadcastLobby('investigation-projects-changed', { projectId: project.id, deleted: true });
    res.json({ ok: true, project, ...investigationNavigationPayload() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/investigation-sessions', (req, res) => {
  const hasBackgroundWork = activeChatTurns.size > 0 || activeSubagentTurns.size > 0;
  const agentStatusReset = hasBackgroundWork
    ? { reset: 0, errors: [], skipped: true, reason: 'background sessions are still running' }
    : resetMutableAgentStatus(GLADOS_AGENT_WORKSPACES);
  if (agentStatusReset.errors.length) return res.status(500).json({ ok: false, error: `could not isolate mutable agent status: ${agentStatusReset.errors.join('; ')}` });
  const session = investigationSessions.create({ name: req.body?.name, metadata: req.body?.metadata, activate: req.body?.activate !== false, projectId: req.body?.projectId });
  broadcastLobby('investigation-session-changed', { activeId: session.id, session });
  res.status(201).json({ ok: true, session, ...investigationNavigationPayload(), agentStatusReset });
});

app.post('/api/investigation-sessions/:id/archive', (req, res) => {
  try {
    const session = investigationSessions.archive(req.params.id);
    res.json({ ok: true, session, ...investigationNavigationPayload() });
  } catch (error) {
    res.status(409).json({ ok: false, error: error.message });
  }
});

app.patch('/api/investigation-sessions/:id', (req, res) => {
  try {
    let session = investigationSessions.get(req.params.id);
    if (!session) throw new Error(`investigation session not found: ${req.params.id}`);
    if (req.body?.name !== undefined) session = investigationSessions.rename(req.params.id, req.body.name);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'projectId')) session = investigationSessions.moveToProject(req.params.id, req.body.projectId);
    broadcastLobby('investigation-session-updated', { session });
    res.json({ ok: true, session, ...investigationNavigationPayload() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/investigation-sessions/:id', (req, res) => {
  const sessionId = req.params.id;
  const prefix = `${sessionId}\0`;
  if ([...activeChatTurns.keys(), ...activeSubagentTurns.keys()].some(key => key.startsWith(prefix))) {
    return res.status(409).json({ ok: false, error: 'stop active agent turns before deleting this session' });
  }
  try {
    const result = investigationSessions.delete(sessionId);
    sdkSessionRegistry.clearSession(sessionId);
    resumeCoordinator.clearSession(sessionId);
    for (let index = resumeContinuationQueue.length - 1; index >= 0; index--) {
      if (resumeContinuationQueue[index].investigationSessionId === sessionId) resumeContinuationQueue.splice(index, 1);
    }
    try { fs.rmSync(path.join(attachmentsRoot(process.env), sessionId), { recursive: true, force: true }); }
    catch (error) { console.warn('[attachments] could not remove deleted session images:', error.message); }
    for (const key of [...buffers.keys()]) if (key.startsWith(prefix)) buffers.delete(key);
    for (const [key, clients] of [...sseClients.entries()]) {
      if (!key.startsWith(prefix)) continue;
      for (const client of clients) {
        try { client.res.write(`event: session-deleted\ndata: ${JSON.stringify({ sessionId })}\n\n`); client.res.end(); } catch {}
      }
      sseClients.delete(key);
    }
    pendingGladosKickoffs.delete(sessionId);
    for (let index = approvedPlanQueue.length - 1; index >= 0; index--) {
      if (approvedPlanQueue[index].sessionId !== sessionId) continue;
      approvedPlanQueueIds.delete(approvedPlanQueue[index].id);
      approvedPlanQueue.splice(index, 1);
    }
    const activeId = result.replacement?.id || activeInvestigationSession().id;
    broadcastLobby('investigation-session-deleted', { sessionId, activeId });
    res.json({ ok: true, ...result, ...investigationNavigationPayload(), activeId });
  } catch (error) {
    res.status(409).json({ ok: false, error: error.message });
  }
});

app.post('/api/investigation-sessions/:id/activate', (req, res) => {
  try {
    const clientId = String(req.body?.clientId || '').trim().slice(0, 160);
    const generation = Number(req.body?.generation);
    if (clientId && Number.isSafeInteger(generation) && generation > 0) {
      const lastGeneration = investigationActivationGenerations.get(clientId) || 0;
      if (generation < lastGeneration) {
        const session = activeInvestigationSession();
        return res.json({ ok: true, stale: true, session, ...investigationNavigationPayload() });
      }
      investigationActivationGenerations.set(clientId, generation);
      while (investigationActivationGenerations.size > 100) {
        investigationActivationGenerations.delete(investigationActivationGenerations.keys().next().value);
      }
    }
    const hasBackgroundWork = activeChatTurns.size > 0 || activeSubagentTurns.size > 0;
    const agentStatusReset = hasBackgroundWork
      ? { reset: 0, errors: [], skipped: true, reason: 'background sessions are still running' }
      : resetMutableAgentStatus(GLADOS_AGENT_WORKSPACES);
    if (agentStatusReset.errors.length) return res.status(500).json({ ok: false, error: `could not isolate mutable agent status: ${agentStatusReset.errors.join('; ')}` });
    const session = investigationSessions.activate(req.params.id);
    broadcastLobby('investigation-session-changed', { activeId: session.id, session });
    res.json({ ok: true, session, ...investigationNavigationPayload(), agentStatusReset });
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

// Per-agent ring buffer of recent events (for new SSE subscribers to backfill).
const BUFFER_LIMIT = 500;
const buffers = new Map(); // agentId -> array of events (newest last)
const sseClients = new Map(); // agentId -> Set<{ res, includeStream }>
const lobbyClients = new Set(); // /api/agents SSE subscribers
const activeChatTurns = new Map(); // investigation session + agent -> active turn
const activeSubagentTurns = new Map(); // investigation session + tool call -> active subagent turn
const activeTaskToolIds = new Map(); // toolCallId -> agentId
const resumeCoordinator = new ResumeCoordinator({
  filePath: path.join(GLADOS_RUNTIME_DIR, 'state', 'paused-agent-work.json'),
});
const resumeContinuationQueue = [];
let resumeContinuationRunning = false;
const approvedPlanQueue = [];
const approvedPlanQueueIds = new Set();
let approvedPlanQueueRunning = false;
const pendingGladosKickoffs = new Map();
function activeInvestigationSession() {
  return investigationSessions.getActive() || investigationSessions.ensureInitialSession();
}

function requestSessionId(req) {
  return String(req.body?.session_id || req.query?.session_id || activeInvestigationSession().id);
}

function requireSession(req, res, { writable = false } = {}) {
  const session = investigationSessions.get(requestSessionId(req));
  if (!session) {
    res.status(404).json({ ok: false, error: 'investigation session not found' });
    return null;
  }
  if (writable && session.state !== 'active') {
    res.status(409).json({ ok: false, error: 'investigation session is archived; activate it before making changes' });
    return null;
  }
  return session;
}

function runtimeKey(sessionId, agentId) {
  return `${sessionId}\0${agentId}`;
}

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

function currentSessionForAgent(agentId, sessionId = activeInvestigationSession().id) {
  const turn = activeChatTurns.get(runtimeKey(sessionId, agentId));
  const subagent = [...activeSubagentTurns.values()].find(row => row.investigationSessionId === sessionId && row.agentId === agentId);
  if (!turn && !subagent) return null;
  if (subagent && !turn) {
    return {
      live: true,
      runtime: 'agent-sdk',
      sessionId: subagent.sessionId,
      sessionKey: `sdk:${sessionId}:${agentId}:${subagent.sessionId}`,
      investigationSessionId: sessionId,
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
    sessionKey: `sdk:${sessionId}:${agentId}:${turn.turnId}`,
    investigationSessionId: sessionId,
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

function startSubagentTurn(sessionId, parentAgentId, targetAgent, { toolCallId = null, parentTurnId = null, messagePreview = '', taskPrompt = '' } = {}) {
  if (!targetAgent || targetAgent === parentAgentId) return;
  const key = runtimeKey(sessionId, toolCallId || targetAgent);
  const existing = activeSubagentTurns.get(key);
  if (toolCallId) activeTaskToolIds.set(toolCallId, { sessionId, agentId: targetAgent });
  if (existing?.live) {
    // SubagentStart/liveness can precede the parent Task tool call. Merge the
    // later Task payload so a halt always preserves the exact assignment.
    if (toolCallId) existing.toolCallId = toolCallId;
    if (parentTurnId) existing.parentTurnId = parentTurnId;
    if (messagePreview) existing.messagePreview = messagePreview;
    if (taskPrompt) existing.taskPrompt = taskPrompt;
    return;
  }
  const subagentSessionId = toolCallId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  activeSubagentTurns.set(key, {
    live: true,
    agentId: targetAgent,
    investigationSessionId: sessionId,
    sessionId: subagentSessionId,
    startedAt,
    parentAgentId,
    parentTurnId,
    toolCallId,
    messagePreview,
    taskPrompt,
  });
  broadcastLobby('session-started', { investigationSessionId: sessionId, agentId: targetAgent, sessionId: subagentSessionId, startedAt, parentAgentId, parentTurnId, toolCallId });
}

function finishSubagentTurn(sessionId, targetAgent, { toolCallId = null, reason = null } = {}) {
  if (!targetAgent) return;
  const key = toolCallId
    ? runtimeKey(sessionId, toolCallId)
    : [...activeSubagentTurns.entries()].find(([, row]) => row.investigationSessionId === sessionId && row.agentId === targetAgent)?.[0];
  const turn = key ? activeSubagentTurns.get(key) : null;
  if (!turn) {
    if (toolCallId) activeTaskToolIds.delete(toolCallId);
    return;
  }
  activeSubagentTurns.delete(key);
  if (toolCallId) activeTaskToolIds.delete(toolCallId);
  else if (turn.toolCallId) activeTaskToolIds.delete(turn.toolCallId);
  broadcastLobby('session-ended', { investigationSessionId: sessionId, agentId: targetAgent, sessionId: turn.sessionId, toolCallId: turn.toolCallId, reason });
}

function finishSubagentsForTurn(sessionId, parentAgentId, parentTurnId, reason = 'parent turn ended') {
  for (const [, turn] of [...activeSubagentTurns.entries()]) {
    if (turn.parentAgentId === parentAgentId && (!parentTurnId || turn.parentTurnId === parentTurnId)) {
      finishSubagentTurn(sessionId, turn.agentId || activeTaskToolIds.get(turn.toolCallId)?.agentId, { toolCallId: turn.toolCallId, reason });
    }
  }
}

function securityReviewArtifactRootFromPrompt(message) {
  const value = String(message || '').match(/^artifact_root:\s*(.+)$/m)?.[1]?.trim();
  if (!value || !path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  const investigations = path.resolve(GLADOS_INVESTIGATIONS_DIR);
  return resolved.startsWith(`${investigations}${path.sep}`) ? resolved : null;
}

const SECURITY_REVIEW_TRACK_ROLES = [
  'authorization-access-control',
  'data-flow-injection',
  'secrets-history',
  'resilience-error-handling',
  'iac-config-manifests',
  'cryptography-suppressions',
];

function securityReviewRoleFromDispatch(agentId, prompt = '') {
  if (agentId === 'glados') return 'coordinator';
  if (agentId === 'source-review-validator') return 'source-review-validator';
  if (agentId !== 'source-code') return null;
  const text = String(prompt || '');
  const explicit = text.match(/security_review_role:\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
  if (explicit === 'blind-discovery') return 'source-code-primary';
  if (SECURITY_REVIEW_TRACK_ROLES.includes(explicit)) return explicit;
  const namedTrack = SECURITY_REVIEW_TRACK_ROLES.find(role => new RegExp(`(?:track|security_review_role)[:=\\s]+${role}`, 'i').test(text));
  if (namedTrack) return namedTrack;
  if (explicit === 'historical-regression') return explicit;
  return null;
}

function sendMessageToAgentTrackedRuntime(agentId, message, sessionId = activeInvestigationSession().id, context = {}) {
  const turnId = startChatTurn(sessionId, agentId, message);
  const turn = activeChatTurns.get(runtimeKey(sessionId, agentId));
  const promise = sendMessageToAgentRuntime(sessionId, agentId, message, {
    turnId,
    // Controller prompts are durable machine control records, not operator
    // chat. Keep them in controller_jobs/controller_events without rendering
    // another multi-kilobyte user bubble on every automatic continuation.
    recordPrompt: !context.controllerJobId,
    securityReviewArtifactRoot: securityReviewArtifactRootFromPrompt(message),
    engagementId: context.engagementId || null,
    controllerJobId: context.controllerJobId || null,
    modelOverride: context.modelOverride || null,
  }).then(result => {
    const error = harnessResultError(result);
    if (error) throw new Error(error);
    return result;
  }).finally(() => finishChatTurn(sessionId, agentId, turnId));
  return {
    child: { kill: signal => stopChatTurn(sessionId, agentId, signal || 'controller stop') },
    promise,
  };
}

function pushBuffer(sessionId, agentId, ev) {
  ev = compactTranscriptEventForTransport(ev);
  const key = runtimeKey(sessionId, agentId);
  let buf = buffers.get(key);
  if (!buf) { buf = []; buffers.set(key, buf); }
  if (ev?.id && buf.some(existing => existing?.id === ev.id)) return;
  buf.push(ev);
  if (buf.length > BUFFER_LIMIT) buf.shift();
}

function broadcastTranscript(sessionId, agentId, ev) {
  const set = sseClients.get(runtimeKey(sessionId, agentId));
  if (!set) return;
  const transportEvent = compactTranscriptEventForTransport(ev);
  for (const client of set) {
    const payload = sseFrame(transportEvent, { includeStream: client.includeStream });
    if (payload) client.res.write(payload);
  }
}

function broadcastLobby(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of lobbyClients) res.write(payload);
}

function startChatTurn(sessionId, agentId, message) {
  const key = runtimeKey(sessionId, agentId);
  const conflict = activeTurnConflict(activeChatTurns, key);
  if (conflict) {
    const error = new Error(conflict.error);
    error.code = conflict.code;
    error.conflict = conflict;
    throw error;
  }
  const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  activeChatTurns.set(key, {
    sessionId,
    agentId,
    turnId,
    startedAt,
    messagePreview: String(message || '').slice(0, 160),
    message: String(message || ''),
    abortController: new AbortController(),
    interrupt: null,
    stopRequested: false,
  });
  broadcastLobby('chat-turn-started', { investigationSessionId: sessionId, agentId, turnId, startedAt });
  return turnId;
}

function activeSubagentConflict(sessionId, agentId) {
  const turn = [...activeSubagentTurns.values()].find(row => row.investigationSessionId === sessionId && row.agentId === agentId);
  if (!turn) return null;
  return {
    ok: false,
    error: `${agentId} is already running as a GLaDOS-owned subagent`,
    code: 'GLADOS_SUBAGENT_ALREADY_ACTIVE',
    agentId,
    turnId: turn.toolCallId || turn.sessionId,
    startedAt: turn.startedAt,
    ageMs: Math.max(0, Date.now() - Number(turn.startedAt || Date.now())),
  };
}

function attachChatTurnInterrupt(sessionId, agentId, turnId, interrupt) {
  const turn = activeChatTurns.get(runtimeKey(sessionId, agentId));
  if (!turn || turn.turnId !== turnId) return;
  turn.interrupt = interrupt;
  if (turn.stopRequested && typeof interrupt === 'function') {
    Promise.resolve(interrupt('operator stop')).catch(() => {});
  }
}

function stopChatTurn(sessionId, agentId, reason = 'operator stop') {
  const key = runtimeKey(sessionId, agentId);
  const turn = activeChatTurns.get(key);
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
  activeChatTurns.delete(key);
  finishSubagentsForTurn(sessionId, agentId, turn.turnId, reason);
  broadcastLobby('chat-turn-ended', { investigationSessionId: sessionId, agentId, turnId: turn.turnId, stopped: true, reason });
  transcriptEvent(sessionId, agentId, 'meta', `Stopped current turn: ${reason}`, {
    sub: 'operator-stop',
    turnId: turn.turnId,
  });
  return { ok: true, stopped: true, agentId, turnId: turn.turnId, reason };
}

function finishChatTurn(sessionId, agentId, turnId) {
  const key = runtimeKey(sessionId, agentId);
  const current = activeChatTurns.get(key);
  if (!current || current.turnId !== turnId) return;
  activeChatTurns.delete(key);
  broadcastLobby('chat-turn-ended', { investigationSessionId: sessionId, agentId, turnId });
  if (agentId === 'glados') {
    if (approvedPlanQueue.length) setImmediate(drainApprovedPlanExecutions);
    else if (resumeContinuationQueue.length) setImmediate(drainResumeContinuations);
  }
}

function stopInvestigationRuntime(result, { reason = 'operator ended investigation', sessionId = activeInvestigationSession().id } = {}) {
  let stoppedAgents = 0;
  for (const turn of [...activeChatTurns.values()]) {
    if (turn.sessionId !== sessionId) continue;
    stopChatTurn(turn.sessionId, turn.agentId, reason);
    stoppedAgents += 1;
  }
  for (const turn of [...activeSubagentTurns.values()]) {
    if (turn.investigationSessionId !== sessionId) continue;
    const task = activeTaskToolIds.get(turn.toolCallId);
    if (task) finishSubagentTurn(task.sessionId, task.agentId, { toolCallId: turn.toolCallId, reason });
  }
  const endedPlans = new Set(result?.plans_ended || []);
  for (let index = approvedPlanQueue.length - 1; index >= 0; index -= 1) {
    const queued = approvedPlanQueue[index];
    if (queued.engagementId === result?.engagement_id || endedPlans.has(queued.id)) {
      approvedPlanQueueIds.delete(queued.id);
      approvedPlanQueue.splice(index, 1);
    }
  }
  for (let index = resumeContinuationQueue.length - 1; index >= 0; index -= 1) {
    if (resumeContinuationQueue[index].investigationSessionId === sessionId) resumeContinuationQueue.splice(index, 1);
  }
  pendingGladosKickoffs.delete(sessionId);
  return { stoppedAgents, queuedApprovalsRemoved: endedPlans.size };
}

function transcriptEvent(sessionId, agentId, kind, text, extra = {}) {
  let ev = {
    agentId, sessionId,
    kind,
    text,
    ts: new Date().toISOString(),
    id: `dashboard:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  };
  try {
    ev = transcriptStore.record(sessionId, agentId, ev);
  } catch (e) {
    console.warn('[transcript-store] could not persist dashboard event:', e.message);
  }
  pushBuffer(sessionId, agentId, ev);
  broadcastTranscript(sessionId, agentId, ev);
  return ev;
}

function recordUserTranscript(sessionId, agentId, text, extra = {}) {
  return transcriptEvent(sessionId, agentId, 'user-message', text, {
    id: `dashboard-user:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  });
}

function admitUserTranscript(sessionId, agentId, text, clientId, extra = {}) {
  const safeClientId = String(clientId || '')
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 160) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ev = transcriptStore.record(sessionId, agentId, {
    agentId,
    kind: 'user-message',
    text,
    ts: new Date().toISOString(),
    id: `dashboard-user:${agentId}:${safeClientId}`,
    clientId: safeClientId,
    runtime: 'agent-sdk',
    admitted: true,
    ...extra,
  });
  pushBuffer(sessionId, agentId, ev);
  broadcastTranscript(sessionId, agentId, ev);
  return ev;
}

async function sendMessageToAgentRuntime(sessionId, agentId, message, {
  turnId = null,
  recordPrompt = true,
  securityReviewArtifactRoot = null,
  abortSignal = null,
  engagementId = null,
  controllerJobId = null,
  modelOverride = null,
  attachments = [],
  reasoningEffort = null,
} = {}) {
  if (recordPrompt) recordUserTranscript(sessionId, agentId, message, {
    runtime: 'agent-sdk', engagementId, controllerJobId,
  });
  const turn = turnId ? activeChatTurns.get(runtimeKey(sessionId, agentId)) : null;
  let events = [];
  const securityReviewRolesByToolCall = new Map();
  const securityReviewWorkersByToolCall = new Map();
  const securityReviewAttestations = new Map();
  const persistAttestation = request => {
    if (securityReviewAttestations.has(request.requestId)) return securityReviewAttestations.get(request.requestId);
    const pending = (async () => {
      const stamp = new Date().toISOString();
      const db = new Database(BLACKBOARD_DB);
      try {
        db.prepare(`
          INSERT INTO security_review_llm_requests
            (request_id, engagement_id, controller_job_id, agent_id, review_role, worker_id,
             worker_tool_call_id, requested_model, status, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
          ON CONFLICT(request_id) DO NOTHING
        `).run(request.requestId, engagementId, controllerJobId, request.agentId, request.reviewRole,
          request.workerId, request.workerToolCallId, request.requestedModel, stamp);
        const owner = db.prepare('SELECT engagement_id FROM security_review_llm_requests WHERE request_id=?').get(request.requestId);
        if (owner?.engagement_id !== engagementId) {
          db.prepare("UPDATE security_review_llm_requests SET status='CONFLICT', last_error='request ID reused across engagements' WHERE request_id=?").run(request.requestId);
          return null;
        }
        const identity = db.prepare(`
          SELECT agent_id, review_role, worker_id, worker_tool_call_id, requested_model, controller_job_id
          FROM security_review_llm_requests WHERE request_id=?
        `).get(request.requestId);
        if (identity && (identity.agent_id !== request.agentId
            || (identity.review_role || null) !== (request.reviewRole || null)
            || (identity.worker_id || null) !== (request.workerId || null)
            || (identity.worker_tool_call_id || null) !== (request.workerToolCallId || null)
            || (identity.requested_model || null) !== (request.requestedModel || null)
            || (identity.controller_job_id || null) !== (controllerJobId || null))) {
          db.prepare("UPDATE security_review_llm_requests SET status='CONFLICT', last_error='request ID reused for a different work unit' WHERE request_id=?").run(request.requestId);
          return null;
        }
      } finally { db.close(); }
      const headerReceipt = liteLlmResponseRelay.receipt(request.requestId);
      const evidence = headerReceipt?.gatewayModelId
        ? {
            available: true,
            attempts: 0,
            ...headerReceipt,
            actualModel: headerReceipt.providerModel || headerReceipt.gatewayModelId,
            billedModelName: headerReceipt.logicalModelAlias,
            attestationLevel: headerReceipt.providerModel ? 'provider' : 'deployment',
          }
        : await fetchLiteLlmAttestation(request.requestId, {
            env: process.env,
            gatewayCallId: headerReceipt?.gatewayCallId || request.requestId,
          });
      if (!evidence.available) {
        const unresolved = new Database(BLACKBOARD_DB);
        try {
          unresolved.prepare(`
            UPDATE security_review_llm_requests
            SET status='UNRESOLVED', lookup_attempts=?, last_error=?
            WHERE request_id=? AND engagement_id=?
          `).run(Number(evidence.attempts || 1), evidence.reason, request.requestId, engagementId);
        } finally { unresolved.close(); }
        return null;
      }
      const requestedModel = request.requestedModel || evidence.requestedModel;
      const id = observationId({
        engagementId, requestId: request.requestId, role: request.reviewRole,
        workerId: request.workerId, workerToolCallId: request.workerToolCallId,
        gatewayModelId: evidence.gatewayModelId,
      });
      const settledAt = new Date().toISOString();
      const settled = new Database(BLACKBOARD_DB);
      try {
        settled.prepare(`
          INSERT INTO security_review_model_observations
            (observation_id, engagement_id, controller_job_id, agent_id, review_role, worker_id, worker_tool_call_id,
             requested_model, actual_model, billed_model_name, source, request_id, gateway_model_id, cost_usd,
             logical_model_alias, provider_model, attestation_level, gateway_call_id, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(observation_id) DO NOTHING
        `).run(id, engagementId, controllerJobId, request.agentId, request.reviewRole, request.workerId,
          request.workerToolCallId, requestedModel, evidence.actualModel, evidence.billedModelName,
          evidence.source || 'litellm:spend-log', request.requestId,
          evidence.gatewayModelId, evidence.costUsd, evidence.logicalModelAlias || requestedModel,
          evidence.providerModel || null, evidence.attestationLevel || 'deployment', evidence.gatewayCallId || request.requestId, settledAt);
        settled.prepare(`
          UPDATE security_review_llm_requests
          SET status='SETTLED', lookup_attempts=?, last_error=NULL, settled_at=?
          WHERE request_id=? AND engagement_id=?
        `).run(Number(evidence.attempts || 1), settledAt, request.requestId, engagementId);
      } finally { settled.close(); }
      const projection = projectSecurityReviewLedgers({ dbPath: BLACKBOARD_DB, artifactRoot: securityReviewArtifactRoot, engagementId });
      if (projection.sealInvalidated) {
        setImmediate(() => {
          try { controller.revalidateSecurityReviewAfterAuthorityChange(engagementId); }
          catch (error) { console.warn('[security-review] automatic reseal after authority change failed:', error.message); }
        });
      }
      if (headerReceipt?.gatewayCallId) {
        setTimeout(async () => {
          try {
            const finalEvidence = await fetchLiteLlmAttestation(request.requestId, {
              env: process.env,
              gatewayCallId: headerReceipt.gatewayCallId,
              attempts: 6,
            });
            if (!finalEvidence.available) return;
            liteLlmResponseRelay.reconcile(request.requestId, finalEvidence);
          } catch (error) {
            console.warn('[security-review] late LiteLLM reconciliation failed:', error.message);
          }
        }, 1000).unref?.();
      }
      return id;
    })();
    securityReviewAttestations.set(request.requestId, pending);
    return pending;
  };
  try {
    const sdkCwd = resolveSdkWorkingDirectory({ env: process.env });
    const turnEnv = { ...process.env, GLADOS_SESSION_ID: sessionId };
    if (securityReviewArtifactRoot) {
      let run = null;
      try { run = JSON.parse(fs.readFileSync(path.join(securityReviewArtifactRoot, 'run.json'), 'utf8')); } catch {}
      turnEnv.GLADOS_SECURITY_REVIEW = '1';
      turnEnv.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID = engagementId || path.basename(path.dirname(securityReviewArtifactRoot));
      turnEnv.GLADOS_SECURITY_REVIEW_ARTIFACT_ROOT = securityReviewArtifactRoot;
      turnEnv.GLADOS_SECURITY_REVIEW_REPOSITORY = run?.repositoryPath || '';
      turnEnv.GLADOS_SECURITY_REVIEW_SOURCE_TYPE = run?.sourceType || '';
      turnEnv.GLADOS_SECURITY_REVIEW_GIT_HISTORY = run?.gitHistoryAvailable ? '1' : '0';
      turnEnv.ANTHROPIC_BASE_URL = await liteLlmResponseRelay.ensureStarted();
    }
    const securityReviewMaxTurns = securityReviewArtifactRoot
      ? (loadPolicy().harness?.securityReviewCoordinatorMaxTurns ?? 1000)
      : undefined;
    events = await streamAgentTurn({
      agentId,
      prompt: message,
      store: transcriptStore,
      onEvent: (ev, sdkMessage) => {
        const targetAgent = ev.agentId || agentId;
        if (securityReviewArtifactRoot && ev.kind === 'tool-call' && isTaskDispatchToolName(ev.toolName) && ev.toolCallId) {
          const child = ev.targetAgentId || targetAgentFromToolInput(ev.toolInput);
          const dispatchPrompt = ev.toolInput?.prompt || ev.toolInput?.description || '';
          securityReviewRolesByToolCall.set(ev.toolCallId, securityReviewRoleFromDispatch(child, dispatchPrompt));
          const workerId = discoveryWorkerIdFromPrompt(dispatchPrompt);
          if (workerId) securityReviewWorkersByToolCall.set(ev.toolCallId, workerId);
        }
        if (targetAgent !== agentId && !isAllowedSubagentDispatch(agentId, targetAgent)) return;
        if (ev.kind === 'tool-call' && isTaskDispatchToolName(ev.toolName)) {
          const child = ev.targetAgentId || targetAgentFromToolInput(ev.toolInput);
          if (isAllowedSubagentDispatch(targetAgent, child)) {
            const childPrompt = String(ev.toolInput?.prompt || '').trim();
            startSubagentTurn(sessionId, targetAgent, child, {
              toolCallId: ev.toolCallId,
              parentTurnId: turnId,
              messagePreview: ev.toolInput?.description || childPrompt || ev.text || '',
              taskPrompt: childPrompt,
            });
            // Security-review worker contracts are machine-to-machine control
            // payloads. Their role/liveness remains visible, while the full
            // prompt stays in the SDK audit trail instead of flooding chat.
            if (childPrompt && !securityReviewArtifactRoot) {
              recordUserTranscript(sessionId, child, childPrompt, {
                id: `subagent-prompt:${ev.toolCallId}`,
                runtime: 'agent-sdk',
                parentAgentId: targetAgent,
                parentToolUseId: ev.toolCallId,
                sub: 'subagent-prompt',
              });
            }
          }
        } else if (ev.kind === 'tool-result' && ev.toolCallId
            && (activeTaskToolIds.has(ev.toolCallId) || securityReviewWorkersByToolCall.has(ev.toolCallId))) {
          // A background Task first returns a launch acknowledgement. Its real
          // completion arrives later as task_notification and must own the
          // liveness transition; ending here creates a false idle/active flicker.
          if (!/^Subagent launched\.?$/i.test(String(ev.text || '').trim())) {
            const task = activeTaskToolIds.get(ev.toolCallId);
            const workerId = securityReviewWorkersByToolCall.get(ev.toolCallId);
            if (workerId && engagementId) {
              try {
                finalizeDiscoveryWorker({
                  dbPath: BLACKBOARD_DB, artifactRoot: securityReviewArtifactRoot,
                  engagementId, toolCallId: ev.toolCallId,
                  status: ev.isError ? 'FAILED' : 'SUCCEEDED', error: ev.isError ? ev.text : null,
                });
              } catch (error) { console.warn('[security-review] could not finalize worker dispatch:', error.message); }
            }
            if (task) finishSubagentTurn(task.sessionId, task.agentId, { toolCallId: ev.toolCallId });
          }
        } else if (isAllowedSubagentDispatch(agentId, targetAgent) && (ev.kind === 'thinking-stream' || ev.kind === 'text-stream' || ev.kind === 'assistant-text' || ev.kind === 'tool-call')) {
          startSubagentTurn(sessionId, agentId, targetAgent, {
            toolCallId: ev.parentToolUseId || ev.toolCallId || null,
            parentTurnId: turnId,
            messagePreview: ev.text || ev.toolName || '',
          });
        }
        pushBuffer(sessionId, targetAgent, ev);
        broadcastTranscript(sessionId, targetAgent, ev);
        if (ev.kind === 'liveness') {
          if (!ev.live && securityReviewArtifactRoot && engagementId && ev.toolCallId) {
            try {
              reconcileCompletedDiscoveryWorker({
                dbPath: BLACKBOARD_DB,
                artifactRoot: securityReviewArtifactRoot,
                engagementId,
                toolCallId: ev.toolCallId,
                completedAt: ev.ts || new Date().toISOString(),
              });
            } catch (error) {
              console.warn('[security-review] could not reconcile completed worker liveness:', error.message);
            }
          }
          if (isAllowedSubagentDispatch(agentId, targetAgent)) {
            if (ev.live) startSubagentTurn(sessionId, agentId, targetAgent, { toolCallId: ev.parentToolUseId || ev.toolCallId || null, parentTurnId: turnId, messagePreview: ev.text || ev.state || '' });
            else finishSubagentTurn(sessionId, targetAgent, { toolCallId: ev.parentToolUseId || ev.toolCallId || null, reason: ev.state || 'liveness ended' });
          }
          broadcastLobby('agent-liveness', { investigationSessionId: sessionId, agentId: targetAgent, live: ev.live, state: ev.state, sessionId: currentSessionForAgent(targetAgent, sessionId)?.sessionId || null });
        }
      },
      options: {
        cwd: sdkCwd, env: turnEnv, investigationSessionId: sessionId,
        engagementId, controllerJobId, model: modelOverride || undefined, modelOverride: modelOverride || undefined,
        attachments,
        effort: reasoningEffort || effortForAgent(agentId, process.env),
        autoCompact: readChatPreferences(process.env).autoCompact,
        reviewKey: securityReviewArtifactRoot ? `${engagementId || sessionId}:${controllerJobId || securityReviewArtifactRoot}` : null,
        reviewConcurrencyLimit: loadPolicy().harness?.securityReviewMaxExecutions ?? 3,
        subagentAllowlist: securityReviewArtifactRoot ? ['source-code', 'source-review-validator'] : undefined,
        maxTurns: securityReviewMaxTurns,
        abortSignal: turn?.turnId === turnId ? turn.abortController?.signal : abortSignal || undefined,
        onInterruptReady: interrupt => attachChatTurnInterrupt(sessionId, agentId, turnId, interrupt),
        resumeSessionId: sdkSessionRegistry.get(sessionId, agentId, sdkCwd),
        onSessionId: sdkId => sdkSessionRegistry.set(sessionId, agentId, sdkId, sdkCwd),
        onInvalidSession: (_sessionId, error) => {
          sdkSessionRegistry.clear(sessionId, agentId);
          const timeoutRecovery = error?.code === 'GLADOS_FIRST_ACTIVITY_TIMEOUT';
          transcriptEvent(sessionId, agentId, 'meta', timeoutRecovery
            ? 'The resumed Agent SDK session produced no activity. Cleared it and retried this message once in a fresh session.'
            : 'Recovered a stale Agent SDK session after the application working directory changed.', {
            sub: 'session-recovery',
            reasonCode: error?.code || null,
          });
        },
        onSdkMessage: async (sdkMessage, sdkContext) => {
          if (!securityReviewArtifactRoot || sdkMessage?.type !== 'assistant' || !sdkMessage.request_id) return;
          const parentToolUseId = sdkMessage.parent_tool_use_id || null;
          const targetAgent = sdkMessage.subagent_type
            || sdkContext?.subagentByParentToolUseId?.get(parentToolUseId)
            || agentId;
          const workerId = targetAgent === agentId ? null : securityReviewWorkersByToolCall.get(parentToolUseId)
            || discoveryWorkerIdFromPrompt([...activeSubagentTurns.values()].find(row => row.toolCallId === parentToolUseId)?.taskPrompt || '')
            || null;
          await persistAttestation({
            requestId: sdkMessage.request_id,
            agentId: targetAgent,
            requestedModel: sdkMessage?.message?.model ? bareModelAlias(sdkMessage.message.model, { fallback: null }) : null,
            workerId,
            workerToolCallId: workerId ? parentToolUseId : null,
            reviewRole: targetAgent === agentId
              ? securityReviewRoleFromDispatch(agentId, message)
              : securityReviewRolesByToolCall.get(parentToolUseId) || securityReviewRoleFromDispatch(targetAgent, ''),
          });
        },
      },
    });
  } finally {
    if (securityReviewArtifactRoot && engagementId) {
      await Promise.all([...securityReviewAttestations.values()]);
      for (const [toolCallId, workerId] of securityReviewWorkersByToolCall) {
        try {
          const recovered = reconcileCompletedDiscoveryWorker({
            dbPath: BLACKBOARD_DB, artifactRoot: securityReviewArtifactRoot, engagementId, toolCallId,
          });
          if (!recovered) finalizeDiscoveryWorker({ dbPath: BLACKBOARD_DB, engagementId, toolCallId, status: 'CANCELED', error: 'parent turn ended before worker reconciliation' });
        } catch (error) { console.warn(`[security-review] could not cancel ${workerId}:`, error.message); }
      }
      const projection = projectSecurityReviewLedgers({ dbPath: BLACKBOARD_DB, artifactRoot: securityReviewArtifactRoot, engagementId });
      if (projection.sealInvalidated) {
        setImmediate(() => {
          try { controller.revalidateSecurityReviewAfterAuthorityChange(engagementId); }
          catch (error) { console.warn('[security-review] automatic reseal after authority change failed:', error.message); }
        });
      }
    }
    finishSubagentsForTurn(sessionId, agentId, turnId);
  }
  const finalText = events
    .filter(ev => ev.kind === 'result' || ev.kind === 'assistant-text')
    .map(ev => ev.text)
    .filter(Boolean)
    .join('\n')
    .trim();
  const promptError = events.find(ev => ev.kind === 'prompt-error');
  return {
    runtime: 'agent-sdk',
    result: { payloads: [{ text: finalText || '', mediaUrl: null }] },
    events: events.length,
    error: promptError?.error || promptError?.text || null,
  };
}

function queueAcceptedChatTurn({ sessionId, agentId, message, turnId, attachments = [], reasoningEffort = null, onSuccess = null, onFailure = null }) {
  setImmediate(async () => {
    try {
      const result = await sendMessageToAgentRuntime(sessionId, agentId, message, {
        turnId,
        recordPrompt: false,
        attachments,
        reasoningEffort,
      });
      const resultError = harnessResultError(result);
      if (resultError) throw new Error(resultError);
      // An operator stop removes the authoritative active turn before the SDK
      // finishes unwinding. Do not let that cancelled run mark a goal complete.
      if (activeChatTurns.get(runtimeKey(sessionId, agentId))?.turnId !== turnId) return;
      await onSuccess?.(result);
    } catch (error) {
      transcriptEvent(sessionId, agentId, 'prompt-error', error.message || String(error), {
        error: error.message || String(error),
        code: error.code || null,
        provider: 'LiteLLM Anthropic Messages',
        model: error.model || null,
        api: '/v1/messages',
        liteLlmDiagnostic: error.liteLlmDiagnostic || null,
        turnId,
        isError: true,
      });
      try { await onFailure?.(error); } catch {}
    } finally {
      finishChatTurn(sessionId, agentId, turnId);
    }
  });
}

function queueResumeContinuation(snapshot) {
  resumeContinuationQueue.push(snapshot);
  setImmediate(drainResumeContinuations);
}

async function drainResumeContinuations() {
  if (resumeContinuationRunning || approvedPlanQueueRunning) return;
  const runnableIndex = resumeContinuationQueue.findIndex(row => {
    const rowSessionId = row.investigationSessionId || activeInvestigationSession().id;
    return !activeChatTurns.has(runtimeKey(rowSessionId, 'glados'));
  });
  if (runnableIndex < 0) return;
  const [snapshot] = resumeContinuationQueue.splice(runnableIndex, 1);
  const sessionId = snapshot.investigationSessionId || activeInvestigationSession().id;
  resumeContinuationRunning = true;
  const prompt = resumeCoordinator.buildContinuationPrompt(snapshot);
  const turnId = startChatTurn(sessionId, 'glados', prompt);
  transcriptEvent(sessionId, 'glados', 'operator-event', `Continuing ${snapshot.agentId} after operator resume.`, {
    resumedAgentId: snapshot.agentId,
    continuation: true,
  });
  try {
    const result = await sendMessageToAgentRuntime(sessionId, 'glados', prompt, { turnId });
    const error = harnessResultError(result);
    if (error) {
      transcriptEvent(sessionId, 'glados', 'prompt-error', `Could not continue ${snapshot.agentId}: ${error}`, {
        resumedAgentId: snapshot.agentId,
        continuation: true,
        isError: true,
      });
    }
  } catch (error) {
    transcriptEvent(sessionId, 'glados', 'prompt-error', `Could not continue ${snapshot.agentId}: ${error.message}`, {
      resumedAgentId: snapshot.agentId,
      continuation: true,
      isError: true,
    });
  } finally {
    finishChatTurn(sessionId, 'glados', turnId);
    resumeContinuationRunning = false;
    if (resumeContinuationQueue.length) setImmediate(drainResumeContinuations);
  }
}

function queueApprovedPlanExecution({ id, engagement_id: engagementId, decision, vectors, sessionId = activeInvestigationSession().id } = {}) {
  const planId = String(id || '').trim();
  if (!planId) return { executionQueued: false, error: 'plan id missing' };
  if (approvedPlanQueueIds.has(planId)) return { executionQueued: true, duplicate: true };
  approvedPlanQueueIds.add(planId);
  approvedPlanQueue.push({
    id: planId,
    engagementId: String(engagementId || '').trim(),
    decision: String(decision || 'approve_all'),
    vectors: Array.isArray(vectors) ? vectors.map(String) : [],
    sessionId,
  });
  setImmediate(drainApprovedPlanExecutions);
  return { executionQueued: true, queueDepth: approvedPlanQueue.length };
}

async function drainApprovedPlanExecutions() {
  if (approvedPlanQueueRunning || resumeContinuationRunning) return;
  const runnableIndex = approvedPlanQueue.findIndex(row => !activeChatTurns.has(runtimeKey(row.sessionId, 'glados')));
  if (runnableIndex < 0) return;
  const [approval] = approvedPlanQueue.splice(runnableIndex, 1);
  const executionSessionId = approval.sessionId;
  approvedPlanQueueRunning = true;
  const prompt = [
    'AUTOMATED PLAN-APPROVAL HANDOFF',
    `plan_id: ${approval.id}`,
    `engagement_id: ${approval.engagementId || 'unknown'}`,
    `decision: ${approval.decision}`,
    `approved_vectors: ${approval.vectors.length ? approval.vectors.join(', ') : 'all proposed vectors'}`,
    `operator_approval_reference: plans-api:${approval.id}`,
    'The operator decision is already durable in the plan database. Begin the approved next phase now.',
    'Read the approved plan, dispatch only its approved agent chain, and do not ask the operator to repeat this approval.',
    'Keep the coverage ledger current. If an exploit unlocks a new authenticated surface, return to webapp-recon and synthesize the next plan before further gated testing.',
  ].join('\n');
  let turnId = null;
  try {
    turnId = startChatTurn(executionSessionId, 'glados', prompt);
    transcriptEvent(executionSessionId, 'glados', 'operator-event', `Plan ${approval.id} approved; automatically starting the next phase.`, {
      planId: approval.id,
      engagementId: approval.engagementId || null,
      approvalDecision: approval.decision,
      approvedVectors: approval.vectors,
      automatedApprovalHandoff: true,
    });
    const result = await sendMessageToAgentRuntime(executionSessionId, 'glados', prompt, { turnId });
    const error = harnessResultError(result);
    if (error) throw new Error(error);
  } catch (error) {
    transcriptEvent(executionSessionId, 'glados', 'prompt-error', `Automatic execution of approved plan ${approval.id} failed: ${error.message}`, {
      planId: approval.id,
      automatedApprovalHandoff: true,
      isError: true,
    });
  } finally {
    if (turnId) finishChatTurn(executionSessionId, 'glados', turnId);
    approvedPlanQueueIds.delete(approval.id);
    approvedPlanQueueRunning = false;
    if (approvedPlanQueue.length) setImmediate(drainApprovedPlanExecutions);
    else if (resumeContinuationQueue.length) setImmediate(drainResumeContinuations);
  }
}

const controller = new ControllerLite({
  dbPath: BLACKBOARD_DB,
  sendMessageToAgentTracked: sendMessageToAgentTrackedRuntime,
  currentSessionForAgent,
  getInvestigationSessionId: () => activeInvestigationSession().id,
  onSecurityReviewCompleted: ({ engagementId, sessionId }) => {
    if (!sessionId) return;
    transcriptEvent(
      sessionId,
      'glados',
      'assistant-text',
      'Security review complete. GLaDOS sealed the evidence and generated the deliverables automatically. Open Reports for the report and supporting files.',
      { securityReviewComplete: true, engagementId }
    );
  },
});
try {
  const recovery = reconcileActiveSecurityReviewWorkers({
    dbPath: BLACKBOARD_DB,
    investigationsDir: GLADOS_INVESTIGATIONS_DIR,
  });
  if (recovery.reconciled) console.log(`[security-review] reconciled ${recovery.reconciled} completed worker(s) during startup`);
} catch (error) {
  console.warn('[security-review] startup worker reconciliation failed:', error.message);
}
if (process.env.GLADOS_CONTROLLER_WORKER !== '0') controller.start();

function sessionBlackboardRowCounts(sessionId, { excludeTranscriptEventId = null } = {}) {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    const engagementFilter = 'engagement_id IN (SELECT id FROM engagements WHERE session_id=?)';
    const counts = {
      engagements: db.prepare('SELECT COUNT(*) AS n FROM engagements WHERE session_id=?').get(sessionId).n,
      findings: db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${engagementFilter}`).get(sessionId).n,
      tasks: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${engagementFilter}`).get(sessionId).n,
      plans: db.prepare(`SELECT COUNT(*) AS n FROM plans WHERE ${engagementFilter}`).get(sessionId).n,
      controller_jobs: db.prepare(`SELECT COUNT(*) AS n FROM controller_jobs WHERE ${engagementFilter}`).get(sessionId).n,
      transcripts: db.prepare('SELECT COUNT(*) AS n FROM dashboard_transcript_events WHERE session_id=? AND (? IS NULL OR id<>?)')
        .get(sessionId, excludeTranscriptEventId, excludeTranscriptEventId).n,
    };
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
  const sessionId = String(extra.sessionId || activeInvestigationSession().id);
  let goalId = extra.goalId || null;
  if (!goalId) {
    try {
      const goal = controller.createWebGoal(target, { source: extra.source || 'chat' });
      goalId = goal?.id || null;
    } catch (e) {
      console.warn('[controller] could not record web goal:', e.message);
    }
  }
  const pendingGladosKickoff = {
    sessionId,
    target,
    originalMessage,
    goalId,
    createdAt: Date.now(),
  };
  pendingGladosKickoffs.set(sessionId, pendingGladosKickoff);
  const ev = transcriptEvent(sessionId, 'glados', 'assistant-text', kickoffApprovalPrompt(target), { gated: true });
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
  const netReconRequested = isNetReconRequested(`${pending.originalMessage}\n${operatorReply}`);
  return [
    `Begin the approved investigation kickoff for ${target}.`,
    '',
    'Operator approval gate has already completed in the dashboard.',
    `Approved pre-agent resources, in order: ${resourceText}.`,
    `Explicitly skipped resources: ${skippedText}.`,
    `Network/infrastructure recon explicitly requested by operator: ${netReconRequested ? 'yes' : 'no'}.`,
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
    netReconRequested
      ? '- The operator explicitly requested network recon. Dispatch WEBAPP RECON and NET RECON; the net-recon task must include operator_requested_net_recon: true and operator_request_reference pointing to the original request.'
      : '- Do not dispatch net-recon. Dispatch WEBAPP RECON only and record baseline.net_recon.status=skipped with reason=operator_not_requested.',
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

function resetAgentSession(sessionId, agentId) {
  const key = runtimeKey(sessionId, agentId);
  const hadSession = !!currentSessionForAgent(agentId, sessionId);
  if (agentId === 'glados') resumeCoordinator.clearSession(sessionId);
  else resumeCoordinator.clear(agentId, sessionId);
  if (agentId === 'glados') {
    for (let index = resumeContinuationQueue.length - 1; index >= 0; index--) {
      if (resumeContinuationQueue[index].investigationSessionId === sessionId) resumeContinuationQueue.splice(index, 1);
    }
    for (let index = approvedPlanQueue.length - 1; index >= 0; index--) {
      if (approvedPlanQueue[index].sessionId !== sessionId) continue;
      approvedPlanQueueIds.delete(approvedPlanQueue[index].id);
      approvedPlanQueue.splice(index, 1);
    }
  }
  const turn = activeChatTurns.get(key);
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
  activeChatTurns.delete(key);
  const subagent = [...activeSubagentTurns.values()].find(row => row.investigationSessionId === sessionId && row.agentId === agentId);
  if (subagent?.toolCallId) activeTaskToolIds.delete(subagent.toolCallId);
  for (const [subagentKey, row] of [...activeSubagentTurns.entries()]) {
    if (row.investigationSessionId === sessionId && row.agentId === agentId) activeSubagentTurns.delete(subagentKey);
  }
  for (const [childKey, child] of [...activeSubagentTurns.entries()]) {
    if (child.investigationSessionId === sessionId && child.parentAgentId === agentId) {
      activeSubagentTurns.delete(childKey);
      if (child.toolCallId) activeTaskToolIds.delete(child.toolCallId);
      const childAgentId = child.agentId || activeTaskToolIds.get(child.toolCallId)?.agentId || childKey.split('\0').at(-1);
      broadcastLobby('session-ended', { investigationSessionId: sessionId, agentId: childAgentId, sessionId: child.sessionId, toolCallId: child.toolCallId, reason: 'session reset' });
    }
  }
  buffers.delete(key);
  sdkSessionRegistry.clear(sessionId, agentId);
  broadcastLobby('session-reset', {
    investigationSessionId: sessionId,
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
    ...assessmentAgentIds(),
  ]);
  for (const turn of activeChatTurns.values()) {
    turn.stopRequested = true;
    try {
      if (turn.abortController && !turn.abortController.signal.aborted) turn.abortController.abort(reason);
    } catch {}
    if (typeof turn.interrupt === 'function') {
      Promise.resolve(turn.interrupt(reason)).catch(() => {});
    }
    broadcastLobby('chat-turn-ended', { investigationSessionId: turn.sessionId, agentId: turn.agentId, turnId: turn.turnId, stopped: true, reason });
  }
  for (const [key, turn] of activeSubagentTurns.entries()) {
    broadcastLobby('session-ended', { investigationSessionId: turn.investigationSessionId || key.split('\0')[0], agentId: turn.agentId, sessionId: turn.sessionId, toolCallId: turn.toolCallId, reason });
  }
  activeChatTurns.clear();
  activeSubagentTurns.clear();
  activeTaskToolIds.clear();
  resumeCoordinator.clearAll();
  resumeContinuationQueue.length = 0;
  approvedPlanQueue.length = 0;
  approvedPlanQueueIds.clear();
  approvedPlanQueueRunning = false;
  buffers.clear();
  pendingGladosKickoffs.clear();
  for (const agentId of agentIds) {
    broadcastLobby('session-reset', { investigationSessionId: activeInvestigationSession().id, agentId, runtime: 'agent-sdk', hadSession: true, reason });
  }
  return [...agentIds];
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

  const status = resetMutableAgentStatus(workspaces);
  errors.push(...status.errors);

  return {
    ok: errors.length === 0,
    agents,
    dreamsCleared,
    statusFilesReset: status.reset,
    errors,
  };
}

function bufferedTranscriptEvents(sessionId, agentId, lastEventId = null, options = {}) {
  let dashboardEvents = [];
  try {
    dashboardEvents = transcriptStore.listRecent(sessionId, agentId, { limit: BUFFER_LIMIT });
  } catch (e) {
    console.warn('[transcript-store] could not list dashboard events:', e.message);
  }
  const mergeOptions = { includeStream: options.includeStream !== false };
  const merged = mergeTranscriptEvents(
    { events: dashboardEvents, options: mergeOptions },
    { events: buffers.get(runtimeKey(sessionId, agentId)) || [], options: mergeOptions }
  );
  return afterLastEventId(merged, lastEventId).slice(-BUFFER_LIMIT);
}

// --- REST ---

app.post('/api/operator-action-approvals', (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  const agentId = String(req.body?.agent_id || '');
  if (!assessmentAgentIds().includes(agentId)) return res.status(400).json({ error: 'unknown agent_id' });
  let targetUrl;
  try { targetUrl = normalizeActionTarget(req.body?.target_url); }
  catch { return res.status(400).json({ error: 'valid target_url required' }); }
  const method = String(req.body?.method || '*').toUpperCase();
  if (!/^(?:\*|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method)) {
    return res.status(400).json({ error: 'invalid method' });
  }
  const risk = String(req.body?.risk_to_target || '*').toLowerCase();
  if (!['*', 'low', 'medium', 'high'].includes(risk)) return res.status(400).json({ error: 'invalid risk_to_target' });
  const ttlSeconds = Math.max(30, Math.min(3600, Number(req.body?.ttl_seconds || 600)));
  const now = Date.now();
  const approval = {
    id: `action_${crypto.randomBytes(8).toString('hex')}`,
    session_id: session.id,
    agent_id: agentId,
    target_url: targetUrl,
    method,
    risk_to_target: risk,
    operator: String(req.body?.operator || 'operator').slice(0, 120),
    reason: String(req.body?.reason || '').slice(0, 1000),
    created_at: now,
    expires_at: now + ttlSeconds * 1000,
  };
  const Database = require('better-sqlite3');
  const db = new Database(BLACKBOARD_DB);
  try {
    db.prepare(`
      INSERT INTO operator_action_approvals
        (id, session_id, agent_id, target_url, method, risk_to_target, operator, reason, created_at, expires_at)
      VALUES (@id, @session_id, @agent_id, @target_url, @method, @risk_to_target, @operator, @reason, @created_at, @expires_at)
    `).run(approval);
  } finally {
    db.close();
  }
  broadcastLobby('operator-action-approved', approval);
  res.status(201).json({ ok: true, approval });
});

app.get('/api/agents', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const registry = loadAgentRegistry();
  const out = registry.map(a => {
    const snap = currentSessionForAgent(a.id, session.id);
    return {
      id: a.id,
      name: a.name,
      model: a.model,
      workspace: a.workspace,
      runtime: a.runtime || 'agent-sdk',
      active: !!(snap && snap.live),
      session: snap,
      halted: watchdogHalt.agentStatus(a.id, { sessionId: session.id }).haltActive,
    };
  });
  res.json({ agents: out, sessionId: session.id });
});

// Lobby event stream — session-started / session-ended.
app.get('/api/agents/stream', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  lobbyClients.add(res);
  const registry = loadAgentRegistry();
  const snapshot = registry
    .map(a => ({ agentId: a.id, session: currentSessionForAgent(a.id, session.id) }))
    .filter(r => r.session && r.session.live)
    .map(r => ({ investigationSessionId: session.id, agentId: r.agentId, sessionId: r.session.sessionId }));
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  req.on('close', () => lobbyClients.delete(res));
});

// Per-agent transcript SSE. On connect, backfills recent buffer then streams live.
app.get('/api/agents/:id/transcript', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
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
  for (const ev of bufferedTranscriptEvents(session.id, agentId, lastEventId, { includeStream })) {
    const payload = sseFrame(ev, { includeStream });
    if (payload) res.write(payload);
  }

  const key = runtimeKey(session.id, agentId);
  let set = sseClients.get(key);
  if (!set) { set = new Set(); sseClients.set(key, set); }
  const client = { res, includeStream };
  set.add(client);
  req.on('close', () => { set.delete(client); if (!set.size) sseClients.delete(key); });
});

function chatComposerState(sessionId, agentId) {
  const agent = agentDetails.listSettingsAgents().find(row => row.id === agentId);
  if (!agent) return null;
  const preferences = readChatPreferences(process.env);
  const { file: _fullAccessFile, ...fullAccess } = readFullAccessState(process.env);
  return {
    agentId,
    model: agent.model || null,
    effort: effortForAgent(agentId, process.env),
    effortLevels: [...EFFORT_LEVELS],
    autoCompact: preferences.autoCompact,
    fullAccess: agentId === 'glados' ? {
      enabled: fullAccess.enabled,
      available: process.platform === 'darwin' && process.env.GLADOS_DESKTOP === '1',
    } : null,
  };
}

app.get('/api/chat/:agent/composer', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const state = chatComposerState(session.id, String(req.params.agent || ''));
  if (!state) return res.status(404).json({ ok: false, error: 'agent not found' });
  res.json({ ok: true, ...state });
});

app.get('/api/settings/operator-profile', (_req, res) => {
  const preferences = readChatPreferences(process.env);
  res.json({
    ok: true,
    name: preferences.operatorName,
    initials: operatorInitials(preferences.operatorName),
  });
});

app.patch('/api/settings/operator-profile', (req, res) => {
  try {
    const preferences = writeChatPreferences({ operatorName: req.body?.name }, process.env);
    const profile = { name: preferences.operatorName, initials: operatorInitials(preferences.operatorName) };
    broadcastLobby('operator-profile-changed', profile);
    res.json({ ok: true, ...profile });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.patch('/api/chat/:agent/composer', (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  const agentId = String(req.params.agent || '');
  if (!agentDetails.listSettingsAgents().some(row => row.id === agentId)) {
    return res.status(404).json({ ok: false, error: 'agent not found' });
  }
  try {
    writeChatPreferences({ agentId, effort: req.body?.effort }, process.env);
    const state = chatComposerState(session.id, agentId);
    broadcastLobby('agent-reasoning-changed', { agentId, effort: state.effort });
    res.json({ ok: true, ...state });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/chat/attachments/:id', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const file = attachmentPath(session.id, req.params.id, process.env);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  const extension = path.extname(file).toLowerCase();
  const mimeType = Object.entries(MIME_EXTENSIONS).find(([, ext]) => ext === extension)?.[0] || 'application/octet-stream';
  res.set({
    'Content-Type': mimeType,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
});

// GLaDOS chat — POST message; reply arrives via the normal transcript stream.
app.post('/api/chat/glados', async (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  const message = (req.body && req.body.message) || '';
  if (!message.trim()) return res.status(400).json({ error: 'message required' });
  const namedSession = investigationSessions.nameFromFirstPrompt(session.id, message);
  if (namedSession?.name !== session.name) {
    session.name = namedSession.name;
    session.metadata = namedSession.metadata;
    broadcastLobby('investigation-session-updated', { session: namedSession });
  }
  const conflict = activeTurnConflict(activeChatTurns, runtimeKey(session.id, 'glados'));
  if (conflict) return res.status(409).json(conflict);
  let attachments = [];
  try { attachments = storeChatAttachments(session.id, req.body?.attachments, process.env); }
  catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
  const attachmentMetadata = attachments.map(row => publicAttachment(row, session.id));
  let admittedEvent;
  try {
    // Persist before starting the SDK. A renderer/app restart can no longer
    // erase a message that was sitting in an hours-long HTTP request.
    admittedEvent = admitUserTranscript(session.id, 'glados', message, req.body?.client_id, { attachments: attachmentMetadata });
  } catch (error) {
    return res.status(503).json({ ok: false, error: `message was not admitted: ${error.message}` });
  }

  // These are dashboard-owned facts, not assessment work. Answer them without
  // starting the large coordinator prompt or booting MCP servers.
  const normalizedMessage = message.trim().toLowerCase();
  if (!attachments.length && /\bwhat\s+(?:model|llm)\b|\bwhich\s+model\b|\bmodel\s+(?:are|r)\b/.test(normalizedMessage)) {
    const glados = loadAgentRegistry().find(agent => agent.id === 'glados');
    const text = `I'm running ${glados?.model || 'the configured GLaDOS model'} for this session.`;
    const ev = transcriptEvent(session.id, 'glados', 'assistant-text', text, { fastPath: 'model' });
    return res.json({ ok: true, fastPath: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
  }
  if (!attachments.length && /\b(?:what\s+)?version\b.*\bglados\b|\bglados\b.*\bversion\b/.test(normalizedMessage)) {
    const text = `This is GLaDOS ${getVersionInfo().version}.`;
    const ev = transcriptEvent(session.id, 'glados', 'assistant-text', text, { fastPath: 'version' });
    return res.json({ ok: true, fastPath: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
  }

  const pendingGladosKickoff = pendingGladosKickoffs.get(session.id) || null;
  if (pendingGladosKickoff) {
    if (isKickoffCancel(message)) {
      const cancelled = pendingGladosKickoff;
      pendingGladosKickoffs.delete(session.id);
      if (cancelled.goalId) controller.updateGoalStatus(cancelled.goalId, 'cancelled');
      const ev = transcriptEvent(session.id, 'glados', 'assistant-text', `Cancelled the pending investigation kickoff for \`${cancelled.target}\`. No resources were checked and no agents were dispatched.`);
      return res.json({ ok: true, gated: true, cancelled: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
    }

    if (!isKickoffApproval(message) && !/\b(skip|only|domainsai|dradis|dradistab)\b/i.test(message)) {
      const ev = transcriptEvent(
        session.id, 'glados',
        'assistant-text',
        `I am still paused before starting \`${pendingGladosKickoff.target}\`. Reply with "continue", "skip DradisTab/Dradis and proceed with DomainsAI", or another explicit change before I check resources or dispatch agents.`
      );
      return res.json({ ok: true, gated: true, waiting: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
    }

    const approved = pendingGladosKickoff;
    pendingGladosKickoffs.delete(session.id);
    if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'running');
    const approvedMessage = buildApprovedKickoffMessage(approved, message);
    const turnId = startChatTurn(session.id, 'glados', approvedMessage);
    transcriptEvent(session.id, 'glados', 'operator-event', approvedMessage, {
      sub: 'kickoff-handoff',
      turnId,
      admittedUserEventId: admittedEvent.sseId,
    });
    res.status(202).json({ ok: true, accepted: true, gated: true, approved: true, turnId });
    queueAcceptedChatTurn({
      sessionId: session.id,
      agentId: 'glados',
      message: approvedMessage,
      turnId,
      onSuccess: () => { if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'complete'); },
      onFailure: () => { if (approved.goalId) controller.updateGoalStatus(approved.goalId, 'failed'); },
    });
    return;
  }

  if (!attachments.length && /^(?:continue|resume)$/i.test(message.trim())) {
    const recovery = controller.resumeLatestRecoverableSecurityReviewForSession(session.id);
    if (recovery.ok) {
      const text = recovery.completed
        ? `Recovered, sealed, and published security review \`${recovery.engagementId}\` from its durable artifacts.`
        : `Reconnected security review job \`${recovery.jobId}\` to its durable checkpoint. The controller will continue and publish automatically.`;
      const ev = transcriptEvent(session.id, 'glados', 'assistant-text', text, {
        fastPath: 'security-review-controller-resume',
        controllerJobId: recovery.jobId,
        engagementId: recovery.engagementId,
      });
      return res.json({ ok: true, fastPath: true, recoveredSecurityReview: true, ...recovery,
        result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
    }
  }

  if (!attachments.length && isFreshSessionQuestion(message)) {
    const counts = sessionBlackboardRowCounts(session.id, { excludeTranscriptEventId: admittedEvent.dashboardEventId });
    const rows = counts ? Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0) : null;
    const activeAgents = (() => {
      try {
        return loadAgentRegistry().filter(a => currentSessionForAgent(a.id, session.id)?.live).length;
      } catch { return 0; }
    })();
    const stateText = rows === 0 && activeAgents === 0
      ? 'Yes — this investigation session has no prior engagements, plans, tasks, findings, or Agent SDK transcript history. Shared agent memory, proxy history, evidence, and reports are preserved across sessions.'
      : `This investigation session contains ${rows ?? 'unknown'} scoped blackboard/transcript row(s) and ${activeAgents} active agent(s). Other sessions remain isolated by engagement ownership in the shared SQLite database.`;
    const ev = transcriptEvent(
      session.id, 'glados',
      'assistant-text',
      stateText
    );
    return res.json({ ok: true, gated: true, synthetic: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
  }

  const turnId = startChatTurn(session.id, 'glados', message);
  res.status(202).json({ ok: true, accepted: true, turnId, eventId: admittedEvent.sseId });
  queueAcceptedChatTurn({
    sessionId: session.id,
    agentId: 'glados',
    message,
    turnId,
    attachments,
    reasoningEffort: effortForAgent('glados', process.env),
  });
});

// Direct specialist chat is the authoritative operator-to-worker handoff for
// approvals that cannot be delegated by another agent (for example, an
// irreversible target lifecycle action). The dashboard user message is sent
// as the specialist's root turn rather than quoted through GLaDOS/SendMessage.
app.post('/api/chat/:agent', async (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  const agentId = String(req.params.agent || '');
  const message = (req.body && req.body.message) || '';
  if (!assessmentAgentIds().includes(agentId) || agentId === 'glados') {
    return res.status(404).json({ error: 'agent not found' });
  }
  if (!message.trim()) return res.status(400).json({ error: 'message required' });
  const conflict = activeTurnConflict(activeChatTurns, runtimeKey(session.id, agentId));
  if (conflict) return res.status(409).json(conflict);
  const subagentConflict = activeSubagentConflict(session.id, agentId);
  if (subagentConflict) return res.status(409).json(subagentConflict);
  let attachments = [];
  try { attachments = storeChatAttachments(session.id, req.body?.attachments, process.env); }
  catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
  const attachmentMetadata = attachments.map(row => publicAttachment(row, session.id));
  let admittedEvent;
  try {
    admittedEvent = admitUserTranscript(session.id, agentId, message, req.body?.client_id, { attachments: attachmentMetadata });
  } catch (error) {
    return res.status(503).json({ ok: false, error: `message was not admitted: ${error.message}` });
  }

  const turnId = startChatTurn(session.id, agentId, message);
  res.status(202).json({ ok: true, accepted: true, direct: true, agentId, turnId, eventId: admittedEvent.sseId });
  queueAcceptedChatTurn({
    sessionId: session.id,
    agentId,
    message,
    turnId,
    attachments,
    reasoningEffort: effortForAgent(agentId, process.env),
  });
});

app.post('/api/chat/:agent/stop', (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  const agentId = req.params.agent;
  const reason = String(req.body?.reason || 'operator stop').slice(0, 200);
  res.json(stopChatTurn(session.id, agentId, reason));
});

app.get('/api/chat/status/:agent', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const turn = activeChatTurns.get(runtimeKey(session.id, req.params.agent));
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

async function haltAgent(agentId, reason = 'dashboard halt', initiator = 'dashboard', sessionId = activeInvestigationSession().id) {
  if (!assessmentAgentIds().includes(agentId)) throw new Error(`unknown GLaDOS agent: ${agentId}`);
  const result = await watchdogHalt.agentHalt(agentId, reason, { initiator, sessionId });
  let interruptedParent = null;
  const direct = activeChatTurns.get(runtimeKey(sessionId, agentId));
  const subagent = [...activeSubagentTurns.values()].find(row => row.investigationSessionId === sessionId && row.agentId === agentId);
  if (subagent) {
    const parentTurn = activeChatTurns.get(runtimeKey(sessionId, subagent.parentAgentId));
    resumeCoordinator.capture(agentId, {
      investigationSessionId: sessionId,
      parentAgentId: subagent.parentAgentId,
      taskPrompt: subagent.taskPrompt,
      taskDescription: subagent.messagePreview,
      operatorPrompt: parentTurn?.message || parentTurn?.messagePreview || '',
    });
  }
  try { direct?.abortController?.abort(`${agentId} halted by operator`); } catch {}
  if (typeof direct?.interrupt === 'function') {
    await Promise.resolve(direct.interrupt(`${agentId} halted by operator`)).catch(() => {});
  }
  if (subagent?.parentAgentId) {
    interruptedParent = subagent.parentAgentId;
    const parentTurn = activeChatTurns.get(runtimeKey(sessionId, interruptedParent));
    try { parentTurn?.abortController?.abort(`${agentId} halted by operator`); } catch {}
    if (typeof parentTurn?.interrupt === 'function') {
      await Promise.resolve(parentTurn.interrupt(`${agentId} halted by operator`)).catch(() => {});
    }
  }
  const notice = `Operator halted ${agentId}: ${reason}. ${interruptedParent ? `Its owning ${interruptedParent} turn was interrupted and its task context was saved for resume.` : 'Future tool calls are denied until this agent is resumed.'}`;
  transcriptEvent(sessionId, agentId, 'operator-event', notice, { halted: true, initiator, isError: true });
  if (agentId !== 'glados') transcriptEvent(sessionId, 'glados', 'operator-event', notice, { haltedAgentId: agentId, halted: true, initiator, isError: true });
  broadcastLobby('halt', { investigationSessionId: sessionId, agentId, reason, interruptedParent, haltActive: true });
  return { ...result, interruptedParent };
}

async function resumeAgent(agentId, initiator = 'dashboard', sessionId = activeInvestigationSession().id) {
  if (!assessmentAgentIds().includes(agentId)) throw new Error(`unknown GLaDOS agent: ${agentId}`);
  const result = await watchdogHalt.agentResume(agentId, { initiator, sessionId });
  const pausedWork = resumeCoordinator.take(agentId, sessionId);
  if (pausedWork) queueResumeContinuation(pausedWork);
  const notice = pausedWork
    ? `Operator resumed ${agentId}. The halt gate is clear and GLaDOS will re-dispatch the saved task context to continue its work.`
    : `Operator resumed ${agentId}. New turns and tool calls are permitted by the per-agent halt gate.`;
  transcriptEvent(sessionId, agentId, 'operator-event', notice, { halted: false, initiator });
  if (agentId !== 'glados') transcriptEvent(sessionId, 'glados', 'operator-event', notice, { haltedAgentId: agentId, halted: false, initiator });
  broadcastLobby('resume', { investigationSessionId: sessionId, agentId, haltActive: false });
  return { ...result, continuationScheduled: !!pausedWork };
}

async function probeTarget(targetUrl) {
  const result = await watchdogHealth.probe(targetUrl);
  broadcastLobby('target-health', result);
  return result;
}

function currentProxyConfig() {
  return proxyBackendConfig(process.env);
}

function currentProxyHealth() {
  const store = proxyHealth(currentProxyConfig());
  const supervised = process.env.GLADOS_DESKTOP === '1' && store.backend === 'mitmproxy';
  return combineProxyRuntimeHealth(store, proxyRuntime, { supervised });
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

function activeAgentStatus(sessionId = null) {
  try {
    if (!sessionId) {
      const running = new Map();
      for (const turn of activeChatTurns.values()) {
        running.set(runtimeKey(turn.sessionId, turn.agentId), {
          agentId: turn.agentId,
          sessionId: turn.turnId,
          investigationSessionId: turn.sessionId,
        });
      }
      for (const turn of activeSubagentTurns.values()) {
        running.set(runtimeKey(turn.investigationSessionId, turn.agentId), {
          agentId: turn.agentId,
          sessionId: turn.sessionId,
          investigationSessionId: turn.investigationSessionId,
        });
      }
      return [...running.values()];
    }
    return loadAgentRegistry()
      .map(a => ({ agentId: a.id, session: currentSessionForAgent(a.id, sessionId) }))
      .filter(a => a.session && a.session.live)
      .map(a => ({ agentId: a.agentId, sessionId: a.session.sessionId, investigationSessionId: sessionId }));
  } catch {
    return [];
  }
}

function overviewPayload(sessionId = activeInvestigationSession().id) {
  const Database = require('better-sqlite3');
  const agents = loadAgentRegistry().map(agent => {
    const session = currentSessionForAgent(agent.id, sessionId);
    return {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      active: !!session?.live,
      halted: watchdogHalt.agentStatus(agent.id, { sessionId }).haltActive,
      sessionId: session?.sessionId || null,
    };
  });
  const proxy = currentProxyHealth();
  const { file: _fullAccessFile, ...fullAccessState } = readFullAccessState(process.env);
  let db;
  let engagement = null;
  let goal = null;
  let plan = null;
  let topFindings = [];
  let assessmentMetrics = null;
  let findings = { total: 0, critical: 0, high: 0, medium: 0, low: 0, pendingValidation: 0 };
  let tasks = { total: 0, pending: 0, running: 0, complete: 0, failed: 0, cancelled: 0 };
  try {
    db = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    engagement = db.prepare(`
      SELECT id, target_name AS target, scope, status, started_at AS startedAt, completed_at AS completedAt
       FROM engagements WHERE session_id = ?
      -- The overview represents the most recently started engagement. Giving
      -- every active row absolute priority lets an older, empty kickoff stub
      -- permanently mask a later canonical completed engagement.
      ORDER BY datetime(started_at) DESC, rowid DESC
      LIMIT 1
    `).get(sessionId) || null;
    if (engagement) {
      try { assessmentMetrics = engagementMetrics(db, engagement.id); }
      catch (error) { console.warn('[overview] could not calculate engagement metrics:', error.message); }
      goal = db.prepare(`
        SELECT id, type, target, status, created_at AS createdAt, updated_at AS updatedAt
        FROM controller_goals
        WHERE engagement_id = ? OR target = ?
        ORDER BY datetime(updated_at) DESC LIMIT 1
      `).get(engagement.id, engagement.target) || null;
      plan = db.prepare(`
        SELECT id, version, state, plan_json AS planJson, created_at AS createdAt,
               approved_at AS approvedAt, completed_at AS completedAt
        FROM plans WHERE engagement_id = ? ORDER BY version DESC, datetime(created_at) DESC LIMIT 1
      `).get(engagement.id) || null;
      if (plan) {
        let planDocument = {};
        try { planDocument = JSON.parse(plan.planJson) || {}; } catch {}
        const vectors = Array.isArray(planDocument.proposed_vectors) ? planDocument.proposed_vectors : [];
        plan.objective = planDocument.terminal_objective
          || vectors[0]?.name
          || planDocument.replan_reason
          || 'Review the approved vectors and current evidence.';
        plan.vectors = vectors.slice(0, 4).map(vector => ({
          cwe: vector.cwe || null,
          name: vector.name || vector.rationale || vector.cwe || 'Unnamed vector',
          risk: vector.risk_to_target || null,
          agents: Array.isArray(vector.agents) ? vector.agents.slice(0, 4) : [],
        }));
        plan.agentChain = Array.isArray(planDocument.agent_chain) ? planDocument.agent_chain.slice(0, 8) : [];
        delete plan.planJson;
      }
      const findingRows = db.prepare(`
        SELECT lower(COALESCE(severity, priority, 'unknown')) AS severity,
               lower(COALESCE(validation_status, 'pending')) AS validationStatus,
               COUNT(*) AS n
        FROM findings WHERE engagement_id = ? GROUP BY severity, validationStatus
      `).all(engagement.id);
      findings = findingRows.reduce((out, row) => {
        out.total += row.n;
        if (Object.prototype.hasOwnProperty.call(out, row.severity)) out[row.severity] += row.n;
        if (!['validated', 'confirmed', 'rejected', 'false_positive'].includes(row.validationStatus)) out.pendingValidation += row.n;
        return out;
      }, findings);
      topFindings = db.prepare(`
        SELECT id, title, cwe_id AS cwe, affected_component AS component,
               lower(COALESCE(severity, 'informational')) AS severity,
               cvss_score AS cvss, lower(COALESCE(validation_status, 'pending')) AS validationStatus,
               confidence_score AS confidence, updated_at AS updatedAt
        FROM findings
        WHERE engagement_id = ?
        ORDER BY CASE lower(COALESCE(severity, 'informational'))
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 ELSE 4 END,
          COALESCE(cvss_score, 0) DESC, COALESCE(confidence_score, 0) DESC, id DESC
        LIMIT 5
      `).all(engagement.id);
      const taskRows = db.prepare(`SELECT lower(COALESCE(status, 'pending')) AS status, COUNT(*) AS n FROM tasks WHERE engagement_id = ? GROUP BY status`).all(engagement.id);
      tasks = taskRows.reduce((out, row) => {
        out.total += row.n;
        if (['running', 'in_progress', 'active'].includes(row.status)) out.running += row.n;
        else if (['complete', 'completed', 'done'].includes(row.status)) out.complete += row.n;
        else if (row.status === 'cancelled') out.cancelled += row.n;
        else if (['failed', 'error'].includes(row.status)) out.failed += row.n;
        else out.pending += row.n;
        return out;
      }, tasks);
    }
  } catch (error) {
    console.warn('[overview] could not read blackboard:', error.message);
  } finally {
    try { db?.close(); } catch {}
  }

  if (engagement?.scope) {
    try { engagement.scope = JSON.parse(engagement.scope); } catch {}
  }
  const activeAgents = agents.filter(agent => agent.active);
  const haltedAgents = agents.filter(agent => agent.halted);
  const pendingApprovals = plan?.state === 'pending_approval' ? 1 : 0;
  let phase = 'Standby';
  if (engagement) {
    if (engagement.status === 'complete' || engagement.completedAt) phase = 'Complete';
    else if (pendingApprovals) phase = 'Awaiting approval';
    else if (plan && ['approved', 'executing'].includes(plan.state)) phase = 'Execution';
    else phase = 'Reconnaissance';
  }
  const healthRows = watchdogHealth.listHealth();
  const targetHealth = engagement
    ? healthRows.find(row => String(row.target_url || '').includes(engagement.target) || String(engagement.target || '').includes(String(row.target_url || ''))) || null
    : null;
  return {
    generatedAt: new Date().toISOString(),
    version: getVersionInfo().version,
    phase,
    engagement,
    goal,
    plan,
    findings,
    topFindings,
    tasks,
    assessmentMetrics,
    agents,
    activeAgents,
    haltedAgents,
    pendingApprovals,
    targetHealth,
    proxy: {
      backend: proxy.backend,
      healthy: proxy.healthy,
      stale: proxy.stale,
      rps: proxy.rps || 0,
      error: proxy.error || null,
      processStatus: proxy.processStatus,
    },
    fullAccess: {
      available: process.platform === 'darwin' && process.env.GLADOS_DESKTOP === '1',
      enabled: fullAccessState.enabled === true,
      updatedAt: fullAccessState.updatedAt || null,
    },
  };
}

function planSummary(sessionId = activeInvestigationSession().id) {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT p.state, COUNT(*) AS n FROM plans p JOIN engagements e ON e.id=p.engagement_id WHERE e.session_id=? GROUP BY p.state').all(sessionId);
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

function controllerStatusPayload(sessionId = activeInvestigationSession().id) {
  const pendingGladosKickoff = pendingGladosKickoffs.get(sessionId) || null;
  return controller.status({
    pendingKickoff: pendingGladosKickoff ? {
      target: pendingGladosKickoff.target,
      goalId: pendingGladosKickoff.goalId || null,
      createdAt: pendingGladosKickoff.createdAt,
    } : null,
    activeAgents: activeAgentStatus(sessionId),
    targetHealth: watchdogHealth.listHealth(),
    plans: planSummary(sessionId),
    sessionId,
  });
}

async function runSlash(raw, sessionId = activeInvestigationSession().id) {
  const parsed = slash.parseSlashCommand(raw);
  const events = [];
  const emit = (text, kind = 'assistant-text', extra = {}) => {
    const ev = transcriptEvent(sessionId, 'glados', kind, text, { slash: true, ...extra });
    events.push(ev);
    return ev;
  };

  const commandEvent = recordUserTranscript(sessionId, 'glados', `$ ${String(raw || '').trim()}`, { slash: true });
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
    else emit(JSON.stringify(await haltAgent(arg, 'slash command', 'slash', sessionId), null, 2));
  } else if (cmd === '/resume') {
    if (!arg) emit('usage: /resume <agent>');
    else emit(JSON.stringify(await resumeAgent(arg, 'slash', sessionId), null, 2));
  } else if (cmd === '/probe') {
    if (!arg) emit('usage: /probe <url>');
    else emit(JSON.stringify(await probeTarget(arg), null, 2));
  } else if (cmd === '/status') {
    emit(slash.formatStatus(controllerStatusPayload(sessionId)));
  } else if (cmd === '/goal' || cmd === '/investigate') {
    if (!arg) {
      emit(cmd === '/investigate' ? slash.investigateReadyPrompt() : slash.targetUsage(cmd));
    } else if (!slash.isUrlOrDomain(arg)) {
      emit(`${slash.targetUsage(cmd)}\nTarget must be a URL or domain.`);
    } else {
      const target = normalizeTarget(arg);
      const goal = controller.createWebGoal(target, { source: cmd }, sessionId);
      const kickoff = createPendingGladosKickoff(target, raw, { goalId: goal.id, source: 'slash', sessionId });
      if (kickoff.event) events.push(kickoff.event);
    }
  } else if (cmd === '/security-review') {
    const review = slash.parseSecurityReviewArg(arg);
    if (!review.ok) {
      emit(`${review.error}\nusage: /security-review [--full] [--blind|--regression|--informed] [--time-limit 60m] [--single-model alias] <local-path>`);
    } else if (review.isLocalPath) {
      const campaignMode = review.campaign || (() => {
        try {
          const root = path.resolve(review.target);
          if (fs.existsSync(path.join(root, '.git'))) return false;
          return fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .filter(entry => fs.existsSync(path.join(root, entry.name, '.git'))).length >= 2;
        } catch { return false; }
      })();
      const goal = controller.createSecurityReviewGoal(path.resolve(review.target), {
        source: cmd, target_kind: 'local_path', context_mode: review.mode,
        max_duration_minutes: review.maxDurationMinutes, single_model: review.singleModel,
        review_profile: review.reviewProfile, campaign: campaignMode,
      }, sessionId);
      const configuredModels = new Map(loadHarnessRegistry({ env: process.env }).map(agent => [agent.id, agent.model]));
      const sourceModel = review.singleModel || configuredModels.get('source-code');
      const validatorModel = review.singleModel || configuredModels.get('source-review-validator');
      const expectedModels = {
        coordinator: review.singleModel || configuredModels.get('glados'),
        'source-code-primary': sourceModel,
        'authorization-access-control': sourceModel,
        'data-flow-injection': sourceModel,
        'secrets-history': sourceModel,
        'resilience-error-handling': sourceModel,
        'iac-config-manifests': sourceModel,
        'cryptography-suppressions': sourceModel,
        'source-review-validator': validatorModel,
      };
      const job = controller.enqueueSecurityReviewPath(review.target, {
        goalId: goal.id,
        engagementId: goal.engagement_id,
        contextMode: review.mode,
        maxDurationMinutes: review.maxDurationMinutes,
        discoveryConcurrency: loadPolicy().harness?.securityReviewDiscoveryConcurrency ?? 3,
        specialistConcurrency: loadPolicy().harness?.securityReviewSpecialistConcurrency ?? 3,
        allowedModels: [...new Set(Object.values(expectedModels).filter(Boolean))],
        expectedModels,
        requireModelDiversity: !review.singleModel,
        modelDiversityWaiver: review.singleModel ? `Operator approved a single-model review using ${review.singleModel} in this slash command.` : null,
        reviewProfile: review.reviewProfile,
        campaignMode,
        sessionId,
      });
      const queuedRun = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(controller.db.name)), 'investigations', job.engagement_id, 'security-review', 'run.json'), 'utf8'));
      emit(`Queued ${campaignMode ? `${queuedRun.campaign.repositoryCount}-repository expedited security-review campaign` : `${review.reviewProfile} source-code security review`} for \`${job.target}\`.\nJob: ${job.id}\nRuntime contract: ${queuedRun.contractRevision} (orchestration revision ${queuedRun.orchestrationRevision}).\nContext mode: ${queuedRun.contextMode}${queuedRun.requestedContextMode === 'auto' ? ` (automatically resolved; prior ${queuedRun.priorContext?.status === 'AVAILABLE' ? 'matched' : 'not found'})` : ''}.\nProfile: ${review.reviewProfile}${campaignMode ? ' portfolio breadth first, then risk-ranked depth' : ''}.\nTime ceiling: ${review.maxDurationMinutes ? `${review.maxDurationMinutes} minutes` : 'none; completion is saturation and gate driven'}.\nDiscovery policy: at least ${queuedRun.deepScan.minDiscoveryRuns} successful passes, stop only after ${queuedRun.deepScan.stopAfterNoNew} consecutive no-new passes, ${queuedRun.deepScan.maxDiscoveryRuns == null ? 'no fixed attempt ceiling' : `maximum ${queuedRun.deepScan.maxDiscoveryRuns}`}; up to ${queuedRun.deepScan.discoveryConcurrency} workers per batch.\nModel policy: ${review.singleModel ? `${review.singleModel} only (operator-approved diversity waiver)` : 'configured review models with diversity required'}.\nQuality gates: deterministic inventory, ${campaignMode ? 'one broad pass per campaign repository, ' : ''}risk-ranked specialist review, centralized semantic deduplication, source-based reportability, independent High/Critical validation, omission-focused validation, sealed evidence artifacts, and mandatory deliverables${queuedRun.contextMode === 'blind' ? '; prior-report lookup and regression are prohibited for this run' : '; blind discovery is followed by matched historical regression'}.`);
    } else if (review.isUrlOrDomain) {
      const target = normalizeTarget(review.target);
      const goal = controller.createGoal({
        type: 'security_review',
        target,
        status: 'pending_approval',
        metadata: { source: cmd, target_kind: 'url_or_domain', context_mode: review.mode },
      });
      const kickoff = createPendingGladosKickoff(target, raw, { goalId: goal.id, source: 'slash-security-review', sessionId });
      if (kickoff.event) events.push(kickoff.event);
    } else {
      emit('usage: /security-review [--blind|--regression|--informed] [--expedited [--campaign]] [--time-limit 60m] [--single-model alias] <url|domain|local-path>');
    }
  } else if (cmd === '/clear') {
    return { ok: true, events, action: { type: 'clear-local-transcript' } };
  }
  return { ok: true, events };
}

app.post('/api/slash/run', async (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  try {
    const command = String(req.body?.command || '');
    if (!command.trim()) return res.status(400).json({ ok: false, error: 'command required' });
    res.json(await runSlash(command, session.id));
  } catch (e) {
    const ev = transcriptEvent(session.id, 'glados', 'assistant-text', `error: ${e.message}`, { slash: true, isError: true });
    res.status(500).json({ ok: false, error: e.message, events: [ev] });
  }
});

app.get('/api/controller/status', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try { res.json({ ok: true, ...controllerStatusPayload(session.id) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/overview', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const usagePeriod = req.query.usage_period === 'daily' ? 'daily' : 'weekly';
    const llmUsage = await getLiteLlmUsage({ force: req.query.usage === 'refresh', days: usagePeriod === 'daily' ? 1 : 7 });
    const period = llmUsage.period || require('./lib/litellm-usage').usageWindow(new Date(), usagePeriod === 'daily' ? 1 : 7);
    const usageDb = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    try { llmUsage.sdkObserved = sdkUsageForPeriod(usageDb, period); }
    finally { usageDb.close(); }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, session, ...overviewPayload(session.id), llmUsage });
  }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/controller/events', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try { res.json({ ok: true, events: controller.eventsSince(req.query.since, req.query.limit, session.id) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/controller/goals', (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  try {
    const { type = 'webapp_goal', target, metadata = {} } = req.body || {};
    if (!target) return res.status(400).json({ ok: false, error: 'target required' });
    if (type === 'webapp_goal') return res.json({ ok: true, goal: controller.createWebGoal(target, metadata, session.id) });
    if (type === 'security_review') return res.json({ ok: true, goal: controller.createSecurityReviewGoal(target, metadata, session.id) });
    return res.status(400).json({ ok: false, error: 'unsupported goal type' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/controller/jobs/:id/cancel', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try { res.json(controller.cancelJob(req.params.id, { sessionId: session.id })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Halt controls (wired to watchdog lib) ---
app.post('/api/halt/:id', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    res.json(await haltAgent(req.params.id, req.body?.reason || 'dashboard halt', 'dashboard', session.id));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/resume/:id', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    res.json(await resumeAgent(req.params.id, 'dashboard', session.id));
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
  try { res.json(reports.deletePath(String(req.query.path || ''))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.patch('/api/reports/file', (req, res) => {
  try {
    const { path: reportPath, name } = req.body || {};
    res.json(reports.renamePath(String(reportPath || ''), String(name || '')));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
app.post('/api/gateway/restart', async (req, res) => {
  const agentIds = clearAllRuntimeSessions('runtime restart');
  const proxyConfig = currentProxyConfig();
  const managedProxy = process.env.GLADOS_DESKTOP === '1' && proxyConfig.backend === 'mitmproxy';
  if (managedProxy) await stopDesktopProxy();

  const blackboard = { ok: true, preserved: true };
  const proxy = { ok: true, preserved: true };
  if (managedProxy) startDesktopProxy();

  const ok = blackboard.ok && proxy.ok;
  const result = {
    ok,
    refreshId: crypto.randomUUID(),
    runtime: 'agent-sdk',
    resetAll: true,
    resetCount: agentIds.length,
    agentIds,
    plansReset: false,
    blackboardReset: false,
    proxyReset: false,
    blackboard,
    proxy,
    proxyRestarted: managedProxy,
    message: ok
      ? 'Agent runtime processes were refreshed. Investigation sessions, blackboard data, transcripts, and proxy history were preserved.'
      : 'Runtime processes were refreshed with errors.',
  };
  broadcastLobby('runtime-refresh', result);
  res.status(ok ? 200 : 500).json(result);
});

// Clears only this investigation session's SDK conversation/liveness state.
// Blackboard rows, durable transcript history, evidence, reports, and other
// investigation sessions are intentionally preserved.
app.post('/api/agents/:id/reset-session', (req, res) => {
  const agentId = req.params.id;
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  try {
    const ids = agentId === 'glados' ? assessmentAgentIds() : [agentId];
    const results = ids.map(id => {
      try { return resetAgentSession(session.id, id); }
      catch (e) { return { ok: false, agentId: id, error: e.message }; }
    });
    const failed = results.filter(r => !r.ok);
    if (failed.length) return res.status(500).json({ ok: false, agentId, cascade: agentId === 'glados', results });
    let blackboard = null;
    let memories = null;
    let looseArtifacts = null;
    if (agentId === 'glados') {
      pendingGladosKickoffs.delete(session.id);
      blackboard = { ok: true, preserved: true };
      memories = { ok: true, preserved: true };
      looseArtifacts = { ok: true, preserved: true };
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
      looseArtifacts,
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
    res.json(await agentDetails.listKnownModels());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/settings/agents/models', async (req, res) => {
  try {
    const catalog = await agentDetails.listKnownModels();
    if (!catalog.available) {
      return res.status(503).json({ ok: false, error: catalog.message || 'LiteLLM model discovery is unavailable.' });
    }
    const result = agentDetails.updateAgentModels(req.body?.changes, catalog.models);
    for (const entry of result.results.filter(entry => entry.ok && !entry.unchanged)) {
      broadcastLobby('agent-model-changed', entry);
    }
    const status = result.partial ? 207 : (result.ok ? 200 : 400);
    res.status(status).json(result);
  } catch (e) {
    const status = /required|too many|invalid|not found|unavailable|duplicate/i.test(e.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: e.message });
  }
});
app.post('/api/agents/:id/model', async (req, res) => {
  try {
    const requestedModel = String(req.body?.model || '').trim();
    const catalog = await agentDetails.listKnownModels();
    if (!catalog.available) {
      return res.status(503).json({ ok: false, error: catalog.message || 'LiteLLM model discovery is unavailable.' });
    }
    if (!catalog.models.includes(requestedModel)) {
      return res.status(400).json({ ok: false, error: `model is not currently available on LiteLLM: ${requestedModel}` });
    }
    const result = agentDetails.updateAgentModel(req.params.id, requestedModel);
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

app.post('/api/update/preservation-snapshot', async (req, res) => {
  try {
    const result = await createUpdatePreservationSnapshot({
      runtimeDir: GLADOS_RUNTIME_DIR,
      blackboardDb: BLACKBOARD_DB,
      watchdogDb: WATCHDOG_DB,
      activeAgents: activeAgentStatus().length,
      targetVersion: String(req.body?.targetVersion || 'unknown'),
    });
    res.json(result);
  } catch (error) {
    res.status(409).json({ ok: false, error: error.message });
  }
});

app.get('/api/update/stream', (req, res) => {
  updateRunner.startUpdateStream({
    res,
    force: /^(1|true|yes)$/i.test(String(req.query.force || '')),
    activeAgents: activeAgentStatus().length,
  });
});

app.get('/api/health/proxy', (req, res) => {
  res.json(currentProxyHealth());
});

app.post('/api/engagements/:id/end', (req, res) => {
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  if (!investigationSessions.ownsEngagement(session.id, req.params.id)) return res.status(404).json({ ok: false, error: 'engagement not found in this investigation session' });
  const Database = require('better-sqlite3');
  const reason = String(req.body?.reason || 'operator ended investigation from Overview').slice(0, 1000);
  const operator = String(req.body?.operator || 'operator').slice(0, 120);
  const db = new Database(BLACKBOARD_DB);
  try {
    const result = endInvestigationForEngagement(db, {
      engagementId: req.params.id,
      operator,
      reason,
    });
    stopInvestigationRuntime(result, { reason, sessionId: session.id });
    broadcastLobby('engagement-ended', {
      engagement_id: result.engagement_id,
      status: result.engagement_status,
      reason,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  } finally {
    db.close();
  }
});

// v4 — Plan-approval workflow endpoints (see routes/plans.js).
app.use('/api/plans', planRoutes(broadcastLobby, {
  onApproved: queueApprovedPlanExecution,
  onEnded: stopInvestigationRuntime,
  getSessionId: req => requestSessionId(req),
}));

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
  const session = requireSession(req, res);
  if (!session) return;
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dbPath = BLACKBOARD_DB;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const where = ['engagement_id IN (SELECT id FROM engagements WHERE session_id=?)']; const args = [session.id];
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
  const session = requireSession(req, res, { writable: true });
  if (!session) return;
  const Database = require('better-sqlite3');
  const dbPath = BLACKBOARD_DB;
  const db = new Database(dbPath);
  try {
    const state = req.body?.state || 'dismissed';
    if (!['accepted','dismissed','superseded'].includes(state)) return res.status(400).json({ error: 'bad state' });
    const r = db.prepare(
      "UPDATE replan_proposals SET state = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND engagement_id IN (SELECT id FROM engagements WHERE session_id=?)"
    ).run(state, req.body?.resolved_by || 'operator', req.params.id, session.id);
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
  try { await liteLlmResponseRelay.close(); } catch {}
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
