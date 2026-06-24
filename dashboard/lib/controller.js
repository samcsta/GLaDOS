const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const RUNNING_STATUSES = ['running', 'cancelling'];

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function safeTargetSlug(target) {
  return String(target || 'target')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'target';
}

function engagementIdForTarget(target) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${safeTargetSlug(target)}-${date}`;
}

function openControllerDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

class ControllerLite {
  constructor({
    dbPath,
    sendMessageToAgentTracked = null,
    currentSessionForAgent = null,
    workerId = `dashboard-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrent = Number(process.env.GLADOS_CONTROLLER_MAX_CONCURRENT || 3),
    leaseMs = Number(process.env.GLADOS_CONTROLLER_LEASE_MS || 20 * 60 * 1000),
  }) {
    this.db = openControllerDb(dbPath);
    this.sendMessageToAgentTracked = sendMessageToAgentTracked;
    this.currentSessionForAgent = currentSessionForAgent;
    this.workerId = workerId;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.leaseMs = Math.max(60_000, leaseMs);
    this.running = new Map(); // jobId -> { child, heartbeat }
    this.timer = null;
    this._prepare();
  }

  _prepare() {
    this.insertEngagement = this.db.prepare(`
      INSERT INTO engagements (id, target_name, scope, status)
      VALUES (?, ?, ?, 'active')
      ON CONFLICT(id) DO UPDATE SET target_name=excluded.target_name
    `);
    this.insertGoal = this.db.prepare(`
      INSERT INTO controller_goals
        (id, type, target, status, engagement_id, created_by, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertJob = this.db.prepare(`
      INSERT INTO controller_jobs
        (id, goal_id, engagement_id, agent_id, instance_id, job_type, target, prompt, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `);
    this.insertEvent = this.db.prepare(`
      INSERT INTO controller_events (goal_id, job_id, event_type, message, data_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.activeGoalsStmt = this.db.prepare(`
      SELECT * FROM controller_goals
      WHERE status IN ('active','pending_approval','queued','running')
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 50
    `);
    this.recentGoalsStmt = this.db.prepare(`
      SELECT * FROM controller_goals
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 20
    `);
    this.activeJobsStmt = this.db.prepare(`
      SELECT * FROM controller_jobs
      WHERE status IN ('queued','running','cancelling')
      ORDER BY created_at ASC
      LIMIT 100
    `);
    this.recentFailuresStmt = this.db.prepare(`
      SELECT * FROM controller_jobs
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 10
    `);
    this.eventsSinceStmt = this.db.prepare(`
      SELECT * FROM controller_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `);
    this.jobById = this.db.prepare('SELECT * FROM controller_jobs WHERE id = ?');
    this.updateGoalStatusStmt = this.db.prepare(`
      UPDATE controller_goals
      SET status=?, updated_at=?, completed_at=CASE WHEN ? IN ('complete','cancelled','failed') THEN ? ELSE completed_at END
      WHERE id=?
    `);
    this.cancelQueued = this.db.prepare(`
      UPDATE controller_jobs
      SET status='cancelled', cancel_requested=1, updated_at=?, finished_at=?
      WHERE id=? AND status='queued'
    `);
    this.markCancelRequested = this.db.prepare(`
      UPDATE controller_jobs
      SET cancel_requested=1, status=CASE WHEN status='running' THEN 'cancelling' ELSE status END, updated_at=?
      WHERE id=? AND status IN ('running','cancelling')
    `);
    this.markStaleRunning = this.db.prepare(`
      UPDATE controller_jobs
      SET status='failed', error=?, updated_at=?, finished_at=?
      WHERE status IN ('running','cancelling')
    `);
    this.runningCount = this.db.prepare(`
      SELECT COUNT(*) AS n FROM controller_jobs WHERE status IN ('running','cancelling')
    `);
    this.nextQueued = this.db.prepare(`
      SELECT *
      FROM controller_jobs AS q
      WHERE q.status='queued'
        AND q.cancel_requested=0
        AND NOT EXISTS (
          SELECT 1 FROM controller_jobs AS r
          WHERE r.agent_id=q.agent_id AND r.status IN ('running','cancelling')
        )
      ORDER BY q.created_at ASC
      LIMIT 1
    `);
    this.markRunning = this.db.prepare(`
      UPDATE controller_jobs
      SET status='running', attempts=attempts+1, lease_owner=?, lease_expires_at=?,
          heartbeat_at=?, updated_at=?, started_at=COALESCE(started_at, ?)
      WHERE id=? AND status='queued'
    `);
    this.heartbeat = this.db.prepare(`
      UPDATE controller_jobs
      SET heartbeat_at=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND status IN ('running','cancelling')
    `);
    this.markDone = this.db.prepare(`
      UPDATE controller_jobs
      SET status=?, result_json=?, error=?, updated_at=?, finished_at=?
      WHERE id=?
    `);
  }

  reconcileStaleRunning() {
    const stamp = nowIso();
    const result = this.markStaleRunning.run('dashboard restarted before worker-owned job finished', stamp, stamp);
    if (result.changes) {
      this.logEvent(null, null, 'jobs_reconciled', `Marked ${result.changes} stale running job(s) failed after dashboard startup.`, { changes: result.changes });
    }
    return result.changes;
  }

  ensureEngagement(target) {
    const engagementId = engagementIdForTarget(target);
    this.insertEngagement.run(engagementId, target, JSON.stringify([target]));
    return engagementId;
  }

  createGoal({ type, target, createdBy = 'operator', metadata = {}, status = 'active', engagementId = null }) {
    if (!type || !target) throw new Error('type and target are required');
    const goalId = id('goal');
    const engId = engagementId || this.ensureEngagement(target);
    this.insertGoal.run(goalId, type, target, status, engId, createdBy, JSON.stringify(metadata || {}), nowIso());
    this.logEvent(goalId, null, 'goal_created', `Created ${type} goal for ${target}.`, { type, target, engagement_id: engId });
    return this.getGoal(goalId);
  }

  createWebGoal(target, metadata = {}) {
    return this.createGoal({ type: 'webapp_goal', target, metadata, status: 'pending_approval' });
  }

  createSecurityReviewGoal(target, metadata = {}) {
    return this.createGoal({ type: 'security_review', target, metadata, status: 'queued' });
  }

  enqueueSecurityReviewPath(localPath, { goalId = null, engagementId = null } = {}) {
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) throw new Error(`local path not found: ${abs}`);
    const goal = goalId ? this.getGoal(goalId) : this.createSecurityReviewGoal(abs, { source: 'slash' });
    const jobId = id('job');
    const engId = engagementId || goal.engagement_id || this.ensureEngagement(abs);
    const prompt = [
      `Run a source-code security review for this local repository path: ${abs}`,
      '',
      'Use local repository tools (`rg`, manifest readers, language-native tests/builds when useful).',
      'Do not modify files.',
      'Report findings with file:line, source-to-sink trace, exploitability assumptions, and recommended dynamic validation steps.',
      'Do not print secret values; report only the location and type.',
    ].join('\n');
    this.insertJob.run(jobId, goal.id, engId, 'source-code', 'source-code#1', 'security_review_local_path', abs, prompt, nowIso());
    this.logEvent(goal.id, jobId, 'job_queued', `Queued source-code security review for ${abs}.`, { agent_id: 'source-code', target: abs });
    return this.getJob(jobId);
  }

  getGoal(goalId) {
    const row = this.db.prepare('SELECT * FROM controller_goals WHERE id = ?').get(goalId);
    return row ? decodeRow(row) : null;
  }

  updateGoalStatus(goalId, status) {
    if (!goalId || !status) return { ok: false, changed: 0 };
    const stamp = nowIso();
    const result = this.updateGoalStatusStmt.run(status, stamp, status, stamp, goalId);
    if (result.changes) this.logEvent(goalId, null, `goal_${status}`, `Goal ${goalId} marked ${status}.`, {});
    return { ok: true, changed: result.changes };
  }

  getJob(jobId) {
    const row = this.jobById.get(jobId);
    return row ? decodeRow(row) : null;
  }

  logEvent(goalId, jobId, eventType, message, data = {}) {
    const info = this.insertEvent.run(goalId || null, jobId || null, eventType, message || null, JSON.stringify(data || {}));
    return { id: info.lastInsertRowid, goal_id: goalId || null, job_id: jobId || null, event_type: eventType, message, data };
  }

  status({ pendingKickoff = null, activeAgents = [], targetHealth = [], plans = null } = {}) {
    return {
      goals: this.activeGoalsStmt.all().map(decodeRow),
      recentGoals: this.recentGoalsStmt.all().map(decodeRow),
      jobs: this.activeJobsStmt.all().map(decodeRow),
      recentFailures: this.recentFailuresStmt.all().map(decodeRow),
      pendingPrecheckApproval: pendingKickoff || null,
      activeAgents,
      targetHealth,
      plans,
    };
  }

  eventsSince(since = 0, limit = 100) {
    return this.eventsSinceStmt.all(Number(since) || 0, Math.max(1, Math.min(500, Number(limit) || 100))).map(decodeRow);
  }

  cancelJob(jobId) {
    const queued = this.cancelQueued.run(nowIso(), nowIso(), jobId);
    if (queued.changes) {
      this.logEvent(null, jobId, 'job_cancelled', `Cancelled queued job ${jobId}.`, {});
      return { ok: true, jobId, status: 'cancelled', running: false };
    }

    const running = this.markCancelRequested.run(nowIso(), jobId);
    if (!running.changes) {
      const row = this.getJob(jobId);
      if (!row) return { ok: false, error: 'job not found' };
      return { ok: true, jobId, status: row.status, running: RUNNING_STATUSES.includes(row.status), changed: false };
    }

    const tracked = this.running.get(jobId);
    if (tracked?.child) {
      try { tracked.child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try {
          const current = this.getJob(jobId);
          if (current && RUNNING_STATUSES.includes(current.status)) tracked.child.kill('SIGKILL');
        } catch {}
      }, 5000).unref?.();
    }
    this.logEvent(null, jobId, 'job_cancel_requested', `Requested cancellation for running job ${jobId}.`, { tracked: !!tracked });
    return { ok: true, jobId, status: 'cancelling', running: true, tracked: !!tracked };
  }

  start() {
    this.reconcileStaleRunning();
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), 1500);
    this.timer.unref?.();
    this.tick();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [jobId, rec] of this.running) {
      clearInterval(rec.heartbeat);
      try { rec.child?.kill('SIGTERM'); } catch {}
      this.running.delete(jobId);
    }
  }

  tick() {
    if (!this.sendMessageToAgentTracked) return;
    while (this.runningCount.get().n < this.maxConcurrent) {
      const job = this.nextQueued.get();
      if (!job) return;
      this._startJob(job);
    }
  }

  _startJob(job) {
    const stamp = nowIso();
    const leaseUntil = nowMs() + this.leaseMs;
    const started = this.markRunning.run(this.workerId, leaseUntil, nowMs(), stamp, stamp, job.id);
    if (!started.changes) return;
    this.logEvent(job.goal_id, job.id, 'job_started', `Started ${job.agent_id} job ${job.id}.`, { agent_id: job.agent_id });

    let tracked;
    try {
      tracked = this.sendMessageToAgentTracked(job.agent_id, job.prompt);
    } catch (e) {
      this._finishJob(job, 'failed', null, e.message);
      return;
    }
    const heartbeat = setInterval(() => {
      try { this.heartbeat.run(nowMs(), nowMs() + this.leaseMs, nowIso(), job.id); } catch {}
    }, 30_000);
    heartbeat.unref?.();
    this.running.set(job.id, { child: tracked.child, heartbeat });

    tracked.promise.then(result => {
      const current = this.getJob(job.id);
      const wasCancelled = current?.cancel_requested;
      this._finishJob(job, wasCancelled ? 'cancelled' : 'succeeded', result, wasCancelled ? 'cancelled by operator' : null);
    }).catch(err => {
      const current = this.getJob(job.id);
      const wasCancelled = current?.cancel_requested || err?.killed || err?.signal;
      this._finishJob(job, wasCancelled ? 'cancelled' : 'failed', { stdout: err?.stdout, stderr: err?.stderr }, wasCancelled ? 'cancelled by operator' : err.message);
    });
  }

  _finishJob(job, status, result, error) {
    const rec = this.running.get(job.id);
    if (rec) {
      clearInterval(rec.heartbeat);
      this.running.delete(job.id);
    }
    const stamp = nowIso();
    this.markDone.run(status, result ? JSON.stringify(result) : null, error || null, stamp, stamp, job.id);
    this.logEvent(job.goal_id, job.id, `job_${status}`, `${job.agent_id} job ${job.id} ${status}.`, { error: error || null });
  }

  close() {
    this.stop();
    try { this.db.close(); } catch {}
  }
}

function decodeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of ['metadata_json', 'result_json', 'data_json']) {
    if (out[key]) {
      try { out[key.replace(/_json$/, '')] = JSON.parse(out[key]); } catch {}
    }
  }
  return out;
}

module.exports = {
  ControllerLite,
  engagementIdForTarget,
};
