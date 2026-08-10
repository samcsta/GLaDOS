const crypto = require('node:crypto');
const Database = require('better-sqlite3');

class InvestigationSessionStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('secure_delete = ON');
    this.ensureInitialSession();
    this.removeDuplicateEmptyUnassignedSessions();
  }

  ensureInitialSession() {
    const active = this.getActive();
    if (active) return active;
    const existing = this.db.prepare('SELECT id FROM investigation_sessions ORDER BY datetime(created_at) ASC LIMIT 1').get();
    if (existing) {
      this.db.prepare(`UPDATE investigation_sessions SET state='active', archived_at=NULL, updated_at=datetime('now') WHERE id=?`).run(existing.id);
      return this.get(existing.id);
    }
    return this.createUnassigned();
  }

  createUnassigned() {
    const active = this.getActive();
    if (active?.metadata?.unassigned) return active;
    const existing = this.db.prepare(`
      SELECT id FROM investigation_sessions
      WHERE state='archived' AND json_extract(metadata_json, '$.unassigned')=1
      ORDER BY datetime(updated_at) DESC LIMIT 1
    `).get();
    if (existing) return this.activate(existing.id);
    return this.create({ name: 'Unassigned session', metadata: { unassigned: true }, activate: true });
  }

  removeDuplicateEmptyUnassignedSessions() {
    const rows = this.db.prepare(`
      SELECT s.id, s.state
      FROM investigation_sessions s
      WHERE json_extract(s.metadata_json, '$.unassigned')=1
        AND NOT EXISTS (SELECT 1 FROM engagements e WHERE e.session_id=s.id)
        AND NOT EXISTS (SELECT 1 FROM dashboard_transcript_events t WHERE t.session_id=s.id)
      ORDER BY CASE s.state WHEN 'active' THEN 0 ELSE 1 END, datetime(s.updated_at) DESC
    `).all();
    if (rows.length <= 1) return 0;
    const remove = rows.slice(1).map(row => row.id);
    const tx = this.db.transaction(() => {
      for (const id of remove) {
        this.db.prepare('DELETE FROM operator_action_approvals WHERE session_id=?').run(id);
        this.db.prepare("DELETE FROM investigation_sessions WHERE id=? AND state='archived'").run(id);
      }
    });
    tx();
    return remove.length;
  }

  list({ includeArchived = true } = {}) {
    const where = includeArchived ? '' : `WHERE state='active'`;
    return this.db.prepare(`
      SELECT s.*, COUNT(e.id) AS engagement_count
      FROM investigation_sessions s
      LEFT JOIN engagements e ON e.session_id=s.id
      ${where}
      GROUP BY s.id
      ORDER BY CASE s.state WHEN 'active' THEN 0 ELSE 1 END, datetime(s.updated_at) DESC
    `).all().map(decodeSession);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM investigation_sessions WHERE id=?').get(id);
    return row ? decodeSession(row) : null;
  }

  getActive() {
    const row = this.db.prepare(`SELECT * FROM investigation_sessions WHERE state='active' LIMIT 1`).get();
    return row ? decodeSession(row) : null;
  }

  create({ name, metadata = {}, activate = true } = {}) {
    const id = `session_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
    const label = String(name || '').trim().slice(0, 120) || 'Unassigned session';
    const tx = this.db.transaction(() => {
      if (activate) this.db.prepare(`UPDATE investigation_sessions SET state='archived', archived_at=COALESCE(archived_at, datetime('now')), updated_at=datetime('now') WHERE state='active'`).run();
      this.db.prepare(`INSERT INTO investigation_sessions (id, name, state, archived_at, metadata_json) VALUES (?, ?, ?, ?, ?)`).run(
        id, label, activate ? 'active' : 'archived', activate ? null : new Date().toISOString(), JSON.stringify(metadata || {})
      );
    });
    tx();
    return this.get(id);
  }

  activate(id) {
    if (!this.get(id)) throw new Error(`investigation session not found: ${id}`);
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE investigation_sessions SET state='archived', archived_at=COALESCE(archived_at, datetime('now')), updated_at=datetime('now') WHERE state='active' AND id<>?`).run(id);
      this.db.prepare(`UPDATE investigation_sessions SET state='active', archived_at=NULL, updated_at=datetime('now') WHERE id=?`).run(id);
    });
    tx();
    return this.get(id);
  }

  rename(id, name, { clearUnassigned = true } = {}) {
    const session = this.get(id);
    if (!session) throw new Error(`investigation session not found: ${id}`);
    const label = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!label) throw new Error('session name required');
    const metadata = { ...(session.metadata || {}) };
    if (clearUnassigned) delete metadata.unassigned;
    this.db.prepare(`UPDATE investigation_sessions SET name=?, metadata_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(label, JSON.stringify(metadata), id);
    return this.get(id);
  }

  nameFromFirstPrompt(id, prompt) {
    const session = this.get(id);
    if (!session?.metadata?.unassigned) return session;
    const text = String(prompt || '')
      .replace(/^\s*\/[a-z-]+\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[?.!,;:]+$/g, '');
    if (!text) return session;
    const words = text.split(' ');
    let label = words.slice(0, 9).join(' ');
    if (words.length > 9) label += '...';
    label = label.slice(0, 72).trim();
    return this.rename(id, label || 'New investigation');
  }

  archive(id) {
    const session = this.get(id);
    if (!session) throw new Error(`investigation session not found: ${id}`);
    if (session.state === 'active') throw new Error('create or activate another investigation before archiving the active session');
    this.db.prepare(`UPDATE investigation_sessions SET state='archived', archived_at=COALESCE(archived_at, datetime('now')), updated_at=datetime('now') WHERE id=?`).run(id);
    return this.get(id);
  }

  ownsEngagement(sessionId, engagementId) {
    return !!this.db.prepare('SELECT 1 FROM engagements WHERE id=? AND session_id=?').get(engagementId, sessionId);
  }

  engagementIds(sessionId) {
    return this.db.prepare('SELECT id FROM engagements WHERE session_id=?').all(sessionId).map(row => row.id);
  }

  hasRunningWork(sessionId) {
    return !!this.db.prepare(`
      SELECT 1 FROM controller_jobs
      WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)
        AND status IN ('running','cancelling')
      LIMIT 1
    `).get(sessionId);
  }

  delete(id) {
    const session = this.get(id);
    if (!session) throw new Error(`investigation session not found: ${id}`);
    if (this.hasRunningWork(id)) throw new Error('stop running controller jobs before deleting this session');
    const rowsDeleted = {};
    let replacement = null;
    const runDelete = (table, sql, ...params) => {
      const result = this.db.prepare(sql).run(...params);
      rowsDeleted[table] = result.changes;
    };
    const tx = this.db.transaction(() => {
      if (session.state === 'active') {
        this.db.prepare(`UPDATE investigation_sessions SET state='archived', archived_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(id);
        const existing = this.db.prepare(`
          SELECT id FROM investigation_sessions
          WHERE id<>? AND state='archived'
          ORDER BY CASE WHEN json_extract(metadata_json, '$.unassigned')=1 THEN 0 ELSE 1 END,
                   datetime(updated_at) DESC
          LIMIT 1
        `).get(id);
        if (existing) {
          this.db.prepare(`UPDATE investigation_sessions SET state='active', archived_at=NULL, updated_at=datetime('now') WHERE id=?`).run(existing.id);
          replacement = existing.id;
        } else {
          const replacementId = `session_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
          this.db.prepare(`INSERT INTO investigation_sessions (id, name, state, metadata_json) VALUES (?, 'Unassigned session', 'active', '{"unassigned":true}')`).run(replacementId);
          replacement = replacementId;
        }
      }
      runDelete('controller_events', `DELETE FROM controller_events WHERE goal_id IN (SELECT id FROM controller_goals WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)) OR job_id IN (SELECT id FROM controller_jobs WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?))`, id, id);
      runDelete('controller_jobs', `DELETE FROM controller_jobs WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?) OR goal_id IN (SELECT id FROM controller_goals WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?))`, id, id);
      runDelete('controller_goals', `DELETE FROM controller_goals WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('security_review_worker_attempts', `DELETE FROM security_review_worker_attempts WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('security_review_worker_runs', `DELETE FROM security_review_worker_runs WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('security_review_model_observations', `DELETE FROM security_review_model_observations WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('security_review_llm_requests', `DELETE FROM security_review_llm_requests WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('replan_proposals', `DELETE FROM replan_proposals WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('plan_approvals', `DELETE FROM plan_approvals WHERE plan_id IN (SELECT p.id FROM plans p JOIN engagements e ON e.id=p.engagement_id WHERE e.session_id=?)`, id);
      runDelete('plans', `DELETE FROM plans WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('recon_steps', `DELETE FROM recon_steps WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('baseline_recon', `DELETE FROM baseline_recon WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('tasks', `DELETE FROM tasks WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('findings', `DELETE FROM findings WHERE engagement_id IN (SELECT id FROM engagements WHERE session_id=?)`, id);
      runDelete('engagements', `DELETE FROM engagements WHERE session_id=?`, id);
      runDelete('dashboard_transcript_events', `DELETE FROM dashboard_transcript_events WHERE session_id=?`, id);
      runDelete('operator_action_approvals', `DELETE FROM operator_action_approvals WHERE session_id=?`, id);
      runDelete('investigation_sessions', `DELETE FROM investigation_sessions WHERE id=?`, id);
      const violation = this.db.prepare('PRAGMA foreign_key_check').get();
      if (violation) throw new Error(`foreign key check failed after deleting session ${id}`);
    });
    tx();
    return { session, replacement: replacement ? this.get(replacement) : this.getActive(), rowsDeleted };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

function decodeSession(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || '{}'); } catch {}
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null,
    engagementCount: Number(row.engagement_count || 0),
    metadata,
  };
}

module.exports = { InvestigationSessionStore };
