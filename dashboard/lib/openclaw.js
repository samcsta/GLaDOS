const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AGENTS_DIR, OPENCLAW_JSON, OPENCLAW_BIN } = require('./config');

function loadAgentRegistry() {
  try {
    const raw = fs.readFileSync(OPENCLAW_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.agents?.list || [];
  } catch (e) {
    return [];
  }
}

function listAgentIds() {
  try {
    return fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    return [];
  }
}

function readSessionsIndex(agentId) {
  const p = path.join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

const LIVE_MTIME_MS = 2 * 60 * 1000; // session JSONL touched within 2 min = live

function sessionSnapshot(agentId, key, entry) {
  if (!entry) return null;
  const sessionFile = entry.sessionFile;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(sessionFile).mtimeMs; } catch {}
  const endedAtMs = typeof entry.endedAt === 'number' ? entry.endedAt : 0;
  const fresh = mtimeMs > 0 && (Date.now() - mtimeMs) < LIVE_MTIME_MS;
  const statusRunning = entry.status === 'running';
  const cleanlyEnded = endedAtMs > 0 && (!entry.startedAt || endedAtMs >= entry.startedAt);

  // Treat as live only if status says running AND there's no completed endedAt AND
  // the JSONL has been touched recently. sessions.json leaves status="running" on
  // dirty exits so we can't trust it alone.
  const live = statusRunning && !cleanlyEnded && fresh;

  return {
    agentId,
    sessionKey: key,
    sessionId: entry.sessionId,
    sessionFile,
    status: entry.status,
    live,
    abortedLastRun: !!entry.abortedLastRun,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    mtimeMs,
    model: entry.model,
    modelProvider: entry.modelProvider,
    runtime: key.includes(':subagent:') ? 'subagent' : 'main',
  };
}

function currentSessionForAgent(agentId) {
  const idx = readSessionsIndex(agentId);
  if (!idx) return null;
  const snapshots = Object.entries(idx)
    .filter(([key]) => key === `agent:${agentId}:main` || key.startsWith(`agent:${agentId}:subagent:`))
    .map(([key, entry]) => sessionSnapshot(agentId, key, entry))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.mtimeMs || b.startedAt || 0) - (a.mtimeMs || a.startedAt || 0);
    });
  return snapshots[0] || null;
}

function sessionsDir(agentId) {
  return path.join(AGENTS_DIR, agentId, 'sessions');
}

// execFile timeout must be long enough to cover a whole agent turn, including
// any tool calls, subagent dispatches, and the LLM synthesis step. 60s was way
// too short — it produced spurious "Command failed" rejections on the
// dashboard even though the agent was still working and its reply eventually
// landed in the transcript SSE stream. We now cap at 15 minutes; if the
// upstream LLM proxy idle-times-out (currently 60s on llmapi.redteamstuff.com)
// openclaw itself will close cleanly with a prompt-error, well before this.
const OPENCLAW_AGENT_TIMEOUT_MS = Number(process.env.OPENCLAW_AGENT_TIMEOUT_MS) || 15 * 60 * 1000;

function sendMessageToAgent(agentId, message) {
  return new Promise((resolve, reject) => {
    execFile(
      OPENCLAW_BIN,
      ['agent', '--agent', agentId, '--message', message, '--json'],
      { timeout: OPENCLAW_AGENT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr?.toString();
          err.stdout = stdout?.toString();
          return reject(err);
        }
        let parsed = null;
        try { parsed = JSON.parse(stdout); } catch {}
        resolve(parsed || { raw: stdout?.toString() });
      }
    );
  });
}

module.exports = {
  loadAgentRegistry,
  listAgentIds,
  readSessionsIndex,
  sessionSnapshot,
  currentSessionForAgent,
  sessionsDir,
  sendMessageToAgent,
};
