const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
const { ControllerLite } = require('../lib/controller');
const { InvestigationSessionStore } = require('../lib/investigation-session-store');
const deepScan = require('../lib/security-review/deep-scan');
const finalize = require('../lib/security-review/finalize');

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
  assert.match(job.prompt, /contract_revision: v4\.3-source-reportability-semantic-dedupe/);
  assert.match(job.prompt, /durable harness-owned worker/);
  assert.match(job.prompt, /source-review-validator/);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
  assert.equal(run.orchestrationRevision, 3);
  assert.equal(run.contractRevision, 'v4.3-source-reportability-semantic-dedupe');
  assert.equal(run.requestedContextMode, 'auto');
  assert.equal(run.contextMode, 'blind');
  assert.match(fs.readFileSync(path.join(artifactRoot, 'controller', 'workflow-contract.txt'), 'utf8'), /SOURCE SECURITY REVIEW WORKFLOW v4/);
  assert.equal(job.status, 'queued');
  const cancelled = controller.cancelJob(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(controller.getJob(job.id).status, 'cancelled');
  assert.equal(controller.db.prepare('SELECT status FROM engagements WHERE id=?').get(job.engagement_id).status, 'cancelled');
  controller.close();
});

test('default security review automatically retains an exact-match sealed prior review after blind discovery', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const priorId = `prior-${path.basename(dir)}`;
  const priorRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', priorId, 'security-review');
  fs.mkdirSync(priorRoot, { recursive: true });
  fs.writeFileSync(path.join(priorRoot, 'run.json'), `${JSON.stringify({
    repositoryPath: fs.realpathSync(repo), head: 'prior-head', deepScan: { completedAt: '2026-08-20T12:00:00.000Z' },
  })}\n`);
  fs.writeFileSync(path.join(priorRoot, 'findings.json'), `${JSON.stringify({
    findings: [{ id: 'PRIOR-1', title: 'Prior weakness', severity: 'medium', cwe_ids: ['CWE-829'], locations: [] }],
  })}\n`);
  fs.writeFileSync(path.join(priorRoot, 'completion-receipt.json'), `${JSON.stringify({
    engagement_id: priorId, status: 'SEALED', terminal_state: 'SATURATED', repository_head: 'prior-head',
  })}\n`);

  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
  const prior = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'regression', 'prior-context.json'), 'utf8'));
  assert.equal(run.requestedContextMode, 'auto');
  assert.equal(run.contextMode, 'informed');
  assert.equal(run.priorContext.priorEngagementId, priorId);
  assert.deepEqual(prior.findings.map(row => row.id), ['PRIOR-1']);
  assert.match(job.prompt, /blind discovery first/i);
  assert.match(job.prompt, /regression\/prior-context\.json/);
  controller.close();
  fs.rmSync(path.dirname(priorRoot), { recursive: true, force: true });
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

test('security-review jobs cannot succeed when publication fails after evidence gates pass', () => {
  const originalFinalize = finalize.finalizeSecurityReview;
  finalize.finalizeSecurityReview = () => ({
    passed: false,
    recoverable: true,
    retryMode: 'controller',
    phase: 'deliverables',
    blockers: ['deliverables: publication fixture failed'],
    gate: { passed: true, missing: [], invalid: [] },
  });
  delete require.cache[require.resolve('../lib/controller')];
  const { ControllerLite: PatchedController } = require('../lib/controller');
  try {
    const { dir, dbPath } = tempEnv();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    const controller = new PatchedController({ dbPath, finalizationRetryMs: 60_000 });
    const job = controller.enqueueSecurityReviewPath(repo);
    controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
    controller.db.prepare("UPDATE controller_goals SET status='active' WHERE id=?").run(job.goal_id);
    controller._finishJob(job, 'succeeded', { result: 'analysis complete' }, null);
    assert.equal(controller.getJob(job.id).status, 'running');
    assert.equal(controller.getGoal(job.goal_id).status, 'active');
    assert.equal(controller.db.prepare('SELECT status FROM engagements WHERE id=?').get(job.engagement_id).status, 'active');
    controller.close();
  } finally {
    finalize.finalizeSecurityReview = originalFinalize;
    delete require.cache[require.resolve('../lib/controller')];
  }
});

test('controller persists proven saturation before retrying a terminal artifact blocker', () => {
  const originalFinalize = finalize.finalizeSecurityReview;
  const originalSaturation = deepScan.discoverySaturationCheckpoint;
  const originalMarkSaturated = deepScan.markDeepScanSaturated;
  finalize.finalizeSecurityReview = () => ({ passed: false, recoverable: true, blockers: ['missing terminal artifact'] });
  deepScan.discoverySaturationCheckpoint = () => ({ passed: true, invalid: [] });
  let saturated = false;
  deepScan.markDeepScanSaturated = artifactRoot => {
    saturated = true;
    for (const relative of ['run.json', 'discovery/deep/manifest.json']) {
      const file = path.join(artifactRoot, relative);
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (relative === 'run.json') document.deepScan.terminalState = 'SATURATED';
      else document.status = 'SATURATED';
      fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
    }
  };
  delete require.cache[require.resolve('../lib/controller')];
  const { ControllerLite: PatchedController } = require('../lib/controller');
  try {
    const { dir, dbPath } = tempEnv();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    const controller = new PatchedController({ dbPath });
    const job = controller.enqueueSecurityReviewPath(repo);
    controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
    controller._finishJob(job, 'succeeded', { result: 'analysis complete' }, null);
    assert.equal(saturated, true);
    assert.equal(controller.getJob(job.id).status, 'queued');
    controller.close();
  } finally {
    finalize.finalizeSecurityReview = originalFinalize;
    deepScan.discoverySaturationCheckpoint = originalSaturation;
    deepScan.markDeepScanSaturated = originalMarkSaturated;
    delete require.cache[require.resolve('../lib/controller')];
  }
});

test('controller waits for runtime settlement and seals without another model turn', async () => {
  const originalFinalize = finalize.finalizeSecurityReview;
  let calls = 0;
  finalize.finalizeSecurityReview = () => {
    calls += 1;
    return calls === 1
      ? { passed: false, recoverable: true, retryMode: 'controller', phase: 'runtime-settlement', blockers: ['1 model request(s) remain PENDING'] }
      : { passed: true, recoverable: false, retryMode: 'none', blockers: [], gate: { passed: true, missing: [], invalid: [] } };
  };
  delete require.cache[require.resolve('../lib/controller')];
  const { ControllerLite: PatchedController } = require('../lib/controller');
  try {
    const { dir, dbPath } = tempEnv();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    initRepo(repo);
    const completed = [];
    const controller = new PatchedController({
      dbPath,
      finalizationRetryMs: 10,
      finalizationTimeoutMs: 200,
      onSecurityReviewCompleted: event => completed.push(event),
    });
    const job = controller.enqueueSecurityReviewPath(repo);
    const pendingTask = controller.db.prepare(`INSERT INTO tasks
      (engagement_id,assigned_to,task_type,target,description,status)
      VALUES (?,?,?,?,?,'pending')`).run(job.engagement_id, 'source-code', 'scan', repo, 'redundant retry dispatch');
    controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
    controller._finishJob(job, 'succeeded', { result: 'analysis complete' }, null);
    assert.equal(controller.getJob(job.id).status, 'running');
    assert.equal(controller.db.prepare("SELECT COUNT(*) AS n FROM controller_events WHERE job_id=? AND event_type='security_review_finalization_waiting'").get(job.id).n, 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 2);
    assert.equal(controller.getJob(job.id).status, 'succeeded');
    assert.equal(controller.getGoal(job.goal_id).status, 'complete');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].engagementId, job.engagement_id);
    assert.equal(completed[0].sessionId, 'legacy');
    const reconciled = controller.db.prepare('SELECT status,result FROM tasks WHERE id=?').get(pendingTask.lastInsertRowid);
    assert.equal(reconciled.status, 'cancelled');
    assert.match(reconciled.result, /redundant nonterminal task/);
    controller.close();
  } finally {
    finalize.finalizeSecurityReview = originalFinalize;
    delete require.cache[require.resolve('../lib/controller')];
  }
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

test('saturated security review can resume for terminal artifact correction', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running', attempts=1 WHERE id=?").run(job.id);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  for (const relative of ['run.json', 'discovery/deep/manifest.json']) {
    const file = path.join(artifactRoot, relative);
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (relative === 'run.json') document.deepScan.terminalState = 'SATURATED';
    else document.status = 'SATURATED';
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  }
  assert.equal(controller._resumeInterruptedSecurityReview(
    controller.getJob(job.id),
    'security review incomplete: missing tracks/resilience-error-handling/findings.jsonl',
  ), true);
  const continued = controller.getJob(job.id);
  assert.equal(continued.status, 'queued');
  assert.match(continued.prompt, /Discovery is already SATURATED/);
  assert.match(continued.prompt, /Do not dispatch another discovery worker/);
  assert.match(continued.prompt, /Missing authoritative model-role observations:/);
  assert.match(continued.prompt, /Dispatch each listed role exactly once/);
  assert.doesNotMatch(continued.prompt, /Do not dispatch those specialists/);
  assert.doesNotMatch(continued.prompt, /SOURCE SECURITY REVIEW WORKFLOW v4/);
  assert.match(continued.prompt, /workflow_contract:/);
  assert.ok(continued.prompt.length < 6000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8')).deepScan.terminalState, 'SATURATED');
  controller.close();
});

test('terminal artifact progress permits another saturated continuation', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running', attempts=1 WHERE id=?").run(job.id);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  for (const relative of ['run.json', 'discovery/deep/manifest.json']) {
    const file = path.join(artifactRoot, relative);
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (relative === 'run.json') document.deepScan.terminalState = 'SATURATED';
    else document.status = 'SATURATED';
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  }
  assert.equal(controller._resumeInterruptedSecurityReview(
    controller.getJob(job.id),
    'security review incomplete: first terminal artifact blocker',
  ), true);
  fs.mkdirSync(path.join(artifactRoot, 'tracks', 'resilience-error-handling'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'tracks', 'resilience-error-handling', 'findings.jsonl'), '');
  controller.db.prepare("UPDATE controller_jobs SET status='running' WHERE id=?").run(job.id);
  assert.equal(controller._resumeInterruptedSecurityReview(
    controller.getJob(job.id),
    'security review incomplete: second terminal artifact blocker',
  ), true);
  controller.close();
});

test('recovered saturated review can continue without legacy checkpoint metadata', () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='running', attempts=5 WHERE id=?").run(job.id);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  for (const relative of ['run.json', 'discovery/deep/manifest.json']) {
    const file = path.join(artifactRoot, relative);
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (relative === 'run.json') document.deepScan.terminalState = 'SATURATED';
    else document.status = 'SATURATED';
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  }
  assert.equal(controller._resumeInterruptedSecurityReview(
    controller.getJob(job.id),
    'security review incomplete: recovered terminal artifact blocker',
  ), true);
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

test('transient LiteLLM failures retry the same durable checkpoint with bounded backoff', async () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const tracked = [];
  const controller = new ControllerLite({
    dbPath,
    transientRetryBaseMs: 10,
    transientRetryMaxMs: 10,
    transientRetryLimit: 3,
    sendMessageToAgentTracked(_agentId, prompt) {
      const item = pendingTracked();
      item.prompt = prompt;
      tracked.push(item);
      return { child: item.child, promise: item.promise };
    },
  });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.tick();
  tracked[0].resolve({ error: 'Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete.' });
  await new Promise(resolve => setTimeout(resolve, 45));

  assert.equal(tracked.length, 2);
  assert.match(tracked[1].prompt, /DURABLE COORDINATOR CONTINUATION/);
  assert.ok(tracked[1].prompt.length < 6000);
  tracked[1].resolve({ error: 'upstream request timeout' });
  await new Promise(resolve => setTimeout(resolve, 45));

  const continued = controller.getJob(job.id);
  assert.equal(tracked.length, 3);
  assert.equal(continued.attempts, 3);
  assert.ok(['queued', 'running'].includes(continued.status));
  assert.equal(controller.db.prepare(`SELECT COUNT(*) AS n FROM controller_events
    WHERE job_id=? AND event_type='security_review_transient_retry_scheduled'`).get(job.id).n, 2);
  controller.cancelJob(job.id);
  tracked[2].resolve({});
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.close();
});

test('operator resume reconnects a failed security review to its controller job', async () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({
    dbPath,
    transientRetryBaseMs: 10,
    transientRetryMaxMs: 10,
  });
  const job = controller.enqueueSecurityReviewPath(repo);
  controller.db.prepare("UPDATE controller_jobs SET status='failed', attempts=5, error=? WHERE id=?")
    .run('API Error: 502 GLaDOS could not reach LiteLLM.', job.id);
  const sessionId = controller.db.prepare('SELECT session_id FROM engagements WHERE id=?').get(job.engagement_id).session_id;

  const recovery = controller.resumeLatestRecoverableSecurityReviewForSession(sessionId);
  assert.equal(recovery.ok, true);
  assert.equal(recovery.resumed, true);
  assert.equal(recovery.jobId, job.id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(controller.getJob(job.id).status, 'queued');
  assert.equal(controller.getJob(job.id).attempts, 5);
  controller.close();
});

test('operator resume reopens a matched failed deep-scan lifecycle', async () => {
  const { dir, dbPath } = tempEnv();
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  initRepo(repo);
  const controller = new ControllerLite({ dbPath });
  const job = controller.enqueueSecurityReviewPath(repo);
  const artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'investigations', job.engagement_id, 'security-review');
  const runPath = path.join(artifactRoot, 'run.json');
  const manifestPath = path.join(artifactRoot, 'discovery', 'deep', 'manifest.json');
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  run.deepScan.terminalState = 'FAILED';
  run.deepScan.completedAt = new Date().toISOString();
  run.deepScan.failureReason = 'security-review hard gates failed';
  manifest.status = 'FAILED';
  manifest.completed_at = new Date().toISOString();
  manifest.failure_reason = 'security-review hard gates failed';
  fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  controller.db.prepare("UPDATE controller_jobs SET status='failed', error=? WHERE id=?")
    .run('security-review hard gates failed (1); read controller/preflight.json', job.id);
  const sessionId = controller.db.prepare('SELECT session_id FROM engagements WHERE id=?').get(job.engagement_id).session_id;

  const recovery = controller.resumeLatestRecoverableSecurityReviewForSession(sessionId);
  assert.equal(recovery.ok, true);
  assert.equal(recovery.resumed, true);
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).deepScan.terminalState, 'RUNNING');
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).status, 'RUNNING');
  assert.equal(controller.db.prepare(`SELECT COUNT(*) AS n FROM controller_events
    WHERE job_id=? AND event_type='security_review_lifecycle_reopened'`).get(job.id).n, 1);
  controller.close();
});
