'use strict';

function upsertBaseline(db, args) {
  const engagementId = args.engagement_id;
  const merge = args.merge && typeof args.merge === 'object' ? args.merge : {};

  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT summary_json, complete FROM baseline_recon WHERE engagement_id = ?'
    ).get(engagementId);
    let summary = {};
    if (existing) {
      try { summary = JSON.parse(existing.summary_json) || {}; } catch { summary = {}; }
    }
    for (const [key, value] of Object.entries(merge)) summary[key] = value;

    const summaryJson = JSON.stringify(summary);
    const complete = args.complete === true || Boolean(existing?.complete);
    if (existing) {
      if (args.complete === true) {
        db.prepare(`
          UPDATE baseline_recon
          SET summary_json = ?, complete = 1, completed_at = datetime('now'), updated_at = datetime('now')
          WHERE engagement_id = ?
        `).run(summaryJson, engagementId);
      } else {
        db.prepare(`
          UPDATE baseline_recon
          SET summary_json = ?, updated_at = datetime('now')
          WHERE engagement_id = ?
        `).run(summaryJson, engagementId);
      }
    } else {
      db.prepare(`
        INSERT INTO baseline_recon (engagement_id, summary_json, complete, completed_at)
        VALUES (?, ?, ?, ?)
      `).run(engagementId, summaryJson, complete ? 1 : 0, complete ? new Date().toISOString() : null);
    }

    return { summary, complete };
  });

  return tx();
}

module.exports = { upsertBaseline };
