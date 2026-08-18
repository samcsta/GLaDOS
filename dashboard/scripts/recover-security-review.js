#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BLACKBOARD_DB, GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { SdkSessionRegistry } = require('../lib/harness/session-registry');
const { verifySecurityReviewInventory } = require('../lib/security-review/inventory');
const {
  projectSecurityReviewLedgers,
  reconcileCompletedDiscoveryWorker,
  reconcileInvalidSuccessfulDiscoveryWorkers,
} = require('../lib/security-review/deep-scan');
const { invalidateSecurityReviewSeal } = require('../lib/security-review/finalize');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function main(engagementId) {
  const artifactRoot = path.join(GLADOS_INVESTIGATIONS_DIR, engagementId, 'security-review');
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

    const stamp = new Date().toISOString();
    run.deepScan = { ...run.deepScan, terminalState: 'RUNNING', completedAt: null, failureReason: null };
    writeJson(runFile, run);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.status = 'RUNNING';
    manifest.completed_at = null;
    manifest.failure_reason = null;
    manifest.omitted_workers = (manifest.omitted_workers || []).filter(omission => {
      const row = db.prepare('SELECT status FROM security_review_worker_runs WHERE engagement_id=? AND worker_id=?').get(engagementId, omission.worker_id);
      return row?.status !== 'SUCCEEDED';
    });
    writeJson(manifestFile, manifest);
    invalidateSecurityReviewSeal(artifactRoot);

    const checkpoint = db.prepare(`
      SELECT data_json FROM controller_events
      WHERE job_id=? AND event_type='job_continuation_queued'
      ORDER BY id DESC LIMIT 1
    `).get(job.id);
    const originalContract = String(job.prompt || '').includes('SOURCE SECURITY REVIEW WORKFLOW v4')
      ? String(job.prompt).slice(String(job.prompt).indexOf('SOURCE SECURITY REVIEW WORKFLOW v4'))
      : String(job.prompt || '');
    const resumePrompt = [
      'SECURITY REVIEW WORKFLOW v4 - OPERATOR-APPROVED RECOVERY',
      `artifact_root: ${artifactRoot}`,
      `engagement_id: ${engagementId}`,
      '',
      'The controller reconciled every valid completed discovery worker from its durable receipt and model observations.',
      invalidSuccesses.length ? `The controller demoted invalid legacy success rows without durable artifacts: ${invalidSuccesses.join(', ')}.` : '',
      'The deterministic inventory verifier passed for the current repository snapshot. Treat any prior snapshot-mismatch claim based on a non-64-character expected hash as invalid, while preserving the failed worker row for auditability.',
      'Read run.json, the projected worker ledger, dedupe state, and existing artifacts. Rebuild canonical deduplication from all successful workers in sequence order.',
      'Continue with the next unused worker until the configured no-new streak proves saturation, then run all six specialist tracks and source-review-validator.',
      'Do not rerun a reconciled successful worker. Do not create a new engagement or inventory. Preserve blind-mode constraints and the original absence of a deadline.',
      checkpoint ? `Previous continuation metadata: ${checkpoint.data_json}` : '',
      '',
      originalContract,
    ].filter(Boolean).join('\n');
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
    return { engagementId, jobId: job.id, reconciledWorkers: reconciled, invalidSuccesses, status: 'queued' };
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
