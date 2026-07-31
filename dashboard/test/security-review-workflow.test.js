const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function completeReviewArtifacts(root, { classLevelCoverage = false, omitSemanticCheck = null, omitCandidateDisposition = false } = {}) {
  writeJson(root, 'run.json', { head: 'snapshot:test', fileCount: 1 });
  writeJson(root, 'intake/scope.json', { repository: { head: 'snapshot:test' } });
  writeJsonLines(root, 'inventory/files.jsonl', [{ key: 'main.go', path: 'main.go', category: 'source' }]);
  writeJsonLines(root, 'inventory/routes.jsonl', []);
  writeJsonLines(root, 'inventory/suppressions.jsonl', []);
  writeJsonLines(root, 'inventory/http-clients.jsonl', []);
  writeJsonLines(root, 'inventory/crypto-operations.jsonl', []);
  writeJsonLines(root, 'inventory/security-sensitive.jsonl', [{
    key: 'main.go:request-body-binding',
    category: 'semantic-review-candidate',
    check_id: 'request-binding-mass-assignment',
    rule: 'request-body-binding',
    file: 'main.go',
    lines: [3],
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
  const result = sourceReviewGateStatus(root);
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
