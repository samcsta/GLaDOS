const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  securityReviewArtifactRoot,
  securityReviewCoordinatorPrompt,
} = require('./security-review/workflow');
const { generateSecurityReviewInventory, verifySecurityReviewInventory } = require('./security-review/inventory');
const { findPriorSecurityReview, writePriorContext } = require('./security-review/prior-review');
const {
  buildSecurityReviewCampaign,
  expeditedDeepScanConfig,
} = require('./security-review/campaign');
const {
  discoverySaturationCheckpoint,
  ensureDiscoverySaturated,
  initializeDeepScanRun,
  markDeepScanCapped,
  markDeepScanSaturated,
  projectSecurityReviewLedgers,
  reconcileInvalidSuccessfulDiscoveryWorkers,
  REQUIRED_MODEL_ROLES,
} = require('./security-review/deep-scan');
const { finalizeSecurityReview, invalidateSecurityReviewSeal, revalidateSecurityReview } = require('./security-review/finalize');

const RUNNING_STATUSES = ['running', 'cancelling'];
// Security-review coordinator turns are finite, but the durable workflow is
// completion-driven. A max-turn interruption resumes the same artifacts and
// must not become an implicit campaign cutoff.
const SECURITY_REVIEW_MAX_CONTINUATIONS = null;
const SECURITY_REVIEW_CONTRACT = 'controller/workflow-contract.txt';

function isRecoverableCoordinatorInterruption(error) {
  return /maximum number of turns|reached max(?:imum)? turns|dashboard restarted before worker-owned job finished|security review incomplete|Agent SDK ended without meaningful model or tool activity|Agent SDK produced no messages .* active turn|connection closed mid-response|premature(?:ly)? closed response|(?:API Error:\s*)?(?:429|50[0-4])\b|could not reach LiteLLM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|upstream (?:connect|request|timeout)/i
    .test(String(error || ''));
}

function isTransientGatewayInterruption(error) {
  return /connection closed mid-response|premature(?:ly)? closed response|(?:API Error:\s*)?(?:429|50[0-4])\b|could not reach LiteLLM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|upstream (?:connect|request|timeout)/i
    .test(String(error || ''));
}

function activeSecurityReviewRun(artifactRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.deepScan?.terminalState === 'RUNNING';
  } catch { return false; }
}

function securityReviewCheckpoint(db, engagementId, artifactRoot) {
  const files = [
    'run.json',
    'discovery/deep/manifest.json',
    'discovery/deep/workers.jsonl',
    'discovery/deep/dedupe.json',
    'discovery/findings.jsonl',
    'discovery/coverage-ledger.jsonl',
    'tracks/authorization-access-control/findings.jsonl',
    'tracks/data-flow-injection/findings.jsonl',
    'tracks/secrets-history/findings.jsonl',
    'tracks/resilience-error-handling/findings.jsonl',
    'tracks/iac-config-manifests/findings.jsonl',
    'tracks/cryptography-suppressions/findings.jsonl',
    'tracks/authorization-access-control/route-authz-matrix.jsonl',
    'tracks/data-flow-injection/source-sink-matrix.jsonl',
    'tracks/secrets-history/sensitive-data-dispositions.jsonl',
    'tracks/resilience-error-handling/http-client-matrix.jsonl',
    'tracks/iac-config-manifests/disposition-matrix.jsonl',
    'tracks/cryptography-suppressions/crypto-matrix.jsonl',
    'tracks/cryptography-suppressions/suppression-dispositions.jsonl',
    'validation/new-candidates.jsonl',
    'validation/candidate-closure.jsonl',
    'validation/attack-paths.jsonl',
    'validation/challenge-matrix.json',
    'validation/semantic-coverage.json',
    'dynamic-validation/matrix.jsonl',
  ].map(relative => {
    try {
      const bytes = fs.readFileSync(path.join(artifactRoot, relative));
      return [relative, crypto.createHash('sha256').update(bytes).digest('hex')];
    } catch { return [relative, null]; }
  });
  const workers = db.prepare(`
    SELECT status, COUNT(*) AS n FROM security_review_worker_runs
    WHERE engagement_id=? GROUP BY status ORDER BY status
  `).all(engagementId);
  const roles = db.prepare(`
    SELECT DISTINCT review_role FROM security_review_model_observations
    WHERE engagement_id=? AND review_role IS NOT NULL ORDER BY review_role
  `).all(engagementId).map(row => row.review_role);
  return crypto.createHash('sha256').update(JSON.stringify({ files, workers, roles })).digest('hex');
}

function readJsonLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

function exactSetStatus(artifactRoot, inventoryRelative, matrixRelative) {
  const inventory = readJsonLines(path.join(artifactRoot, inventoryRelative));
  const matrix = readJsonLines(path.join(artifactRoot, matrixRelative));
  return {
    inventory_rows: inventory.length,
    matrix_rows: matrix.length,
    exact_key_and_order_equality: inventory.length === matrix.length
      && inventory.every((row, index) => row.key === matrix[index]?.inventory_key),
  };
}

function findingClosureStatus(artifactRoot) {
  const ids = new Set();
  for (const relative of [
    'discovery/findings.jsonl',
    'tracks/authorization-access-control/findings.jsonl',
    'tracks/data-flow-injection/findings.jsonl',
    'tracks/secrets-history/findings.jsonl',
    'tracks/resilience-error-handling/findings.jsonl',
    'tracks/iac-config-manifests/findings.jsonl',
    'tracks/cryptography-suppressions/findings.jsonl',
  ]) for (const row of readJsonLines(path.join(artifactRoot, relative))) {
    const id = row.finding_id || row.id;
    if (id) ids.add(id);
  }
  const closed = new Set();
  for (const row of readJsonLines(path.join(artifactRoot, 'validation/candidate-closure.jsonl'))) {
    if (row.candidate_id) closed.add(row.candidate_id);
    if (String(row.disposition || '').toUpperCase() === 'REPORTABLE') for (const id of row.finding_ids || []) closed.add(id);
  }
  return [...ids].filter(id => !closed.has(id)).sort();
}

function missingModelRoles(db, engagementId) {
  const observed = new Set(db.prepare(`
    SELECT DISTINCT review_role FROM security_review_model_observations
    WHERE engagement_id=? AND review_role IS NOT NULL
  `).all(engagementId).map(row => row.review_role));
  return REQUIRED_MODEL_ROLES.filter(role => !observed.has(role));
}

function persistSecurityReviewContract(artifactRoot, prompt) {
  const file = path.join(artifactRoot, SECURITY_REVIEW_CONTRACT);
  if (fs.existsSync(file)) return file;
  const text = String(prompt || '');
  const contractAt = text.indexOf('SOURCE SECURITY REVIEW WORKFLOW v4');
  const contract = contractAt >= 0 ? text.slice(contractAt) : text;
  if (!contract.trim()) throw new Error('security-review workflow contract is unavailable');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, contract.endsWith('\n') ? contract : `${contract}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return file;
}

function securityReviewContinuationPrompt(prompt, { artifactRoot, reason, lifecycleState = 'RUNNING', missingRoles = [] }) {
  const contractFile = persistSecurityReviewContract(artifactRoot, prompt);
  const instructions = lifecycleState === 'SATURATED'
      ? [
        'Discovery is already SATURATED. Do not dispatch another discovery worker and do not change the saturation proof.',
        'Correct only the incomplete or invalid model-owned terminal artifacts named in continuation_reason, then return for controller finalization.',
        'findings.json, observations.json, coverage.json, validation/model-receipts.jsonl, scan-manifest.json, and completion-receipt.json are controller-owned projections. Never edit them; repair the cited discovery, specialist, candidate-closure, attack-path, or semantic-coverage source row instead.',
      ]
    : [
        'Validate the existing terminal worker chain, compute the next sequential worker ID, and continue from that exact checkpoint. Never reuse a terminal worker ID or count this coordinator continuation as a discovery worker failure.',
        'If a worker is FAILED or CANCELED and lacks a successful retry, dispatch a new next-sequential worker with a standalone retry_of: worker-NNN line naming that failed worker. Retry unresolved workers before ordinary discovery; do not edit their receipt-bound artifacts.',
        'For each completed batch, write the complete canonical discovery/candidates.jsonl first and wait for success, then write discovery/deep/dedupe.json last and wait for success. Dispatch the next batch only in a later assistant response; never race dispatch against aggregation writes.',
        'Leave run.json.deepScan.terminalState and discovery/deep/manifest.json.status RUNNING after proving the no-new streak. The harness atomically transitions both to SATURATED when the first post-discovery role is dispatched.',
        'Keep the original blind-context prohibition and original wall-clock deadline. Existing candidates from this engagement may be used only for centralized deduplication and closure; never disclose them to later blind-discovery workers.',
      ];
  const routes = exactSetStatus(artifactRoot, 'inventory/routes.jsonl', 'tracks/authorization-access-control/route-authz-matrix.jsonl');
  const cryptoMatrix = exactSetStatus(artifactRoot, 'inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl');
  const missingFindingClosure = findingClosureStatus(artifactRoot);
  return [
    'SECURITY REVIEW WORKFLOW v4 — DURABLE COORDINATOR CONTINUATION',
    `artifact_root: ${artifactRoot}`,
    `workflow_contract: ${contractFile}`,
    `continuation_reason: ${String(reason || '').slice(0, 6000)}`,
    '',
    'Resume this same engagement from its durable artifacts. Do not initialize a new run, engagement, inventory, manifest, or deadline.',
    'The full immutable workflow contract is in workflow_contract. Read it if the resumed SDK context is unavailable; do not copy it into another prompt or response.',
    'Read run.json, discovery/deep/manifest.json, discovery/deep/workers.jsonl, discovery/deep/dedupe.json, validation/runtime-model-observations.jsonl, and the existing blackboard tasks before acting.',
    fs.existsSync(path.join(artifactRoot, 'controller', 'preflight.json'))
      ? 'Read controller/preflight.json first. It is the controller-owned complete blocker set for this checkpoint; repair all listed model-owned artifacts in one pass.'
      : 'No controller preflight file exists for this checkpoint.',
    ...instructions,
    `Controller-verified route matrix status: ${JSON.stringify(routes)}.`,
    `Controller-verified crypto matrix status: ${JSON.stringify(cryptoMatrix)}.`,
    routes.exact_key_and_order_equality && cryptoMatrix.exact_key_and_order_equality
      ? 'The route and crypto exact-set gates are already satisfied. Do not rewrite those matrices, infer counts from displayed line indexes, or report them as blockers.'
      : 'Only repair an exact-set matrix that the controller status above marks false; preserve inventory identity and ordinal order.',
    missingRoles.length
      ? `Missing authoritative model-role observations: ${missingRoles.join(', ')}. Dispatch each listed role exactly once using its canonical security_review_role solely to create authoritative runtime evidence. Preserve already complete artifacts; the role must verify them and return without rewriting exact-set matrices unless it finds concrete evidence they are invalid.`
      : 'All required review roles already have authoritative runtime observations; do not dispatch a specialist solely for model receipt evidence.',
    missingFindingClosure.length
      ? `Current mandatory source-finding closure gap: ${missingFindingClosure.join(', ')}. Dispatch source-review-validator to give every listed ID one terminal challenge outcome, one candidate-closure row, and one attack-path row. Preserve evidence and choose REPORTABLE, OBSERVATION, SUPPRESSED, or NOT_APPLICABLE from source evidence; do not default all rows to one disposition.`
      : 'The controller found no source-finding closure gap at continuation dispatch time.',
    'Every validation/new-candidates.jsonl row must have exactly one NEW challenge outcome with the same candidate_id. Repair identity mismatches without inventing another alias.',
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
    onSecurityReviewCompleted = null,
    workerId = `dashboard-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrent = Number(process.env.GLADOS_CONTROLLER_MAX_CONCURRENT || 3),
    leaseMs = Number(process.env.GLADOS_CONTROLLER_LEASE_MS || 20 * 60 * 1000),
    finalizationRetryMs = Number(process.env.GLADOS_SECURITY_REVIEW_FINALIZATION_RETRY_MS || 250),
    finalizationTimeoutMs = Number(process.env.GLADOS_SECURITY_REVIEW_FINALIZATION_TIMEOUT_MS || 2 * 60 * 1000),
    transientRetryBaseMs = Number(process.env.GLADOS_SECURITY_REVIEW_TRANSIENT_RETRY_BASE_MS || 2_000),
    transientRetryMaxMs = Number(process.env.GLADOS_SECURITY_REVIEW_TRANSIENT_RETRY_MAX_MS || 30_000),
    transientRetryLimit = Number(process.env.GLADOS_SECURITY_REVIEW_TRANSIENT_RETRY_LIMIT || 8),
  }) {
    this.db = openControllerDb(dbPath);
    this.sendMessageToAgentTracked = sendMessageToAgentTracked;
    this.currentSessionForAgent = currentSessionForAgent;
    this.getInvestigationSessionId = getInvestigationSessionId;
    this.onSecurityReviewCompleted = onSecurityReviewCompleted;
    this.workerId = workerId;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.leaseMs = Math.max(60_000, leaseMs);
    this.finalizationRetryMs = Math.max(10, finalizationRetryMs);
    this.finalizationTimeoutMs = Math.max(this.finalizationRetryMs, finalizationTimeoutMs);
    this.transientRetryBaseMs = Math.max(10, transientRetryBaseMs);
    this.transientRetryMaxMs = Math.max(this.transientRetryBaseMs, transientRetryMaxMs);
    this.transientRetryLimit = Math.max(1, transientRetryLimit);
    this.running = new Map(); // jobId -> { child, heartbeat }
    this.finalizationState = new Map(); // jobId -> { startedAt, attempts }
    this.transientRetryTimers = new Map(); // jobId -> timer
    this.securityReviewCompletionNotified = new Set();
    this.timer = null;
    this._prepare();
  }

  _notifySecurityReviewCompleted(jobOrEngagementId) {
    const engagementId = typeof jobOrEngagementId === 'string'
      ? jobOrEngagementId : jobOrEngagementId?.engagement_id;
    if (!engagementId || this.securityReviewCompletionNotified.has(engagementId)) return;
    this.securityReviewCompletionNotified.add(engagementId);
    if (typeof process.send === 'function') {
      try { process.send({ type: 'glados-security-review-deliverables-ready', engagementId }); } catch {}
    }
    if (typeof this.onSecurityReviewCompleted === 'function') {
      try {
        this.onSecurityReviewCompleted({
          engagementId,
          jobId: typeof jobOrEngagementId === 'object' ? jobOrEngagementId?.id || null : null,
          sessionId: this.engagementSession.get(engagementId)?.session_id || null,
        });
      } catch {}
    }
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
      SELECT g.* FROM controller_goals g JOIN engagements e ON e.id=g.engagement_id
      WHERE g.status IN ('active','pending_approval','queued','running') AND e.session_id=?
      ORDER BY g.updated_at DESC, g.created_at DESC
      LIMIT 50
    `);
    this.recentGoalsStmt = this.db.prepare(`
      SELECT g.* FROM controller_goals g JOIN engagements e ON e.id=g.engagement_id
      WHERE e.session_id=?
      ORDER BY g.updated_at DESC, g.created_at DESC
      LIMIT 20
    `);
    this.activeJobsStmt = this.db.prepare(`
      SELECT j.* FROM controller_jobs j JOIN engagements e ON e.id=j.engagement_id
      WHERE j.status IN ('queued','running','cancelling') AND e.session_id=?
      ORDER BY j.created_at ASC
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
      SELECT j.* FROM controller_jobs j JOIN engagements e ON e.id=j.engagement_id
      WHERE j.status = 'failed' AND e.session_id=?
      ORDER BY j.updated_at DESC
      LIMIT 10
    `);
    this.eventsSinceStmt = this.db.prepare(`
      SELECT event.* FROM controller_events event
      LEFT JOIN controller_jobs job ON job.id=event.job_id
      LEFT JOIN controller_goals goal ON goal.id=event.goal_id
      LEFT JOIN engagements e ON e.id=COALESCE(job.engagement_id, goal.engagement_id)
      WHERE event.id > ? AND e.session_id=?
      ORDER BY event.id ASC
      LIMIT ?
    `);
    this.jobById = this.db.prepare('SELECT * FROM controller_jobs WHERE id = ?');
    this.securityReviewJobByEngagement = this.db.prepare(`
      SELECT * FROM controller_jobs
      WHERE engagement_id=? AND job_type='security_review_workflow_v3'
      ORDER BY created_at DESC LIMIT 1
    `);
    this.jobByIdAndSession = this.db.prepare(`
      SELECT j.* FROM controller_jobs j JOIN engagements e ON e.id=j.engagement_id WHERE j.id=? AND e.session_id=?
    `);
    this.engagementSession = this.db.prepare('SELECT session_id FROM engagements WHERE id = ?');
    this.authoritativeWorkerRuns = this.db.prepare(`
      SELECT * FROM security_review_worker_runs WHERE engagement_id=? ORDER BY sequence
    `);
    this.authoritativeModelObservations = this.db.prepare(`
      SELECT observation_id, engagement_id, controller_job_id, agent_id, review_role, worker_id, worker_tool_call_id,
             requested_model, actual_model, billed_model_name, source, request_id, gateway_model_id, cost_usd,
             logical_model_alias, provider_model, attestation_level, gateway_call_id, observed_at
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
      SELECT q.*
      FROM controller_jobs AS q
      JOIN engagements AS queued_engagement ON queued_engagement.id=q.engagement_id
      WHERE q.status='queued'
        AND q.cancel_requested=0
        AND NOT EXISTS (
          SELECT 1
          FROM controller_jobs AS r
          JOIN engagements AS running_engagement ON running_engagement.id=r.engagement_id
          WHERE r.agent_id=q.agent_id
            AND r.status IN ('running','cancelling')
            AND running_engagement.session_id=queued_engagement.session_id
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
    this.markSecurityReviewFinalizing = this.db.prepare(`
      UPDATE controller_jobs
      SET status='running', error=NULL, finished_at=NULL, lease_owner=?, lease_expires_at=?,
          heartbeat_at=?, updated_at=?
      WHERE id=? AND status IN ('running','failed') AND cancel_requested=0
    `);
    this.recoverableSecurityReviewJobs = this.db.prepare(`
      SELECT * FROM controller_jobs
      WHERE status='failed' AND job_type='security_review_workflow_v3' AND cancel_requested=0
      ORDER BY updated_at ASC
    `);
    this.latestFailedSecurityReviewBySession = this.db.prepare(`
      SELECT j.* FROM controller_jobs AS j
      JOIN engagements AS e ON e.id=j.engagement_id
      WHERE e.session_id=? AND j.status='failed'
        AND j.job_type='security_review_workflow_v3' AND j.cancel_requested=0
      ORDER BY j.updated_at DESC LIMIT 1
    `);
    this.transientRetryCount = this.db.prepare(`
      SELECT COUNT(*) AS n FROM controller_events
      WHERE job_id=? AND event_type='security_review_transient_retry_scheduled'
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
    this.lastContinuation = this.db.prepare(`
      SELECT data_json FROM controller_events
      WHERE job_id=? AND event_type='job_continuation_queued'
      ORDER BY id DESC LIMIT 1
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

  _resumeInterruptedSecurityReview(job, error, { force = false } = {}) {
    if (job?.job_type !== 'security_review_workflow_v3') return false;
    if (!isRecoverableCoordinatorInterruption(error)) return false;
    if (SECURITY_REVIEW_MAX_CONTINUATIONS != null
        && Number(job.attempts || 0) >= SECURITY_REVIEW_MAX_CONTINUATIONS) return false;

    const transientGatewayFailure = isTransientGatewayInterruption(error);
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
    if (['RUNNING', 'SATURATED'].includes(run?.deepScan?.terminalState)
        && ['RUNNING', 'SATURATED'].includes(manifest?.status)
        && run.deepScan.terminalState !== manifest.status) {
      const transition = ensureDiscoverySaturated(artifactRoot);
      if (transition.passed) {
        try {
          run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
          manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'discovery', 'deep', 'manifest.json'), 'utf8'));
        } catch { return false; }
      }
    }
    const deadlineValue = run?.deepScan?.deadlineAt || manifest?.deadline_at || null;
    const deadlineMs = deadlineValue ? Date.parse(deadlineValue) : null;
    if (deadlineValue && (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now())) {
      try { markDeepScanCapped(artifactRoot, 'security-review wall-clock limit reached before coordinator continuation'); } catch {}
      return false;
    }
    if (force && run?.deepScan?.terminalState === 'FAILED' && manifest?.status === 'FAILED') {
      try {
        reopenFailedDeepScan(artifactRoot, run, manifest);
        this.logEvent(job.goal_id, job.id, 'security_review_lifecycle_reopened',
          `Reopened failed security-review lifecycle for explicit recovery of ${job.id}.`, {
            prior_failure_reason: run?.deepScan?.failureReason || manifest?.failure_reason || null,
          });
      } catch {
        return false;
      }
    }
    const lifecycleState = run?.deepScan?.terminalState;
    if (lifecycleState !== manifest?.status || !['RUNNING', 'SATURATED'].includes(lifecycleState)) return false;

    let reconciledInvalidWorkers = [];
    try {
      reconciledInvalidWorkers = reconcileInvalidSuccessfulDiscoveryWorkers({
        dbPath: this.db.name,
        artifactRoot,
        engagementId: job.engagement_id,
      });
      if (reconciledInvalidWorkers.length) {
        projectSecurityReviewLedgers({ db: this.db, artifactRoot, engagementId: job.engagement_id });
      }
    } catch (reconciliationError) {
      console.warn('[security-review] could not reconcile invalid terminal workers:', reconciliationError.message);
    }

    const rec = this.running.get(job.id);
    if (rec) {
      clearInterval(rec.heartbeat);
      if (rec.deadlineTimer) clearTimeout(rec.deadlineTimer);
      if (rec.finalizationTimer) clearTimeout(rec.finalizationTimer);
      this.running.delete(job.id);
    }
    this.finalizationState.delete(job.id);
    const reason = [
      String(error || 'recoverable coordinator interruption'),
      reconciledInvalidWorkers.length
        ? `controller demoted schema-invalid successful workers for sequential retry: ${reconciledInvalidWorkers.join(', ')}`
        : null,
    ].filter(Boolean).join('; ');
    const checkpoint = securityReviewCheckpoint(this.db, job.engagement_id, artifactRoot);
    let previousCheckpoint = null;
    try { previousCheckpoint = JSON.parse(this.lastContinuation.get(job.id)?.data_json || '{}').checkpoint || null; } catch {}
    if (previousCheckpoint === checkpoint && !transientGatewayFailure && !force) return false;
    const prompt = securityReviewContinuationPrompt(job.prompt, {
      artifactRoot,
      reason,
      lifecycleState,
      missingRoles: missingModelRoles(this.db, job.engagement_id),
    });
    const queueContinuation = () => {
      this.transientRetryTimers.delete(job.id);
      const stamp = nowIso();
      const queued = this.requeueInterruptedSecurityReview.run(prompt, stamp, job.id);
      if (!queued.changes) return false;
      if (job.goal_id) this.requeueInterruptedSecurityReviewGoal.run(stamp, job.goal_id);
      this.logEvent(job.goal_id, job.id, 'job_continuation_queued', `Queued durable coordinator continuation for ${job.id}.`, {
        reason,
        artifact_root: artifactRoot,
        deadline_at: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
        next_attempt: Number(job.attempts || 0) + 1,
        checkpoint,
      });
      setImmediate(() => this.tick());
      return true;
    };
    if (transientGatewayFailure) {
      const priorRetries = Number(this.transientRetryCount.get(job.id)?.n || 0);
      if (priorRetries >= this.transientRetryLimit) return false;
      const exponential = Math.min(this.transientRetryMaxMs, this.transientRetryBaseMs * (2 ** Math.min(priorRetries, 8)));
      const jitter = Math.floor(exponential * 0.2 * Math.random());
      const delayMs = exponential + jitter;
      this.logEvent(job.goal_id, job.id, 'security_review_transient_retry_scheduled',
        `Transient gateway failure; retrying ${job.id} from its durable checkpoint.`, {
          reason, retry_number: priorRetries + 1, retry_limit: this.transientRetryLimit,
          delay_ms: delayMs, checkpoint,
        });
      const timer = setTimeout(queueContinuation, delayMs);
      timer.unref?.();
      this.transientRetryTimers.set(job.id, timer);
      return true;
    }
    if (!queueContinuation()) return false;
    return true;
  }

  resumeLatestRecoverableSecurityReviewForSession(sessionId) {
    const raw = this.latestFailedSecurityReviewBySession.get(sessionId);
    if (!raw) return { ok: false, error: 'no failed security review is available to resume' };
    const job = decodeRow(raw);
    if (SECURITY_REVIEW_MAX_CONTINUATIONS != null
        && Number(job.attempts || 0) >= SECURITY_REVIEW_MAX_CONTINUATIONS) {
      const previousAttempts = Number(job.attempts || 0);
      const stamp = nowIso();
      this.db.prepare(`
        UPDATE controller_jobs SET attempts=0, updated_at=?
        WHERE id=? AND status='failed'
      `).run(stamp, job.id);
      job.attempts = 0;
      this.logEvent(job.goal_id, job.id, 'security_review_continuation_budget_reset',
        `Operator-requested recovery reset the continuation budget for ${job.id}.`, {
          previous_attempts: previousAttempts,
          reason: 'explicit operator resume',
        });
    }
    const artifactRoot = securityReviewArtifactRoot(path.dirname(path.dirname(this.db.name)), job.engagement_id);
    const goal = job.goal_id ? this.getGoal(job.goal_id) : null;
    let revalidated = null;
    try {
      revalidated = revalidateSecurityReview({
        db: this.db, artifactRoot, engagementId: job.engagement_id,
        campaignExpected: goal?.metadata?.campaign === true,
      });
    } catch {}
    if (revalidated?.passed) {
      this._notifySecurityReviewCompleted(job);
      return { ok: true, completed: true, jobId: job.id, engagementId: job.engagement_id };
    }
    if (revalidated?.retryMode === 'controller'
        && this._scheduleSecurityReviewFinalization(job, null, revalidated)) {
      return { ok: true, resumed: true, jobId: job.id, engagementId: job.engagement_id };
    }
    const reason = job.error
      ? `security review incomplete: ${job.error}`
      : 'security review incomplete: operator requested controller resume';
    if (this._resumeInterruptedSecurityReview(job, reason, { force: true })) {
      return { ok: true, resumed: true, jobId: job.id, engagementId: job.engagement_id };
    }
    return { ok: false, error: 'the failed security review has no recoverable durable checkpoint', jobId: job.id };
  }

  _scheduleSecurityReviewFinalization(job, coordinatorResult, finalization) {
    const current = this.getJob(job.id);
    if (!current || current.cancel_requested || ['succeeded', 'cancelled'].includes(current.status)) return false;
    const previous = this.running.get(job.id);
    const state = this.finalizationState.get(job.id) || { startedAt: Date.now(), attempts: 0 };
    const startedAt = state.startedAt;
    const attempts = Number(state.attempts || 0);
    if (previous) {
      clearInterval(previous.heartbeat);
      if (previous.deadlineTimer) clearTimeout(previous.deadlineTimer);
      if (previous.finalizationTimer) clearTimeout(previous.finalizationTimer);
      this.running.delete(job.id);
    }
    if (Date.now() - startedAt >= this.finalizationTimeoutMs) {
      const blockers = (finalization?.blockers || []).join('; ');
      this._finishJob(current, 'failed', coordinatorResult,
        `security-review controller finalization timed out waiting for runtime settlement${blockers ? `: ${blockers}` : ''}`);
      return false;
    }
    const stamp = nowIso();
    const leaseUntil = nowMs() + this.leaseMs;
    const marked = this.markSecurityReviewFinalizing.run(this.workerId, leaseUntil, nowMs(), stamp, job.id);
    if (!marked.changes) return false;
    const heartbeat = setInterval(() => {
      try { this.heartbeat.run(nowMs(), nowMs() + this.leaseMs, nowIso(), job.id); } catch {}
    }, 30_000);
    heartbeat.unref?.();
    const delay = Math.min(5_000, this.finalizationRetryMs * (2 ** Math.min(attempts, 5)));
    const rec = {
      child: null,
      heartbeat,
      deadlineTimer: null,
      finalizationTimer: null,
      finalizing: true,
      finalizationStartedAt: startedAt,
      finalizationAttempts: attempts + 1,
    };
    this.finalizationState.set(job.id, { startedAt, attempts: attempts + 1 });
    rec.finalizationTimer = setTimeout(() => {
      const refreshed = this.getJob(job.id);
      if (!refreshed || refreshed.cancel_requested || refreshed.status !== 'running') return;
      this._finishJob(refreshed, 'succeeded', coordinatorResult, null);
    }, delay);
    rec.finalizationTimer.unref?.();
    this.running.set(job.id, rec);
    if (attempts === 0) {
      this.logEvent(job.goal_id, job.id, 'security_review_finalization_waiting',
        `Waiting for authoritative runtime settlement before sealing ${job.engagement_id}.`, {
          phase: finalization?.phase || 'runtime-settlement',
          blockers: finalization?.blockers || [],
        });
    }
    return true;
  }

  resumeInterruptedSecurityReviews() {
    let resumed = 0;
    this.reconcileStaleWorkerRuns.run(nowIso(), 'dashboard restarted before discovery worker returned');
    this.reconcileStaleWorkerAttempts.run(nowIso(), 'dashboard restarted before discovery worker returned');
    for (const job of this.recoverableSecurityReviewJobs.all()) {
      const artifactRoot = securityReviewArtifactRoot(path.dirname(path.dirname(this.db.name)), job.engagement_id);
      const goal = job.goal_id ? this.getGoal(job.goal_id) : null;
      let revalidated = null;
      try {
        revalidated = revalidateSecurityReview({
          db: this.db,
          artifactRoot,
          engagementId: job.engagement_id,
          campaignExpected: goal?.metadata?.campaign === true,
        });
      } catch {}
      if (revalidated?.passed) {
        this._notifySecurityReviewCompleted(job);
        continue;
      }
      if (revalidated?.retryMode === 'controller'
          && this._scheduleSecurityReviewFinalization(job, null, revalidated)) {
        resumed += 1;
        continue;
      }
      if (this._resumeInterruptedSecurityReview(job, job.error)) resumed += 1;
      else {
        this._terminalizeSecurityReview(job, 'failed', job.error || 'security review could not be resumed');
        if (job.goal_id) this.updateGoalStatus(job.goal_id, 'failed');
      }
    }
    return resumed;
  }

  revalidateSecurityReviewAfterAuthorityChange(engagementId) {
    const rawJob = this.securityReviewJobByEngagement.get(engagementId);
    if (!rawJob) return { passed: false, retryMode: 'none', blockers: ['security-review job not found'] };
    const job = decodeRow(rawJob);
    if (RUNNING_STATUSES.includes(job.status)) {
      return { passed: false, retryMode: 'controller', blockers: ['active coordinator turn will finalize the changed authority state'] };
    }
    const artifactRoot = securityReviewArtifactRoot(path.dirname(path.dirname(this.db.name)), engagementId);
    const goal = job.goal_id ? this.getGoal(job.goal_id) : null;
    const result = revalidateSecurityReview({
      db: this.db,
      artifactRoot,
      engagementId,
      campaignExpected: goal?.metadata?.campaign === true,
    });
    if (result.passed) {
      this._notifySecurityReviewCompleted(job);
      return result;
    }
    const stamp = nowIso();
    const reason = `authoritative runtime state changed after sealing: ${(result.blockers || []).join('; ')}`;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE controller_jobs SET status='failed', error=?, finished_at=?, updated_at=?
        WHERE id=? AND status='succeeded' AND cancel_requested=0`).run(reason, stamp, stamp, job.id);
      if (job.goal_id) this.db.prepare(`UPDATE controller_goals SET status='queued', completed_at=NULL, updated_at=?
        WHERE id=? AND status!='cancelled'`).run(stamp, job.goal_id);
      this.db.prepare("UPDATE engagements SET status='active', completed_at=NULL WHERE id=?").run(engagementId);
    })();
    const reopened = this.getJob(job.id);
    if (result.retryMode === 'controller'
        && this._scheduleSecurityReviewFinalization(reopened, null, result)) return result;
    if (result.retryMode === 'model'
        && this._resumeInterruptedSecurityReview(reopened, `security review incomplete: ${reason}`)) return result;
    this._terminalizeSecurityReview(reopened, 'failed', reason);
    if (job.goal_id) this.updateGoalStatus(job.goal_id, 'failed');
    return result;
  }

  ensureEngagement(target, sessionId = null) {
    const ownedSessionId = sessionId || this.getInvestigationSessionId();
    const engagementId = `${engagementIdForTarget(target)}-${crypto.randomBytes(3).toString('hex')}`;
    this.insertEngagement.run(engagementId, ownedSessionId, target, JSON.stringify([target]));
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
    contextMode = 'auto',
    maxDurationMinutes = null,
    discoveryConcurrency = 3,
    specialistConcurrency = 3,
    allowedModels = [],
    expectedModels = {},
    requireModelDiversity = true,
    modelDiversityWaiver = null,
    reviewProfile = 'comprehensive',
    campaignMode = false,
    sessionId = null,
  } = {}) {
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) throw new Error(`local path not found: ${abs}`);
    const profile = reviewProfile === 'expedited' ? 'expedited' : 'comprehensive';
    if (campaignMode && profile !== 'expedited') throw new Error('security-review campaign requires the expedited profile');
    const campaign = campaignMode ? buildSecurityReviewCampaign(abs) : null;
    const goal = goalId ? this.getGoal(goalId) : this.createSecurityReviewGoal(abs, {
      source: 'slash',
      review_profile: profile,
      campaign: campaignMode,
    }, sessionId);
    const jobId = id('job');
    const engId = engagementId || goal.engagement_id || this.ensureEngagement(abs);
    const runtimeDir = path.dirname(path.dirname(this.db.name));
    const artifactRoot = securityReviewArtifactRoot(runtimeDir, engId);
    const inventory = generateSecurityReviewInventory({ repositoryPath: abs, artifactRoot });
    const scanConfig = profile === 'expedited'
      ? expeditedDeepScanConfig(campaign?.repository_count || 0, {
          maxDurationMinutes,
          discoveryConcurrency,
          specialistConcurrency,
        })
      : { maxDurationMinutes, discoveryConcurrency, specialistConcurrency };
    const run = initializeDeepScanRun(artifactRoot, {
      config: scanConfig,
      allowedModels,
      expectedModels,
      requireModelDiversity,
      modelDiversityWaiver,
      reviewProfile: profile,
      campaign,
    });
    const requestedContextMode = ['auto', 'blind', 'regression', 'informed'].includes(contextMode) ? contextMode : 'auto';
    let priorContext = null;
    if (requestedContextMode !== 'blind') {
      priorContext = findPriorSecurityReview({
        investigationsRoot: path.join(runtimeDir, 'investigations'),
        repositoryPath: abs,
        remote: inventory.remote,
        excludeEngagementId: engId,
      });
    }
    const resolvedContextMode = requestedContextMode === 'auto'
      ? (priorContext ? 'informed' : 'blind')
      : requestedContextMode;
    if (['informed', 'regression'].includes(resolvedContextMode) && !priorContext) {
      throw new Error(`${resolvedContextMode} security review requires a sealed prior review matched by canonical repository path or remote URL`);
    }
    if (priorContext) writePriorContext(artifactRoot, priorContext);
    run.requestedContextMode = requestedContextMode;
    run.contextMode = resolvedContextMode;
    run.priorContext = priorContext ? {
      status: 'AVAILABLE',
      artifact: 'regression/prior-context.json',
      priorEngagementId: priorContext.prior_engagement_id,
      matchBasis: priorContext.match_basis,
      findingCount: priorContext.findings.length,
    } : { status: 'NOT_FOUND' };
    fs.writeFileSync(path.join(artifactRoot, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    writeInventoryVerification(artifactRoot, verifySecurityReviewInventory({ repositoryPath: abs, artifactRoot }));
    const prompt = securityReviewCoordinatorPrompt({
      repositoryPath: abs,
      engagementId: engId,
      goalId: goal.id,
      artifactRoot,
      contextMode: resolvedContextMode,
      deepScan: run.deepScan,
      modelPolicy: run.modelPolicy,
      reviewProfile: profile,
      campaign,
    });
    persistSecurityReviewContract(artifactRoot, prompt);
    this.insertJob.run(jobId, goal.id, engId, 'glados', 'glados#security-review', 'security_review_workflow_v3', abs, prompt, nowIso());
    this.logEvent(goal.id, jobId, 'job_queued', `Queued staged source-code security review for ${abs}.`, {
      agent_id: 'glados', target: abs, workflow_version: run.workflowVersion,
      contract_revision: run.contractRevision, orchestration_revision: run.orchestrationRevision,
      requested_context_mode: requestedContextMode, context_mode: resolvedContextMode, artifact_root: artifactRoot,
      repository_head: inventory.head, deadline_at: run.deepScan.deadlineAt, model_policy: run.modelPolicy,
      review_profile: profile, campaign_repository_count: campaign?.repository_count || 0,
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
    const reviewProfile = run?.reviewProfile || 'comprehensive';
    const repositoryCount = Number(run?.campaign?.repositoryCount || 0);
    const base = {
      phase: job.status === 'queued' ? 'Queued' : 'Initializing',
      detail: job.status === 'queued'
        ? `Waiting for the review coordinator${repositoryCount ? ` · ${repositoryCount}-repository expedited campaign` : ''}`
        : `Preparing deterministic inventory${repositoryCount ? ` for ${repositoryCount} repositories` : ''}`,
      percent: job.status === 'queued' ? 0 : 3,
      workers,
      successfulWorkers,
      noNewStreak,
      saturationTarget,
      terminalState,
      deadlineAt: run?.deepScan?.deadlineAt || manifest?.deadline_at || null,
      reviewProfile,
      repositoryCount,
    };
    if (job.status === 'queued') return base;
    if (terminalState === 'CAPPED') return { ...base, phase: 'Capped', detail: run?.deepScan?.capReason || manifest?.cap_reason || 'Review limit reached', percent: 100 };
    if (!exists('context/threat-model.json')) return { ...base, phase: 'Threat modeling', detail: 'Deriving trust boundaries and attack hypotheses', percent: 10 };
    if (manifest?.status !== 'SATURATED') {
      return {
        ...base,
        phase: repositoryCount ? 'Portfolio discovery' : 'Blind discovery',
        detail: repositoryCount
          ? `${Math.min(successfulWorkers, repositoryCount)}/${repositoryCount} repository breadth passes · ${successfulWorkers} total workers · saturation ${noNewStreak}/${saturationTarget}`
          : `${successfulWorkers} successful worker${successfulWorkers === 1 ? '' : 's'} · saturation ${noNewStreak}/${saturationTarget}`,
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
    const scopedSessionId = sessionId || this.getInvestigationSessionId();
    const securityReviews = sessionId
      ? this.activeSecurityReviewsBySession.all(sessionId).map(row => {
          const job = decodeRow(row);
          return { ...job, progress: this._securityReviewProgress(job) };
        })
      : [];
    return {
      goals: this.activeGoalsStmt.all(scopedSessionId).map(decodeRow),
      recentGoals: this.recentGoalsStmt.all(scopedSessionId).map(decodeRow),
      jobs: this.activeJobsStmt.all(scopedSessionId).map(decodeRow),
      securityReviews,
      recentFailures: this.recentFailuresStmt.all(scopedSessionId).map(decodeRow),
      pendingPrecheckApproval: pendingKickoff || null,
      activeAgents,
      targetHealth,
      plans,
    };
  }

  eventsSince(since = 0, limit = 100, sessionId = null) {
    return this.eventsSinceStmt.all(Number(since) || 0, sessionId || this.getInvestigationSessionId(), Math.max(1, Math.min(500, Number(limit) || 100))).map(decodeRow);
  }

  cancelJob(jobId, { sessionId = null } = {}) {
    const job = sessionId ? this.jobByIdAndSession.get(jobId, sessionId) : this.getJob(jobId);
    if (!job) return { ok: false, error: 'job not found' };
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
    if (tracked?.finalizing) {
      this._finishJob(job, 'cancelled', null, 'cancelled by operator');
      return { ok: true, jobId, status: 'cancelled', running: false, tracked: true };
    }
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
      if (rec.finalizationTimer) clearTimeout(rec.finalizationTimer);
      try { rec.child?.kill('SIGTERM'); } catch {}
      this.running.delete(jobId);
    }
    this.finalizationState.clear();
    for (const timer of this.transientRetryTimers.values()) clearTimeout(timer);
    this.transientRetryTimers.clear();
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
    const rec = { child: tracked.child, heartbeat, deadlineTimer: null, finalizationTimer: null, timedOut: false };
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
      if (rec.finalizationTimer) clearTimeout(rec.finalizationTimer);
      this.running.delete(job.id);
    }
    let finalStatus = status;
    let finalError = error || null;
    let finalResult = result;
    let gate = null;
    if (status === 'succeeded' && job.job_type === 'security_review_workflow_v3') {
      const runtimeDir = path.dirname(path.dirname(this.db.name));
      const artifactRoot = securityReviewArtifactRoot(runtimeDir, job.engagement_id);
      const goal = job.goal_id ? this.getGoal(job.goal_id) : null;
      const finalized = finalizeSecurityReview({
        db: this.db,
        artifactRoot,
        engagementId: job.engagement_id,
        campaignExpected: goal?.metadata?.campaign === true,
      });
      gate = finalized.passed
        ? finalized.gate || { passed: true, missing: [], invalid: [] }
        : {
            ...(finalized.gate || {}),
            passed: false,
            missing: finalized.gate?.missing || [],
            invalid: [...new Set([
              ...(finalized.gate?.invalid || []),
              ...(finalized.blockers || []),
            ])],
          };
      finalResult = result && typeof result === 'object'
        ? { ...result, securityReviewGate: gate, ...(finalized.warnings ? { securityReviewWarnings: finalized.warnings } : {}) }
        : { result: result || null, securityReviewGate: gate, ...(finalized.warnings ? { securityReviewWarnings: finalized.warnings } : {}) };
      if (!finalized.passed) {
        const failures = [...gate.missing.map(item => `missing ${item}`), ...gate.invalid];
        const gateError = finalized.preflight
          ? `security-review hard gates failed (${failures.length}); read ${finalized.preflight}`
          : `security-review hard gates failed: ${failures.join('; ')}`;
        if (activeSecurityReviewRun(artifactRoot)) {
          try {
            if (discoverySaturationCheckpoint(artifactRoot).passed) markDeepScanSaturated(artifactRoot);
          } catch {}
        }
        const retryMode = finalized.retryMode || (finalized.recoverable ? 'model' : 'none');
        if (retryMode === 'controller'
            && this._scheduleSecurityReviewFinalization(current || job, result, finalized)) {
          return this.getJob(job.id);
        }
        if ((retryMode === 'model' || activeSecurityReviewRun(artifactRoot))
            && this._resumeInterruptedSecurityReview(current || job, `security review incomplete: ${gateError}`)) {
          return this.getJob(job.id);
        }
        finalStatus = 'failed';
        finalError = gateError;
      }
    }
    const stamp = nowIso();
    this.finalizationState.delete(job.id);
    this.markDone.run(finalStatus, finalResult ? JSON.stringify(finalResult) : null, finalError, stamp, stamp, job.id);
    if (job.job_type === 'security_review_workflow_v3') this._terminalizeSecurityReview(job, finalStatus, finalError);
    if (job.goal_id) {
      const goalStatus = finalStatus === 'succeeded' ? 'complete' : finalStatus === 'cancelled' ? 'cancelled' : 'failed';
      this.updateGoalStatus(job.goal_id, goalStatus);
    }
    this.logEvent(job.goal_id, job.id, `job_${finalStatus}`, `${job.agent_id} job ${job.id} ${finalStatus}.`, {
      error: finalError,
      security_review_gate: gate,
    });
    if (job.job_type === 'security_review_workflow_v3' && finalStatus === 'succeeded') {
      this._notifySecurityReviewCompleted(job);
    }
    return this.getJob(job.id);
  }

  _terminalizeSecurityReview(job, status, reason) {
    const stamp = nowIso();
    // Successfully sealed artifacts prove the required work, but they do not
    // prove that a leftover pending dispatch actually ran. Keep the audit log
    // truthful: completed workers retain their status and redundant/unstarted
    // tasks are canceled instead of being backfilled as completed.
    const taskStatus = status === 'succeeded' || status === 'cancelled' ? 'cancelled' : 'failed';
    const taskReason = status === 'succeeded'
      ? 'controller reconciled redundant nonterminal task after successful sealed review'
      : reason || `controller job ${status}`;
    let artifactState = null;
    try {
      const artifactRoot = securityReviewArtifactRoot(path.dirname(path.dirname(this.db.name)), job.engagement_id);
      artifactState = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.deepScan?.terminalState;
      const cappedFailure = /wall-clock|deadline|attempt ceiling|maximum of \d+ attempts|terminated before completion/i.test(String(reason || ''));
      if (status === 'failed' && artifactState === 'RUNNING' && cappedFailure) {
        markDeepScanCapped(artifactRoot, reason || 'security-review terminated before completion');
        artifactState = 'CAPPED';
      } else if (status === 'failed' && artifactState === 'RUNNING') {
        markDeepScanFailed(artifactRoot, reason || 'security-review orchestration failed');
        artifactState = 'FAILED';
      }
      if (status !== 'succeeded') invalidateSecurityReviewSeal(artifactRoot);
    } catch {}
    const engagementStatus = status === 'succeeded' ? 'complete'
      : artifactState === 'CAPPED' || String(reason || '').includes('wall-clock limit') ? 'capped'
        : status === 'cancelled' ? 'cancelled' : 'failed';
    const tx = this.db.transaction(() => {
      this.reconcileTasks.run(taskStatus, taskReason, stamp, job.engagement_id);
      this.finishEngagement.run(engagementStatus, stamp, job.engagement_id);
    });
    tx();
  }

  close() {
    this.stop();
    try { this.db.close(); } catch {}
  }
}

function markDeepScanFailed(artifactRoot, reason) {
  const stamp = nowIso();
  for (const relative of ['run.json', 'discovery/deep/manifest.json']) {
    const file = path.join(artifactRoot, relative);
    let document;
    try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (relative === 'run.json') {
      document.deepScan = { ...(document.deepScan || {}), terminalState: 'FAILED', completedAt: stamp, failureReason: reason };
    } else {
      document.status = 'FAILED';
      document.completed_at = stamp;
      document.failure_reason = reason;
    }
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
}

function reopenFailedDeepScan(artifactRoot, run, manifest) {
  const writeJson = (file, document) => {
    const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  run.deepScan = { ...(run.deepScan || {}), terminalState: 'RUNNING' };
  delete run.deepScan.completedAt;
  delete run.deepScan.failureReason;
  manifest.status = 'RUNNING';
  delete manifest.completed_at;
  delete manifest.failure_reason;
  writeJson(path.join(artifactRoot, 'run.json'), run);
  writeJson(path.join(artifactRoot, 'discovery', 'deep', 'manifest.json'), manifest);
}

function writeInventoryVerification(artifactRoot, receipt) {
  const file = path.join(artifactRoot, 'inventory', 'verification.json');
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
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
  persistSecurityReviewContract,
  securityReviewContinuationPrompt,
};
