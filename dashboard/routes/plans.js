// GLaDOS v3.1 — Plans & plan-approval REST endpoints.
// Wraps the blackboard `plans` + `plan_approvals` tables with a small Express
// router. Mounted from server.js as `app.use('/api/plans', require('./routes/plans')(broadcastLobby))`.
//
// Endpoints:
//   GET    /api/plans                  — list (optionally filter by ?engagement_id= or ?state=)
//   GET    /api/plans/:id              — single plan with its approval history
//   POST   /api/plans                  — create (plan-synthesizer output) → state=pending_approval
//   POST   /api/plans/:id/approve      — body: {vectors?: [cwe...], operator?, reason?} → state=approved
//   POST   /api/plans/:id/modify       — body: {plan_json, reason?} → creates child plan, old → superseded
//   POST   /api/plans/:id/reject       — body: {reason} → state=rejected
//   POST   /api/plans/:id/complete     — state=complete
//
// Every state-changing call emits a lobby SSE event so the dashboard re-renders.

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');

// v3.1 Tier 2 — Derive a per-agent fetch ACL from an approved plan's recon
// summary + agent_chain. Writes $OPENCLAW_HOME/glados-fetch-acl.json with a strict
// allow-list: Phase 1 agents keep their canonical OSINT surface; exploitation
// agents (those in agent_chain) are scoped to target hostnames discovered in
// recon. tag-injector picks up the new file within ~1s (mtime-cached).
const ACL_PATH = path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'), 'glados-fetch-acl.json');
const PHASE1_SURFACES = {
  osint:         ['*.shodan.io','*.censys.io','crt.sh','*.crt.sh','api.github.com','*.github.com','archive.org','web.archive.org','*.virustotal.com'],
  'origin-ip':   ['*.shodan.io','*.censys.io','*.fofa.info','dns.google','cloudflare-dns.com'],
  'net-recon':   ['dns.google','cloudflare-dns.com'],
  'webapp-recon':[], // gets target hosts
  'source-code': ['api.github.com','*.github.com','gitlab.com','*.gitlab.com'],
  'js-reverser': [],
  'mobile-api-recon': [],
  'evidence-curator': [],
  'scope-guardian': [],
};
function extractTargetHosts(plan) {
  const hosts = new Set();
  const rs = plan?.recon_summary || {};
  if (rs.target) hosts.add(String(rs.target).toLowerCase());
  if (rs.dns?.a) for (const a of rs.dns.a) hosts.add(String(a).toLowerCase());
  if (rs.dns?.cname_chain) for (const c of rs.dns.cname_chain) hosts.add(String(c).toLowerCase());
  if (rs.tls?.san) for (const s of rs.tls.san) hosts.add(String(s).toLowerCase());
  return [...hosts].filter(Boolean);
}
function buildAclFromPlan(plan) {
  const agents = {};
  for (const [a, surface] of Object.entries(PHASE1_SURFACES)) agents[a] = { allow: surface.slice() };
  const targetHosts = extractTargetHosts(plan);
  if (targetHosts.length) {
    agents['webapp-recon'] = { allow: targetHosts };
    // Wildcards: if target is `example.com`, also allow `*.example.com`.
    const wildcards = targetHosts.filter(h => !h.startsWith('*.')).map(h => '*.' + h);
    const expanded = [...new Set([...targetHosts, ...wildcards])];
    for (const a of (plan?.agent_chain || [])) {
      if (PHASE1_SURFACES[a]) continue; // don't overwrite Phase 1 surface
      agents[a] = { allow: expanded };
    }
  }
  return {
    version: 1,
    enabled: true,
    default: 'deny',
    generated: { at: new Date().toISOString(), engagement_id: plan.engagement_id, plan_id: plan.id },
    agents,
  };
}
function writeAclSafe(acl) {
  try {
    fs.mkdirSync(path.dirname(ACL_PATH), { recursive: true });
    // Backup existing first.
    if (fs.existsSync(ACL_PATH)) {
      try { fs.copyFileSync(ACL_PATH, ACL_PATH + '.bak'); } catch {}
    }
    fs.writeFileSync(ACL_PATH, JSON.stringify(acl, null, 2));
    return { ok: true, path: ACL_PATH };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const DB_PATH = path.resolve(
  process.env.BLACKBOARD_DB || path.join(os.homedir(), '.glados', 'blackboard', 'blackboard.db')
);

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function validatePlanJson(raw) {
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return { ok: false, error: 'plan_json is not valid JSON: ' + e.message }; }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'plan must be an object' };
  if (!obj.engagement_id) return { ok: false, error: 'plan.engagement_id required' };
  if (!Array.isArray(obj.proposed_vectors) || obj.proposed_vectors.length === 0)
    return { ok: false, error: 'plan.proposed_vectors must be a non-empty array' };
  if (!Array.isArray(obj.agent_chain)) return { ok: false, error: 'plan.agent_chain must be an array' };
  for (const v of obj.proposed_vectors) {
    if (!/^CWE-\d+$/.test(String(v.cwe || ''))) return { ok: false, error: `vector.cwe invalid: ${v.cwe}` };
    if (!v.rationale) return { ok: false, error: `vector ${v.cwe} missing rationale` };
    if (!['low','medium','high'].includes(v.risk_to_target))
      return { ok: false, error: `vector ${v.cwe} risk_to_target must be low|medium|high` };
    if (typeof v.confidence_pre !== 'number' || v.confidence_pre < 0 || v.confidence_pre > 1)
      return { ok: false, error: `vector ${v.cwe} confidence_pre out of range` };
  }
  return { ok: true, plan: obj };
}

module.exports = function makeRouter(broadcastLobby) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const db = openDb();
    try {
      const where = [];
      const args = [];
      if (req.query.engagement_id) { where.push('engagement_id = ?'); args.push(req.query.engagement_id); }
      if (req.query.state) { where.push('state = ?'); args.push(req.query.state); }
      const sql = `SELECT id, engagement_id, version, state, parent_plan_id, replan_reason,
        created_at, approved_at, rejected_at, completed_at FROM plans
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT 200`;
      res.json({ plans: db.prepare(sql).all(...args) });
    } finally { db.close(); }
  });

  router.get('/:id', (req, res) => {
    const db = openDb();
    try {
      const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
      if (!plan) return res.status(404).json({ error: 'plan not found' });
      const approvals = db.prepare('SELECT * FROM plan_approvals WHERE plan_id = ? ORDER BY created_at ASC')
        .all(req.params.id);
      res.json({ plan, approvals });
    } finally { db.close(); }
  });

  router.post('/', (req, res) => {
    const check = validatePlanJson(req.body.plan_json || req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const plan = check.plan;
    const id = req.body.id || 'plan_' + crypto.randomBytes(6).toString('hex');
    const db = openDb();
    try {
      const parent = plan.parent_plan_id || null;
      // If replanning, mark the parent as superseded.
      if (parent) {
        db.prepare("UPDATE plans SET state='superseded' WHERE id = ? AND state IN ('pending_approval','approved','executing')")
          .run(parent);
      }
      const version = parent
        ? (db.prepare('SELECT version FROM plans WHERE id = ?').get(parent)?.version || 0) + 1
        : 1;
      db.prepare(`INSERT INTO plans
        (id, engagement_id, version, state, plan_json, recon_summary, parent_plan_id, replan_reason)
        VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?)`).run(
          id, plan.engagement_id, version,
          JSON.stringify(plan),
          plan.recon_summary ? JSON.stringify(plan.recon_summary) : null,
          parent, plan.replan_reason || null
        );
      broadcastLobby('plan-pending', { id, engagement_id: plan.engagement_id, version, parent_plan_id: parent });
      res.status(201).json({ id, state: 'pending_approval' });
    } finally { db.close(); }
  });

  // v3.1.04252026 (Blocker H) — Transactional plan approval.
  //
  // Old path:
  //   1) UPDATE plans SET state='approved'
  //   2) INSERT INTO plan_approvals
  //   3) Attempt ACL write → if it fails, plan is already approved and the
  //      next sessions_spawn passes the gate with NO ACL boundary in place.
  //      That's exactly the safety boundary v3.1 promised.
  //
  // New path:
  //   1) Build & write the ACL FIRST. If writeAcl=true and the write fails
  //      (disk full, perms, schema error), refuse the approval entirely with
  //      a 5xx — plan stays pending_approval.
  //   2) Only after the ACL is on disk do we open a write txn that flips
  //      state=approved + records plan_approvals. If that txn fails, we roll
  //      back the ACL to its prior contents from the .bak we wrote in step 1.
  //
  // writeAcl=false (operator-explicit override) skips the boundary entirely;
  // we record that in plan_approvals.notes so it shows up in audit.
  router.post('/:id/approve', (req, res) => {
    const { vectors, operator = 'operator', reason, writeAcl = true } = req.body || {};
    const decision = Array.isArray(vectors) && vectors.length ? 'approve_selected' : 'approve_all';
    const db = openDb();
    try {
      const row = db.prepare("SELECT id, state, plan_json, engagement_id FROM plans WHERE id = ?").get(req.params.id);
      if (!row) return res.status(404).json({ error: 'plan not found' });
      if (row.state !== 'pending_approval')
        return res.status(409).json({ error: `cannot approve plan in state=${row.state}` });

      // ----- Step 1: ACL write FIRST (before any plan-state changes) -----
      let aclResult = { ok: false, skipped: true };
      let aclBackupContents = null; // for rollback on txn failure
      if (writeAcl) {
        try {
          const planJson = JSON.parse(row.plan_json);
          planJson.id = row.id;
          planJson.engagement_id = row.engagement_id;
          const acl = buildAclFromPlan(planJson);
          if (Array.isArray(vectors) && vectors.length) {
            const approvedAgents = new Set(['osint','origin-ip','net-recon','webapp-recon','source-code','js-reverser','mobile-api-recon','evidence-curator','scope-guardian']);
            for (const v of (planJson.proposed_vectors || [])) {
              if (vectors.includes(v.cwe)) (v.agents || []).forEach(a => approvedAgents.add(a));
            }
            for (const a of Object.keys(acl.agents)) {
              if (!approvedAgents.has(a)) delete acl.agents[a];
            }
          }
          // Snapshot prior ACL (if any) for rollback.
          try { aclBackupContents = fs.existsSync(ACL_PATH) ? fs.readFileSync(ACL_PATH, 'utf8') : null; } catch { aclBackupContents = null; }
          aclResult = writeAclSafe(acl);
          if (!aclResult.ok) {
            return res.status(500).json({
              ok: false,
              error: 'ACL write failed; refusing to approve plan without ACL boundary',
              acl: aclResult,
              hint: 'Inspect ' + ACL_PATH + ' and parent dir; retry approval after fixing. To approve without an ACL set body.writeAcl=false (NOT recommended).',
            });
          }
        } catch (e) {
          return res.status(500).json({
            ok: false,
            error: 'ACL build/write threw: ' + e.message,
            hint: 'Plan stays pending_approval. Fix the underlying error and retry.',
          });
        }
      }

      // ----- Step 2: plan state change in a single SQLite txn -----
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare("UPDATE plans SET state='approved', approved_at=? WHERE id = ?").run(now, req.params.id);
        db.prepare(`INSERT INTO plan_approvals (plan_id, decision, approved_vectors, operator, reason, modifications)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
            req.params.id, decision,
            vectors ? JSON.stringify(vectors) : null,
            operator,
            (reason || null) + (writeAcl ? '' : ' [WARN: writeAcl=false; no ACL written]'),
            null
          );
      });
      try {
        tx();
      } catch (txErr) {
        // Roll back the ACL write so on-disk state matches DB state.
        if (writeAcl) {
          try {
            if (aclBackupContents !== null) fs.writeFileSync(ACL_PATH, aclBackupContents);
            else if (fs.existsSync(ACL_PATH)) fs.unlinkSync(ACL_PATH);
          } catch (rollbackErr) {
            return res.status(500).json({
              ok: false,
              error: 'plan-approve txn failed AND ACL rollback failed: ' + txErr.message + ' / ' + rollbackErr.message,
              hint: 'ACL on disk may be stale relative to DB. Inspect ' + ACL_PATH + ' manually.',
            });
          }
        }
        return res.status(500).json({ ok: false, error: 'plan-approve txn failed; ACL rolled back: ' + txErr.message });
      }

      broadcastLobby('plan-approved', { id: req.params.id, decision, vectors: vectors || null, acl: aclResult });
      res.json({ ok: true, state: 'approved', decision, acl: aclResult });
    } finally { db.close(); }
  });

  // Preview endpoint — returns the ACL that WOULD be written without approval.
  router.get('/:id/acl-preview', (req, res) => {
    const db = openDb();
    try {
      const row = db.prepare("SELECT id, plan_json, engagement_id FROM plans WHERE id = ?").get(req.params.id);
      if (!row) return res.status(404).json({ error: 'plan not found' });
      const plan = JSON.parse(row.plan_json);
      plan.id = row.id;
      plan.engagement_id = row.engagement_id;
      res.json(buildAclFromPlan(plan));
    } finally { db.close(); }
  });

  router.post('/:id/modify', (req, res) => {
    const check = validatePlanJson(req.body.plan_json);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const db = openDb();
    try {
      const parent = db.prepare('SELECT id, engagement_id, version FROM plans WHERE id = ?').get(req.params.id);
      if (!parent) return res.status(404).json({ error: 'plan not found' });
      const newId = 'plan_' + crypto.randomBytes(6).toString('hex');
      db.prepare("UPDATE plans SET state='superseded' WHERE id = ?").run(req.params.id);
      db.prepare(`INSERT INTO plans
        (id, engagement_id, version, state, plan_json, recon_summary, parent_plan_id, replan_reason)
        VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?)`).run(
          newId, parent.engagement_id, parent.version + 1,
          JSON.stringify(check.plan),
          check.plan.recon_summary ? JSON.stringify(check.plan.recon_summary) : null,
          req.params.id, req.body.reason || 'operator modification'
        );
      db.prepare(`INSERT INTO plan_approvals (plan_id, decision, modifications, operator, reason)
        VALUES (?, 'modify', ?, ?, ?)`).run(
          req.params.id, JSON.stringify(check.plan),
          req.body.operator || 'operator', req.body.reason || null
        );
      broadcastLobby('plan-modified', { old_id: req.params.id, new_id: newId });
      res.status(201).json({ ok: true, new_plan_id: newId, state: 'pending_approval' });
    } finally { db.close(); }
  });

  router.post('/:id/reject', (req, res) => {
    const { reason = '', operator = 'operator' } = req.body || {};
    const db = openDb();
    try {
      const plan = db.prepare("SELECT id, state FROM plans WHERE id = ?").get(req.params.id);
      if (!plan) return res.status(404).json({ error: 'plan not found' });
      if (plan.state !== 'pending_approval')
        return res.status(409).json({ error: `cannot reject plan in state=${plan.state}` });
      const now = new Date().toISOString();
      db.prepare("UPDATE plans SET state='rejected', rejected_at=? WHERE id = ?").run(now, req.params.id);
      db.prepare("INSERT INTO plan_approvals (plan_id, decision, operator, reason) VALUES (?, 'reject', ?, ?)")
        .run(req.params.id, operator, reason);
      broadcastLobby('plan-rejected', { id: req.params.id, reason });
      res.json({ ok: true, state: 'rejected' });
    } finally { db.close(); }
  });

  router.post('/:id/complete', (req, res) => {
    const db = openDb();
    try {
      const now = new Date().toISOString();
      const r = db.prepare("UPDATE plans SET state='complete', completed_at=? WHERE id = ? AND state IN ('approved','executing')")
        .run(now, req.params.id);
      if (!r.changes) return res.status(409).json({ error: 'plan not in approved/executing state' });
      broadcastLobby('plan-complete', { id: req.params.id });
      res.json({ ok: true, state: 'complete' });
    } finally { db.close(); }
  });

  return router;
};
