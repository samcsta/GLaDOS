const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const { ControllerLite } = require('../lib/controller');

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-controller-test-'));
  const dbPath = path.join(dir, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  return { dir, dbPath };
}

function pendingTracked() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const child = { killed: false, kill() { this.killed = true; } };
  return { child, promise, resolve };
}

function initRepo(repo) {
  cp.execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'main.go'), 'package main\nfunc main() {}\n');
  cp.execFileSync('git', ['-C', repo, 'add', '.']);
  cp.execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
}

test('creates web goals linked to engagements', () => {
  const { dbPath } = tempEnv();
  const controller = new ControllerLite({ dbPath });
  const goal = controller.createWebGoal('https://example.com', { source: 'test' });
  assert.equal(goal.type, 'webapp_goal');
  assert.equal(goal.status, 'pending_approval');
  assert.ok(goal.engagement_id);
  const status = controller.status();
  assert.equal(status.goals.length, 1);
  controller.close();
});

test('queues staged source-code reviews through GLaDOS and cancels queued jobs', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  assert.equal(job.agent_id, 'glados');
  assert.equal(job.job_type, 'security_review_workflow_v2');
  assert.match(job.prompt, /SOURCE SECURITY REVIEW WORKFLOW v2/);
  assert.match(job.prompt, /source-review-validator/);
  assert.equal(job.status, 'queued');
  const cancelled = controller.cancelJob(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(controller.getJob(job.id).status, 'cancelled');
  controller.close();
});

test('worker enforces one running job per agent', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const tracked = [];
  const controller = new ControllerLite({
    dbPath,
    maxConcurrent: 3,
    sendMessageToAgentTracked() {
      const item = pendingTracked();
      tracked.push(item);
      return { child: item.child, promise: item.promise };
    },
  });
  const j1 = controller.enqueueSecurityReviewPath(repo);
  const j2 = controller.enqueueSecurityReviewPath(repo);
  controller.tick();
  assert.equal(controller.getJob(j1.id).status, 'running');
  assert.equal(controller.getJob(j2.id).status, 'queued');
  assert.equal(tracked.length, 1);
  controller.stop();
  controller.close();
});

test('reconciles stale running jobs on startup', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
  assert.equal(controller.reconcileStaleRunning(), 1);
  assert.equal(controller.getJob(job.id).status, 'failed');
  controller.close();
});

test('security-review jobs cannot succeed when deterministic completion gates fail', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller._finishJob(job, 'succeeded', { result: 'model claimed completion' }, null);
  const finished = controller.getJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /security-review hard gates failed/);
  assert.equal(finished.result.securityReviewGate.passed, false);
  assert.equal(controller.getGoal(job.goal_id).status, 'failed');
  controller.close();
});
