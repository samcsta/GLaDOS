const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ENGAGEMENT_STATUSES = new Set(['active', 'complete', 'cancelled']);

function updateEngagement(db, { engagementId, status, completionGuard = null }) {
  if (!engagementId) throw new Error('engagement_id is required');
  if (!ENGAGEMENT_STATUSES.has(status)) {
    throw new Error(`invalid engagement status: ${status}`);
  }
  const engagement = db.prepare('SELECT id FROM engagements WHERE id = ?').get(engagementId);
  if (!engagement) throw new Error(`engagement '${engagementId}' not found`);

  if (status === 'complete') {
    const nonterminal = db.prepare(`
      SELECT id, assigned_to, status
      FROM tasks
      WHERE engagement_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY id
    `).all(engagementId);
    if (nonterminal.length) {
      const summary = nonterminal.map(task => `#${task.id}:${task.assigned_to}:${task.status}`).join(', ');
      throw new Error(`cannot complete engagement while tasks are nonterminal (${summary})`);
    }
    if (completionGuard) completionGuard({ engagementId });
  }

  db.prepare(`
    UPDATE engagements
    SET status = ?,
        completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(status, status, engagementId);
  return db.prepare('SELECT * FROM engagements WHERE id = ?').get(engagementId);
}

module.exports = {
  ENGAGEMENT_STATUSES,
  TERMINAL_TASK_STATUSES,
  updateEngagement,
};
