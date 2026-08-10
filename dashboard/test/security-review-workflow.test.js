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
const { generateSecurityReviewInventory } = require('../lib/security-review/inventory');
const {
  REQUIRED_MODEL_ROLES,
  appendRuntimeModelObservation,
  claimDiscoveryWorker,
  discoveryDispatchCheckpoint,
  discoverySaturationCheckpoint,
  finalizeDiscoveryWorker,
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
    dbPath, engagementId, toolCallId: 'tool-1', status: 'SUCCEEDED',
  }), true);
  assert.match(claimDiscoveryWorker({
    dbPath, artifactRoot, engagementId, workerId: 'worker-001', toolCallId: 'tool-repeat',
  }).reason, /out of sequence|already dispatched/);
});

function completeDeepArtifacts(root) {
  const run = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
  run.workflowVersion = 3;
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
    '"completed_at":"ISO-8601"',
    '"candidates_artifact":"discovery/deep/worker-NNN/candidates.jsonl"',
    '"input_worker_ids":["worker-001"]',
    '"worker_id":"worker-001","source_candidate_id":"worker-001-C0001"',
    '"new_candidate_counts":{"worker-001":1}',
    '"no_new_streak":0',
  ]) assert.equal(prompt.includes(exactField), true, `missing exact coordinator field contract: ${exactField}`);
  assert.match(prompt, /Never invent, predict, alias, or use a placeholder observation ID/);
  assert.match(prompt, /three standalone machine-readable lines exactly/);
  assert.match(prompt, /Preserve the harness-created discovery\/deep\/manifest\.json fields/);
});

test('security review asks for approval only for live actions and formal reporting', () => {
  const prompt = securityReviewCoordinatorPrompt({
    repositoryPath: '/tmp/repository', engagementId: 'eng-1', goalId: 'goal-1', artifactRoot: '/tmp/artifacts', contextMode: 'blind',
  });
  assert.match(prompt, /Automatically retry incomplete static-analysis\/validation tasks/);
  assert.match(prompt, /Mark the analysis goal complete and deliver validated results/);
  assert.match(prompt, /approval is required only for live\/target-facing actions and for generating or publishing the formal report package/i);
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

test('source review gate status blocks incomplete artifact sets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-source-review-gates-'));
  const blocked = sourceReviewGateStatus(root);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.missing.includes('inventory/files.jsonl'), true);
  assert.equal(blocked.missing.includes('validation/challenge-matrix.json'), true);
  assert.equal(blocked.missing.includes('validation/semantic-coverage.json'), true);
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
