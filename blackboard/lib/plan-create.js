'use strict';

const crypto = require('node:crypto');

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be an object');
  if (!plan.engagement_id) throw new Error('plan.engagement_id required');
  if (!Array.isArray(plan.proposed_vectors) || plan.proposed_vectors.length === 0) {
    throw new Error('plan.proposed_vectors must be a non-empty array');
  }
  if (!Array.isArray(plan.agent_chain)) throw new Error('plan.agent_chain must be an array');
  for (const vector of plan.proposed_vectors) {
    if (!/^CWE-\d+$/.test(String(vector.cwe || ''))) throw new Error(`vector.cwe invalid: ${vector.cwe}`);
    if (!vector.rationale) throw new Error(`vector ${vector.cwe} missing rationale`);
    if (!['low', 'medium', 'high'].includes(vector.risk_to_target)) {
      throw new Error(`vector ${vector.cwe} risk_to_target must be low|medium|high`);
    }
    if (typeof vector.confidence_pre !== 'number' || vector.confidence_pre < 0 || vector.confidence_pre > 1) {
      throw new Error(`vector ${vector.cwe} confidence_pre out of range`);
    }
  }
  return plan;
}

function createOrReusePlan(db, plan, requestedId = null) {
  validatePlan(plan);
  const planJson = JSON.stringify(plan);
  const id = requestedId || `plan_${crypto.createHash('sha256').update(planJson).digest('hex').slice(0, 12)}`;
  const existing = db.prepare('SELECT id, engagement_id, state, plan_json FROM plans WHERE id = ?').get(id);
  if (existing) {
    if (existing.engagement_id !== plan.engagement_id || existing.plan_json !== planJson) {
      throw new Error(`Plan '${id}' already exists with different content`);
    }
    return { created: false, id, state: existing.state };
  }

  const parent = plan.parent_plan_id || null;
  const version = parent
    ? (db.prepare('SELECT version FROM plans WHERE id = ?').get(parent)?.version || 0) + 1
    : 1;
  const tx = db.transaction(() => {
    if (parent) {
      db.prepare("UPDATE plans SET state='superseded' WHERE id = ? AND state IN ('pending_approval','approved','executing')")
        .run(parent);
    }
    db.prepare(`INSERT INTO plans
      (id, engagement_id, version, state, plan_json, recon_summary, parent_plan_id, replan_reason)
      VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?)`)
      .run(
        id,
        plan.engagement_id,
        version,
        planJson,
        plan.recon_summary ? JSON.stringify(plan.recon_summary) : null,
        parent,
        plan.replan_reason || null
      );
  });
  tx();
  return { created: true, id, state: 'pending_approval', version };
}

module.exports = { validatePlan, createOrReusePlan };
