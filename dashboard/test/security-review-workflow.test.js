const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {
  SPECIALIST_TRACKS,
  securityReviewCoordinatorPrompt,
  sourceReviewGateStatus,
} = require('../lib/security-review/workflow');
const { generateSecurityReviewInventory } = require('../lib/security-review/inventory');

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
    'HEAD and history secret-scan receipts',
    'Every High/Critical finding has validator confirmation',
    'pending operator confirmation',
  ]) assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  for (const track of SPECIALIST_TRACKS) assert.match(prompt, new RegExp(track));
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
  fs.writeFileSync(path.join(repo, 'main.go'), 'package main\n//nolint:gosec\nfunc register() { router.GET("/users/:id", handler) }\n');
  fs.writeFileSync(path.join(repo, 'manifests', 'overlays', 'prod', 'app.yaml'), 'kind: Deployment\n');
  cp.execFileSync('git', ['init', '-q', repo]);
  cp.execFileSync('git', ['-C', repo, 'add', '.']);
  cp.execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const first = generateSecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  const fileManifest = fs.readFileSync(path.join(artifacts, 'inventory', 'files.jsonl'), 'utf8');
  const routes = fs.readFileSync(path.join(artifacts, 'inventory', 'routes.jsonl'), 'utf8');
  const suppressions = fs.readFileSync(path.join(artifacts, 'inventory', 'suppressions.jsonl'), 'utf8');
  const second = generateSecurityReviewInventory({ repositoryPath: repo, artifactRoot: artifacts });
  assert.equal(first.head, second.head);
  assert.match(fileManifest, /manifests\/overlays\/prod\/app\.yaml/);
  assert.match(routes, /main\.go/);
  assert.match(suppressions, /nolint-gosec/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'inventory', 'secrets-head.json'), 'utf8')).completed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'inventory', 'secrets-history.json'), 'utf8')).completed, true);
});
