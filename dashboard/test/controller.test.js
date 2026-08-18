const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const { ControllerLite } = require('../lib/controller');
const { InvestigationSessionStore } = require('../lib/investigation-session-store');

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
  assert.equal(job.job_type, 'security_review_workflow_v3');
  assert.match(job.prompt, /SOURCE SECURITY REVIEW WORKFLOW v4/);
  assert.match(job.prompt, /durable harness-owned worker/);
  assert.match(job.prompt, /source-review-validator/);
  assert.equal(job.status, 'queued');
  const cancelled = controller.cancelJob(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(controller.getJob(job.id).status, 'cancelled');
  assert.equal(controller.db.prepare('SELECT status FROM engagements WHERE id=?').get(job.engagement_id).status, 'cancelled');
  controller.close();
});

test('controller status exposes session-scoped security-review progress', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath, getInvestigationSessionId: () => 'legacy' });
  const job = controller.enqueueSecurityReviewPath(repo);
  const status = controller.status({ sessionId: 'legacy' });
  assert.equal(status.securityReviews.length, 1);
  assert.equal(status.securityReviews[0].id, job.id);
  assert.equal(status.securityReviews[0].progress.phase, 'Queued');
  assert.equal(status.securityReviews[0].progress.percent, 0);
  assert.deepEqual(controller.status({ sessionId: 'different-session' }).securityReviews, []);
  controller.close();
});

test('controller status and cancellation do not cross investigation sessions', () => {
  const { dir, dbPath } = tempEnv();
  const repoOne = path.join(dir, 'one');
  const repoTwo = path.join(dir, 'two');
  fs.mkdirSync(repoOne);
  fs.mkdirSync(repoTwo);
  initRepo(repoOne);
  initRepo(repoTwo);
  const sessions = new InvestigationSessionStore(dbPath);
  const sessionOne = sessions.create({ name: 'One' });
  const sessionTwo = sessions.create({ name: 'Two' });
  let current = sessionOne.id;
  const controller = new ControllerLite({ dbPath, getInvestigationSessionId: () => current });
  const first = controller.enqueueSecurityReviewPath(repoOne, { sessionId: sessionOne.id });
  current = sessionTwo.id;
  const second = controller.enqueueSecurityReviewPath(repoTwo, { sessionId: sessionTwo.id });
  assert.deepEqual(controller.status({ sessionId: sessionOne.id }).jobs.map(job => job.id), [first.id]);
  assert.deepEqual(controller.status({ sessionId: sessionTwo.id }).jobs.map(job => job.id), [second.id]);
  assert.equal(controller.cancelJob(second.id, { sessionId: sessionOne.id }).ok, false);
  assert.equal(controller.getJob(second.id).status, 'queued');
  controller.close();
  sessions.close();
});

test('security reviews have no wall-clock deadline unless the operator sets one', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
  assert.equal(run.deepScan.maxDurationMinutes, null);
  assert.equal(run.deepScan.deadlineAt, null);
  assert.equal(run.deepScan.discoveryConcurrency, 3);
  assert.equal(run.deepScan.specialistConcurrency, 3);
  controller.close();
});

test('queues an expedited portfolio as one breadth-then-depth campaign', () => {
  const { dir, dbPath } = tempEnv();
  const portfolio = path.join(dir, 'repos');
  fs.mkdirSync(portfolio);
  for (const name of ['service-b', 'service-a']) {
    const repo = path.join(portfolio, name);
    fs.mkdirSync(repo);
    initRepo(repo);
  }
  const controller = new ControllerLite({ dbPath, getInvestigationSessionId: () => 'legacy' });
  const job = controller.enqueueSecurityReviewPath(portfolio, {
    reviewProfile: 'expedited',
    campaignMode: true,
  });
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
  const campaign = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'portfolio', 'repositories.json'), 'utf8'));
  assert.equal(run.reviewProfile, 'expedited');
  assert.equal(run.campaign.repositoryCount, 2);
  assert.equal(controller.getGoal(job.goal_id).metadata.campaign, true);
  assert.equal(run.deepScan.minDiscoveryRuns, 3);
  assert.equal(run.deepScan.stopAfterNoNew, 3);
  assert.equal(run.deepScan.maxDiscoveryRuns, null);
  assert.equal(run.deepScan.maxDurationMinutes, null);
  assert.deepEqual(campaign.repositories.map(repo => repo.name), ['service-a', 'service-b']);
  assert.match(job.prompt, /EXPEDITED MULTI-REPOSITORY CAMPAIGN CONTRACT/);
  assert.match(job.prompt, /worker-001=repo-001:service-a/);
  assert.match(job.prompt, /no fixed discovery-attempt ceiling/);
  const progress = controller.status({ sessionId: 'legacy' }).securityReviews[0].progress;
  assert.equal(progress.reviewProfile, 'expedited');
  assert.equal(progress.repositoryCount, 2);
  controller.close();
});

test('security-review progress advances from discovery through sealing artifacts', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath, getInvestigationSessionId: () => 'legacy' });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running', started_at=datetime('now') WHERE id=?").run(job.id);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  fs.mkdirSync(path.join(artifactRoot, 'context'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'context', 'threat-model.json'), '{}\n');
  fs.mkdirSync(path.join(artifactRoot, 'discovery', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'discovery', 'deep', 'workers.jsonl'), '{}\n{}\n');
  fs.writeFileSync(path.join(artifactRoot, 'discovery', 'deep', 'dedupe.json'), JSON.stringify({
    input_worker_ids: ['worker-001', 'worker-002'], no_new_streak: 1,
  }));
  const progress = controller.status({ sessionId: 'legacy' }).securityReviews[0].progress;
  assert.equal(progress.phase, 'Blind discovery');
  assert.equal(progress.successfulWorkers, 2);
  assert.equal(progress.noNewStreak, 1);
  assert.match(progress.detail, /saturation 1\/3/);
  controller.close();
});

test('worker enforces one running job per agent within an investigation session', () => {
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

test('worker runs the same coordinator concurrently across different investigation sessions', () => {
  const { dir, dbPath } = tempEnv();
  const repoOne = path.join(dir, 'repo-one');
  const repoTwo = path.join(dir, 'repo-two');
  fs.mkdirSync(repoOne);
  fs.mkdirSync(repoTwo);
  initRepo(repoOne);
  initRepo(repoTwo);
  const sessions = new InvestigationSessionStore(dbPath);
  const sessionOne = sessions.create({ name: 'Review one' });
  const sessionTwo = sessions.create({ name: 'Review two' });
  let currentSessionId = sessionOne.id;
  const tracked = [];
  const controller = new ControllerLite({
    dbPath,
    maxConcurrent: 3,
    getInvestigationSessionId: () => currentSessionId,
    sendMessageToAgentTracked() {
      const item = pendingTracked();
      tracked.push(item);
      return { child: item.child, promise: item.promise };
    },
  });
  const first = controller.enqueueSecurityReviewPath(repoOne);
  currentSessionId = sessionTwo.id;
  const second = controller.enqueueSecurityReviewPath(repoTwo);
  controller.tick();
  assert.equal(controller.getJob(first.id).status, 'running');
  assert.equal(controller.getJob(second.id).status, 'running');
  assert.equal(tracked.length, 2);
  controller.stop();
  controller.close();
  sessions.close();
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

test('dashboard restart resumes the same durable security-review campaign artifacts', async () => {
  const { dir, dbPath } = tempEnv();
  const portfolio = path.join(dir, 'repos');
  fs.mkdirSync(portfolio);
  for (const name of ['api', 'web']) {
    const repo = path.join(portfolio, name);
    fs.mkdirSync(repo);
    initRepo(repo);
  }
  const first = new ControllerLite({ dbPath });
  const job = first.enqueueSecurityReviewPath(portfolio, { reviewProfile: 'expedited', campaignMode: true });
  first.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
  first.close();

  const tracked = [];
  const resumed = new ControllerLite({
    dbPath,
    sendMessageToAgentTracked(_agentId, prompt) {
      const item = pendingTracked();
      item.prompt = prompt;
      tracked.push(item);
      return { child: item.child, promise: item.promise };
    },
  });
  resumed.start();
  const continued = resumed.getJob(job.id);
  assert.equal(continued.status, 'running');
  assert.equal(continued.attempts, 1);
  assert.match(continued.prompt, /DURABLE COORDINATOR CONTINUATION/);
  assert.match(continued.prompt, /Do not initialize a new run/);
  assert.equal(tracked.length, 1);
  resumed.cancelJob(job.id);
  tracked[0].resolve({});
  await new Promise(resolve => setTimeout(resolve, 20));
  resumed.stop();
  resumed.close();
});

test('security-review jobs cannot succeed when deterministic completion gates fail', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const runFile = path.join(artifactRoot, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run.deepScan.terminalState = 'CAPPED';
  fs.writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  controller._finishJob(job, 'succeeded', { result: 'model claimed completion' }, null);
  const finished = controller.getJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /security-review hard gates failed/);
  assert.equal(finished.result.securityReviewGate.passed, false);
  assert.equal(controller.getGoal(job.goal_id).status, 'failed');
  assert.equal(controller.db.prepare('SELECT status FROM engagements WHERE id=?').get(job.engagement_id).status, 'capped');
  assert.equal(fs.existsSync(path.join(artifactRoot, 'completion-receipt.json')), false);
  controller.close();
});

test('unchanged security-review checkpoint does not queue endless continuations', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running', attempts=1 WHERE id=?").run(job.id);
  const current = controller.getJob(job.id);
  assert.equal(controller._resumeInterruptedSecurityReview(current, 'security review incomplete: fixture'), true);
  controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
  assert.equal(controller._resumeInterruptedSecurityReview(controller.getJob(job.id), 'security review incomplete: fixture'), false);
  controller.close();
});

test('append-only model observations do not create false continuation progress', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running', attempts=1 WHERE id=?").run(job.id);
  controller.db.prepare(`INSERT INTO security_review_model_observations
    (observation_id,engagement_id,agent_id,review_role,requested_model,actual_model,source,request_id,gateway_model_id,observed_at)
    VALUES ('observation-initial',?,'glados','coordinator','gpt-5.6-terra','deployment-terra','litellm:response-headers','request-initial','deployment-terra','2026-08-17T11:59:00Z')`).run(job.engagement_id);
  assert.equal(controller._resumeInterruptedSecurityReview(controller.getJob(job.id), 'security review incomplete: fixture'), true);
  controller.db.prepare(`INSERT INTO security_review_model_observations
    (observation_id,engagement_id,agent_id,review_role,requested_model,actual_model,source,request_id,gateway_model_id,observed_at)
    VALUES ('observation-noise',?,'glados','coordinator','gpt-5.6-terra','deployment-terra','litellm:response-headers','request-noise','deployment-terra','2026-08-17T12:00:00Z')`).run(job.engagement_id);
  controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
  assert.equal(controller._resumeInterruptedSecurityReview(controller.getJob(job.id), 'security review incomplete: fixture'), false);
  controller.close();
});

test('terminal orchestration failure marks active review artifacts failed', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller._finishJob(job, 'failed', null, 'unrecoverable orchestration error');
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8')).deepScan.terminalState, 'FAILED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, 'discovery/deep/manifest.json'), 'utf8')).status, 'FAILED');
  controller.close();
});

test('security-review wall-clock ceiling marks the run capped and terminates its worker', async () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const tracked = pendingTracked();
  const controller = new ControllerLite({
    dbPath,
    sendMessageToAgentTracked() { return { child: tracked.child, promise: tracked.promise }; },
  });
  const job = controller.enqueueSecurityReviewPath(repo, { maxDurationMinutes: 1 });
  const statusFile = path.join(path.dirname(path.dirname(dbPath)), 'workspaces', 'agents', 'glados', 'AGENT-STATUS.md');
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, '# stale active roster\n');
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const runFile = path.join(artifactRoot, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run.deepScan.deadlineAt = new Date(Date.now() - 1_000).toISOString();
  fs.writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  controller.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  const finished = controller.getJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /wall-clock limit reached/);
  assert.equal(tracked.child.killed, true);
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).deepScan.terminalState, 'CAPPED');
  assert.equal(controller.db.prepare('SELECT status FROM engagements WHERE id=?').get(job.engagement_id).status, 'capped');
  assert.equal(fs.readFileSync(statusFile, 'utf8'), '# stale active roster\n');
  controller.close();
});

test('recoverable coordinator turn exhaustion resumes the same durable security review', async () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const tracked = [];
  const controller = new ControllerLite({
    dbPath,
    sendMessageToAgentTracked(_agentId, prompt) {
      const item = pendingTracked();
      item.prompt = prompt;
      tracked.push(item);
      return { child: item.child, promise: item.promise };
    },
  });
  const job = controller.enqueueSecurityReviewPath(repo, { maxDurationMinutes: 120 });
  controller.tick();
  tracked[0].promise.catch(() => {});
  tracked[0].resolve(Promise.reject(new Error('Claude Code returned an error result: Reached maximum number of turns (40)')));
  await new Promise(resolve => setTimeout(resolve, 30));
  const continued = controller.getJob(job.id);
  assert.ok(['queued', 'running'].includes(continued.status));
  assert.equal(continued.engagement_id, job.engagement_id);
  assert.equal(continued.attempts >= 1, true);
  assert.match(continued.prompt, /DURABLE COORDINATOR CONTINUATION/);
  assert.match(continued.prompt, /Do not initialize a new run/);
  assert.equal(controller.getGoal(job.goal_id).completed_at, null);
  controller.stop();
  controller.close();
});
