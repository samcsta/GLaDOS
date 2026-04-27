// v3.1.04242026 — Hard plan-approval dispatch gate.
//
// Before v3.1, the "no exploitation before plan approval" rule lived only in
// SOUL.md as a prompt-enforced invariant (I1-I4). This module turns the rule
// into a deterministic tool: plan_check_dispatch(agent_id, engagement_id?)
// returns whether the agent is allowed to dispatch right now, based on the
// approved plan row in the blackboard.
//
// Classification:
//   - PHASE1_AGENTS: always allowed (they only produce the summary card + plan).
//   - EXPLOITATION_AGENTS: require an approved plan AND membership in its
//     agent_chain (or in proposed_vectors.agents).
//   - META_AGENTS: always allowed (supervisor, validators, report-writer).
//
// The read uses a read-only, best-effort connection to blackboard.db. If the
// DB is unavailable we default to deny for exploitation agents (fail-closed
// for the dangerous class) and allow for phase-1/meta.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const GLADOS_RUNTIME_DIR = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados');
const BLACKBOARD_DB = process.env.BLACKBOARD_DB ||
  path.join(GLADOS_RUNTIME_DIR, 'blackboard', 'blackboard.db');

const PHASE1_AGENTS = new Set([
  'osint', 'origin-ip', 'net-recon', 'webapp-recon',
  'source-code', 'plan-synthesizer', 'js-reverser',
  'mobile-api-recon',
]);
const EXPLOITATION_AGENTS = new Set([
  'webapp-vuln', 'poc-coder', 'postex', 'ad-expert',
  'phisherman', 'api-expert', 'c2-builder', 'data-exfil',
  'graphql-specialist', 'cloud-exposure',
]);
const META_AGENTS = new Set([
  'glados', 'atlas', 'ai-specialist',
  'report-writer', 'report-validator',
  'webapp-validator', 'api-validator', 'poc-validator',
  'postex-validator', 'ad-validator', 'c2-validator',
  'phish-validator', 'evidence-curator', 'scope-guardian',
]);

let dbHandle = null;
function getDb() {
  if (dbHandle) return dbHandle;
  if (!fs.existsSync(BLACKBOARD_DB)) return null;
  try {
    dbHandle = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    dbHandle.pragma('journal_mode = WAL');
    return dbHandle;
  } catch {
    return null;
  }
}

// Look up the "current" engagement when the caller didn't pass one.
// Preference: most recently started active engagement. Status values are
// application-defined ('active' is the default per the schema).
function currentEngagementId(db) {
  try {
    const row = db.prepare(
      "SELECT id FROM engagements WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get();
    return row?.id || null;
  } catch { return null; }
}

// Latest approved plan for an engagement.
function latestApprovedPlan(db, engagementId) {
  try {
    return db.prepare(
      "SELECT id, plan_json, approved_at FROM plans " +
      "WHERE engagement_id = ? AND state = 'approved' " +
      "ORDER BY approved_at DESC LIMIT 1"
    ).get(engagementId);
  } catch { return null; }
}

// agent_chain format:  [{ agent: 'webapp-vuln', ... }, ...]  or  ['webapp-vuln', ...]
// proposed_vectors format: [{ agents: [...], cwe: ... }, ...]
function agentsApprovedByPlan(planJson) {
  const agents = new Set();
  try {
    const p = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
    for (const step of (p.agent_chain || [])) {
      if (typeof step === 'string') agents.add(step);
      else if (step && step.agent) agents.add(step.agent);
    }
    for (const v of (p.proposed_vectors || [])) {
      for (const a of (v.agents || [])) agents.add(a);
    }
  } catch {}
  return agents;
}

// The public tool. Returns:
//   { allowed, reason, phase, engagement_id?, plan_id?, approved_agents? }
function planCheckDispatch(agentId, engagementId) {
  if (!agentId || typeof agentId !== 'string') {
    return { allowed: false, reason: 'missing agent_id', phase: 'unknown' };
  }

  if (META_AGENTS.has(agentId)) {
    return { allowed: true, reason: 'meta agent — always permitted', phase: 'meta' };
  }
  if (PHASE1_AGENTS.has(agentId)) {
    return { allowed: true, reason: 'phase 1 recon — always permitted (SOUL I3)', phase: 'phase1' };
  }
  if (!EXPLOITATION_AGENTS.has(agentId)) {
    // Unknown agent: treat like exploitation-class to be safe, but flag it.
    // Unknown names should never silently pass the gate.
    return { allowed: false, reason: `unknown agent_id '${agentId}' — refusing by default`, phase: 'unknown' };
  }

  // Exploitation class — requires approved plan.
  const db = getDb();
  if (!db) {
    return {
      allowed: false,
      reason: 'blackboard db unavailable — fail closed for exploitation agent',
      phase: 'exploitation',
    };
  }

  const engId = engagementId || currentEngagementId(db);
  if (!engId) {
    return {
      allowed: false,
      reason: 'no active engagement on blackboard',
      phase: 'exploitation',
    };
  }

  const plan = latestApprovedPlan(db, engId);
  if (!plan) {
    return {
      allowed: false,
      reason: `no approved plan for engagement '${engId}' (SOUL I1)`,
      phase: 'exploitation',
      engagement_id: engId,
    };
  }

  const approved = agentsApprovedByPlan(plan.plan_json);
  if (!approved.has(agentId)) {
    return {
      allowed: false,
      reason: `agent '${agentId}' not in approved agent_chain of plan ${plan.id}`,
      phase: 'exploitation',
      engagement_id: engId,
      plan_id: plan.id,
      approved_agents: [...approved],
    };
  }

  return {
    allowed: true,
    reason: 'approved plan includes agent',
    phase: 'exploitation',
    engagement_id: engId,
    plan_id: plan.id,
    approved_agents: [...approved],
  };
}

module.exports = {
  planCheckDispatch,
  PHASE1_AGENTS,
  EXPLOITATION_AGENTS,
  META_AGENTS,
};
