'use strict';

function normalizeActionTarget(value) {
  const url = new URL(String(value || ''));
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/g, '');
  return url.toString();
}

function findExplicitOperatorActionApproval(db, args, now = Date.now()) {
  if (!db) return null;
  let targetUrl;
  try { targetUrl = normalizeActionTarget(args.target_url); }
  catch { return null; }
  const method = String(args.method || '*').toUpperCase();
  const risk = String(args.risk_to_target || '*').toLowerCase();
  try {
    return db.prepare(`
      SELECT id, agent_id, target_url, method, risk_to_target, operator, reason, created_at, expires_at
      FROM operator_action_approvals
      WHERE agent_id = ?
        AND target_url = ?
        AND (method = '*' OR method = ?)
        AND (risk_to_target = '*' OR risk_to_target = ?)
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(String(args.agent_id || ''), targetUrl, method, risk, now) || null;
  } catch {
    return null;
  }
}

module.exports = {
  normalizeActionTarget,
  findExplicitOperatorActionApproval,
};
