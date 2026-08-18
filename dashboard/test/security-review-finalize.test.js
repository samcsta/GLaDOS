const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateCanonicalCoverage, generateCanonicalFindings, generateCanonicalObservations, generateModelReceipts, invalidateSecurityReviewSeal, sealSecurityReview } = require('../lib/security-review/finalize');
const { normalizeSecurityReviewArtifacts } = require('../lib/security-review/normalize-artifacts');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('controller normalizes supported legacy semantic and empty-inventory artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-normalize-'));
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), [{
    inventory_key: 'main.go:authorization-policy-symbol', check_id: 'authorization-policy-constant-consistency',
    rule: 'authorization-policy-symbol', file: 'main.go', line_ranges: [{ start_line: 2, end_line: 3 }],
  }]);
  writeJson(path.join(root, 'validation/semantic-coverage.json'), {
    checks: [{ check_id: 'authorization-policy-constant-consistency', status: 'FINDING', analysis: 'Finding', evidence: [{ file: 'main.go', line_range: '2-3', rule: 'authorization-policy-symbol', observed_evidence: 'Observed', result: 'FINDING' }], finding_ids: ['F-1'] }],
    candidate_dispositions: [{ inventory_key: 'main.go:authorization-policy-symbol', check_id: 'authorization-policy-constant-consistency', rule: 'authorization-policy-symbol', disposition: 'FINDING', line_evidence: ['main.go:2-3'], analysis: 'File-specific review', finding_ids: ['F-1'] }],
    referrals: [{ referral_id: 'R-1', disposition: 'FINDING', finding_ids: ['F-1'] }],
  });
  writeJson(path.join(root, 'validation/challenge-matrix.json'), {
    candidate_reviews: [{ candidate_id: 'F-1', outcome: 'CONFIRMED', evidence: 'Evidence' }],
  });
  for (const [inventory, matrix] of [
    ['inventory/suppressions.jsonl', 'tracks/cryptography-suppressions/suppression-dispositions.jsonl'],
    ['inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl'],
    ['inventory/http-clients.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl'],
  ]) {
    writeJsonLines(path.join(root, inventory), []);
    writeJsonLines(path.join(root, matrix), [{ sentinel: true }]);
  }
  const normalized = normalizeSecurityReviewArtifacts(root);
  assert.equal(normalized.changed.length, 5);
  const semantic = JSON.parse(fs.readFileSync(path.join(root, 'validation/semantic-coverage.json'), 'utf8'));
  assert.equal(semantic.checks[0].id, 'authorization-policy-constant-consistency');
  assert.equal(semantic.candidate_dispositions[0].status, 'FINDING');
  assert.equal(semantic.candidate_dispositions[0].evidence.file, 'main.go');
  assert.equal(semantic.referrals[0].id, 'R-1');
  assert.equal(semantic.referrals[0].status, 'FINDING');
  const challenge = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));
  assert.equal(challenge.outcomes[0].id, 'F-1');
  assert.equal(fs.readFileSync(path.join(root, 'tracks/resilience-error-handling/http-client-matrix.jsonl'), 'utf8'), '');
});

test('controller generates deterministic canonical findings and coverage schemas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-schema-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'worker-001-C0001', disposition: 'REPORTABLE', finding_ids: ['F-1'],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'F-1', summary: 'Candidate description', sink: 'Candidate sink',
    locations: [{ path: 'main.go', start_line: 1, end_line: 2, role: 'source' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'F-1', title: 'Finding', severity: 'high', description: 'Description', impact: 'Impact',
    recommendation: 'Fix it', reachability: 'Reachable', locations: [{ path: 'main.go', start_line: 1, end_line: 2, role: 'source' }],
  }]);
  writeJsonLines(path.join(root, 'inventory/files.jsonl'), [{ path: 'main.go' }, { path: 'README.md' }]);
  writeJsonLines(path.join(root, 'discovery/coverage-ledger.jsonl'), [
    { path: 'main.go', disposition: 'FINDING', review_method: 'deep-file-review', finding_ids: ['F-1'] },
    { path: 'README.md', disposition: 'TESTED_NEGATIVE', review_method: 'file-specific-review' },
  ]);
  const run = { head: 'snapshot:test', engagementId: 'eng-1' };
  const findings = generateCanonicalFindings(root, run);
  const coverage = generateCanonicalCoverage(root, run);
  assert.equal(findings.findings[0].id, 'F-1');
  assert.equal(findings.findings[0].finding_id, undefined);
  assert.equal(findings.findings[0].source, 'main.go:1-2');
  assert.deepEqual(coverage.files.map(row => row.path), ['main.go', 'README.md']);
  assert.deepEqual(coverage.files[0].finding_ids, ['F-1']);
});

test('controller prefers detailed specialist findings and merges validation metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-finding-merge-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'REPORTABLE', finding_ids: ['F-1'],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', summary: 'Candidate', sink: 'Sink',
    locations: [{ path: 'main.go', start_line: 1, end_line: 2, role: 'source' }],
  }]);
  writeJsonLines(path.join(root, 'tracks/resilience-error-handling/findings.jsonl'), [{
    finding_id: 'F-1', title: 'Detailed finding', severity: 'high', description: 'Detailed description', impact: 'Impact',
    recommendation: 'Fix', reachable_entry_point: 'Reachable', status: 'candidate',
    locations: [{ path: 'main.go', start_line: 1, end_line: 2, role: 'source' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'F-1', validated: true, confidence: 'high', counterevidence: ['External control unknown.'],
  }]);
  const finding = generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng-1' }).findings[0];
  assert.equal(finding.description, 'Detailed description');
  assert.equal(finding.status, 'candidate');
  assert.deepEqual(finding.counterevidence, ['External control unknown.']);
});

test('controller refuses to fabricate a canonical finding when no finding row exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-derived-finding-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'REPORTABLE', finding_ids: ['F-1'],
    counterevidence: 'External policy unknown.', proof_gaps: ['Validate runtime policy.'],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', cwe_ids: ['CWE-862'], summary: 'Missing object authorization',
    sink: 'Repository update', reachability: 'Authenticated API route.', confidence: 'high',
    locations: [{ path: 'main.go', start_line: 1, end_line: 2, role: 'source' }, { path: 'repo.go', start_line: 5, end_line: 7, role: 'sink' }],
  }]);
  assert.throws(() => generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng-1' }), /missing source rows: F-1/);
});

test('controller canonical output fills exact finding and coverage fields from retained evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-legacy-fields-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'F-1', disposition: 'REPORTABLE', finding_ids: ['F-1'],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'F-1', summary: 'Candidate description', sink: 'Sensitive sink',
    locations: [{ path: 'main.go', start_line: 3, end_line: 4, role: 'source' }, { path: 'sink.go', start_line: 8, end_line: 9, role: 'sink' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'F-1', title: 'Finding', severity: 'high', impact: 'Impact', recommendation: 'Fix', reachability: 'Reachable',
  }]);
  writeJsonLines(path.join(root, 'inventory/files.jsonl'), [{ path: 'main.go' }]);
  writeJsonLines(path.join(root, 'discovery/coverage-ledger.jsonl'), [{
    path: 'main.go', coverage_disposition: 'REPORTABLE_CANDIDATE_EVIDENCE', evidence: 'F-1',
  }]);
  const run = { head: 'snapshot:test', engagementId: 'eng-1' };
  const finding = generateCanonicalFindings(root, run).findings[0];
  assert.equal(finding.description, 'Candidate description');
  assert.equal(finding.source, 'main.go:3-4');
  assert.equal(finding.sink, 'sink.go:8-9');
  assert.equal(finding.locations.length, 2);
  assert.equal(generateCanonicalCoverage(root, run).files[0].disposition, 'REPORTABLE_CANDIDATE_EVIDENCE');
});

test('controller separates observations from reportable findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-observations-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'OBSERVATION', observation_ids: ['O-1'],
    observation_category: 'supply-chain-hardening', reportability_rationale: 'Registry mutability is unproven.',
    recommendation: 'Pin the image digest.',
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', cwe_ids: ['CWE-829'], summary: 'Mutable image reference', evidence: 'Image has no digest.',
    locations: [{ path: 'build.gradle', start_line: 1, end_line: 2, role: 'source' }], reachability: 'Build time.',
    counterevidence: 'Private registry policy is unknown.', proof_gaps: ['Inspect registry policy.'], confidence: 'low',
  }]);
  const observations = generateCanonicalObservations(root, { head: 'snapshot:test', engagementId: 'eng-1' });
  assert.equal(observations.observations.length, 1);
  assert.equal(observations.observations[0].id, 'O-1');
  assert.equal(observations.observations[0].candidate_id, 'C-1');
  assert.equal(observations.observations[0].category, 'supply-chain-hardening');
  assert.equal(generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng-1' }).findings.length, 0);
});

test('controller normalizes terminal report artifacts from supported model output variants', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-terminal-normalize-'));
  writeJson(path.join(root, 'run.json'), { deepScan: { terminalState: 'SATURATED' } });
  writeJson(path.join(root, 'discovery/deep/manifest.json'), { completed_at: '2026-08-18T00:44:40.510Z' });
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), [{
    inventory_key: 'main.go:rule', check_id: 'request-binding-mass-assignment', rule: 'rule', file: 'main.go',
    line_ranges: [{ start_line: 1, end_line: 2 }],
  }]);
  writeJson(path.join(root, 'validation/semantic-coverage.json'), {
    checks: [{ id: 'secret-authenticity-and-exposure', status: 'FINDING', analysis: 'Closed as FSH-001', evidence: [{}], finding_ids: ['FSH-001'] }],
    candidate_dispositions: [{ inventory_key: 'main.go:rule', check_id: 'request-binding-mass-assignment', disposition: 'NOT_APPLICABLE', analysis: 'No sink', evidence: {} }],
    referrals: [{ referral_id: 'R-1', disposition: 'OBSERVATION', evidence: {} }],
  });
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'NEW-1', disposition: 'REPORTABLE', finding_ids: ['RES-001'],
  }]);
  writeJson(path.join(root, 'validation/challenge-matrix.json'), {
    outcomes: [{ id: 'NEW-1', candidate_id: 'NEW-1', outcome: 'NEW' }],
  });
  writeJsonLines(path.join(root, 'validation/new-candidates.jsonl'), [{
    candidate_id: 'NEW-1', locations: [{ path: 'main.go', start_line: 1, end_line: 1, role: 'entry' }],
  }]);
  writeJsonLines(path.join(root, 'inventory/crypto-operations.jsonl'), [{ key: 'crypto-1' }]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), [{ inventory_key: 'crypto-1' }]);
  writeJsonLines(path.join(root, 'inventory/suppressions.jsonl'), []);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/suppression-dispositions.jsonl'), []);
  writeJsonLines(path.join(root, 'inventory/http-clients.jsonl'), []);
  writeJsonLines(path.join(root, 'tracks/resilience-error-handling/http-client-matrix.jsonl'), []);

  normalizeSecurityReviewArtifacts(root);
  const run = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
  const semantic = JSON.parse(fs.readFileSync(path.join(root, 'validation/semantic-coverage.json'), 'utf8'));
  const challenge = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));
  const validatorCandidate = JSON.parse(fs.readFileSync(path.join(root, 'validation/new-candidates.jsonl'), 'utf8'));
  assert.equal(run.deepScan.completedAt, '2026-08-18T00:44:40.510Z');
  assert.deepEqual(semantic.checks[0].finding_ids, ['FSH-001']);
  assert.equal(semantic.candidate_dispositions[0].reason, 'No sink');
  assert.equal(semantic.referrals[0].status, 'OBSERVATION');
  assert.equal(challenge.outcomes.some(row => row.id === 'RES-001'), false);
  assert.equal(validatorCandidate.locations[0].role, 'source');
  assert.equal(fs.readFileSync(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), 'utf8').trim(), '{"inventory_key":"crypto-1"}');
});

test('controller refuses to manufacture per-file coverage from candidate dispositions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-coverage-refusal-'));
  writeJsonLines(path.join(root, 'inventory/files.jsonl'), [{ path: 'main.go', key: 'main.go', binary: false }]);
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), [{
    inventory_key: 'main.go:rule', file: 'main.go', rule: 'rule', line_ranges: [{ start_line: 1, end_line: 2 }],
  }]);
  writeJsonLines(path.join(root, 'discovery/coverage-ledger.jsonl'), [{
    candidate_id: 'C-1', disposition: 'REPORTABLE', finding_ids: ['F-1'], evidence_locations: [],
  }]);
  assert.throws(() => normalizeSecurityReviewArtifacts(root), /candidate-shaped coverage cannot prove file review/);
});

test('controller generates exactly one model receipt per required role', () => {
  const roles = [
    'coordinator', 'source-code-primary', 'authorization-access-control', 'data-flow-injection',
    'secrets-history', 'resilience-error-handling', 'iac-config-manifests',
    'cryptography-suppressions', 'source-review-validator',
  ];
  const observations = roles.map((role, index) => ({
    observation_id: `obs-${index}`,
    review_role: role,
    agent_id: role === 'coordinator' ? 'glados' : role === 'source-review-validator' ? 'source-review-validator' : 'source-code',
    worker_id: role === 'source-code-primary' ? 'worker-001' : null,
    requested_model: role === 'source-review-validator' ? 'gpt-validator' : 'gpt-source',
    actual_model: `deployment-${role}`,
    billed_model_name: role === 'source-review-validator' ? 'gpt-validator' : 'gpt-source',
    gateway_model_id: `deployment-${role}`,
    provider_model: null,
    attestation_level: 'deployment',
    source: 'litellm:response-headers',
  }));
  const receipts = generateModelReceipts(observations);
  assert.equal(receipts.length, 9);
  assert.deepEqual(receipts.map(row => row.role), roles);
  assert.deepEqual(receipts[1].observation_ids, ['obs-1']);
  assert.equal(receipts[1].billed_model_name, 'gpt-source');
  assert.equal(receipts[1].gateway_model_id, 'deployment-source-code-primary');
});

test('security-review sealing refuses a run that is not saturated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-refuse-early-seal-'));
  assert.throws(() => sealSecurityReview(root, { head: 'snapshot:test', deepScan: { terminalState: 'RUNNING' } }, 'eng'), /before run reaches SATURATED/);
  assert.equal(fs.existsSync(path.join(root, 'completion-receipt.json')), false);
});

test('invalidating a security-review seal removes both integrity receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-invalidate-seal-'));
  writeJson(path.join(root, 'scan-manifest.json'), { terminal_state: 'SATURATED' });
  writeJson(path.join(root, 'completion-receipt.json'), { status: 'SEALED' });
  invalidateSecurityReviewSeal(root);
  assert.equal(fs.existsSync(path.join(root, 'scan-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'completion-receipt.json')), false);
});
