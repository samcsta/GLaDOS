const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { PORT, BLACKBOARD_DB } = require('./lib/config');
const { AgentWatcher } = require('./lib/agent-watcher');
const { loadAgentRegistry, listAgentIds, currentSessionForAgent, sendMessageToAgent } = require('./lib/openclaw');
const reports = require('./lib/reports');
const agentDetails = require('./lib/agent-details');
const { JsonlTail, convertToEvents } = require('./lib/jsonl-tail');
const { RawStreamTail } = require('./lib/raw-stream-tail');
const watchdogHealth = require('glados-watchdog/lib/health');
const watchdogHalt = require('glados-watchdog/lib/halt');
const { CircuitBreaker, getBurpRps } = require('glados-watchdog/lib/breaker');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let rawStreamFloorMs = Date.now();

try {
  require('../scripts/lib/glados-local').ensureBlackboardDb({ blackboardDb: BLACKBOARD_DB });
} catch (e) {
  console.warn('[startup] could not initialize blackboard db:', e.message);
}

// Boot-time hygiene: keep the sessions/ tree from accumulating archived
// JSONLs (we hit 7.4 MB / 57 files in a few days under the prior keep-forever
// behavior; the agent-watcher's chokidar can in some failure modes re-tail a
// stale file and bleed prior chat into a fresh pane). Also keep the
// agentDir IDENTITY.md files in sync with the workspace canonical so the
// model never gets two competing system prompts. Both run cheaply once on
// boot; the same helpers run again on glados session reset.
try {
  const prune = pruneArchivedSessions();
  if (prune.deleted > 0) console.log(`[startup] pruned ${prune.deleted} archived session(s) (retention=${prune.retention})`);
} catch (e) { console.warn('[startup] archive prune failed:', e.message); }
try {
  const sync = syncAgentDirIdentities();
  if (sync.synced > 0) console.log(`[startup] synced ${sync.synced} agentDir IDENTITY.md from workspace`);
} catch (e) { console.warn('[startup] agentDir sync failed:', e.message); }
try {
  const raw = truncateRawStream();
  rawStreamFloorMs = Date.now();
  if (raw.bytesBefore > 0) console.log(`[startup] truncated raw-stream.jsonl (${raw.bytesBefore} bytes)`);
} catch (e) { console.warn('[startup] raw-stream truncate failed:', e.message); }

const watcher = new AgentWatcher().start();

// Per-agent ring buffer of recent events (for new SSE subscribers to backfill).
const BUFFER_LIMIT = 500;
const buffers = new Map(); // agentId -> array of events (newest last)
const sseClients = new Map(); // agentId -> Set<res>
const lobbyClients = new Set(); // /api/agents SSE subscribers
const activeChatTurns = new Map(); // agentId -> { turnId, startedAt, messagePreview }
const recentChatTurns = new Map(); // agentId -> { turnId, expiresAt } short grace for late raw-stream fs events
let pendingGladosKickoff = null;
let pendingGladosTargetRequest = null;
const BLACKBOARD_STATE_TABLES = [
  'replan_proposals',
  'plan_approvals',
  'plans',
  'recon_steps',
  'baseline_recon',
  'tasks',
  'findings',
  'engagements',
];

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
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of set) res.write(payload);
}

function broadcastLobby(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of lobbyClients) res.write(payload);
}

function startChatTurn(agentId, message) {
  const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  // Raw-stream can replay compaction/safeguard tokens with historical `ts`
  // values. A new direct chat turn should never render raw tokens older than
  // the user message that triggered it.
  rawStreamFloorMs = Math.max(rawStreamFloorMs, startedAt - 1000);
  activeChatTurns.set(agentId, {
    turnId,
    startedAt,
    messagePreview: String(message || '').slice(0, 160),
  });
  recentChatTurns.delete(agentId);
  broadcastLobby('chat-turn-started', { agentId, turnId, startedAt });
  return turnId;
}

function finishChatTurn(agentId, turnId) {
  const current = activeChatTurns.get(agentId);
  if (!current || current.turnId !== turnId) return;
  activeChatTurns.delete(agentId);
  recentChatTurns.set(agentId, { turnId, expiresAt: Date.now() + 15_000 });
  broadcastLobby('chat-turn-ended', { agentId, turnId });
}

function finishActiveChatTurn(agentId, ev = null) {
  const current = activeChatTurns.get(agentId);
  if (!current) return;
  const evMs = eventSortMs(ev);
  if (evMs && evMs < current.startedAt - 1000) return;
  finishChatTurn(agentId, current.turnId);
}

function transcriptEvent(agentId, kind, text, extra = {}) {
  const ev = {
    agentId,
    kind,
    text,
    ts: new Date().toISOString(),
    id: `dashboard:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  };
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

function extractInvestigationTarget(message) {
  const text = String(message || '').trim();
  const patterns = [
    /\b(?:begin|start|launch|run|perform|open)\s+(?:an?\s+)?(?:fresh\s+)?(?:investigation|assessment|web\s*app\s*assessment|test(?:-|\s*)run)\s+(?:on|for|against)\s+["'`]?([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`<>]+|[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/i,
    /\b(?:investigate|assess|test)\s+["'`]?([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`<>]+|[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return normalizeTarget(m[1]);
  }
  return null;
}

function extractBareTarget(message) {
  const text = String(message || '').trim();
  if (!text || /\s/.test(text.replace(/^https?:\/\//i, ''))) return null;
  const m = text.match(/^["'`]?(https?:\/\/[^\s"'`<>]+|[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})(?:\/[^"'`\s<>]*)?["'`.,!?;:]*$/i);
  return m?.[1] ? normalizeTarget(m[1]) : null;
}

function isAssessmentReadinessIntent(message) {
  const text = String(message || '').toLowerCase();
  return /\b(ready|start|begin|run|launch|kick\s*off|spin\s*up)\b/.test(text)
    && /\b(assessment|investigation|engagement|web\s*app|team)\b/.test(text);
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

function createPendingGladosKickoff(target, originalMessage) {
  pendingGladosTargetRequest = null;
  pendingGladosKickoff = {
    target,
    originalMessage,
    createdAt: Date.now(),
  };
  const ev = transcriptEvent('glados', 'assistant-text', kickoffApprovalPrompt(target), { gated: true });
  return {
    ok: true,
    gated: true,
    pending: pendingGladosKickoff,
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

function openclawResultError(result) {
  const payloads = result?.result?.payloads || [];
  const text = payloads.map(p => p?.text || '').join('\n').trim();
  if (/LLM request failed|LLM idle timeout|network connection error/i.test(text)) {
    return text || 'OpenClaw model request failed';
  }
  const stopReason = result?.result?.stopReason;
  const err = result?.result?.error || result?.error;
  if (stopReason === 'error' || err) return err || 'OpenClaw run stopped with error';
  return null;
}

function assessmentAgentIds() {
  const registryIds = loadAgentRegistry().map(a => a.id).filter(Boolean);
  const ids = registryIds.length ? registryIds : listAgentIds();
  // Atlas is the user's general chatbot; a GLaDOS operational reset should not
  // erase that separate conversation unless Atlas itself is selected.
  return [...new Set(ids)].filter(id => id !== 'atlas');
}

function resetAgentSession(agentId, ts = new Date().toISOString().replace(/[:.]/g, '-')) {
  const fs = require('node:fs');
  const os = require('node:os');
  const sessionsIdxPath = path.join(os.homedir(), '.openclaw/agents', agentId, 'sessions/sessions.json');
  const snap = currentSessionForAgent(agentId);
  let idx = null;
  const archivedPaths = [];
  const removedLockPaths = [];
  let removedIndexEntry = false;

  try {
    idx = JSON.parse(fs.readFileSync(sessionsIdxPath, 'utf8'));
  } catch {}

  const entries = idx && typeof idx === 'object'
    ? Object.entries(idx).filter(([key]) => key === `agent:${agentId}:main` || key.startsWith(`agent:${agentId}:subagent:`))
    : [];
  if (!entries.length && snap?.sessionFile) entries.push([snap.sessionKey || `agent:${agentId}:main`, { sessionFile: snap.sessionFile }]);

  for (const [key, entry] of entries) {
    const sessionFile = entry?.sessionFile;
    if (sessionFile && fs.existsSync(sessionFile)) {
      const archivedPath = `${sessionFile}.archived-${ts}`;
      fs.renameSync(sessionFile, archivedPath);
      archivedPaths.push(archivedPath);
    }

    const lockPath = sessionFile ? `${sessionFile}.lock` : null;
    if (lockPath && fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      removedLockPaths.push(lockPath);
    }

    if (idx && idx[key]) {
      delete idx[key];
      removedIndexEntry = true;
    }
  }

  if (idx && removedIndexEntry) {
    fs.writeFileSync(sessionsIdxPath, JSON.stringify(idx, null, 2));
  }

  // Sweep loose orphan JSONLs that the index-driven pass above missed.
  // Orphans accumulate when an OpenClaw process is killed between writing a
  // session JSONL and updating sessions.json — the file exists but no index
  // entry names it, so prior resets couldn't see it. Without this sweep,
  // the agent-watcher's chokidar scan can later replay an orphan's content
  // into the live pane and bleed prior-investigation chat into a fresh
  // session. We rename rather than delete (recoverable on disk).
  const sessionsDirPath = path.dirname(sessionsIdxPath);
  const orphanArchivedPaths = [];
  try {
    const justArchived = new Set(archivedPaths);
    for (const name of fs.readdirSync(sessionsDirPath)) {
      if (!name.endsWith('.jsonl')) continue;       // skip already-archived (.jsonl.archived-*)
      const full = path.join(sessionsDirPath, name);
      if (justArchived.has(full)) continue;          // we just touched this one
      // If the index still references this file, it's a live session for a
      // different key (subagent we missed, etc.) — leave it alone.
      let referencedInIndex = false;
      try {
        const raw = fs.readFileSync(sessionsIdxPath, 'utf8');
        if (raw.includes(name)) referencedInIndex = true;
      } catch {}
      if (referencedInIndex) continue;
      const orphanArchived = `${full}.archived-orphan-${ts}`;
      try {
        fs.renameSync(full, orphanArchived);
        orphanArchivedPaths.push(orphanArchived);
      } catch (e) {
        // Best-effort — log but don't fail the reset.
        console.warn(`[reset:${agentId}] could not archive orphan ${name}: ${e.message}`);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[reset:${agentId}] orphan sweep failed: ${e.message}`);
  }

  buffers.delete(agentId);
  broadcastLobby('session-reset', {
    agentId,
    archivedPath: archivedPaths[0] || null,
    archivedPaths,
    orphanArchivedPaths,
    removedIndexEntry,
  });
  return {
    ok: true,
    agentId,
    archivedPath: archivedPaths[0] || null,
    archivedPaths,
    orphanArchivedPaths,
    removedLockPath: removedLockPaths[0] || null,
    removedLockPaths,
    removedIndexEntry,
    hadSession: entries.length > 0 || removedIndexEntry || orphanArchivedPaths.length > 0,
  };
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

// Clears every state source that can leak prior-investigation context into a
// fresh GLaDOS session. There are three sources, all independent:
//   1. memory/.dreams/* in each agent workspace — short-term recall snippets
//      indexed across past memory files. The agent startup procedure
//      (workspaces/agents/<id>/AGENTS.md) reads these; if not cleared, snippets
//      from prior assessments resurface as "remembered context".
//   2. ~/.openclaw/memory/<id>.sqlite — OpenClaw's per-agent vector embedding
//      store. Holds chunks, file index, and embedding cache. Empty on most
//      agents but accumulates on glados/atlas if the operator interacts.
//   3. Stray .archived-* JSONLs older than the retention budget — see
//      pruneArchivedSessions(). Not handled here; called separately on reset.
// The curated long-term MEMORY.md is intentionally preserved.
function wipeAgentMemories() {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const Database = require('better-sqlite3');
  const workspaces = process.env.GLADOS_AGENT_WORKSPACES
    || path.join(os.homedir(), '.glados', 'workspaces', 'agents');
  const openclawMemDir = path.join(os.homedir(), '.openclaw', 'memory');
  let dreamsCleared = 0;
  let sqliteCleared = 0;
  let agents = 0;
  const errors = [];

  // 1. Workspace .dreams short-term recall.
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

  // 2. OpenClaw per-agent memory SQLite (vector embedding store). Clear data
  // tables but leave schema intact so OpenClaw doesn't have to recreate it.
  // Schema: chunks, chunks_fts*, files, embedding_cache, meta.
  if (fs.existsSync(openclawMemDir)) {
    for (const f of fs.readdirSync(openclawMemDir)) {
      if (!f.endsWith('.sqlite')) continue;
      const dbPath = path.join(openclawMemDir, f);
      let db;
      try {
        db = new Database(dbPath);
        db.exec(`
          DELETE FROM chunks;
          DELETE FROM files;
          DELETE FROM chunks_fts;
          DELETE FROM embedding_cache;
        `);
        sqliteCleared++;
      } catch (e) {
        errors.push(`openclaw-mem ${f}: ${e.message}`);
      } finally {
        try { db?.close(); } catch {}
      }
    }
  }

  return {
    ok: errors.length === 0,
    agents,
    dreamsCleared,
    openclawMemoryCleared: sqliteCleared,
    errors,
  };
}

// Truncates ~/.openclaw/logs/raw-stream.jsonl so the dashboard's RawStreamTail
// starts fresh on the next turn. The gateway's per-token thinking/text stream
// accumulates in this file unboundedly between rotations (50 MB threshold —
// took a week to fill 7 MB, never rotated). When `compaction.mode: "safeguard"`
// is active in openclaw.json, the gateway can replay old thinking tokens with
// their original `ts` field during compaction, producing transient SSE events
// that render in the GLaDOS pane with stale timestamps and disappear on page
// refresh (because they're never written to the durable session JSONL). This
// is the source of "old thinking content leaks during a fresh response" —
// truncating clears the gateway's replay buffer.
function truncateRawStream() {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const file = process.env.OPENCLAW_RAW_STREAM_PATH
    || path.join(os.homedir(), '.openclaw', 'logs', 'raw-stream.jsonl');
  let bytesBefore = 0;
  try { bytesBefore = fs.statSync(file).size; } catch {}
  try { fs.writeFileSync(file, ''); }
  catch (e) { return { ok: false, error: e.message }; }
  rawStreamFloorMs = Date.now();
  return { ok: true, bytesBefore, truncatedAt: rawStreamFloorMs };
}

// Syncs every agent's openclaw.json `agentDir` IDENTITY.md (if present) from
// the canonical workspace IDENTITY.md so the model never gets two competing
// system prompts. The two-location issue exists historically because some
// agents have both `workspace` and `agentDir` configured in openclaw.json
// (e.g. glados), and OpenClaw loads files from both paths. If they drift,
// the older file can dominate or contradict the workspace version. This
// helper makes them identical, with the workspace as the source of truth.
function syncAgentDirIdentities() {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const workspaces = process.env.GLADOS_AGENT_WORKSPACES
    || path.join(os.homedir(), '.glados', 'workspaces', 'agents');
  const openclawAgents = path.join(os.homedir(), '.openclaw', 'agents');
  let synced = 0;
  let skipped = 0;
  const errors = [];
  if (!fs.existsSync(workspaces) || !fs.existsSync(openclawAgents)) {
    return { ok: true, synced, skipped, errors };
  }
  for (const ent of fs.readdirSync(openclawAgents, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const agentDirIdentity = path.join(openclawAgents, ent.name, 'agent', 'IDENTITY.md');
    const workspaceIdentity = path.join(workspaces, ent.name, 'IDENTITY.md');
    if (!fs.existsSync(agentDirIdentity) || !fs.existsSync(workspaceIdentity)) {
      skipped++;
      continue;
    }
    try {
      const ws = fs.readFileSync(workspaceIdentity, 'utf8');
      const ad = fs.readFileSync(agentDirIdentity, 'utf8');
      if (ws === ad) { skipped++; continue; }
      fs.writeFileSync(agentDirIdentity, ws);
      synced++;
    } catch (e) {
      errors.push(`${ent.name}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, synced, skipped, errors };
}

// Deletes archived session JSONLs older than the retention budget across every
// agent's sessions/ directory. Default retention is 0 — every reset garbage
// collects all archives, since the operator explicitly does not use the
// forensic trail. Override with env var GLADOS_ARCHIVE_RETENTION=N to keep
// the most-recent N archive files per agent.
//
// Without this prune, archived JSONLs accumulated unboundedly (we hit 7.4 MB
// across 57 files in a few days), and the agent-watcher's chokidar instance
// could in some failure modes re-tail a stale file and bleed prior chat into
// a fresh pane. Garbage collecting on reset keeps the sessions/ directory at
// most one-archive-per-agent immediately after each reset.
function pruneArchivedSessions() {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const retention = Math.max(0, Number(process.env.GLADOS_ARCHIVE_RETENTION) || 0);
  const agentsRoot = path.join(os.homedir(), '.openclaw', 'agents');
  let deleted = 0;
  let kept = 0;
  const errors = [];
  if (!fs.existsSync(agentsRoot)) return { ok: true, deleted, kept, retention, errors };
  for (const agentEnt of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!agentEnt.isDirectory()) continue;
    const sessDir = path.join(agentsRoot, agentEnt.name, 'sessions');
    if (!fs.existsSync(sessDir)) continue;
    let archives;
    try {
      archives = fs.readdirSync(sessDir)
        .filter(f => f.includes('.jsonl.archived'))
        .map(f => {
          const full = path.join(sessDir, f);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch {}
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first
    } catch (e) {
      errors.push(`${agentEnt.name}: ${e.message}`);
      continue;
    }
    archives.forEach((a, i) => {
      if (i < retention) { kept++; return; }
      try { fs.rmSync(a.full, { force: true }); deleted++; }
      catch (e) { errors.push(`${agentEnt.name}/${path.basename(a.full)}: ${e.message}`); }
    });
  }
  return { ok: errors.length === 0, deleted, kept, retention, errors };
}

function candidateRawStreamAgent() {
  const active = [...activeChatTurns.keys()];
  if (active.length === 1) return active[0];
  const now = Date.now();
  for (const [agentId, v] of recentChatTurns) {
    if (!v || v.expiresAt < now) recentChatTurns.delete(agentId);
  }
  const recent = [...recentChatTurns.keys()];
  return recent.length === 1 ? recent[0] : null;
}

watcher.on('event', ev => {
  pushBuffer(ev.agentId, ev);
  broadcastTranscript(ev.agentId, ev);
  if (ev.kind === 'assistant-text' || ev.kind === 'prompt-error') {
    finishActiveChatTurn(ev.agentId, ev);
  }
});
watcher.on('session-started', info => {
  broadcastLobby('session-started', info);
});
watcher.on('session-ended', info => {
  broadcastLobby('session-ended', info);
});

// --- Real-time token stream from OpenClaw's raw-stream log ---
// The gateway (when launched with OPENCLAW_RAW_STREAM=1) appends per-token
// thinking/text deltas to ~/.openclaw/logs/raw-stream.jsonl. The file's
// events are keyed by sessionId — we maintain a reverse map sessionId->agentId
// from each agent's sessions.json and fan every delta into the matching
// agent's SSE transcript stream. Frontend coalesces deltas into one live entry
// per turn (see public/app.js 'thinking-stream' / 'text-stream' handling).
const sessionToAgent = new Map(); // sessionId -> agentId
const orphanRawDeltas = new Map(); // sessionId -> [{...raw-stream ev}]
function bufferOrphanRawDelta(ev) {
  const key = ev.sessionId;
  if (!key) return;
  const arr = orphanRawDeltas.get(key) || [];
  arr.push({ ev, ts: Date.now() });
  while (arr.length > 300) arr.shift();
  orphanRawDeltas.set(key, arr);
}
function flushOrphanRawDeltas(sessionId, agentId) {
  const arr = orphanRawDeltas.get(sessionId);
  if (!arr || !agentId) return;
  orphanRawDeltas.delete(sessionId);
  const cutoff = Date.now() - 30_000;
  for (const item of arr) {
    if (item.ts < cutoff) continue;
    broadcastTranscript(agentId, { agentId, ...item.ev });
  }
}
function refreshSessionMap() {
  try {
    const registry = loadAgentRegistry();
    for (const a of registry) {
      const snap = currentSessionForAgent(a.id);
      if (snap && snap.sessionId) {
        sessionToAgent.set(snap.sessionId, a.id);
        flushOrphanRawDeltas(snap.sessionId, a.id);
      }
    }
  } catch {}
}
refreshSessionMap();
setInterval(refreshSessionMap, 5_000);
watcher.on('session-started', info => {
  if (info?.sessionId && info?.agentId) {
    sessionToAgent.set(info.sessionId, info.agentId);
    flushOrphanRawDeltas(info.sessionId, info.agentId);
  }
});

// Extract agentId from a runId. The gateway uses runId patterns like:
//   <uuid>                                                — main-agent turn
//   announce:v1:agent:<id>:subagent:<sub-uuid>:<uuid>     — subagent heartbeat
//   ...:agent:<id>:...                                    — other agent-scoped runs
// Returns the embedded agent id when present, else null. We only trust the
// extracted id if it matches a known registered agent — otherwise we'd let
// arbitrary runId text become pane labels.
function agentFromRunId(runId, knownAgentIds) {
  if (typeof runId !== 'string') return null;
  const m = runId.match(/(?:^|[:/])agent:([a-zA-Z0-9_-]+)(?:[:/]|$)/);
  if (!m) return null;
  const id = m[1];
  return knownAgentIds.has(id) ? id : null;
}

function rawEventMs(ev) {
  const parsed = Date.parse(ev?.ts || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function staleRawStreamEvent(ev, agentId) {
  const evMs = rawEventMs(ev);
  if (evMs < rawStreamFloorMs - 1000) return true;
  const snap = agentId ? currentSessionForAgent(agentId) : null;
  if (snap?.sessionId && ev.sessionId && ev.sessionId !== snap.sessionId) return true;
  if (snap?.startedAt && evMs < snap.startedAt - 1000) return true;
  return false;
}

function readSessionBackfillEvents(sessionFile, agentId, sessionId) {
  let raw = '';
  try { raw = fs.readFileSync(sessionFile, 'utf8'); } catch { return null; }
  const events = [];
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    for (const ev of convertToEvents(obj)) {
      events.push({ agentId, sessionId, ...ev });
    }
  }
  return suppressSupersededPromptErrors(events);
}

function eventSortMs(ev) {
  const ms = Date.parse(ev?.ts || '');
  return Number.isFinite(ms) ? ms : 0;
}

function bufferedTranscriptEvents(agentId) {
  let backfill = [];
  const snap = currentSessionForAgent(agentId);
  if (snap && snap.sessionFile && fs.existsSync(snap.sessionFile)) {
    backfill = readSessionBackfillEvents(snap.sessionFile, agentId, snap.sessionId) || [];
    for (const ev of backfill) pushBuffer(agentId, ev);
  }
  const seen = new Set();
  const combined = [];
  for (const ev of [...backfill, ...(buffers.get(agentId) || [])]) {
    const key = ev?.id ? `id:${ev.id}` : `${ev?.kind || ''}:${ev?.ts || ''}:${ev?.text || ev?.toolCallId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(ev);
  }
  return combined.sort((a, b) => {
    const d = eventSortMs(a) - eventSortMs(b);
    if (d) return d;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function suppressSupersededPromptErrors(events) {
  if (!Array.isArray(events) || events.length === 0) return events || [];
  return events.filter((ev, i) => {
    if (ev.kind !== 'prompt-error') return true;
    return !events.slice(i + 1).some(later => later.kind === 'assistant-text');
  });
}

const rawStream = new RawStreamTail().start();
rawStream.on('raw', ev => {
  // Suppress subagent heartbeat traffic ("NO_REPLY" replies and the like).
  // These are gateway-internal liveness pings — never operator-facing chat —
  // and previously cluttered the GLaDOS pane as one-token fragments because
  // they have no sessionId and got routed to the candidate agent.
  if (typeof ev.runId === 'string' && ev.runId.startsWith('announce:')) return;

  // Build the known-agent set fresh each event — registry is small and this
  // saves us from staleness if a new agent was just registered.
  const knownAgentIds = new Set(loadAgentRegistry().map(a => a.id));

  // Lazy-learn: if a sessionId isn't in our map yet (e.g. brand-new session we
  // haven't scanned), do a one-shot refresh before dropping the event.
  let agentId = ev.sessionId ? sessionToAgent.get(ev.sessionId) : null;
  if (!agentId && ev.sessionId) { refreshSessionMap(); agentId = sessionToAgent.get(ev.sessionId); }
  // The raw-stream log frequently omits sessionId but always has runId, and
  // the runId itself encodes the agent for any agent-scoped run. Prefer that
  // over the "active chat" candidate fallback so subagent traffic lands in
  // the subagent's pane instead of polluting whichever chat is currently up.
  if (!agentId) {
    agentId = agentFromRunId(ev.runId, knownAgentIds);
  }
  if (!agentId && !ev.sessionId) {
    agentId = candidateRawStreamAgent();
  }
  if (!agentId) {
    if (ev.sessionId) bufferOrphanRawDelta(ev);
    return;
  }
  if (staleRawStreamEvent(ev, agentId)) return;
  const enriched = { agentId, ...ev };
  // DO NOT push to the per-agent ring buffer — the buffer is for backfill
  // on reconnect and a 2000-token-per-turn flood would blow it out instantly.
  // Streaming deltas are live-only; reconnecting clients re-read the final
  // message from the session JSONL (which is the durable source of truth).
  broadcastTranscript(agentId, enriched);
});
rawStream.on('rotated', info => {
  console.log(`[raw-stream] rotated to ${info.rotatedTo}`);
});
rawStream.on('error', e => {
  console.warn('[raw-stream] error:', e.message);
});

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
      active: !!(snap && snap.live),
      session: snap,
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
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  // Backfill from the durable session JSONL plus the in-memory ring. This is
  // intentionally done on every connect, not only when the ring is empty:
  // subagent prompts can be written before the watcher attaches, while later
  // live events still populate the ring.
  for (const ev of bufferedTranscriptEvents(agentId)) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  let set = sseClients.get(agentId);
  if (!set) { set = new Set(); sseClients.set(agentId, set); }
  set.add(res);
  req.on('close', () => set.delete(res));
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
    const approvedMessage = buildApprovedKickoffMessage(approved, message);
    const turnId = startChatTurn('glados', approvedMessage);
    try {
      const result = await sendMessageToAgent('glados', approvedMessage);
      const resultError = openclawResultError(result);
      if (resultError) return res.status(502).json({ ok: false, error: resultError, result });
      return res.json({ ok: true, gated: true, approved: true, result });
    } catch (e) {
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

  if (pendingGladosTargetRequest) {
    recordUserTranscript('glados', message);
    if (isKickoffCancel(message)) {
      pendingGladosTargetRequest = null;
      const ev = transcriptEvent('glados', 'assistant-text', 'Cancelled assessment startup. No resources were checked and no agents were dispatched.');
      return res.json({ ok: true, gated: true, cancelled: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
    }

    const target = extractInvestigationTarget(message) || extractBareTarget(message);
    if (target) {
      return res.json(createPendingGladosKickoff(target, message));
    }

    const ev = transcriptEvent(
      'glados',
      'assistant-text',
      'I am ready and still only need the target. Send a domain or URL, and I will ask before checking DradisTab, Dradis, or DomainsAI.'
    );
    return res.json({ ok: true, gated: true, waitingForTarget: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
  }

  const kickoffTarget = extractInvestigationTarget(message);
  if (kickoffTarget) {
    recordUserTranscript('glados', message);
    return res.json(createPendingGladosKickoff(kickoffTarget, message));
  }

  if (isAssessmentReadinessIntent(message)) {
    recordUserTranscript('glados', message);
    pendingGladosTargetRequest = {
      createdAt: Date.now(),
      originalMessage: message,
    };
    const ev = transcriptEvent(
      'glados',
      'assistant-text',
      'Ready. The local ROE, operator context, and local secret profiles are already configured. What target should we assess?'
    );
    return res.json({ ok: true, gated: true, waitingForTarget: true, result: { payloads: [{ text: ev.text, mediaUrl: null }] } });
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
    const result = await sendMessageToAgent('glados', message);
    const resultError = openclawResultError(result);
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

// Atlas chat — local general-purpose assistant (not red-team). Same plumbing
// as GLaDOS: POST message, reply streams back over the agent's transcript SSE.
app.post('/api/chat/atlas', async (req, res) => {
  const message = (req.body && req.body.message) || '';
  if (!message.trim()) return res.status(400).json({ error: 'message required' });
  const turnId = startChatTurn('atlas', message);
  try {
    const result = await sendMessageToAgent('atlas', message);
    const resultError = openclawResultError(result);
    if (resultError) return res.status(502).json({ ok: false, error: resultError, result });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stderr: e.stderr, stdout: e.stdout });
  } finally {
    finishChatTurn('atlas', turnId);
  }
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

// Atlas image upload — saves a base64-data-URL image to a staging dir and
// returns the absolute path. The frontend then appends that path into the
// user's next message text so Atlas can use `read` (or vision, if the model
// supports it) to inspect it.
const ATLAS_UPLOADS = path.join(require('node:os').tmpdir(), 'atlas-uploads');
try { require('node:fs').mkdirSync(ATLAS_UPLOADS, { recursive: true }); } catch {}
app.use('/api/chat/atlas/uploads', express.json({ limit: '25mb' }));
app.post('/api/chat/atlas/upload', express.json({ limit: '25mb' }), (req, res) => {
  const { dataUrl, filename } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ ok: false, error: 'dataUrl required' });
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'unsupported image format' });
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const base = (filename || 'upload').replace(/[^\w.\-]/g, '_').slice(0, 40);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(ATLAS_UPLOADS, `${stamp}-${base}.${ext}`);
  try {
    require('node:fs').writeFileSync(outPath, Buffer.from(m[3], 'base64'));
    res.json({ ok: true, path: outPath, bytes: Buffer.from(m[3], 'base64').length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Halt controls (wired to watchdog lib) ---
app.post('/api/halt/:id', async (req, res) => {
  try {
    const result = await watchdogHalt.agentHalt(
      req.params.id,
      req.body?.reason || 'dashboard halt',
      { initiator: 'dashboard' }
    );
    broadcastLobby('halt', { agentId: req.params.id, reason: req.body?.reason });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/resume/:id', async (req, res) => {
  try {
    const result = await watchdogHalt.agentResume(req.params.id, { initiator: 'dashboard' });
    broadcastLobby('resume', { agentId: req.params.id });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/halt-all', async (req, res) => {
  try {
    const result = await watchdogHalt.engagementHaltAll(
      req.body?.engagement_id || null,
      req.body?.reason || 'dashboard halt-all',
      { initiator: 'dashboard' }
    );
    broadcastLobby('halt-all', {
      reason: req.body?.reason,
      haltedAgents: result.haltedAgents || [],
    });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// v3.1: companion to /api/halt-all. Clears deny rules for every agent the
// halt-all added, and re-enables the Burp scope.
app.post('/api/resume-all', async (req, res) => {
  try {
    const result = await watchdogHalt.engagementResumeAll({ initiator: 'dashboard' });
    broadcastLobby('resume-all', { resumed: result.resumed || [] });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Target health ---
app.post('/api/targets/probe', async (req, res) => {
  const { target_url } = req.body || {};
  if (!target_url) return res.status(400).json({ ok: false, error: 'target_url required' });
  try {
    const result = await watchdogHealth.probe(target_url);
    broadcastLobby('target-health', result);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/targets', (req, res) => {
  res.json({ targets: watchdogHealth.listHealth() });
});

// --- Burp RPS + gate indicator ---
app.get('/api/burp/rps', async (req, res) => {
  const rps = await getBurpRps({ windowSec: 10 });
  res.json({ rps });
});

// --- Burp extension passthrough (:1338 — GLaDOS Montoya extension) ---
// The dashboard's Proxy tab calls these; the server forwards to the extension
// so the browser never needs to know about :1338 directly. If the extension
// isn't running, these degrade gracefully (503 / empty SSE).
const BURP_EXT_API = process.env.BURP_EXT_API || 'http://127.0.0.1:1338';
app.get('/api/proxy/detail', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const upstream = await fetch(`${BURP_EXT_API}/proxy/detail?id=${encodeURIComponent(id)}`);
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'not found' });
    res.json(await upstream.json());
  } catch {
    res.status(503).json({ error: 'burp extension unreachable at :1338' });
  }
});
app.get('/api/proxy/metrics', async (req, res) => {
  // v3.1 — per-agent proxy metrics passthrough.
  const qs = new URLSearchParams();
  if (req.query.window) qs.set('window', String(req.query.window));
  try {
    const upstream = await fetch(`${BURP_EXT_API}/proxy/metrics?${qs}`);
    if (!upstream.ok) return res.status(upstream.status).json({ agents: [] });
    res.json(await upstream.json());
  } catch {
    res.status(503).json({ error: 'burp extension unreachable at :1338', agents: [] });
  }
});
app.get('/api/proxy/history', async (req, res) => {
  const qs = new URLSearchParams();
  if (req.query.since) qs.set('since', String(req.query.since));
  if (req.query.limit) qs.set('limit', String(req.query.limit));
  try {
    const upstream = await fetch(`${BURP_EXT_API}/proxy/history?${qs}`);
    if (!upstream.ok) return res.status(upstream.status).json([]);
    const rows = await upstream.json();
    res.json(rows);
  } catch {
    res.status(503).json({ error: 'burp extension unreachable at :1338' });
  }
});
// v3.1 — Request replay. Fires an HTTP request through Burp proxy so it lands
// in history with the provided agent tag; returns the response inline.
// Body: { method, url, headers: {..}, body?: string, agentTag?: string, timeoutMs? }
app.post('/api/proxy/replay', async (req, res) => {
  const { method = 'GET', url, headers = {}, body = null, agentTag = 'replay', timeoutMs = 15000 } =
    req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid http(s) url required' });
  // Forbid replay to loopback / localhost — prevents accidentally re-sending
  // dashboard/gateway/ollama traffic through Burp and muddying attribution.
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
      return res.status(400).json({ error: 'refusing replay to loopback' });
    }
  } catch { return res.status(400).json({ error: 'invalid url' }); }

  const undici = (() => { try { return require('undici'); } catch { return null; } })();
  const ProxyAgent = undici?.ProxyAgent;
  const proxyUrl = process.env.GLADOS_REPLAY_PROXY || 'http://127.0.0.1:8080';
  const dispatcher = ProxyAgent
    ? new ProxyAgent({
      uri: proxyUrl,
      // Replay intentionally talks through Burp, which resigns upstream TLS
      // with the local PortSwigger CA. Some operator shells do not export that
      // CA into Node, so tolerate Burp's interception cert for this endpoint.
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
  // Pipe SSE from the extension to the browser. Emit dashboard-side comments
  // immediately and on an interval so the Proxy tab can show "live" even when
  // Burp has no request events to forward yet.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`: dashboard proxy stream open\n\n`);
  let upstream, aborted = false;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    if (!aborted && !res.destroyed) res.write(`: dashboard heartbeat ${Date.now()}\n\n`);
  }, 15000);
  req.on('close', () => { aborted = true; controller.abort(); clearInterval(heartbeat); });
  try {
    upstream = await fetch(`${BURP_EXT_API}/proxy/stream`, { signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      res.write(`: upstream unreachable\n\n`);
      return res.end();
    }
    res.write(`: upstream connected\n\n`);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    if (!aborted) res.write(`: upstream error\n\n`);
  } finally {
    clearInterval(heartbeat);
  }
  res.end();
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

// Serves the standalone Mermaid flow diagram for the About tab iframe.
app.get('/api/flow-diagram', (req, res) => {
  const p = path.resolve(__dirname, '..', 'glados-flow-diagram.html');
  res.sendFile(p, err => { if (err) res.status(404).send('flow diagram not found'); });
});

// Restarts the OpenClaw Gateway service via `openclaw daemon restart`.
app.post('/api/gateway/restart', (req, res) => {
  const { execFile } = require('node:child_process');
  const { OPENCLAW_BIN } = require('./lib/config');
  execFile(OPENCLAW_BIN, ['daemon', 'restart'], { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: err.message, stderr: stderr?.toString() });
    const rawStream = truncateRawStream();
    broadcastLobby('gateway-restart', { ok: true, rawStream });
    res.json({ ok: true, stdout: stdout?.toString(), stderr: stderr?.toString(), rawStream });
  });
});

// Archives the current session JSONL so the agent's next turn starts fresh.
// When agentId === 'glados', cascades to every assessment agent AND wipes the
// blackboard (engagements, findings, tasks, plans, recon state) — a glados
// reset means a new investigation, and findings from a prior target must not
// bleed into the next one. Evidence files and exported reports on the
// filesystem are intentionally untouched.
app.post('/api/agents/:id/reset-session', (req, res) => {
  const agentId = req.params.id;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ids = agentId === 'glados' ? assessmentAgentIds() : [agentId];
    const results = ids.map(id => {
      try { return resetAgentSession(id, ts); }
      catch (e) { return { ok: false, agentId: id, error: e.message }; }
    });
    const failed = results.filter(r => !r.ok);
    if (failed.length) return res.status(500).json({ ok: false, agentId, cascade: agentId === 'glados', results });

    let blackboard = null;
    let memories = null;
    let archivePrune = null;
    let agentDirSync = null;
    let rawStream = null;
    if (agentId === 'glados') {
      pendingGladosKickoff = null;
      pendingGladosTargetRequest = null;
      blackboard = wipeBlackboard();
      memories = wipeAgentMemories();
      archivePrune = pruneArchivedSessions();
      agentDirSync = syncAgentDirIdentities();
      rawStream = truncateRawStream();
      broadcastLobby('blackboard-wiped', blackboard);
      broadcastLobby('memories-wiped', memories);
      broadcastLobby('archives-pruned', archivePrune);
      broadcastLobby('raw-stream-truncated', rawStream);
    }

    const primary = results.find(r => r.agentId === agentId) || results[0];
    res.json({
      ok: true,
      agentId,
      archivedPath: primary?.archivedPath || null,
      cascade: agentId === 'glados',
      resetCount: results.length,
      results,
      blackboard,
      memories,
      archivePrune,
      agentDirSync,
      rawStream,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- Agent details + model update (Settings) ---
app.get('/api/agents/:id/details', (req, res) => {
  const d = agentDetails.agentDetails(req.params.id);
  if (!d) return res.status(404).json({ error: 'agent not found' });
  res.json(d);
});
app.get('/api/models', async (req, res) => {
  res.json({ models: await agentDetails.listKnownModels() });
});
app.post('/api/agents/:id/model', (req, res) => {
  try {
    const result = agentDetails.updateAgentModel(req.params.id, String(req.body?.model || ''));
    broadcastLobby('agent-model-changed', result);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// --- Slash commands metadata for the chat autocomplete ---
app.get('/api/slash-commands', (req, res) => {
  res.json({
    commands: [
      { cmd: '/help', desc: 'List dashboard slash commands' },
      { cmd: '/agents', desc: 'Show live subagents (curl /api/agents)' },
      { cmd: '/halt <agent>', desc: 'Halt a single agent (writes deny rule + burp-gate halt-agent)' },
      { cmd: '/halt-all', desc: 'Engagement-wide halt (Burp scope drop-all + deny-all)' },
      { cmd: '/resume <agent>', desc: 'Resume a halted agent' },
      { cmd: '/probe <url>', desc: 'Run watchdog target_probe against a URL' },
      { cmd: '/breaker', desc: 'Show circuit-breaker status' },
      { cmd: '/clear', desc: 'Clear the current transcript view (local only)' },
    ],
  });
});

app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, activeAgents: watcher.activeAgents().length });
});

// v3.1 — Burp + patch-integrity sentinel written by the tag-injector preload.
// Dashboard polls every 5s and renders a red banner if `healthy` is false.
app.get('/api/health/burp', (req, res) => {
  const p = path.join(require('node:os').homedir(), '.openclaw/logs/tag-injector-health.json');
  try {
    const raw = require('node:fs').readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const stale = Date.now() - data.ts > 180_000; // older than 3× probe interval
    res.json({ ...data, stale });
  } catch (e) {
    res.status(503).json({
      healthy: false,
      error: 'sentinel not available — tag-injector not loaded?',
      hint: 'Check NODE_OPTIONS on the gateway plist; restart gateway.',
    });
  }
});

// v3.1 — Re-apply the openclaw bundle patches from the dashboard (Help tab
// "Re-apply patches" button). Runs tools/patch-openclaw-bundle.sh and returns
// stdout/stderr so the operator can see the result.
app.post('/api/health/burp/reapply-patches', (req, res) => {
  const { execFile } = require('node:child_process');
  const script = path.resolve(__dirname, '..', 'tools/patch-openclaw-bundle.sh');
  execFile('bash', [script], { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: err.message, stdout: stdout?.toString(), stderr: stderr?.toString() });
    broadcastLobby('patches-reapplied', { ok: true });
    res.json({ ok: true, stdout: stdout?.toString(), stderr: stderr?.toString() });
  });
});

// v3.1 Tier 2 — Getting Started "Validate this step" endpoints.
// Each returns { ok: true|false, detail: '...', hint?: '...' }.
app.get('/api/validate/:step', async (req, res) => {
  const { execFile } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const step = req.params.step;

  const run = (cmd, args, timeoutMs = 5000) => new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

  try {
    if (step === 'burp-ca') {
      const r = await run('security', ['find-certificate', '-c', 'PortSwigger CA', '/Library/Keychains/System.keychain']);
      if (r.code === 0 && /PortSwigger/i.test(r.stdout)) return res.json({ ok: true, detail: 'PortSwigger CA trusted in System.keychain' });
      return res.json({ ok: false, detail: 'PortSwigger CA not found in System.keychain', hint: 'Re-run step 1.4 — export CA from Burp and security add-trusted-cert.' });
    }
    if (step === 'burp-proxy') {
      const r = await run('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', 'http://127.0.0.1:8080', '--max-time', '4', 'http://example.com']);
      const code = Number((r.stdout || '').trim());
      if (code >= 200 && code < 600) return res.json({ ok: true, detail: `proxy alive → example.com → ${code}` });
      return res.json({ ok: false, detail: 'curl through 127.0.0.1:8080 failed', hint: 'Launch Burp Pro and confirm Proxy listener on :8080.' });
    }
    if (step === 'burp-ext') {
      try {
        const r = await fetch('http://127.0.0.1:1338/health', { signal: AbortSignal.timeout(3000) });
        if (r.ok) { const j = await r.json().catch(() => ({})); return res.json({ ok: true, detail: `extension healthy: ${JSON.stringify(j).slice(0,200)}` }); }
        return res.json({ ok: false, detail: `extension returned HTTP ${r.status}`, hint: 'Re-install glados-proxy-api jar in Burp Extensions.' });
      } catch (e) { return res.json({ ok: false, detail: 'no response on :1338', hint: 'Burp closed or extension not loaded — see step 1.6.' }); }
    }
    if (step === 'burp-rest') {
      try {
        const r = await fetch('http://127.0.0.1:1337/v0.1/', { signal: AbortSignal.timeout(3000) });
        if (r.status < 500) return res.json({ ok: true, detail: `Burp native REST reachable (HTTP ${r.status})` });
        return res.json({ ok: false, detail: `Burp REST returned ${r.status}`, hint: 'Enable REST API: Settings → Suite → REST API.' });
      } catch (e) { return res.json({ ok: false, detail: 'no response on :1337', hint: 'Enable Burp REST API at :1337 (loopback, no key).' }); }
    }
    if (step === 'dashboard') {
      return res.json({ ok: true, detail: 'dashboard is responding — you just hit it' });
    }
    if (step === 'gateway') {
      // On some workstations the OpenClaw status probe takes >5s while the
      // daemon is healthy, especially right after a restart.
      const r = await run('/usr/local/bin/openclaw', ['daemon', 'status'], 15000);
      if (r.code === 0 && /running/i.test(r.stdout)) return res.json({ ok: true, detail: 'openclaw daemon: running' });
      // Fallback — try homebrew bin path
      const r2 = await run('/opt/homebrew/bin/openclaw', ['daemon', 'status'], 15000);
      if (r2.code === 0 && /running/i.test(r2.stdout)) return res.json({ ok: true, detail: 'openclaw daemon: running' });
      return res.json({ ok: false, detail: 'openclaw daemon not running', hint: 'Run `openclaw daemon start` or click Restart gateway.' });
    }
    if (step === 'patches') {
      const distDir = path.join(os.homedir(), '../../opt/homebrew/lib/node_modules/openclaw/dist');
      const resolved = path.resolve(distDir);
      const scan = (marker) => {
        try {
          const files = fs.readdirSync(resolved).filter(f => f.endsWith('.js'));
          for (const f of files) {
            const txt = fs.readFileSync(path.join(resolved, f), 'utf8');
            if (txt.includes(marker)) return f;
          }
        } catch {}
        return null;
      };
      const alsFile = scan('GLADOS_ALS_PATCH_V1');
      const ssrfV2File = scan('GLADOS_SSRF_ROUTE_V2');
      const ssrfV1File = ssrfV2File ? null : scan('GLADOS_SSRF_ROUTE_V1');
      const ssrfFile = ssrfV2File || ssrfV1File;
      const ssrfVersion = ssrfV2File ? 'v2' : (ssrfV1File ? 'v1' : 'missing');
      const planGateFile = scan('GLADOS_PLAN_GATE_V2') || scan('GLADOS_PLAN_GATE_V1');
      if (alsFile && ssrfFile && planGateFile) {
        return res.json({
          ok: true,
          detail: `ALS marker in ${alsFile}, SSRF ${ssrfVersion} marker in ${ssrfFile}, plan-gate marker in ${planGateFile}`,
          patches: {
            als: { ok: true, file: alsFile },
            ssrf: { ok: true, file: ssrfFile, version: ssrfVersion },
            planGate: { ok: true, file: planGateFile },
          },
        });
      }
      return res.json({
        ok: false,
        detail: `missing markers — ALS:${alsFile ? 'ok' : 'MISSING'} SSRF:${ssrfFile ? ssrfVersion : 'MISSING'} PLAN_GATE:${planGateFile ? 'ok' : 'MISSING'}`,
        hint: 'Re-run `bash tools/patch-openclaw-bundle.sh`, then Restart gateway.',
      });
    }
    if (step === 'watchdog-mcp') {
      const r = await run('/opt/homebrew/bin/openclaw', ['mcp', 'list'], 5000);
      const out = (r.stdout || '') + (r.stderr || '');
      if (/watchdog/i.test(out)) return res.json({ ok: true, detail: 'watchdog MCP registered' });
      return res.json({ ok: false, detail: 'watchdog MCP not listed', hint: 'Check ~/.openclaw/openclaw.json mcpServers block.' });
    }
    if (step === 'tag-injector') {
      const p = path.join(os.homedir(), '.openclaw/logs/tag-injector-health.json');
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const stale = Date.now() - data.ts > 180_000;
        if (data.healthy && !stale) return res.json({ ok: true, detail: `sentinel healthy · age ${((Date.now() - data.ts)/1000).toFixed(0)}s` });
        return res.json({ ok: false, detail: stale ? 'sentinel is stale' : 'sentinel reports unhealthy', hint: 'Restart gateway; see Help tab Re-apply patches.' });
      } catch { return res.json({ ok: false, detail: 'no sentinel found', hint: 'Gateway not running or NODE_OPTIONS missing preload.' }); }
    }
    return res.status(400).json({ ok: false, error: 'unknown validation step: ' + step });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v3.1 — Plan-approval workflow endpoints (see routes/plans.js).
app.use('/api/plans', require('./routes/plans')(broadcastLobby));

// Circuit breaker — polls Burp proxy history; on trip, broadcast to lobby.
const breaker = new CircuitBreaker({
  intervalMs: 5000,
  onTrip: info => broadcastLobby('breaker-trip', info),
}).start();

// v3.1.04252026 (Blocker E) — Replan-proposal watcher.
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
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dbPath = path.resolve(__dirname, '..', 'blackboard', 'blackboard.db');
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GLaDOS Ops Dashboard on http://localhost:${PORT}`);
});

function shutdown() { try { watcher.stop(); breaker.stop(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
