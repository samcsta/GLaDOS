// GLaDOS v4 — Plans & plan-approval REST endpoints.
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
//   POST   /api/plans/:id/end          — operator terminal decision; cancels engagement without reporting
//   POST   /api/plans/:id/complete     — state=complete
//
// Every state-changing call emits a lobby SSE event so the dashboard re-renders.

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const Database = require('better-sqlite3');

const GLADOS_RUNTIME_DIR = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados');

// Derive a per-agent fetch ACL from an approved plan's recon summary and
// agent_chain. The v4 policy copy lives under ~/.glados, never under legacy
// runtime homes.
const ACL_PATH = process.env.GLADOS_FETCH_ACL ||
  path.join(GLADOS_RUNTIME_DIR, 'policy', 'glados-fetch-acl.json');
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
  const add = value => {
    if (!value) return;
    try {
      hosts.add(new URL(String(value).includes('://') ? String(value) : `http://${value}`).hostname.toLowerCase());
    } catch {}
  };
  add(rs.target);
  if (rs.dns?.a) for (const a of rs.dns.a) add(a);
  if (rs.dns?.cname_chain) for (const c of rs.dns.cname_chain) add(c);
  if (rs.tls?.san) for (const s of rs.tls.san) add(s.replace(/^\*\./, ''));
  return [...hosts].filter(Boolean);
}
function buildAclFromPlan(plan) {
  const agents = {};
  for (const [a, surface] of Object.entries(PHASE1_SURFACES)) agents[a] = { allow: surface.slice() };
  const targetHosts = extractTargetHosts(plan);
  if (targetHosts.length) {
    agents['webapp-recon'] = { allow: targetHosts };
    // Wildcards: if target is `example.com`, also allow `*.example.com`.
    const wildcards = targetHosts.filter(h => !net.isIP(h) && !h.startsWith('*.')).map(h => '*.' + h);
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
    fs.mkdirSync(path.dirname(ACL_PATH), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(ACL_PATH), 0o700);
    // Backup existing first.
    if (fs.existsSync(ACL_PATH)) {
      try { fs.copyFileSync(ACL_PATH, ACL_PATH + '.bak'); } catch {}
    }
    fs.writeFileSync(ACL_PATH, `${JSON.stringify(acl, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(ACL_PATH, 0o600);
    return { ok: true, path: ACL_PATH };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const DB_PATH = path.resolve(
  process.env.BLACKBOARD_DB || path.join(os.homedir(), '.glados', 'blackboard', 'blackboard.db')
);

function openDb(dbPath = DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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

function endInvestigationForEngagement(db, {
  engagementId,
  operator = 'operator',
  reason = 'operator ended investigation',
  requiredPlanId = null,
}) {
  const engagement = db.prepare('SELECT id, status FROM engagements WHERE id = ?').get(engagementId);
  if (!engagement) {
    const error = new Error('engagement not found');
    error.statusCode = 404;
    throw error;
  }
  if (String(engagement.status || '').toLowerCase() === 'cancelled') {
    return {
      ok: true,
      already_ended: true,
      state: 'rejected',
      decision: 'end_investigation',
      engagement_id: engagement.id,
      engagement_status: 'cancelled',
      tasks_cancelled: 0,
      reports_started: false,
    };
  }
  const actionableStates = ['pending_approval', 'approved', 'executing'];
  const activePlans = db.prepare(`SELECT id, engagement_id, state FROM plans
    WHERE engagement_id = ? AND state IN ('pending_approval','approved','executing')
    ORDER BY rowid DESC`).all(engagement.id);
  if (requiredPlanId && !activePlans.some(plan => plan.id === requiredPlanId)) {
    const required = db.prepare('SELECT id, engagement_id, state FROM plans WHERE id = ?').get(requiredPlanId);
    const error = new Error(!required
      ? 'plan not found'
      : required.engagement_id !== engagement.id
        ? 'plan does not belong to engagement'
        : `cannot end investigation from plan state=${required.state}`);
    error.statusCode = !required ? 404 : 409;
    throw error;
  }
  const now = new Date().toISOString();
  let tasksCancelled = 0;
  let jobsCancelled = 0;
  const tx = db.transaction(() => {
    for (const plan of activePlans) {
      if (!actionableStates.includes(plan.state)) continue;
      db.prepare("UPDATE plans SET state='rejected', rejected_at=? WHERE id = ?").run(now, plan.id);
      db.prepare(`INSERT INTO plan_approvals (plan_id, decision, operator, reason)
        VALUES (?, 'end_investigation', ?, ?)`).run(plan.id, operator, reason);
    }
    tasksCancelled = db.prepare(`UPDATE tasks
      SET status='cancelled', updated_at=?
      WHERE engagement_id=? AND status NOT IN ('completed','failed','cancelled')`)
      .run(now, engagement.id).changes;
    db.prepare("UPDATE engagements SET status='cancelled', completed_at=? WHERE id = ?")
      .run(now, engagement.id);
    try {
      db.prepare("UPDATE replan_proposals SET state='dismissed', resolved_at=?, resolved_by=? WHERE engagement_id=? AND state='open'")
        .run(now, operator, engagement.id);
    } catch {}
    try {
      jobsCancelled = db.prepare(`UPDATE controller_jobs
        SET status='cancelled', cancel_requested=1, updated_at=?, finished_at=?
        WHERE engagement_id=? AND status IN ('queued','running')`)
        .run(now, now, engagement.id).changes;
    } catch {}
    try {
      db.prepare(`UPDATE controller_goals SET status='cancelled', updated_at=?, completed_at=?
        WHERE engagement_id=? AND status NOT IN ('complete','completed','cancelled','failed')`)
        .run(now, now, engagement.id);
    } catch {}
  });
  tx();
  return {
    ok: true,
    state: 'rejected',
    decision: 'end_investigation',
    engagement_id: engagement.id,
    engagement_status: 'cancelled',
    tasks_cancelled: tasksCancelled,
    jobs_cancelled: jobsCancelled,
    plans_ended: activePlans.map(plan => plan.id),
    reports_started: false,
  };
}

function endInvestigationForPlan(db, { planId, operator = 'operator', reason = 'operator ended investigation' }) {
  const plan = db.prepare('SELECT id, engagement_id, state FROM plans WHERE id = ?').get(planId);
  if (!plan) {
    const error = new Error('plan not found');
    error.statusCode = 404;
    throw error;
  }
  return endInvestigationForEngagement(db, {
    engagementId: plan.engagement_id,
    operator,
    reason,
    requiredPlanId: planId,
  });
}

function makeRouter(broadcastLobby, { onApproved = null, onEnded = null, dbPath = DB_PATH, getSessionId = () => 'legacy' } = {}) {
  const router = express.Router();
  const openRouterDb = () => openDb(dbPath);
  const hasSessionSchema = db => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investigation_sessions'").get();
  const planForSession = (db, fields, id, sessionId) => hasSessionSchema(db)
    ? db.prepare(`SELECT ${fields} FROM plans p JOIN engagements e ON e.id=p.engagement_id WHERE p.id=? AND e.session_id=?`).get(id, sessionId)
    : db.prepare(`SELECT ${fields.replaceAll('p.', '')} FROM plans WHERE id=?`).get(id);

  router.get('/', (req, res) => {
    const db = openRouterDb();
    try {
      const where = [];
      const args = [];
      if (hasSessionSchema(db)) { where.push('engagement_id IN (SELECT id FROM engagements WHERE session_id=?)'); args.push(getSessionId(req)); }
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
    const db = openRouterDb();
    try {
      const plan = planForSession(db, 'p.*', req.params.id, getSessionId(req));
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
    const sessionId = getSessionId(req);
    const id = req.body.id || 'plan_' + crypto.randomBytes(6).toString('hex');
    const db = openRouterDb();
    try {
      if (hasSessionSchema(db) && !db.prepare('SELECT 1 FROM engagements WHERE id=? AND session_id=?').get(plan.engagement_id, sessionId)) return res.status(409).json({ error: 'engagement belongs to another investigation session' });
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

  // Transactional plan approval.
  //
  // Old path:
  //   1) UPDATE plans SET state='approved'
  //   2) INSERT INTO plan_approvals
  //   3) Attempt ACL write → if it fails, plan is already approved and the
  //      next dispatch passes the gate with NO ACL boundary in place.
  // This is the v4 boundary between operator approval and target-capable tools.
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
    const db = openRouterDb();
    try {
      const row = planForSession(db, 'p.id, p.state, p.plan_json, p.engagement_id', req.params.id, getSessionId(req));
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

      let execution = { executionQueued: false };
      if (typeof onApproved === 'function') {
        try {
          execution = onApproved({
            id: req.params.id,
            engagement_id: row.engagement_id,
            decision,
            vectors: vectors || null,
          }) || execution;
        } catch (error) {
          execution = { executionQueued: false, executionError: error.message };
        }
      }
      broadcastLobby('plan-approved', {
        id: req.params.id,
        engagement_id: row.engagement_id,
        decision,
        vectors: vectors || null,
        acl: aclResult,
        execution_queued: !!execution.executionQueued,
      });
      res.json({
        ok: true,
        state: 'approved',
        decision,
        acl: aclResult,
        execution_queued: !!execution.executionQueued,
        execution_error: execution.executionError || null,
      });
    } finally { db.close(); }
  });

  // Preview endpoint — returns the ACL that WOULD be written without approval.
  router.get('/:id/acl-preview', (req, res) => {
    const db = openRouterDb();
    try {
      const row = planForSession(db, 'p.id, p.plan_json, p.engagement_id', req.params.id, getSessionId(req));
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
    const db = openRouterDb();
    try {
      const parent = planForSession(db, 'p.id, p.engagement_id, p.version', req.params.id, getSessionId(req));
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
    const db = openRouterDb();
    try {
      const plan = planForSession(db, 'p.id, p.state', req.params.id, getSessionId(req));
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

  router.post('/:id/end', (req, res) => {
    const { reason = 'operator ended investigation', operator = 'operator' } = req.body || {};
    const db = openRouterDb();
    try {
      const result = endInvestigationForPlan(db, {
        planId: req.params.id,
        operator,
        reason,
      });
      broadcastLobby('plan-ended', result);
      broadcastLobby('engagement-ended', {
        engagement_id: result.engagement_id,
        status: result.engagement_status,
        reason,
      });
      if (typeof onEnded === 'function') onEnded(result, { reason, operator });
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: error.message });
    } finally { db.close(); }
  });

  router.post('/:id/complete', (req, res) => {
    const db = openRouterDb();
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
}

module.exports = makeRouter;
module.exports.extractTargetHosts = extractTargetHosts;
module.exports.buildAclFromPlan = buildAclFromPlan;
module.exports.endInvestigationForPlan = endInvestigationForPlan;
module.exports.endInvestigationForEngagement = endInvestigationForEngagement;
