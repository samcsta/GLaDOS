#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BLACKBOARD_DB, GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { SdkSessionRegistry } = require('../lib/harness/session-registry');
const { verifySecurityReviewInventory } = require('../lib/security-review/inventory');
const { securityReviewArtifactRoot } = require('../lib/security-review/workflow');
const {
  discoverySaturationCheckpoint,
  markDeepScanSaturated,
  projectSecurityReviewLedgers,
  reconcileCompletedDiscoveryWorker,
  reconcileInvalidSuccessfulDiscoveryWorkers,
  REQUIRED_MODEL_ROLES,
} = require('../lib/security-review/deep-scan');
const { invalidateSecurityReviewSeal, revalidateSecurityReview } = require('../lib/security-review/finalize');
const { securityReviewContinuationPrompt } = require('../lib/controller');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function resolveArtifactRoot(engagementId) {
  const exact = securityReviewArtifactRoot(path.dirname(GLADOS_INVESTIGATIONS_DIR), engagementId);
  if (fs.existsSync(path.join(exact, 'run.json'))) return exact;
  const matches = fs.readdirSync(GLADOS_INVESTIGATIONS_DIR, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const reviewRoot = path.join(GLADOS_INVESTIGATIONS_DIR, entry.name, 'security-review');
    for (const relative of ['completion-receipt.json', 'scan-manifest.json', 'findings.json', 'observations.json']) {
      try {
        const document = JSON.parse(fs.readFileSync(path.join(reviewRoot, relative), 'utf8'));
        if (document.engagement_id === engagementId) return [reviewRoot];
      } catch {}
    }
    return [];
  });
  if (matches.length !== 1) throw new Error(`security-review artifacts for ${engagementId} were ${matches.length ? 'ambiguous' : 'not found'}`);
  return matches[0];
}

function readJsonLines(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
}

function findingClosureStatus(artifactRoot) {
  const findingFiles = [
    'discovery/findings.jsonl',
    'tracks/authorization-access-control/findings.jsonl',
    'tracks/data-flow-injection/findings.jsonl',
    'tracks/secrets-history/findings.jsonl',
    'tracks/resilience-error-handling/findings.jsonl',
    'tracks/iac-config-manifests/findings.jsonl',
    'tracks/cryptography-suppressions/findings.jsonl',
  ];
  const findingIds = new Set();
  for (const relative of findingFiles) {
    for (const row of readJsonLines(path.join(artifactRoot, relative))) {
      const id = row.finding_id || row.id;
      if (id) findingIds.add(id);
    }
  }
  const closure = readJsonLines(path.join(artifactRoot, 'validation', 'candidate-closure.jsonl'));
  const closed = new Set(closure.map(row => row.candidate_id).filter(Boolean));
  for (const row of closure) {
    if (String(row.disposition || '').toUpperCase() !== 'REPORTABLE') continue;
    for (const id of row.finding_ids || []) closed.add(id);
  }
  return {
    source_finding_ids: [...findingIds].sort(),
    missing_closure_ids: [...findingIds].filter(id => !closed.has(id)).sort(),
  };
}

function main(engagementId) {
  const artifactRoot = resolveArtifactRoot(engagementId);
  const runFile = path.join(artifactRoot, 'run.json');
  const manifestFile = path.join(artifactRoot, 'discovery', 'deep', 'manifest.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const verification = verifySecurityReviewInventory({ repositoryPath: run.repositoryPath, artifactRoot });
  if (!verification.verified) throw new Error(`repository snapshot drift prevents recovery: ${JSON.stringify(verification)}`);

  const db = new Database(BLACKBOARD_DB);
  try {
    const job = db.prepare(`
      SELECT * FROM controller_jobs
      WHERE engagement_id=? AND job_type='security_review_workflow_v3'
      ORDER BY created_at DESC LIMIT 1
    `).get(engagementId);
    if (!job) throw new Error(`security-review job not found for ${engagementId}`);
    const workers = db.prepare(`
      SELECT worker_id, tool_call_id FROM security_review_worker_runs
      WHERE engagement_id=? ORDER BY sequence
    `).all(engagementId);
    let reconciled = 0;
    for (const worker of workers) {
      if (reconcileCompletedDiscoveryWorker({
        dbPath: BLACKBOARD_DB, artifactRoot, engagementId, toolCallId: worker.tool_call_id,
      })) reconciled += 1;
    }
    const invalidSuccesses = reconcileInvalidSuccessfulDiscoveryWorkers({
      dbPath: BLACKBOARD_DB, artifactRoot, engagementId,
    });
    projectSecurityReviewLedgers({ db, artifactRoot, engagementId });

    const goal = job.goal_id ? db.prepare('SELECT metadata_json FROM controller_goals WHERE id=?').get(job.goal_id) : null;
    let goalMetadata = {};
    try { goalMetadata = JSON.parse(goal?.metadata_json || '{}'); } catch {}
    let revalidated = revalidateSecurityReview({
      db,
      artifactRoot,
      engagementId,
      campaignExpected: goalMetadata.campaign === true,
    });
    for (let attempt = 0; revalidated.retryMode === 'controller' && attempt < 20; attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      revalidated = revalidateSecurityReview({
        db,
        artifactRoot,
        engagementId,
        campaignExpected: goalMetadata.campaign === true,
      });
    }
    if (revalidated.passed) {
      return {
        engagementId,
        jobId: job.id,
        reconciledWorkers: reconciled,
        invalidSuccesses,
        discoveryState: 'SATURATED',
        status: 'succeeded',
        execution: 'controller-only',
      };
    }
    if (revalidated.retryMode === 'controller') {
      throw new Error(`authoritative runtime settlement is still pending; no model recovery was queued: ${revalidated.blockers.join('; ')}`);
    }

    const stamp = new Date().toISOString();
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const previousCompletedAt = manifest.completed_at || run.deepScan?.completedAt || stamp;
    run.deepScan = { ...run.deepScan, terminalState: 'RUNNING', completedAt: null, failureReason: null };
    writeJson(runFile, run);
    manifest.status = 'RUNNING';
    manifest.completed_at = null;
    manifest.failure_reason = null;
    manifest.omitted_workers = (manifest.omitted_workers || []).filter(omission => {
      const row = db.prepare('SELECT status FROM security_review_worker_runs WHERE engagement_id=? AND worker_id=?').get(engagementId, omission.worker_id);
      return row?.status !== 'SUCCEEDED';
    });
    writeJson(manifestFile, manifest);
    invalidateSecurityReviewSeal(artifactRoot);
    const saturation = discoverySaturationCheckpoint(artifactRoot);
    if (saturation.passed) markDeepScanSaturated(artifactRoot, previousCompletedAt);

    const checkpoint = db.prepare(`
      SELECT data_json FROM controller_events
      WHERE job_id=? AND event_type='job_continuation_queued'
      ORDER BY id DESC LIMIT 1
    `).get(job.id);
    const findingClosure = findingClosureStatus(artifactRoot);
    const observedRoles = new Set(db.prepare(`SELECT DISTINCT review_role FROM security_review_model_observations
      WHERE engagement_id=? AND review_role IS NOT NULL`).all(engagementId).map(row => row.review_role));
    const missingRoles = REQUIRED_MODEL_ROLES.filter(role => !observedRoles.has(role));
    const recoveryReason = [
      `operator-approved recovery for ${engagementId}`,
      `reconciled ${reconciled} durable worker(s)`,
      invalidSuccesses.length ? `demoted invalid legacy successes: ${invalidSuccesses.join(', ')}` : null,
      findingClosure.missing_closure_ids.length ? `unclosed source findings: ${findingClosure.missing_closure_ids.join(', ')}` : null,
      checkpoint ? `previous continuation metadata: ${checkpoint.data_json}` : null,
    ].filter(Boolean).join('; ');
    const resumePrompt = securityReviewContinuationPrompt(job.prompt, {
      artifactRoot,
      reason: recoveryReason,
      lifecycleState: saturation.passed ? 'SATURATED' : 'RUNNING',
      missingRoles,
    });
    const sessionId = db.prepare('SELECT session_id FROM engagements WHERE id=?').get(engagementId)?.session_id;
    if (sessionId) new SdkSessionRegistry().clear(sessionId, 'glados');
    db.transaction(() => {
      db.prepare(`
        UPDATE controller_jobs SET status='queued', prompt=?, result_json=NULL, error=NULL,
          cancel_requested=0, updated_at=?, finished_at=NULL, lease_owner=NULL,
          lease_expires_at=NULL, heartbeat_at=NULL
        WHERE id=?
      `).run(resumePrompt, stamp, job.id);
      if (job.goal_id) db.prepare("UPDATE controller_goals SET status='queued', completed_at=NULL, updated_at=? WHERE id=?").run(stamp, job.goal_id);
      db.prepare("UPDATE engagements SET status='active', completed_at=NULL WHERE id=?").run(engagementId);
      db.prepare(`INSERT INTO controller_events (goal_id,job_id,event_type,message,data_json)
        VALUES (?,?,'security_review_recovery_queued',?,?)`)
        .run(job.goal_id || null, job.id, `Recovered durable discovery state and queued ${engagementId}.`, JSON.stringify({ engagement_id: engagementId, reconciled_workers: reconciled }));
    })();
    return { engagementId, jobId: job.id, reconciledWorkers: reconciled, invalidSuccesses, discoveryState: saturation.passed ? 'SATURATED' : 'RUNNING', status: 'queued' };
  } finally { db.close(); }
}

const ids = process.argv.slice(2);
if (!ids.length) {
  process.stderr.write('usage: recover-security-review.js <engagement-id> [...]\n');
  process.exit(2);
}
for (const engagementId of ids) {
  try { process.stdout.write(`${JSON.stringify(main(engagementId))}\n`); }
  catch (error) { process.stderr.write(`${engagementId}: ${error.message}\n`); process.exitCode = 1; }
}
