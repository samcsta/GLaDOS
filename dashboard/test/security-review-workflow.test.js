const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {
  SPECIALIST_TRACKS,
  SEMANTIC_REVIEW_CHECKS,
  securityReviewCoordinatorPrompt,
  sourceReviewGateStatus,
} = require('../lib/security-review/workflow');
const { generateSecurityReviewInventory, verifySecurityReviewInventory } = require('../lib/security-review/inventory');
const {
  REQUIRED_MODEL_ROLES,
  appendRuntimeModelObservation,
  bindRuntimeModelObservationToWorker,
  reconcileRuntimeModelObservationsToWorkers,
  claimDiscoveryWorker,
  discoveryDispatchCheckpoint,
  discoverySaturationCheckpoint,
  finalizeDiscoveryWorker,
  normalizeDeepScanConfig,
  reconcileActiveSecurityReviewWorkers,
  reconcileCompletedDiscoveryWorker,
  reconcileInvalidSuccessfulDiscoveryWorkers,
} = require('../lib/security-review/deep-scan');
const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');

function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(root, relative, rows) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
}

function sha256(root, relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

test('runtime model ledger rejects SDK lifecycle placeholders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-model-ledger-test-'));
  assert.equal(appendRuntimeModelObservation(root, {
    agent_id: 'source-code',
    model: '<synthetic>',
    source: 'agent-sdk:assistant.model',
    worker_id: 'worker-001',
  }), null);
  assert.equal(fs.existsSync(path.join(root, 'validation', 'runtime-model-observations.jsonl')), false);
  const valid = appendRuntimeModelObservation(root, {
    agent_id: 'source-code',
    model: 'gpt-5.6-luna',
    source: 'agent-sdk:assistant.model',
    worker_id: 'worker-001',
  });
  assert.equal(valid.model, 'gpt-5.6-luna');
});

test('harness binds a settled runtime observation to the terminal discovery worker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-worker-model-binding-'));
  writeJsonLines(root, 'discovery/deep/workers.jsonl', [{
    worker_id: 'worker-001', sequence: 1, status: 'SUCCEEDED', requested_model: 'gpt-5.6-terra',
    actual_model: 'unknown', model_observation_ids: [],
  }, {
    worker_id: 'worker-002', sequence: 2, status: 'FAILED', requested_model: 'gpt-5.6-terra',
    actual_model: 'gpt-5.6-terra', model_observation_ids: [],
  }]);
  assert.equal(bindRuntimeModelObservationToWorker(root, {
    workerId: 'worker-001', observationId: 'model-observation-1', actualModel: 'gpt-5.6-terra',
  }), true);
  const rows = fs.readFileSync(path.join(root, 'discovery/deep/workers.jsonl'), 'utf8')
    .trim().split(/\n/).map(JSON.parse);
  assert.equal(rows[0].actual_model, 'gpt-5.6-terra');
  assert.deepEqual(rows[0].model_observation_ids, ['model-observation-1']);
  assert.deepEqual(rows[1].model_observation_ids, []);
  assert.equal(bindRuntimeModelObservationToWorker(root, {
    workerId: 'worker-001', observationId: 'model-observation-1', actualModel: 'gpt-5.6-terra',
  }), false);
});

test('next discovery gate reconciles receipts that settled before coordinator worker rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-worker-model-reconcile-'));
  writeJsonLines(root, 'discovery/deep/workers.jsonl', [{
    worker_id: 'worker-001', sequence: 1, status: 'SUCCEEDED', requested_model: 'gpt-5.6-terra',
    actual_model: 'unknown', model_observation_ids: [],
  }]);
  writeJsonLines(root, 'validation/runtime-model-observations.jsonl', [{
    observation_id: 'model-observation-1', agent_id: 'source-code', model: 'gpt-5.6-terra',
    source: 'litellm:response-headers', request_id: 'request-1', gateway_model_id: 'deployment-1',
    review_role: 'source-code-primary', worker_id: 'worker-001', observed_at: '2026-08-14T12:00:00.000Z',
  }]);
  assert.equal(reconcileRuntimeModelObservationsToWorkers(root), 1);
  const worker = JSON.parse(fs.readFileSync(path.join(root, 'discovery/deep/workers.jsonl'), 'utf8').trim());
  assert.equal(worker.actual_model, 'gpt-5.6-terra');
  assert.deepEqual(worker.model_observation_ids, ['model-observation-1']);
  assert.equal(reconcileRuntimeModelObservationsToWorkers(root), 0);
});

test('controller projection overwrites model-authored ledgers from authoritative database state', () => {
  const { ensureBlackboardDb } = require('../../scripts/lib/glados-local');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-controller-projection-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("INSERT OR IGNORE INTO engagements (id, session_id, target_name, scope) VALUES ('eng-projection','legacy','fixture','[]')").run();
  db.prepare(`INSERT INTO security_review_worker_runs
    (engagement_id, worker_id, sequence, tool_call_id, status, started_at, completed_at, requested_model)
    VALUES ('eng-projection','worker-001',1,'tool-1','SUCCEEDED','2026-08-14T12:00:00Z','2026-08-14T12:01:00Z','gpt-5.6-terra')`).run();
  db.prepare(`INSERT INTO security_review_model_observations
    (observation_id, engagement_id, agent_id, review_role, worker_id, requested_model, actual_model,
     billed_model_name, source, request_id, gateway_model_id, observed_at, logical_model_alias, attestation_level, gateway_call_id)
    VALUES ('obs-1','eng-projection','source-code','source-code-primary','worker-001','gpt-5.6-terra','deployment-1',
      'gpt-5.6-terra','litellm:response-headers','local-1','deployment-1','2026-08-14T12:00:30Z','gpt-5.6-terra','deployment','gateway-1')`).run();
  db.close();
  writeJsonLines(root, 'discovery/deep/workers.jsonl', [{ worker_id: 'fabricated' }]);
  const { projectSecurityReviewLedgers } = require('../lib/security-review/deep-scan');
  projectSecurityReviewLedgers({ dbPath, artifactRoot: root, engagementId: 'eng-projection' });
  const worker = JSON.parse(fs.readFileSync(path.join(root, 'discovery/deep/workers.jsonl'), 'utf8').trim());
  assert.equal(worker.worker_id, 'worker-001');
  assert.equal(worker.actual_model, 'deployment-1');
  assert.deepEqual(worker.model_observation_ids, ['obs-1']);
});

test('durable receipt and observation reconcile a canceled worker after late completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-late-worker-reconcile-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("INSERT OR IGNORE INTO engagements (id, session_id, target_name, scope) VALUES ('eng-late','legacy','fixture','[]')").run();
  db.prepare(`INSERT INTO security_review_worker_runs
    (engagement_id,worker_id,sequence,tool_call_id,status,started_at,completed_at,error,requested_model)
    VALUES ('eng-late','worker-001',1,'tool-late','CANCELED','2026-08-14T12:00:00Z','2026-08-14T12:01:00Z','parent ended','gpt-5.6-terra')`).run();
  db.prepare(`INSERT INTO security_review_worker_attempts
    (engagement_id,worker_id,sequence,attempt,tool_call_id,status,started_at,completed_at,error)
    VALUES ('eng-late','worker-001',1,1,'tool-late','CANCELED','2026-08-14T12:00:00Z','2026-08-14T12:01:00Z','parent ended')`).run();
  db.prepare(`INSERT INTO security_review_model_observations
    (observation_id,engagement_id,agent_id,review_role,worker_id,requested_model,actual_model,billed_model_name,source,request_id,gateway_model_id,observed_at)
    VALUES ('obs-late','eng-late','source-code','source-code-primary','worker-001','gpt-5.6-terra','deployment-terra','gpt-5.6-terra','litellm:response-headers','request-late','deployment-terra','2026-08-14T12:00:30Z')`).run();
  db.close();
  writeJsonLines(root, 'discovery/deep/worker-001/candidates.jsonl', []);
  writeJson(root, 'discovery/deep/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'SUCCEEDED', candidate_count: 0,
    candidates_sha256: sha256(root, 'discovery/deep/worker-001/candidates.jsonl'),
  });
  assert.equal(reconcileCompletedDiscoveryWorker({
    dbPath, artifactRoot: root, engagementId: 'eng-late', toolCallId: 'tool-late',
  }), true);
  const check = new Database(dbPath, { readonly: true });
  assert.equal(check.prepare("SELECT status FROM security_review_worker_runs WHERE engagement_id='eng-late'").get().status, 'SUCCEEDED');
  check.close();
});

test('worker reconciliation accepts the legacy discovery/workers artifact location', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-legacy-worker-reconcile-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("INSERT OR IGNORE INTO engagements (id, session_id, target_name, scope) VALUES ('eng-legacy','legacy','fixture','[]')").run();
  db.prepare(`INSERT INTO security_review_worker_runs
    (engagement_id,worker_id,sequence,tool_call_id,status,started_at,error,requested_model)
    VALUES ('eng-legacy','worker-001',1,'tool-legacy','CANCELED','2026-08-14T12:00:00Z','parent ended','gpt-5.6-terra')`).run();
  db.prepare(`INSERT INTO security_review_worker_attempts
    (engagement_id,worker_id,sequence,attempt,tool_call_id,status,started_at,error)
    VALUES ('eng-legacy','worker-001',1,1,'tool-legacy','CANCELED','2026-08-14T12:00:00Z','parent ended')`).run();
  db.prepare(`INSERT INTO security_review_model_observations
    (observation_id,engagement_id,agent_id,review_role,worker_id,requested_model,actual_model,billed_model_name,source,request_id,gateway_model_id,observed_at)
    VALUES ('obs-legacy','eng-legacy','source-code','source-code-primary','worker-001','gpt-5.6-terra','deployment-terra','gpt-5.6-terra','litellm:response-headers','request-legacy','deployment-terra','2026-08-14T12:00:30Z')`).run();
  db.close();
  writeJsonLines(root, 'discovery/workers/worker-001/candidates.jsonl', []);
  writeJson(root, 'discovery/workers/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'SUCCEEDED', candidate_count: 0,
    candidates_sha256: sha256(root, 'discovery/workers/worker-001/candidates.jsonl'),
  });
  assert.equal(reconcileCompletedDiscoveryWorker({
    dbPath, artifactRoot: root, engagementId: 'eng-legacy', toolCallId: 'tool-legacy',
  }), true);
  const workers = fs.readFileSync(path.join(root, 'discovery/deep/workers.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(workers[0].status, 'SUCCEEDED');
  assert.equal(workers[0].candidates_artifact, 'discovery/workers/worker-001/candidates.jsonl');
});

test('startup reconciliation recovers durable completed workers for active reviews', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-startup-worker-reconcile-'));
  const dbPath = path.join(root, 'blackboard.db');
  const investigationsDir = path.join(root, 'investigations');
  const artifactRoot = path.join(investigationsDir, 'eng-startup', 'security-review');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("INSERT OR IGNORE INTO engagements (id,session_id,target_name,scope,status) VALUES ('eng-startup','legacy','fixture','[]','active')").run();
  db.prepare(`INSERT INTO security_review_worker_runs
    (engagement_id,worker_id,sequence,tool_call_id,status,started_at,requested_model)
    VALUES ('eng-startup','worker-001',1,'tool-startup','STARTED','2026-08-14T12:00:00Z','gpt-5.6-terra')`).run();
  db.prepare(`INSERT INTO security_review_worker_attempts
    (engagement_id,worker_id,sequence,attempt,tool_call_id,status,started_at)
    VALUES ('eng-startup','worker-001',1,1,'tool-startup','STARTED','2026-08-14T12:00:00Z')`).run();
  db.prepare(`INSERT INTO security_review_model_observations
    (observation_id,engagement_id,agent_id,review_role,worker_id,requested_model,actual_model,billed_model_name,source,request_id,gateway_model_id,observed_at)
    VALUES ('obs-startup','eng-startup','source-code','source-code-primary','worker-001','gpt-5.6-terra','deployment-terra','gpt-5.6-terra','litellm:response-headers','request-startup','deployment-terra','2026-08-14T12:00:30Z')`).run();
  db.close();
  writeJsonLines(artifactRoot, 'discovery/deep/worker-001/candidates.jsonl', []);
  writeJson(artifactRoot, 'discovery/deep/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'SUCCEEDED', candidate_count: 0,
    candidates_sha256: sha256(artifactRoot, 'discovery/deep/worker-001/candidates.jsonl'),
  });
  assert.deepEqual(reconcileActiveSecurityReviewWorkers({ dbPath, investigationsDir }), { checked: 1, reconciled: 1 });
});

test('completion-driven discovery preserves a null attempt ceiling', () => {
  assert.deepEqual(normalizeDeepScanConfig({
    minDiscoveryRuns: 10,
    stopAfterNoNew: 3,
    maxDiscoveryRuns: null,
    maxDurationMinutes: null,
    discoveryConcurrency: 3,
    specialistConcurrency: 3,
  }), {
    minDiscoveryRuns: 10,
    stopAfterNoNew: 3,
    maxDiscoveryRuns: null,
    maxDurationMinutes: null,
    discoveryConcurrency: 3,
    specialistConcurrency: 3,
  });
});

test('controller can transition proven discovery saturation to terminal state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-saturation-transition-'));
  completeReviewArtifacts(root);
  const runFile = path.join(root, 'run.json');
  const manifestFile = path.join(root, 'discovery/deep/manifest.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  run.deepScan.terminalState = 'RUNNING';
  run.deepScan.deadlineAt = null;
  delete run.deepScan.completedAt;
  manifest.status = 'RUNNING';
  manifest.deadline_at = null;
  delete manifest.completed_at;
  writeJson(root, 'run.json', run);
  writeJson(root, 'discovery/deep/manifest.json', manifest);
  const saturation = require('../lib/security-review/deep-scan').discoverySaturationCheckpoint(root);
  assert.equal(saturation.passed, true, saturation.invalid.join('; '));
  require('../lib/security-review/deep-scan').markDeepScanSaturated(root, '2026-08-18T04:00:00.000Z');
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).deepScan.terminalState, 'SATURATED');
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).status, 'SATURATED');
});

test('controller-owned worker claims allow three-wide discovery and reject overflow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-worker-claim-test-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const engagementId = 'eng-claim';
  const artifactRoot = path.join(root, 'investigations', engagementId, 'security-review');
  fs.mkdirSync(artifactRoot, { recursive: true });
  writeJson(artifactRoot, 'run.json', { deepScan: { maxDiscoveryRuns: 60 } });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare('INSERT INTO engagements (id, target_name) VALUES (?, ?)').run(engagementId, 'source-tree');
  db.close();
  assert.deepEqual(claimDiscoveryWorker({
    dbPath, artifactRoot, engagementId, workerId: 'worker-001', toolCallId: 'tool-1',
  }), { claimed: true });
  assert.deepEqual(claimDiscoveryWorker({
    dbPath, artifactRoot, engagementId, workerId: 'worker-002', toolCallId: 'tool-2',
  }), { claimed: true });
  assert.deepEqual(claimDiscoveryWorker({
    dbPath, artifactRoot, engagementId, workerId: 'worker-003', toolCallId: 'tool-3',
  }), { claimed: true });
  assert.match(claimDiscoveryWorker({
    dbPath, artifactRoot, engagementId, workerId: 'worker-004', toolCallId: 'tool-4',
  }).reason, /concurrency limit 3/);
  assert.equal(finalizeDiscoveryWorker({
    dbPath, engagementId, toolCallId: 'tool-1', status: 'FAILED', error: 'fixture failure',
  }), true);
  assert.deepEqual(claimDiscoveryWorker({
    dbPath, artifactRoot, engagementId, workerId: 'worker-001', toolCallId: 'tool-repeat',
  }), { claimed: true });
});

test('successful tool results cannot finalize discovery without durable artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-worker-finalize-artifacts-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("INSERT INTO engagements (id, target_name) VALUES ('eng-finalize', 'fixture')").run();
  db.prepare(`INSERT INTO security_review_worker_runs
    (engagement_id,worker_id,sequence,tool_call_id,status,started_at,requested_model)
    VALUES ('eng-finalize','worker-001',1,'tool-finalize','STARTED','2026-08-14T12:00:00Z','gpt-5.6-terra')`).run();
  db.prepare(`INSERT INTO security_review_worker_attempts
    (engagement_id,worker_id,sequence,attempt,tool_call_id,status,started_at)
    VALUES ('eng-finalize','worker-001',1,1,'tool-finalize','STARTED','2026-08-14T12:00:00Z')`).run();
  db.close();

  assert.equal(finalizeDiscoveryWorker({
    dbPath, artifactRoot: root, engagementId: 'eng-finalize', toolCallId: 'tool-finalize', status: 'SUCCEEDED',
  }), false);
  const check = new Database(dbPath, { readonly: true });
  assert.equal(check.prepare("SELECT status FROM security_review_worker_runs WHERE engagement_id='eng-finalize'").get().status, 'STARTED');
  check.close();
});

test('recovery demotes legacy successful workers that have no durable artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-worker-demote-invalid-'));
  const dbPath = path.join(root, 'blackboard.db');
  ensureBlackboardDb({ blackboardDb: dbPath });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare("INSERT INTO engagements (id, target_name) VALUES ('eng-invalid', 'fixture')").run();
  db.prepare(`INSERT INTO security_review_worker_runs
    (engagement_id,worker_id,sequence,tool_call_id,status,started_at,completed_at,requested_model)
    VALUES ('eng-invalid','worker-001',1,'tool-invalid','SUCCEEDED','2026-08-14T12:00:00Z','2026-08-14T12:01:00Z','gpt-5.6-terra')`).run();
  db.prepare(`INSERT INTO security_review_worker_attempts
    (engagement_id,worker_id,sequence,attempt,tool_call_id,status,started_at,completed_at)
    VALUES ('eng-invalid','worker-001',1,1,'tool-invalid','SUCCEEDED','2026-08-14T12:00:00Z','2026-08-14T12:01:00Z')`).run();
  db.close();

  assert.deepEqual(reconcileInvalidSuccessfulDiscoveryWorkers({
    dbPath, artifactRoot: root, engagementId: 'eng-invalid',
  }), ['worker-001']);
  const check = new Database(dbPath, { readonly: true });
  assert.equal(check.prepare("SELECT status FROM security_review_worker_runs WHERE engagement_id='eng-invalid'").get().status, 'FAILED');
  assert.equal(check.prepare("SELECT status FROM security_review_worker_attempts WHERE engagement_id='eng-invalid'").get().status, 'FAILED');
  check.close();
});

function completeDeepArtifacts(root) {
  const run = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
  run.workflowVersion = 4;
  run.deepScan = {
    minDiscoveryRuns: 3,
    stopAfterNoNew: 6,
    maxDiscoveryRuns: 60,
    maxDurationMinutes: 120,
    discoveryConcurrency: 3,
    specialistConcurrency: 3,
    startedAt: '2026-07-31T12:00:00.000Z',
    deadlineAt: '2026-07-31T14:00:00.000Z',
    completedAt: '2026-07-31T13:00:00.000Z',
    terminalState: 'SATURATED',
  };
  run.modelPolicy = { allowedModels: ['gpt-5.6-luna', 'gpt-5.6-terra'], requireDiversity: true, diversityWaiver: null };
  writeJson(root, 'run.json', run);
  writeJson(root, 'context/threat-model.json', {
    summary: 'Minimal fixture threat model.', trust_boundaries: [], entry_points: [], assets: [], attacker_goals: [], priority_hypotheses: [],
  });
  const candidate = {
    candidate_id: 'worker-001-C0001',
    cwe_ids: ['CWE-20'],
    locations: [{ path: 'main.go', start_line: 1, end_line: 5, role: 'evidence' }],
    summary: 'Fixture candidate',
    evidence: 'The test fixture has a candidate requiring closure.',
    control: 'Input is constrained by the fixture.',
    sink: 'No dangerous operation is reached.',
    reachability: 'The fixture path is locally reachable.',
    counterevidence: 'No unsafe behavior is present.',
    proof_gaps: [],
    confidence: 'high',
  };
  const workers = [];
  for (let sequence = 1; sequence <= 7; sequence++) {
    const workerId = `worker-${String(sequence).padStart(3, '0')}`;
    const candidatesArtifact = `discovery/deep/${workerId}/candidates.jsonl`;
    const receiptArtifact = `discovery/deep/${workerId}/receipt.json`;
    const candidates = sequence === 1 ? [candidate] : [];
    writeJsonLines(root, candidatesArtifact, candidates);
    writeJson(root, receiptArtifact, {
      worker_id: workerId,
      status: 'SUCCEEDED',
      candidate_count: candidates.length,
      candidates_sha256: sha256(root, candidatesArtifact),
    });
    workers.push({
      worker_id: workerId,
      sequence,
      attempt: 1,
      status: 'SUCCEEDED',
      requested_model: 'gpt-5.6-luna',
      actual_model: 'gpt-5.6-luna',
      model_observation_ids: [`obs-worker-${sequence}`],
      started_at: `2026-07-31T12:0${sequence}:00.000Z`,
      completed_at: `2026-07-31T12:0${sequence}:30.000Z`,
      candidates_artifact: candidatesArtifact,
      receipt_artifact: receiptArtifact,
    });
  }
  writeJson(root, 'discovery/deep/manifest.json', {
    schema_version: 1,
    status: 'SATURATED',
    config: run.deepScan,
    started_at: run.deepScan.startedAt,
    completed_at: run.deepScan.completedAt,
    deadline_at: run.deepScan.deadlineAt,
    omitted_workers: [],
  });
  writeJsonLines(root, 'discovery/deep/workers.jsonl', workers);
  writeJson(root, 'discovery/deep/dedupe.json', {
    input_worker_ids: workers.map(row => row.worker_id),
    mappings: [{
      worker_id: 'worker-001', source_candidate_id: 'worker-001-C0001', canonical_candidate_id: 'worker-001-C0001', rationale: 'Unique candidate identity.',
    }],
    new_candidate_counts: Object.fromEntries(workers.map((row, index) => [row.worker_id, index === 0 ? 1 : 0])),
    no_new_streak: 6,
  });
  writeJsonLines(root, 'discovery/candidates.jsonl', [candidate]);
  writeJsonLines(root, 'validation/candidate-closure.jsonl', [{
    candidate_id: 'worker-001-C0001', disposition: 'SUPPRESSED', validation_method: 'independent source inspection',
    evidence: 'The relevant path is constrained.', counterevidence: 'No contrary unsafe path was found.', proof_gaps: [],
  }]);
  writeJsonLines(root, 'validation/attack-paths.jsonl', [{
    candidate_id: 'worker-001-C0001', disposition: 'IGNORE', rationale: 'No attacker-controlled path reaches a security sink.', reachability: 'Local path only.',
  }]);
  const runtimeObservations = [
    { observation_id: 'obs-coordinator', agent_id: 'glados', review_role: 'coordinator', requested_model: 'gpt-5.6-luna', model: 'gpt-5.6-luna', billed_model_name: 'gpt-5.6-luna', source: 'litellm:spend-log', request_id: 'req-coordinator', gateway_model_id: 'deployment-coordinator', observed_at: '2026-07-31T12:00:00.000Z' },
    ...Array.from({ length: 7 }, (_, index) => ({
      observation_id: `obs-worker-${index + 1}`, agent_id: 'source-code', review_role: 'source-code-primary', model: 'gpt-5.6-luna',
      worker_id: `worker-${String(index + 1).padStart(3, '0')}`, requested_model: 'gpt-5.6-luna', billed_model_name: 'gpt-5.6-luna',
      source: 'litellm:spend-log', request_id: `req-worker-${index + 1}`, gateway_model_id: `deployment-worker-${index + 1}`, observed_at: `2026-07-31T12:${10 + index}:00.000Z`, parent_tool_use_id: `tool-worker-${index + 1}`,
    })),
    ...REQUIRED_MODEL_ROLES.filter(role => !['coordinator', 'source-code-primary'].includes(role)).map(role => ({
      observation_id: `obs-${role}`,
      agent_id: role === 'source-review-validator' ? 'source-review-validator' : 'source-code',
      review_role: role,
      model: role === 'source-review-validator' ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
      requested_model: role === 'source-review-validator' ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
      billed_model_name: role === 'source-review-validator' ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
      source: 'litellm:spend-log', request_id: `req-${role}`, gateway_model_id: `deployment-${role}`,
      observed_at: '2026-07-31T12:50:00.000Z',
      parent_tool_use_id: `tool-${role}`,
    })),
  ];
  writeJsonLines(root, 'validation/runtime-model-observations.jsonl', runtimeObservations);
  writeJsonLines(root, 'validation/model-receipts.jsonl', REQUIRED_MODEL_ROLES.map((role, index) => {
    const isValidator = role === 'source-review-validator';
    const isCoordinator = role === 'coordinator';
    return {
      role,
      requested_model: isValidator ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
      actual_model: isValidator ? 'gpt-5.6-terra' : 'gpt-5.6-luna',
      observation_source: 'Agent SDK runtime ledger',
      observation_ids: [isCoordinator ? 'obs-coordinator' : role === 'source-code-primary' ? 'obs-worker-1' : `obs-${role}`],
    };
  }));
  writeJson(root, 'findings.json', { findings: [] });
  writeJson(root, 'observations.json', { observations: [] });
  writeJson(root, 'coverage.json', { files: [{ path: 'main.go', disposition: 'REVIEWED', review_method: 'deep-file-review' }] });
  const sealed = [
    'run.json', 'context/threat-model.json', 'discovery/deep/workers.jsonl', 'discovery/deep/dedupe.json',
    'discovery/candidates.jsonl', 'validation/candidate-closure.jsonl', 'validation/attack-paths.jsonl',
    'validation/runtime-model-observations.jsonl', 'validation/model-receipts.jsonl', 'findings.json', 'coverage.json',
  ];
  const artifactSha256 = Object.fromEntries(sealed.map(relative => [relative, sha256(root, relative)]));
  writeJson(root, 'scan-manifest.json', {
    producer: 'glados-security-review/v1', terminal_state: 'SATURATED', repository_head: run.head, artifact_sha256: artifactSha256,
  });
  writeJson(root, 'completion-receipt.json', { status: 'SEALED', terminal_state: 'SATURATED', artifact_sha256: artifactSha256 });
}

function authoritativeDeepOptions(root) {
  const workers = fs.readFileSync(path.join(root, 'discovery/deep/workers.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  const observations = fs.readFileSync(path.join(root, 'validation/runtime-model-observations.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  return {
    authoritativeWorkerRuns: workers.map(row => ({ ...row, tool_call_id: `tool-${row.worker_id}` })),
    authoritativeModelObservations: observations.map(row => ({
      ...row,
      actual_model: row.model,
      cost_usd: row.cost_usd ?? null,
      worker_id: row.worker_id ?? null,
      requested_model: row.requested_model ?? null,
      billed_model_name: row.billed_model_name ?? null,
      agent_id: row.agent_id,
      review_role: row.review_role,
    })),
  };
}

function completeReviewArtifacts(root, { classLevelCoverage = false, omitSemanticCheck = null, omitCandidateDisposition = false } = {}) {
  writeJson(root, 'run.json', { head: 'snapshot:test', fileCount: 1 });
  writeJson(root, 'intake/scope.json', { repository: { head: 'snapshot:test' } });
  writeJsonLines(root, 'inventory/files.jsonl', [{ key: 'main.go', path: 'main.go', category: 'source' }]);
  writeJsonLines(root, 'inventory/routes.jsonl', []);
  writeJsonLines(root, 'inventory/suppressions.jsonl', []);
  writeJsonLines(root, 'inventory/http-clients.jsonl', []);
  writeJsonLines(root, 'inventory/crypto-operations.jsonl', []);
  writeJsonLines(root, 'inventory/security-sensitive.jsonl', [{
    inventory_key: 'main.go:request-body-binding',
    check_id: 'request-binding-mass-assignment',
    rule: 'request-body-binding',
    file: 'main.go',
    line_range: '3-3',
    observed_evidence: 'Request body binding occurs at this exact line.',
  }]);
  writeJson(root, 'inventory/secrets-head.json', { mode: 'HEAD', completed: true, head: 'snapshot:test', findings: [] });
  writeJson(root, 'inventory/secrets-history.json', { mode: 'history', completed: true, head: 'snapshot:test', findings: [] });
  for (const relative of ['inventory/sensitive-data-head.json', 'inventory/pii-head.json']) {
    writeJson(root, relative, { schema_version: 1, engine: 'glados-sensitive-data/v1', mode: 'HEAD', completed: true, head: 'snapshot:test', candidates: [] });
  }
  writeJson(root, 'inventory/pii-history.json', { schema_version: 1, engine: 'glados-sensitive-data/v1', mode: 'history', completed: true, head: 'snapshot:test', candidates: [] });
  writeJsonLines(root, 'validation/sensitive-data-verifications.jsonl', []);
  writeJsonLines(root, 'discovery/findings.jsonl', []);
  writeJsonLines(root, 'discovery/coverage-ledger.jsonl', [{
    key: 'main.go',
    path: 'main.go',
    review_method: classLevelCoverage ? 'reviewed-as-class:go-source' : 'deep-file-review',
    disposition: classLevelCoverage ? 'reviewed-class-level' : 'reviewed',
  }]);
  for (const track of SPECIALIST_TRACKS) writeJsonLines(root, `tracks/${track}/findings.jsonl`, []);
  writeJsonLines(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl', []);
  writeJsonLines(root, 'tracks/data-flow-injection/source-sink-matrix.jsonl', []);
  writeJson(root, 'tracks/secrets-history/history-receipt.json', { completed: true });
  writeJsonLines(root, 'tracks/secrets-history/sensitive-data-dispositions.jsonl', []);
  writeJsonLines(root, 'tracks/resilience-error-handling/http-client-matrix.jsonl', []);
  writeJsonLines(root, 'tracks/iac-config-manifests/disposition-matrix.jsonl', []);
  writeJsonLines(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl', []);
  writeJsonLines(root, 'tracks/cryptography-suppressions/suppression-dispositions.jsonl', []);
  writeJson(root, 'regression/delta.json', { status: 'NOT_REQUESTED_BLIND_MODE' });
  writeJsonLines(root, 'dynamic-validation/matrix.jsonl', []);
  writeJson(root, 'validation/challenge-matrix.json', { outcomes: [] });

  const evidence = {
    file: 'main.go',
    line_range: '1-5',
    rule: 'manual-semantic-review',
    observed_evidence: 'The fixture was reviewed from its entry point through its terminal operation.',
    result: 'No unsafe behavior is present in the minimal test fixture.',
  };
  writeJson(root, 'validation/semantic-coverage.json', {
    checks: SEMANTIC_REVIEW_CHECKS
      .filter(check => check.id !== omitSemanticCheck)
      .map(check => ({ id: check.id, status: 'TESTED_NEGATIVE', analysis: check.requirement, evidence: [evidence] })),
    candidate_dispositions: omitCandidateDisposition ? [] : [{
      inventory_key: 'main.go:request-body-binding',
      check_id: 'request-binding-mass-assignment',
      status: 'TESTED_NEGATIVE',
      evidence: { ...evidence, rule: 'request-body-binding' },
    }],
    referrals: [],
  });
  completeDeepArtifacts(root);
}

test('source review coordinator contract requires staged analysis and hard gates', () => {
  const prompt = securityReviewCoordinatorPrompt({
    repositoryPath: '/tmp/repository',
    engagementId: 'eng-1',
    goalId: 'goal-1',
    artifactRoot: '/tmp/artifacts',
  });
  for (const phrase of [
    'Deterministic inventory',
    'Blind discovery',
    'repeated blind discovery',
    'discovery/deep/workers.jsonl',
    'centralized deduplication',
    'ordered batches of up to 3 synchronous Agent SDK source-code tasks',
    'SATURATED',
    'Historical regression',
    'Omission-focused independent validation',
    'source-review-validator',
    'route/method/authn/scope/ownership/repository-filter matrix',
    'security-sensitive semantic candidate inventory',
    'validation/semantic-coverage.json',
    'request-binding-mass-assignment',
    'cross-track-referral-closure',
    'HEAD and history secret-scan receipts',
    'Every High/Critical finding has validator confirmation',
    'Do not require approval to complete or present a security review',
  ]) assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  for (const track of SPECIALIST_TRACKS) assert.match(prompt, new RegExp(track));
  for (const exactField of [
    '"input_worker_ids":["worker-001"]',
    '"worker_id":"worker-001","source_candidate_id":"worker-001-C0001"',
    '"new_candidate_counts":{"worker-001":1}',
    '"no_new_streak":0',
  ]) assert.equal(prompt.includes(exactField), true, `missing exact coordinator field contract: ${exactField}`);
  assert.match(prompt, /Never invent, predict, alias, or use a placeholder observation ID/);
  assert.match(prompt, /Never pause for operator approval between batches/);
  assert.match(prompt, /Neither workers nor the coordinator may create or edit discovery\/deep\/workers\.jsonl/);
  assert.match(prompt, /three standalone machine-readable lines exactly/);
  assert.match(prompt, /Preserve the harness-created discovery\/deep\/manifest\.json fields/);
});

test('security review automatically generates built-in reports after sealing', () => {
  const prompt = securityReviewCoordinatorPrompt({
    repositoryPath: '/tmp/repository', engagementId: 'eng-1', goalId: 'goal-1', artifactRoot: '/tmp/artifacts', contextMode: 'blind',
  });
  assert.match(prompt, /Automatically retry incomplete static-analysis\/validation tasks/);
  assert.match(prompt, /return the validated result/);
  assert.match(prompt, /automatically generates and indexes the sealed security-review Markdown, HTML, per-finding, and desktop PDF deliverables/i);
  assert.match(prompt, /Do not wait for wrap approval/);
  assert.match(prompt, /approval remains required for live\/target-facing actions and external publication/i);
  assert.match(prompt, /Do not call engagement completion/);
  assert.doesNotMatch(prompt, /finish at pending operator confirmation/);
});

test('blind source review prohibits prior-report lookup and skips regression without failing the workflow', () => {
  const prompt = securityReviewCoordinatorPrompt({
    repositoryPath: '/tmp/repository', engagementId: 'eng-1', goalId: 'goal-1', artifactRoot: '/tmp/artifacts', contextMode: 'blind',
  });
  assert.match(prompt, /CONTEXT MODE: BLIND/);
  assert.match(prompt, /Do not search for, open, infer, summarize, or compare any prior report/);
  assert.match(prompt, /NOT_REQUESTED_BLIND_MODE/);
  assert.doesNotMatch(prompt, /Search existing investigation\/report indexes/);
});

test('informed source review preserves blind discovery before mandatory regression', () => {
  const prompt = securityReviewCoordinatorPrompt({
    repositoryPath: '/tmp/repository', engagementId: 'eng-1', goalId: 'goal-1', artifactRoot: '/tmp/artifacts', contextMode: 'informed',
  });
  assert.match(prompt, /CONTEXT MODE: INFORMED/);
  assert.match(prompt, /Run blind discovery first/);
  assert.match(prompt, /Every supplied prior finding is dispositioned/);
});

test('expedited campaign contract preserves breadth, risk-ranked depth, and validation quality', () => {
  const campaign = {
    repository_count: 2,
    repositories: [
      { repository_id: 'repo-001', relative_path: 'api', required_discovery_worker: 'worker-001' },
      { repository_id: 'repo-002', relative_path: 'web', required_discovery_worker: 'worker-002' },
    ],
  };
  const prompt = securityReviewCoordinatorPrompt({
    repositoryPath: '/tmp/repos', engagementId: 'eng-1', goalId: 'goal-1', artifactRoot: '/tmp/artifacts',
    reviewProfile: 'expedited', campaign, deepScan: { minDiscoveryRuns: 3, stopAfterNoNew: 3, maxDiscoveryRuns: null },
  });
  assert.match(prompt, /review_profile: expedited/);
  assert.match(prompt, /Required breadth assignments: worker-001=repo-001:api, worker-002=repo-002:web/);
  assert.match(prompt, /before any repeated or cross-repository hotspot pass/);
  assert.match(prompt, /risk-ranked-depth, not reduced evidence standards/i);
  assert.match(prompt, /portfolio\/coverage\.jsonl/);
  assert.match(prompt, /independent reproduction from source/);
  assert.match(prompt, /no repository is partial, blocked, deferred, or silently omitted/i);
  assert.match(prompt, /no fixed discovery-attempt ceiling/i);
});

test('source review gate status blocks incomplete artifact sets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-gates-'));
  const blocked = sourceReviewGateStatus(root);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.missing.includes('inventory/files.jsonl'), true);
  assert.equal(blocked.missing.includes('validation/challenge-matrix.json'), true);
  assert.equal(blocked.missing.includes('validation/semantic-coverage.json'), true);
});

test('source review gate conditionally requires portfolio manifest and coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-portfolio-gates-'));
  writeJson(root, 'run.json', {
    workflowVersion: 3,
    campaign: { enabled: true, repositoryCount: 2 },
  });
  const blocked = sourceReviewGateStatus(root);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.missing.includes('portfolio/repositories.json'), true);
  assert.equal(blocked.missing.includes('portfolio/coverage.jsonl'), true);
});

test('controller campaign expectation cannot be disabled inside mutable run artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-portfolio-marker-'));
  writeJson(root, 'run.json', {
    workflowVersion: 3,
    reviewProfile: 'expedited',
    campaign: { enabled: false },
  });
  const blocked = sourceReviewGateStatus(root, { campaignExpected: true });
  assert.equal(blocked.missing.includes('portfolio/repositories.json'), true);
  assert.match(blocked.invalid.join('\n'), /controller expected a campaign run/);
});

test('source review gate passes a complete machine-verifiable artifact set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-complete-'));
  completeReviewArtifacts(root);
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.equal(result.passed, true);
});

test('source review gate rejects class-level high-risk coverage and semantic omissions', () => {
  const classLevel = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-class-level-'));
  completeReviewArtifacts(classLevel, { classLevelCoverage: true });
  const shallow = sourceReviewGateStatus(classLevel);
  assert.equal(shallow.passed, false);
  assert.equal(shallow.invalid.some(item => /requires deep file-specific review/.test(item)), true);

  const missingCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-semantic-gap-'));
  completeReviewArtifacts(missingCheck, {
    omitSemanticCheck: 'bearer-token-replay',
    omitCandidateDisposition: true,
  });
  const semanticGap = sourceReviewGateStatus(missingCheck);
  assert.equal(semanticGap.passed, false);
  assert.equal(semanticGap.invalid.some(item => /required semantic checks: key mismatch/.test(item)), true);
  assert.equal(semanticGap.invalid.some(item => /semantic candidate dispositions: key mismatch/.test(item)), true);
});

test('source review gate rejects unexplained worker failure, unmapped candidates, and capped completion', () => {
  const failedWorker = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-failed-worker-'));
  completeReviewArtifacts(failedWorker);
  const workersFile = path.join(failedWorker, 'discovery/deep/workers.jsonl');
  fs.appendFileSync(workersFile, `${JSON.stringify({
    worker_id: 'worker-008', sequence: 8, attempt: 1, status: 'FAILED', requested_model: 'gpt-5.6-luna', actual_model: 'gpt-5.6-luna',
    started_at: '2026-07-31T12:08:00.000Z', completed_at: '2026-07-31T12:08:30.000Z', error: 'worker process exited',
  })}\n`);
  const failed = sourceReviewGateStatus(failedWorker);
  assert.equal(failed.passed, false);
  assert.equal(failed.invalid.some(item => /neither retried successfully nor explicitly omitted/.test(item)), true);

  const unmapped = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-unmapped-'));
  completeReviewArtifacts(unmapped);
  const candidatesFile = 'discovery/deep/worker-002/candidates.jsonl';
  const extra = JSON.parse(fs.readFileSync(path.join(unmapped, 'discovery/candidates.jsonl'), 'utf8'));
  extra.candidate_id = 'raw-unmapped';
  writeJsonLines(unmapped, candidatesFile, [extra]);
  writeJson(unmapped, 'discovery/deep/worker-002/receipt.json', {
    worker_id: 'worker-002', status: 'SUCCEEDED', candidate_count: 1, candidates_sha256: sha256(unmapped, candidatesFile),
  });
  const unmappedResult = sourceReviewGateStatus(unmapped);
  assert.equal(unmappedResult.passed, false);
  assert.equal(unmappedResult.invalid.some(item => /dedupe mapping closure/.test(item)), true);

  const capped = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-capped-'));
  completeReviewArtifacts(capped);
  const run = JSON.parse(fs.readFileSync(path.join(capped, 'run.json'), 'utf8'));
  run.deepScan.terminalState = 'CAPPED';
  writeJson(capped, 'run.json', run);
  const cappedResult = sourceReviewGateStatus(capped);
  assert.equal(cappedResult.passed, false);
  assert.equal(cappedResult.invalid.some(item => /expected SATURATED, received CAPPED/.test(item)), true);
});

test('source review gate rejects model receipts not proven by SDK runtime observations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-model-observation-'));
  completeReviewArtifacts(root);
  const receipts = fs.readFileSync(path.join(root, 'validation/model-receipts.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  receipts.find(row => row.role === 'source-review-validator').actual_model = 'gpt-5.6-luna';
  writeJsonLines(root, 'validation/model-receipts.jsonl', receipts);
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.equal(result.passed, false);
  assert.equal(result.invalid.some(item => /actual model is not proven by an authoritative gateway observation/.test(item)), true);
});

test('source review gate rejects a role that does not use its configured model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-expected-model-'));
  completeReviewArtifacts(root);
  const run = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
  run.modelPolicy.expectedModels = { 'source-code-primary': 'gpt-5.6-terra' };
  writeJson(root, 'run.json', run);
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.equal(result.passed, false);
  assert.equal(result.invalid.some(item => /does not match configured model gpt-5\.6-terra/.test(item)), true);
});

test('source review gate binds each discovery worker to its own harness model observation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-worker-observation-'));
  completeReviewArtifacts(root);
  const observations = fs.readFileSync(path.join(root, 'validation/runtime-model-observations.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  observations.find(row => row.observation_id === 'obs-worker-1').worker_id = 'worker-002';
  writeJsonLines(root, 'validation/runtime-model-observations.jsonl', observations);
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.equal(result.passed, false);
  assert.equal(result.invalid.some(item => /actual model is not proven by an authoritative gateway observation|not present unchanged/.test(item)), true);
});

test('validator-origin candidates join closure without fabricating worker dedupe mappings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-validator-candidate-'));
  completeReviewArtifacts(root);
  const candidate = {
    candidate_id: 'NEW-001', cwe_ids: ['CWE-20'],
    locations: [{ path: 'main.go', start_line: 1, end_line: 1, role: 'source' }],
    summary: 'Validator candidate', evidence: 'Evidence', control: 'Control', sink: 'Sink',
    reachability: 'Reachable', counterevidence: 'None', proof_gaps: [], confidence: 'high',
  };
  writeJsonLines(root, 'validation/new-candidates.jsonl', [candidate]);
  const closure = fs.readFileSync(path.join(root, 'validation/candidate-closure.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  closure.push({ candidate_id: 'NEW-001', disposition: 'NOT_APPLICABLE', validation_method: 'validator review', evidence: 'Evidence', counterevidence: 'None', proof_gaps: [] });
  writeJsonLines(root, 'validation/candidate-closure.jsonl', closure);
  const attacks = fs.readFileSync(path.join(root, 'validation/attack-paths.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  attacks.push({ candidate_id: 'NEW-001', disposition: 'NOT_APPLICABLE', rationale: 'Not applicable', reachability: 'Blocked' });
  writeJsonLines(root, 'validation/attack-paths.jsonl', attacks);
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.equal(result.invalid.some(item => /validator candidates vs validation closure|validator candidates vs attack-path/.test(item)), false);
});

test('source review gate accepts evidence-backed observations outside the vulnerability count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-observation-'));
  completeReviewArtifacts(root);
  const closureFile = path.join(root, 'validation/candidate-closure.jsonl');
  const closure = fs.readFileSync(closureFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  closure[0] = {
    candidate_id: closure[0].candidate_id,
    disposition: 'OBSERVATION',
    validation_method: 'independent source review',
    evidence: 'Source pattern exists but exploitability is not established.',
    counterevidence: 'External control is unavailable.',
    proof_gaps: ['Inspect external policy.'],
    observation_ids: [closure[0].candidate_id],
    observation_category: 'conditional-security-observation',
    reportability_rationale: 'Attacker capability and runtime reachability are unproven.',
  };
  writeJsonLines(root, 'validation/candidate-closure.jsonl', closure);
  const attacks = fs.readFileSync(path.join(root, 'validation/attack-paths.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  attacks[0].disposition = 'OBSERVATION';
  writeJsonLines(root, 'validation/attack-paths.jsonl', attacks);
  const findings = JSON.parse(fs.readFileSync(path.join(root, 'findings.json'), 'utf8'));
  findings.findings = [];
  writeJson(root, 'findings.json', findings);
  writeJson(root, 'observations.json', {
    schema_version: 1, producer: 'glados-security-review/v1', engagement_id: 'eng', repository_head: 'snapshot:test',
    observations: [{
      id: closure[0].candidate_id, title: 'Conditional observation', category: 'conditional-security-observation',
      rationale: closure[0].reportability_rationale, recommendation: 'Validate the inherited control.',
      evidence: closure[0].evidence, reachability: 'Build time only.', counterevidence: closure[0].counterevidence,
      locations: [{ path: 'main.go', start_line: 1, end_line: 5, role: 'evidence' }], proof_gaps: closure[0].proof_gaps,
    }],
  });
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.equal(result.invalid.some(item => /OBSERVATION|observations\.json|reportable candidate findings/.test(item)), false);
});

test('semantic referral observations are terminal but NEW is not High/Critical confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-terminal-variants-'));
  completeReviewArtifacts(root);
  const semanticFile = path.join(root, 'validation/semantic-coverage.json');
  const semantic = JSON.parse(fs.readFileSync(semanticFile, 'utf8'));
  semantic.referrals = [{
    id: 'R-1', status: 'OBSERVATION', evidence: {
      file: 'main.go', line_range: '1-2', rule: 'referral', observed_evidence: 'Conditional path', result: 'OBSERVATION',
    },
  }];
  writeJson(root, 'validation/semantic-coverage.json', semantic);
  const findingId = 'F-HIGH';
  const findings = [{ finding_id: findingId, severity: 'high' }];
  writeJsonLines(root, 'discovery/findings.jsonl', findings);
  const challenge = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));
  challenge.outcomes = [{ id: findingId, outcome: 'NEW' }];
  writeJson(root, 'validation/challenge-matrix.json', challenge);
  const result = sourceReviewGateStatus(root, authoritativeDeepOptions(root));
  assert.equal(result.invalid.some(item => /semantic referral R-1/.test(item)), false);
  assert.equal(result.invalid.some(item => /missing validator confirmation/.test(item)), true);
});

test('discovery dispatch checkpoint blocks a new worker until the prior worker is durably reconciled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-discovery-checkpoint-'));
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  writeJson(root, 'run.json', {
    deepScan: {
      minDiscoveryRuns: 3, stopAfterNoNew: 6, maxDiscoveryRuns: 60, maxDurationMinutes: 120, discoveryConcurrency: 3, specialistConcurrency: 3,
      terminalState: 'RUNNING', deadlineAt,
    },
  });
  writeJson(root, 'discovery/deep/manifest.json', {
    schema_version: 1, status: 'RUNNING', config: { minDiscoveryRuns: 3, stopAfterNoNew: 6, maxDiscoveryRuns: 60, maxDurationMinutes: 120, discoveryConcurrency: 3, specialistConcurrency: 3 },
    started_at: '2026-07-31T12:00:00.000Z', deadline_at: deadlineAt, omitted_workers: [],
  });
  const candidate = {
    candidate_id: 'worker-001-C0001', cwe_ids: ['CWE-20'], locations: [{ path: 'main.go', start_line: 1, end_line: 1, role: 'evidence' }],
    summary: 'Candidate', evidence: 'Evidence', control: 'Control', sink: 'Sink', reachability: 'Reachable', counterevidence: 'None', proof_gaps: [], confidence: 'medium',
  };
  writeJsonLines(root, 'discovery/deep/worker-001/candidates.jsonl', [candidate]);
  writeJson(root, 'discovery/deep/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'SUCCEEDED', candidate_count: 1,
    candidates_sha256: sha256(root, 'discovery/deep/worker-001/candidates.jsonl'),
  });
  writeJsonLines(root, 'validation/runtime-model-observations.jsonl', [{
    observation_id: 'obs-worker-001', agent_id: 'source-code', review_role: 'source-code-primary', worker_id: 'worker-001',
    model: 'gpt-5.6-luna', source: 'agent-sdk:assistant.model', observed_at: '2026-07-31T12:01:00.000Z',
  }]);
  writeJsonLines(root, 'discovery/deep/workers.jsonl', [{
    worker_id: 'worker-001', sequence: 1, attempt: 1, status: 'SUCCEEDED', requested_model: 'gpt-5.6-luna', actual_model: 'gpt-5.6-luna',
    model_observation_ids: ['obs-worker-001'], started_at: '2026-07-31T12:00:00.000Z', completed_at: '2026-07-31T12:02:00.000Z',
    retry_of: null, candidates_artifact: 'discovery/deep/worker-001/candidates.jsonl', receipt_artifact: 'discovery/deep/worker-001/receipt.json',
  }]);
  writeJsonLines(root, 'discovery/candidates.jsonl', [candidate]);
  writeJson(root, 'discovery/deep/dedupe.json', {
    input_worker_ids: ['worker-001'],
    mappings: [{ worker_id: 'worker-001', source_candidate_id: 'worker-001-C0001', canonical_candidate_id: 'worker-001-C0001', rationale: 'First introduction.' }],
    new_candidate_counts: { 'worker-001': 1 }, no_new_streak: 0,
  });
  assert.deepEqual(discoveryDispatchCheckpoint(root, { nextWorkerId: 'worker-002' }), { passed: true, invalid: [] });
  const unsaturated = discoverySaturationCheckpoint(root);
  assert.equal(unsaturated.passed, false);
  assert.equal(unsaturated.invalid.some(item => /consecutive zero-new successful workers/.test(item)), true);

  candidate.proof_gaps = 'No remaining proof gaps.';
  writeJsonLines(root, 'discovery/deep/worker-001/candidates.jsonl', [candidate]);
  writeJson(root, 'discovery/deep/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'SUCCEEDED', candidate_count: 1,
    candidates_sha256: sha256(root, 'discovery/deep/worker-001/candidates.jsonl'),
  });
  const invalidCandidate = discoveryDispatchCheckpoint(root, { nextWorkerId: 'worker-002' });
  assert.equal(invalidCandidate.passed, false);
  assert.equal(invalidCandidate.invalid.some(item => /proof_gaps: required array/.test(item)), true);
  candidate.proof_gaps = [];
  writeJsonLines(root, 'discovery/deep/worker-001/candidates.jsonl', [candidate]);
  writeJson(root, 'discovery/deep/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'SUCCEEDED', candidate_count: 1,
    candidates_sha256: sha256(root, 'discovery/deep/worker-001/candidates.jsonl'),
  });

  const workers = fs.readFileSync(path.join(root, 'discovery/deep/workers.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  workers[0].candidate_artifact = workers[0].candidates_artifact;
  delete workers[0].candidates_artifact;
  writeJsonLines(root, 'discovery/deep/workers.jsonl', workers);
  const blocked = discoveryDispatchCheckpoint(root, { nextWorkerId: 'worker-002' });
  assert.equal(blocked.passed, false);
  assert.equal(blocked.invalid.some(item => /legacy ledger field names/.test(item)), true);
});

test('dedupe first introductions use worker sequence rather than mapping row order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-dedupe-order-'));
  completeReviewArtifacts(root);
  const dedupeFile = path.join(root, 'discovery/deep/dedupe.json');
  const dedupe = JSON.parse(fs.readFileSync(dedupeFile, 'utf8'));
  dedupe.mappings.reverse();
  writeJson(root, 'discovery/deep/dedupe.json', dedupe);
  const next = `worker-${String(dedupe.input_worker_ids.length + 1).padStart(3, '0')}`;
  const checkpoint = discoveryDispatchCheckpoint(root, { nextWorkerId: next, saturationProbe: true });
  assert.equal(checkpoint.invalid.some(item => /one-to-one raw candidate closure|new_candidate_counts/.test(item)), false);
  assert.deepEqual(discoverySaturationCheckpoint(root), { passed: true, invalid: [] });
});

test('source review gate rejects noncanonical worker receipt and location schemas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-worker-schema-'));
  completeReviewArtifacts(root);
  const candidatesRelative = 'discovery/deep/worker-001/candidates.jsonl';
  const candidate = JSON.parse(fs.readFileSync(path.join(root, candidatesRelative), 'utf8'));
  candidate.locations = [{ file: 'main.go', line: 1, symbol: 'main' }];
  writeJsonLines(root, candidatesRelative, [candidate]);
  writeJson(root, 'discovery/deep/worker-001/receipt.json', {
    worker_id: 'worker-001', status: 'COMPLETED', candidate_count: 1, candidates_sha256: sha256(root, candidatesRelative),
  });
  const result = sourceReviewGateStatus(root);
  assert.equal(result.passed, false);
  assert.equal(result.invalid.some(item => /unsupported fields file, line, symbol/.test(item)), true);
  assert.equal(result.invalid.some(item => /worker identity\/status mismatch/.test(item)), true);
});

test('blackboard task update exposes engagement id required by its handler', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'blackboard', 'blackboard-mcp', 'index.js'), 'utf8');
  const tool = source.match(/name: "blackboard_task_update",([\s\S]*?)\n  \},\n  \{/i)?.[1] || '';
  assert.match(tool, /engagement_id/);
  assert.match(tool, /required: \["task_id", "engagement_id"\]/);
});

test('security review inventory deterministically enumerates files, suppressions, routes, and scan receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-inventory-'));
  const repo = path.join(root, 'repo');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(repo, 'manifests', 'overlays', 'prod'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'main.go'), [
    'package main',
    '//nolint:gosec',
    'type Request struct { Body Profile }',
    'func register() { router.GET("/users/:id", handler) }',
    'func review(db DB, req Request) {',
    '  filter := fmt.Sprintf("displayName eq \'%s\'", req.Body.Name)',
    '  graphql.ValidateDocument()',
    '  _ = claims.Uti',
    '  operation.Security = []map[string][]string{}',
    '  Authorize(PlatformProfileUpdate)',
    '  db.Delete(&profile).Where("id = ?", req.Body.ID)',
    '  _ = filter',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'manifests', 'overlays', 'prod', 'app.yaml'), 'kind: Deployment\n');
  cp.execFileSync('git', ['init', '-q', repo]);
  cp.execFileSync('git', ['-C', repo, 'add', '.']);
  cp.execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const first = generateSecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  const fileManifest = fs.readFileSync(path.join(artifacts, 'inventory', 'files.jsonl'), 'utf8');
  const routes = fs.readFileSync(path.join(artifacts, 'inventory', 'routes.jsonl'), 'utf8');
  const suppressions = fs.readFileSync(path.join(artifacts, 'inventory', 'suppressions.jsonl'), 'utf8');
  const securitySensitive = fs.readFileSync(path.join(artifacts, 'inventory', 'security-sensitive.jsonl'), 'utf8');
  const second = generateSecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  assert.equal(first.head, second.head);
  assert.match(fileManifest, /manifests\/overlays\/prod\/app\.yaml/);
  assert.match(routes, /main\.go/);
  assert.match(suppressions, /nolint-gosec/);
  for (const checkId of [
    'request-binding-mass-assignment',
    'directory-query-filter-injection',
    'graphql-abuse-controls',
    'bearer-token-replay',
    'oauth-operation-scope-enforcement',
    'authorization-policy-constant-consistency',
    'orm-mutation-ordering',
  ]) assert.match(securitySensitive, new RegExp(checkId));
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'inventory', 'secrets-head.json'), 'utf8')).completed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'inventory', 'secrets-history.json'), 'utf8')).completed, true);
});

test('security review inventory accepts extracted non-Git source snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-snapshot-'));
  const repo = path.join(root, 'source copy');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'pkg', 'api.go'), 'package pkg\nfunc route() { router.GET("/assets", handler) }\n');
  const run = generateSecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  assert.equal(run.sourceType, 'directory-snapshot');
  assert.match(run.head, /^snapshot:[a-f0-9]{64}$/);
  const history = JSON.parse(fs.readFileSync(path.join(artifacts, 'inventory', 'secrets-history.json'), 'utf8'));
  assert.equal(history.completed, false);
  assert.equal(history.unavailable, true);
  assert.match(history.reason, /no Git metadata/);
  assert.match(fs.readFileSync(path.join(artifacts, 'inventory', 'files.jsonl'), 'utf8'), /pkg\/api\.go/);
});

test('canonical inventory verification detects source snapshot drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-inventory-verifier-'));
  const repo = path.join(root, 'repo');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'main.go'), 'package main\n');
  generateSecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  assert.equal(verifySecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts }).verified, true);
  fs.writeFileSync(path.join(repo, 'main.go'), 'package changed\n');
  fs.writeFileSync(path.join(repo, 'added.txt'), 'added\n');
  const drift = verifySecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  assert.equal(drift.verified, false);
  assert.deepEqual(drift.changed, ['main.go']);
  assert.deepEqual(drift.added, ['added.txt']);
});
