const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EXEC_APPROVALS_FILE, NETWORK_TOOL_NAMES, BURP_GATE_SH, OPENCLAW_HOME } = require('./config');
const { db } = require('./db');

// v3.1: enumerate every agent registered in openclaw config. Used by
// engagementHaltAll so a global halt writes a deny row per agent, not just a
// burp-gate flip. The openclaw config layout is `agents.list[]` with either
// `id` or `agentId` fields; we read it best-effort and fall back to the empty
// list, so a malformed/missing config degrades to the old behavior rather
// than throwing during halt-all.
function listRegisteredAgentIds() {
  try {
    const raw = fs.readFileSync(path.join(OPENCLAW_HOME, 'openclaw.json'), 'utf8');
    const d = JSON.parse(raw);
    const list = d?.agents?.list;
    if (!Array.isArray(list)) return [];
    return list
      .map(a => (a && (a.id || a.agentId || a.name)) || null)
      .filter(Boolean);
  } catch { return []; }
}

function readApprovals() {
  try { return JSON.parse(fs.readFileSync(EXEC_APPROVALS_FILE, 'utf8')); }
  catch { return { version: 1, defaults: {}, agents: {} }; }
}

function writeApprovals(obj) {
  const tmp = EXEC_APPROVALS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, EXEC_APPROVALS_FILE);
}

function addAgentDenyRules(agentId, reason) {
  const data = readApprovals();
  data.agents = data.agents || {};
  data.agents[agentId] = data.agents[agentId] || {};
  data.agents[agentId].denied = data.agents[agentId].denied || {};
  const mark = { by: 'watchdog', reason: reason || 'halted', at: Date.now() };
  for (const tool of NETWORK_TOOL_NAMES) {
    data.agents[agentId].denied[tool] = mark;
  }
  writeApprovals(data);
}

function removeAgentDenyRules(agentId) {
  const data = readApprovals();
  if (data.agents && data.agents[agentId] && data.agents[agentId].denied) {
    for (const tool of NETWORK_TOOL_NAMES) delete data.agents[agentId].denied[tool];
    if (Object.keys(data.agents[agentId].denied).length === 0) delete data.agents[agentId].denied;
    if (Object.keys(data.agents[agentId]).length === 0) delete data.agents[agentId];
  }
  writeApprovals(data);
}

function runBurpGate(action, arg) {
  return new Promise(resolve => {
    execFile(BURP_GATE_SH, [action, ...(arg ? [arg] : [])], { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
    });
  });
}

async function agentHalt(agentId, reason, { initiator = 'watchdog' } = {}) {
  addAgentDenyRules(agentId, reason);
  const burp = await runBurpGate('halt-agent', agentId);
  db.prepare(`INSERT INTO halt_log (agent_id, reason, initiator, action, at) VALUES (?, ?, ?, 'halt', ?)`)
    .run(agentId, reason || null, initiator, Date.now());
  return { ok: true, agentId, reason, burp };
}

async function agentResume(agentId, { initiator = 'watchdog' } = {}) {
  removeAgentDenyRules(agentId);
  const burp = await runBurpGate('resume-agent', agentId);
  db.prepare(`INSERT INTO halt_log (agent_id, initiator, action, at) VALUES (?, ?, 'resume', ?)`)
    .run(agentId, initiator, Date.now());
  return { ok: true, agentId, burp };
}

async function engagementHaltAll(engagementId, reason, { initiator = 'watchdog' } = {}) {
  // v3.1: halt-all was previously only a burp-gate flip + log row, which left
  // a gap where an agent mid-call could still hit network tools because the
  // deny map was never updated. Now we enumerate every registered agent and
  // add deny rules for each, in addition to the burp flip.
  const agentIds = listRegisteredAgentIds();
  const haltedAgents = [];
  for (const agentId of agentIds) {
    try {
      addAgentDenyRules(agentId, reason || 'halt-all');
      haltedAgents.push(agentId);
    } catch (e) {
      // Keep going on per-agent failures; we want halt-all to be best-effort.
    }
  }
  const burp = await runBurpGate('halt-all');
  db.prepare(`INSERT INTO halt_log (engagement_id, reason, initiator, action, at) VALUES (?, ?, ?, 'halt-all', ?)`)
    .run(engagementId || null, reason || null, initiator, Date.now());
  return { ok: true, engagementId, reason, burp, haltedAgents };
}

// v3.1: counterpart to engagementHaltAll — clears deny rules for every agent
// that the halt-all added. Callable via /api/resume-all.
async function engagementResumeAll({ initiator = 'watchdog' } = {}) {
  const agentIds = listRegisteredAgentIds();
  const resumed = [];
  for (const agentId of agentIds) {
    try { removeAgentDenyRules(agentId); resumed.push(agentId); } catch {}
  }
  const burp = await runBurpGate('resume-all');
  db.prepare(`INSERT INTO halt_log (initiator, action, at) VALUES (?, 'resume-all', ?)`)
    .run(initiator, Date.now());
  return { ok: true, burp, resumed };
}

function agentStatus(agentId) {
  const data = readApprovals();
  const denied = data.agents?.[agentId]?.denied || null;
  const lastHaltRow = db.prepare(`SELECT * FROM halt_log WHERE agent_id = ? ORDER BY at DESC LIMIT 1`).get(agentId);
  return { agentId, haltActive: !!denied, denied, lastAction: lastHaltRow };
}

module.exports = {
  agentHalt, agentResume, engagementHaltAll, engagementResumeAll, agentStatus,
  addAgentDenyRules, removeAgentDenyRules, readApprovals,
  listRegisteredAgentIds,
};
