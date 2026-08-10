const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  securityReviewArtifactRoot,
  securityReviewCoordinatorPrompt,
  sourceReviewGateStatus,
} = require('./security-review/workflow');
const { generateSecurityReviewInventory } = require('./security-review/inventory');
const { IDLE_AGENT_STATUS } = require('./runtime-reset');
const {
  initializeDeepScanRun,
  markDeepScanCapped,
} = require('./security-review/deep-scan');

const RUNNING_STATUSES = ['running', 'cancelling'];
const SECURITY_REVIEW_MAX_CONTINUATIONS = 12;

function isRecoverableCoordinatorInterruption(error) {
  return /maximum number of turns|reached max(?:imum)? turns|dashboard restarted before worker-owned job finished/i
    .test(String(error || ''));
}

function securityReviewContinuationPrompt(prompt, { artifactRoot, reason }) {
  const text = String(prompt || '');
  const contractAt = text.indexOf('SOURCE SECURITY REVIEW WORKFLOW v3');
  const contract = contractAt >= 0 ? text.slice(contractAt) : text;
  return [
    'SECURITY REVIEW WORKFLOW v3 — DURABLE COORDINATOR CONTINUATION',
    `artifact_root: ${artifactRoot}`,
    `continuation_reason: ${reason}`,
    '',
    'Resume this same engagement from its durable artifacts. Do not initialize a new run, engagement, inventory, manifest, or deadline.',
    'Read run.json, discovery/deep/manifest.json, discovery/deep/workers.jsonl, discovery/deep/dedupe.json, validation/runtime-model-observations.jsonl, and the existing blackboard tasks before acting.',
    'Validate the existing terminal worker chain, compute the next sequential worker ID, and continue from that exact checkpoint. Never rerun a terminal worker or count this coordinator continuation as a discovery worker failure.',
    'Keep the original blind-context prohibition and original wall-clock deadline. Existing candidates from this engagement may be used only for centralized deduplication and closure; never disclose them to later blind-discovery workers.',
    '',
    contract,
  ].join('\n');
}

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
    getInvestigationSessionId = () => 'legacy',
    workerId = `dashboard-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrent = Number(process.env.GLADOS_CONTROLLER_MAX_CONCURRENT || 3),
    leaseMs = Number(process.env.GLADOS_CONTROLLER_LEASE_MS || 20 * 60 * 1000),
  }) {
    this.db = openControllerDb(dbPath);
    this.sendMessageToAgentTracked = sendMessageToAgentTracked;
    this.currentSessionForAgent = currentSessionForAgent;
    this.getInvestigationSessionId = getInvestigationSessionId;
    this.workerId = workerId;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.leaseMs = Math.max(60_000, leaseMs);
    this.running = new Map(); // jobId -> { child, heartbeat }
    this.timer = null;
    this._prepare();
  }

  _prepare() {
    this.insertEngagement = this.db.prepare(`
      INSERT INTO engagements (id, session_id, target_name, scope, status)
      VALUES (?, ?, ?, ?, 'active')
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
    this.activeSecurityReviewsBySession = this.db.prepare(`
      SELECT j.*
      FROM controller_jobs AS j
      JOIN engagements AS e ON e.id=j.engagement_id
      WHERE j.job_type='security_review_workflow_v3'
        AND j.status IN ('queued','running','cancelling')
        AND e.session_id=?
      ORDER BY j.created_at ASC
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
    this.engagementSession = this.db.prepare('SELECT session_id FROM engagements WHERE id = ?');
    this.authoritativeWorkerRuns = this.db.prepare(`
      SELECT * FROM security_review_worker_runs WHERE engagement_id=? ORDER BY sequence
    `);
    this.authoritativeModelObservations = this.db.prepare(`
      SELECT observation_id, engagement_id, controller_job_id, agent_id, review_role, worker_id,
             requested_model, actual_model, billed_model_name, source, request_id, gateway_model_id, cost_usd, observed_at
      FROM security_review_model_observations WHERE engagement_id=? ORDER BY observed_at, observation_id
    `);
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
    this.staleRunningJobs = this.db.prepare(`
      SELECT * FROM controller_jobs WHERE status IN ('running','cancelling')
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
    this.requeueInterruptedSecurityReview = this.db.prepare(`
      UPDATE controller_jobs
      SET status='queued', prompt=?, result_json=NULL, error=NULL, updated_at=?, finished_at=NULL,
          lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL
      WHERE id=? AND status IN ('running','failed') AND cancel_requested=0
    `);
    this.requeueInterruptedSecurityReviewGoal = this.db.prepare(`
      UPDATE controller_goals
      SET status='queued', updated_at=?, completed_at=NULL
      WHERE id=? AND status != 'cancelled'
    `);
    this.recoverableSecurityReviewJobs = this.db.prepare(`
      SELECT * FROM controller_jobs
      WHERE status='failed' AND job_type='security_review_workflow_v3' AND cancel_requested=0
      ORDER BY updated_at ASC
    `);
    this.reconcileStaleWorkerRuns = this.db.prepare(`
      UPDATE security_review_worker_runs
      SET status='CANCELED', completed_at=?, error=COALESCE(error, ?)
      WHERE status='STARTED'
        AND engagement_id IN (
          SELECT engagement_id FROM controller_jobs
          WHERE status='failed' AND job_type='security_review_workflow_v3'
        )
    `);
    this.reconcileStaleWorkerAttempts = this.db.prepare(`
      UPDATE security_review_worker_attempts
      SET status='CANCELED', completed_at=?, error=COALESCE(error, ?)
      WHERE status='STARTED'
        AND engagement_id IN (
          SELECT engagement_id FROM controller_jobs
          WHERE status='failed' AND job_type='security_review_workflow_v3'
        )
    `);
    this.reconcileTasks = this.db.prepare(`
      UPDATE tasks SET status=?, result=COALESCE(result, ?), updated_at=?
      WHERE engagement_id=? AND status NOT IN ('completed','failed','cancelled')
    `);
    this.finishEngagement = this.db.prepare(`
      UPDATE engagements SET status=?, completed_at=COALESCE(completed_at, ?)
      WHERE id=? AND status='active'
    `);
  }

  reconcileStaleRunning() {
    const stale = this.staleRunningJobs.all();
    const stamp = nowIso();
    const result = this.markStaleRunning.run('dashboard restarted before worker-owned job finished', stamp, stamp);
    if (result.changes) {
      this.logEvent(null, null, 'jobs_reconciled', `Marked ${result.changes} stale running job(s) failed after dashboard startup.`, { changes: result.changes });
    }
    for (const job of stale.filter(row => row.job_type !== 'security_review_workflow_v3')) {
      if (job.goal_id) this.updateGoalStatus(job.goal_id, 'failed');
    }
    return result.changes;
  }

  _resumeInterruptedSecurityReview(job, error) {
    if (job?.job_type !== 'security_review_workflow_v3') return false;
    if (!isRecoverableCoordinatorInterruption(error)) return false;
    if (Number(job.attempts || 0) >= SECURITY_REVIEW_MAX_CONTINUATIONS) return false;

    const runtimeDir = path.dirname(path.dirname(this.db.name));
    const artifactRoot = securityReviewArtifactRoot(runtimeDir, job.engagement_id);
    let run;
    let manifest;
    try {
      run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
      manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'discovery', 'deep', 'manifest.json'), 'utf8'));
    } catch {
      return false;
    }
    if (run?.deepScan?.terminalState !== 'RUNNING' || manifest?.status !== 'RUNNING') return false;
    const deadlineValue = run?.deepScan?.deadlineAt || manifest?.deadline_at || null;
    const deadlineMs = deadlineValue ? Date.parse(deadlineValue) : null;
    if (deadlineValue && (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now())) {
      try { markDeepScanCapped(artifactRoot, 'security-review wall-clock limit reached before coordinator continuation'); } catch {}
      return false;
    }

    const rec = this.running.get(job.id);
    if (rec) {
      clearInterval(rec.heartbeat);
      if (rec.deadlineTimer) clearTimeout(rec.deadlineTimer);
      this.running.delete(job.id);
    }
    const reason = String(error || 'recoverable coordinator interruption');
    const prompt = securityReviewContinuationPrompt(job.prompt, { artifactRoot, reason });
    const stamp = nowIso();
    const queued = this.requeueInterruptedSecurityReview.run(prompt, stamp, job.id);
    if (!queued.changes) return false;
    if (job.goal_id) this.requeueInterruptedSecurityReviewGoal.run(stamp, job.goal_id);
    this.logEvent(job.goal_id, job.id, 'job_continuation_queued', `Queued durable coordinator continuation for ${job.id}.`, {
      reason,
      artifact_root: artifactRoot,
      deadline_at: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
      next_attempt: Number(job.attempts || 0) + 1,
    });
    setImmediate(() => this.tick());
    return true;
  }

  resumeInterruptedSecurityReviews() {
    let resumed = 0;
    this.reconcileStaleWorkerRuns.run(nowIso(), 'dashboard restarted before discovery worker returned');
    this.reconcileStaleWorkerAttempts.run(nowIso(), 'dashboard restarted before discovery worker returned');
    for (const job of this.recoverableSecurityReviewJobs.all()) {
      if (this._resumeInterruptedSecurityReview(job, job.error)) resumed += 1;
      else {
        this._terminalizeSecurityReview(job, 'failed', job.error || 'security review could not be resumed');
        if (job.goal_id) this.updateGoalStatus(job.goal_id, 'failed');
      }
    }
    return resumed;
  }

  ensureEngagement(target) {
    const sessionId = this.getInvestigationSessionId();
    const engagementId = `${engagementIdForTarget(target)}-${crypto.randomBytes(3).toString('hex')}`;
    this.insertEngagement.run(engagementId, sessionId, target, JSON.stringify([target]));
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

  enqueueSecurityReviewPath(localPath, {
    goalId = null,
    engagementId = null,
    contextMode = 'blind',
    maxDurationMinutes = null,
    discoveryConcurrency = 3,
    specialistConcurrency = 3,
    allowedModels = [],
    requireModelDiversity = true,
    modelDiversityWaiver = null,
  } = {}) {
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) throw new Error(`local path not found: ${abs}`);
    const goal = goalId ? this.getGoal(goalId) : this.createSecurityReviewGoal(abs, { source: 'slash' });
    const jobId = id('job');
    const engId = engagementId || goal.engagement_id || this.ensureEngagement(abs);
    const runtimeDir = path.dirname(path.dirname(this.db.name));
    const artifactRoot = securityReviewArtifactRoot(runtimeDir, engId);
    const inventory = generateSecurityReviewInventory({ repositoryPath: abs, artifactRoot });
    const run = initializeDeepScanRun(artifactRoot, {
      config: { maxDurationMinutes, discoveryConcurrency, specialistConcurrency },
      allowedModels,
      requireModelDiversity,
      modelDiversityWaiver,
    });
    const prompt = securityReviewCoordinatorPrompt({
      repositoryPath: abs,
      engagementId: engId,
      goalId: goal.id,
      artifactRoot,
      contextMode,
      deepScan: run.deepScan,
      modelPolicy: run.modelPolicy,
    });
    this.insertJob.run(jobId, goal.id, engId, 'glados', 'glados#security-review', 'security_review_workflow_v3', abs, prompt, nowIso());
    this.logEvent(goal.id, jobId, 'job_queued', `Queued staged source-code security review for ${abs}.`, {
      agent_id: 'glados', target: abs, workflow_version: 3, context_mode: contextMode, artifact_root: artifactRoot,
      repository_head: inventory.head, deadline_at: run.deepScan.deadlineAt, model_policy: run.modelPolicy,
    });
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

  _securityReviewProgress(job) {
    const runtimeDir = path.dirname(path.dirname(this.db.name));
    const artifactRoot = securityReviewArtifactRoot(runtimeDir, job.engagement_id);
    const exists = relative => fs.existsSync(path.join(artifactRoot, relative));
    const json = relative => {
      try { return JSON.parse(fs.readFileSync(path.join(artifactRoot, relative), 'utf8')); }
      catch { return null; }
    };
    const jsonlCount = relative => {
      try { return fs.readFileSync(path.join(artifactRoot, relative), 'utf8').split(/\r?\n/).filter(line => line.trim()).length; }
      catch { return 0; }
    };
    const run = json('run.json');
    const manifest = json('discovery/deep/manifest.json');
    const dedupe = json('discovery/deep/dedupe.json');
    const workers = jsonlCount('discovery/deep/workers.jsonl');
    const successfulWorkers = Array.isArray(dedupe?.input_worker_ids) ? dedupe.input_worker_ids.length : 0;
    const noNewStreak = Number.isInteger(dedupe?.no_new_streak) ? dedupe.no_new_streak : 0;
    const saturationTarget = Number(run?.deepScan?.stopAfterNoNew || 6);
    const terminalState = run?.deepScan?.terminalState || manifest?.status || 'RUNNING';
    const base = {
      phase: job.status === 'queued' ? 'Queued' : 'Initializing',
      detail: job.status === 'queued' ? 'Waiting for the review coordinator' : 'Preparing deterministic inventory',
      percent: job.status === 'queued' ? 0 : 3,
      workers,
      successfulWorkers,
      noNewStreak,
      saturationTarget,
      terminalState,
      deadlineAt: run?.deepScan?.deadlineAt || manifest?.deadline_at || null,
    };
    if (job.status === 'queued') return base;
    if (terminalState === 'CAPPED') return { ...base, phase: 'Capped', detail: run?.deepScan?.capReason || manifest?.cap_reason || 'Review limit reached', percent: 100 };
    if (!exists('context/threat-model.json')) return { ...base, phase: 'Threat modeling', detail: 'Deriving trust boundaries and attack hypotheses', percent: 10 };
    if (manifest?.status !== 'SATURATED') {
      return {
        ...base,
        phase: 'Blind discovery',
        detail: `${successfulWorkers} successful worker${successfulWorkers === 1 ? '' : 's'} · saturation ${noNewStreak}/${saturationTarget}`,
        percent: Math.min(40, 15 + successfulWorkers * 2),
      };
    }
    const tracks = [
      'authorization-access-control',
      'data-flow-injection',
      'secrets-history',
      'resilience-error-handling',
      'iac-config-manifests',
      'cryptography-suppressions',
    ];
    const completedTracks = tracks.filter(track => exists(`tracks/${track}/findings.jsonl`)).length;
    if (completedTracks < tracks.length) {
      return {
        ...base,
        phase: 'Specialist review',
        detail: `${completedTracks}/${tracks.length} specialist tracks complete`,
        percent: 45 + completedTracks * 5,
      };
    }
    const closure = exists('validation/candidate-closure.jsonl') && exists('validation/attack-paths.jsonl');
    if (!closure) return { ...base, phase: 'Candidate closure', detail: 'Validating candidates and attack paths', percent: 78 };
    const validator = exists('validation/semantic-coverage.json') && exists('validation/challenge-matrix.json');
    if (!validator) return { ...base, phase: 'Independent validation', detail: 'Challenging findings and searching for omissions', percent: 86 };
    if (!exists('validation/model-receipts.jsonl')) return { ...base, phase: 'Model attestation', detail: 'Reconciling LiteLLM request receipts', percent: 93 };
    if (!exists('completion-receipt.json') || !exists('scan-manifest.json')) return { ...base, phase: 'Sealing', detail: 'Verifying closure and final artifact digests', percent: 97 };
    return { ...base, phase: 'Finalizing', detail: 'All artifacts produced; controller gates are running', percent: 99 };
  }

  status({ pendingKickoff = null, activeAgents = [], targetHealth = [], plans = null, sessionId = null } = {}) {
    const securityReviews = sessionId
      ? this.activeSecurityReviewsBySession.all(sessionId).map(row => {
          const job = decodeRow(row);
          return { ...job, progress: this._securityReviewProgress(job) };
        })
      : [];
    return {
      goals: this.activeGoalsStmt.all().map(decodeRow),
      recentGoals: this.recentGoalsStmt.all().map(decodeRow),
      jobs: this.activeJobsStmt.all().map(decodeRow),
      securityReviews,
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
    const job = this.getJob(jobId);
    const queued = this.cancelQueued.run(nowIso(), nowIso(), jobId);
    if (queued.changes) {
      if (job?.job_type === 'security_review_workflow_v3') this._terminalizeSecurityReview(job, 'cancelled', 'cancelled by operator');
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
    this.resumeInterruptedSecurityReviews();
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
      if (rec.deadlineTimer) clearTimeout(rec.deadlineTimer);
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
      const sessionId = this.engagementSession.get(job.engagement_id)?.session_id || this.getInvestigationSessionId();
      let modelOverride = null;
      if (job.job_type === 'security_review_workflow_v3') {
        const artifactRoot = securityReviewArtifactRoot(path.dirname(path.dirname(this.db.name)), job.engagement_id);
        try {
          const models = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.modelPolicy?.allowedModels || [];
          if (models.length === 1) modelOverride = models[0];
        } catch {}
      }
      tracked = this.sendMessageToAgentTracked(job.agent_id, job.prompt, sessionId, {
        engagementId: job.engagement_id,
        controllerJobId: job.id,
        modelOverride,
      });
    } catch (e) {
      this._finishJob(job, 'failed', null, e.message);
      return;
    }
    const heartbeat = setInterval(() => {
      try { this.heartbeat.run(nowMs(), nowMs() + this.leaseMs, nowIso(), job.id); } catch {}
    }, 30_000);
    heartbeat.unref?.();
    const rec = { child: tracked.child, heartbeat, deadlineTimer: null, timedOut: false };
    this.running.set(job.id, rec);
    if (job.job_type === 'security_review_workflow_v3') {
      const runtimeDir = path.dirname(path.dirname(this.db.name));
      const artifactRoot = securityReviewArtifactRoot(runtimeDir, job.engagement_id);
      let deadlineMs = NaN;
      try { deadlineMs = Date.parse(JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.deepScan?.deadlineAt || ''); } catch {}
      if (Number.isFinite(deadlineMs)) {
        rec.deadlineTimer = setTimeout(() => {
          const current = this.getJob(job.id);
          if (!current || !RUNNING_STATUSES.includes(current.status)) return;
          rec.timedOut = true;
          const reason = 'security-review wall-clock limit reached before saturation';
          try { markDeepScanCapped(artifactRoot, reason); } catch {}
          try { rec.child?.kill('SIGTERM'); } catch {}
          this._finishJob(job, 'failed', { capped: true, artifactRoot }, reason);
        }, Math.max(0, deadlineMs - Date.now()));
        rec.deadlineTimer.unref?.();
      }
    }

    tracked.promise.then(result => {
      const current = this.getJob(job.id);
      const wasCancelled = current?.cancel_requested;
      if (!wasCancelled && result?.error && this._resumeInterruptedSecurityReview(current || job, result.error)) return;
      this._finishJob(job, wasCancelled ? 'cancelled' : result?.error ? 'failed' : 'succeeded', result, wasCancelled ? 'cancelled by operator' : result?.error || null);
    }).catch(err => {
      const current = this.getJob(job.id);
      const wasCancelled = current?.cancel_requested || err?.killed || err?.signal;
      if (!wasCancelled && this._resumeInterruptedSecurityReview(current || job, err?.message || err)) return;
      this._finishJob(job, wasCancelled ? 'cancelled' : 'failed', { stdout: err?.stdout, stderr: err?.stderr }, wasCancelled ? 'cancelled by operator' : err.message);
    });
  }

  _finishJob(job, status, result, error) {
    const current = this.getJob(job.id);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) return current;
    const rec = this.running.get(job.id);
    if (rec) {
      clearInterval(rec.heartbeat);
      if (rec.deadlineTimer) clearTimeout(rec.deadlineTimer);
      this.running.delete(job.id);
    }
    let finalStatus = status;
    let finalError = error || null;
    let finalResult = result;
    let gate = null;
    if (status === 'succeeded' && job.job_type === 'security_review_workflow_v3') {
      const runtimeDir = path.dirname(path.dirname(this.db.name));
      const artifactRoot = securityReviewArtifactRoot(runtimeDir, job.engagement_id);
      gate = sourceReviewGateStatus(artifactRoot, {
        authoritativeWorkerRuns: this.authoritativeWorkerRuns.all(job.engagement_id),
        authoritativeModelObservations: this.authoritativeModelObservations.all(job.engagement_id),
      });
      finalResult = result && typeof result === 'object'
        ? { ...result, securityReviewGate: gate }
        : { result: result || null, securityReviewGate: gate };
      if (!gate.passed) {
        finalStatus = 'failed';
        const failures = [...gate.missing.map(item => `missing ${item}`), ...gate.invalid].slice(0, 8);
        finalError = `security-review hard gates failed: ${failures.join('; ')}`;
      }
    }
    const stamp = nowIso();
    this.markDone.run(finalStatus, finalResult ? JSON.stringify(finalResult) : null, finalError, stamp, stamp, job.id);
    if (job.job_type === 'security_review_workflow_v3') this._terminalizeSecurityReview(job, finalStatus, finalError);
    if (job.job_type === 'security_review_workflow_v3') {
      const runtimeDir = path.dirname(path.dirname(this.db.name));
      const statusFile = path.join(runtimeDir, 'workspaces', 'agents', 'glados', 'AGENT-STATUS.md');
      try {
        if (fs.existsSync(statusFile)) fs.writeFileSync(statusFile, IDLE_AGENT_STATUS, { mode: 0o600 });
      } catch {}
    }
    if (job.goal_id) {
      const goalStatus = finalStatus === 'succeeded' ? 'complete' : finalStatus === 'cancelled' ? 'cancelled' : 'failed';
      this.updateGoalStatus(job.goal_id, goalStatus);
    }
    this.logEvent(job.goal_id, job.id, `job_${finalStatus}`, `${job.agent_id} job ${job.id} ${finalStatus}.`, {
      error: finalError,
      security_review_gate: gate,
    });
    return this.getJob(job.id);
  }

  _terminalizeSecurityReview(job, status, reason) {
    const stamp = nowIso();
    const taskStatus = status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    let artifactState = null;
    try {
      const artifactRoot = securityReviewArtifactRoot(path.dirname(path.dirname(this.db.name)), job.engagement_id);
      artifactState = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.deepScan?.terminalState;
      const cappedFailure = /wall-clock|deadline|attempt ceiling|maximum of \d+ attempts|terminated before completion/i.test(String(reason || ''));
      if (status === 'failed' && artifactState === 'RUNNING' && cappedFailure) {
        markDeepScanCapped(artifactRoot, reason || 'security-review terminated before completion');
        artifactState = 'CAPPED';
      }
    } catch {}
    const engagementStatus = status === 'succeeded' ? 'complete'
      : artifactState === 'CAPPED' || String(reason || '').includes('wall-clock limit') ? 'capped'
        : status === 'cancelled' ? 'cancelled' : 'failed';
    const tx = this.db.transaction(() => {
      this.reconcileTasks.run(taskStatus, reason || `controller job ${status}`, stamp, job.engagement_id);
      this.finishEngagement.run(engagementStatus, stamp, job.engagement_id);
    });
    tx();
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
