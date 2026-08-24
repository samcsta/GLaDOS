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

test('controller adopts compatible terminal disposition fields for candidate closure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-closure-disposition-'));
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), []);
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [
    {
      candidate_id: 'C-1', terminal_disposition: 'SUPPRESSED', duplicate_of_issue_key: 'AUTHZ-001',
      evidence: 'Duplicate trace.', counterevidence: 'Same sink.', proof_gaps: [], validation_method: 'source review',
    },
    {
      candidate_id: 'C-2', terminal_disposition: 'REPORTABLE',
      evidence: 'Confirmed trace.', counterevidence: 'No compensating control in source.', proof_gaps: [], validation_method: 'source review',
    },
  ]);

  normalizeSecurityReviewArtifacts(root);

  const rows = fs.readFileSync(path.join(root, 'validation/candidate-closure.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows[0].disposition, 'SUPPRESSED');
  assert.equal(rows[1].disposition, 'REPORTABLE');
});

test('controller binds existing semantic evidence identity to its authoritative inventory row', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-semantic-identity-'));
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), [{
    inventory_key: 'src/main.go:authorization-policy-symbol',
    rule: 'authorization-policy-symbol',
    file: 'src/main.go',
    line_ranges: [{ start_line: 12, end_line: 14 }, { start_line: 20, end_line: 20 }],
  }]);
  writeJson(path.join(root, 'validation/semantic-coverage.json'), {
    checks: [],
    candidate_dispositions: [{
      inventory_key: 'src/main.go:authorization-policy-symbol',
      status: 'TESTED_NEGATIVE',
      evidence: { observed_evidence: 'Reviewed the complete symbol flow.', result: 'TESTED_NEGATIVE' },
    }],
    referrals: [],
  });

  normalizeSecurityReviewArtifacts(root);
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'validation/semantic-coverage.json'), 'utf8'))
    .candidate_dispositions[0].evidence;

  assert.deepEqual(evidence, {
    observed_evidence: 'Reviewed the complete symbol flow.',
    result: 'TESTED_NEGATIVE',
    file: 'src/main.go',
    rule: 'authorization-policy-symbol',
    line_range: '12-14,20-20',
  });
});

test('controller normalizes alternate specialist artifact names and route rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-track-aliases-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [{ key: 'main.go:1:http-route' }]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-method-authn-scope-ownership-matrix.jsonl'), [
    { inventory_key: 'main.go:1:http-route', authentication: 'JWT', authorization_scope: 'read', ownership_or_repository_filter: 'owner_id', disposition: 'TESTED_NEGATIVE' },
    { inventory_key: null, authentication: 'manual supplemental row', disposition: 'REVIEWED' },
  ]);
  writeJsonLines(path.join(root, 'tracks/data-flow-injection/source-to-sink-matrix.jsonl'), []);
  writeJsonLines(path.join(root, 'tracks/resilience-error-handling/http-client-resilience-matrix.jsonl'), []);
  writeJsonLines(path.join(root, 'tracks/iac-config-manifests/coverage-ledger.jsonl'), [{ asset_key: 'main.go', result: 'TESTED_NEGATIVE', evidence: 'Reviewed.' }]);
  writeJsonLines(path.join(root, 'inventory/crypto-operations.jsonl'), [{ key: 'main.go:2:crypto-operation' }]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-operations-dispositions.jsonl'), [{
    inventory_key: 'main.go:2:crypto-operation', terminal_disposition: 'TESTED_NEGATIVE', justification: 'No crypto operation.',
  }]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/suppressions-dispositions.jsonl'), []);

  normalizeSecurityReviewArtifacts(root);
  const routes = JSON.parse(fs.readFileSync(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), 'utf8'));
  assert.equal(routes.inventory_key, 'main.go:1:http-route');
  assert.equal(routes.scope_role, 'read');
  assert.equal(routes.ownership, 'owner_id');
  const iac = JSON.parse(fs.readFileSync(path.join(root, 'tracks/iac-config-manifests/disposition-matrix.jsonl'), 'utf8'));
  assert.equal(iac.inventory_key, 'main.go');
  const crypto = JSON.parse(fs.readFileSync(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), 'utf8'));
  assert.equal(crypto.disposition, 'TESTED_NEGATIVE');
});

test('controller normalizes sensitive validation states without upgrading coverage evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-sensitive-aliases-'));
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), [{ file: 'main.go' }]);
  writeJsonLines(path.join(root, 'discovery/coverage-ledger.jsonl'), [{ path: 'main.go', review_method: 'manual-review' }]);
  writeJsonLines(path.join(root, 'tracks/secrets-history/sensitive-data-dispositions.jsonl'), [{
    inventory_key: 'HEAD:PII:main.go:1:email-address', kind: 'PII', validation_status: 'NOT_APPLICABLE', rationale: 'Machine identifier.',
  }]);
  normalizeSecurityReviewArtifacts(root);
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'discovery/coverage-ledger.jsonl'), 'utf8'));
  const sensitive = JSON.parse(fs.readFileSync(path.join(root, 'tracks/secrets-history/sensitive-data-dispositions.jsonl'), 'utf8'));
  assert.equal(coverage.review_method, 'manual-review');
  assert.equal(sensitive.validation_status, 'NOT_SENSITIVE');
});

test('controller replaces wrong sensitive-data rows with the canonical redacted exact set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-sensitive-bootstrap-'));
  writeJson(path.join(root, 'inventory/sensitive-data-head.json'), {
    candidates: [{
      inventory_key: 'HEAD:SECRET:main.go:2:secret-assignment', kind: 'SECRET', data_class: 'CREDENTIAL',
      presence_status: 'REFERENCE_ONLY', validation_status: 'UNVERIFIED', fingerprint: null,
      value_redacted: true, exposure: 'HEAD', file: 'main.go', line: 2, rule: 'secret-assignment',
    }, {
      inventory_key: 'HEAD:SECRET:main.go:2:secret-assignment', kind: 'SECRET', data_class: 'CREDENTIAL',
      presence_status: 'REFERENCE_ONLY', validation_status: 'UNVERIFIED', fingerprint: null,
      value_redacted: true, exposure: 'HEAD', file: 'main.go', line: 2, rule: 'secret-assignment',
    }],
  });
  writeJsonLines(path.join(root, 'tracks/secrets-history/sensitive-data-dispositions.jsonl'), [{
    inventory_key: 'main.go:request-body-binding', validation_status: 'UNVERIFIED',
  }]);

  normalizeSecurityReviewArtifacts(root);
  const row = JSON.parse(fs.readFileSync(path.join(root, 'tracks/secrets-history/sensitive-data-dispositions.jsonl'), 'utf8'));

  assert.equal(row.inventory_key, 'HEAD:SECRET:main.go:2:secret-assignment');
  assert.equal(row.presence_status, 'REFERENCE_ONLY');
  assert.equal(row.validation_status, 'UNVERIFIED');
  assert.equal(row.value_redacted, true);
  assert.match(row.rationale, /authenticity remains unverified/);
  assert.equal(Object.hasOwn(row, 'value'), false);
});

test('controller restores route inventory keys from inventory_key aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-route-inventory-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [{ inventory_key: 'main.go:1:http-route' }]);
  normalizeSecurityReviewArtifacts(root);
  const route = JSON.parse(fs.readFileSync(path.join(root, 'inventory/routes.jsonl'), 'utf8'));
  assert.equal(route.key, 'main.go:1:http-route');
});

test('controller refuses to ordinal-project a route alias onto deterministic inventory keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-route-alias-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [
    { key: 'main.go:1:express-router', file: 'main.go', line: 1 },
    { key: 'main.go:2:express-router', file: 'main.go', line: 2 },
  ]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), []);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-authorization-matrix.jsonl'), [{
    route: 'POST /users', authn: 'JWT', scope: 'users:write', ownership: 'owner_id',
    repository_filter: 'owner_id', handler: 'main.go:1', coverage: 'TESTED_NEGATIVE',
  }]);

  normalizeSecurityReviewArtifacts(root);
  assert.equal(fs.readFileSync(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), 'utf8'), '\n');
});

test('controller projects reviewed crypto rule groups onto exact deterministic inventory keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-crypto-groups-'));
  writeJsonLines(path.join(root, 'inventory/crypto-operations.jsonl'), [
    { key: 'main.go:1:crypto-operation', rule: 'crypto-operation' },
    { key: 'main.go:2:crypto-operation', rule: 'crypto-operation' },
    { key: 'main.go:3:weak-hash', rule: 'weak-hash' },
  ]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-operation-dispositions.jsonl'), [{
    inventory_entry_count: 3, rule: 'crypto-operation', inventory_entries: 2,
    disposition: 'TESTED_NEGATIVE', rationale: 'Reviewed crypto calls.', evidence: { result: 'No security-sensitive operation.' },
  }, {
    inventory_entry_count: 3, rule: 'weak-hash', inventory_entries: 1,
    disposition: 'TESTED_NEGATIVE', rationale: 'Reviewed weak hash match.', evidence: { result: 'Documentation only.' },
  }]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), []);

  normalizeSecurityReviewArtifacts(root);
  const rows = fs.readFileSync(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));

  assert.deepEqual(rows.map(row => row.inventory_key), [
    'main.go:1:crypto-operation', 'main.go:2:crypto-operation', 'main.go:3:weak-hash',
  ]);
  assert.equal(rows[0].rationale, 'Reviewed crypto calls.');
  assert.equal(rows[2].evidence.result, 'Documentation only.');
});

test('controller binds copied deterministic inventory keys to exact-set matrix identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-matrix-key-alias-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [
    { key: 'Controller.java:12:java-route', file: 'Controller.java', line: 12 },
  ]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), [
    { key: 'Controller.java:12:java-route', scope: 'NOT_APPLICABLE', disposition: 'NOT_APPLICABLE', evidence: 'Documentation example.' },
  ]);
  writeJsonLines(path.join(root, 'inventory/crypto-operations.jsonl'), [
    { key: 'Dto.java:39:crypto-operation', file: 'Dto.java', line: 39 },
  ]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), [
    { key: 'Dto.java:39:crypto-operation', disposition: 'NOT_APPLICABLE', evidence: 'Schema annotation.' },
  ]);

  normalizeSecurityReviewArtifacts(root);

  const route = JSON.parse(fs.readFileSync(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), 'utf8'));
  const crypto = JSON.parse(fs.readFileSync(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), 'utf8'));
  assert.equal(route.inventory_key, 'Controller.java:12:java-route');
  assert.equal(route.scope_role, 'NOT_APPLICABLE');
  assert.equal(route.trace, 'Documentation example.');
  assert.equal(crypto.inventory_key, 'Dto.java:39:crypto-operation');
  assert.equal(crypto.evidence, 'Schema annotation.');
});

test('controller canonicalizes structured route authorization and repository-operation aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-route-field-aliases-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [{ key: 'Controller.java:12:java-route' }]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), [{
    inventory_key: 'Controller.java:12:java-route',
    authn: { mechanism: 'JWT' },
    scope_authorization: { required: 'items:read' },
    ownership: 'owner constrained',
    repository_operation: 'findByOwner',
    trace: 'route -> service -> repository',
    terminal_disposition: 'TESTED_NEGATIVE',
  }]);

  normalizeSecurityReviewArtifacts(root);
  const route = JSON.parse(fs.readFileSync(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), 'utf8'));

  assert.deepEqual(route.scope_role, { required: 'items:read' });
  assert.equal(route.repository_filter, 'findByOwner');
  assert.equal(route.disposition, 'TESTED_NEGATIVE');
});

test('controller removes copied matrix keys outside deterministic inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-matrix-supplemental-'));
  writeJsonLines(path.join(root, 'inventory/crypto-operations.jsonl'), [
    { key: 'Dto.java:39:crypto-operation' },
  ]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), [
    { key: 'Other.java:1:crypto-operation', disposition: 'NOT_APPLICABLE' },
  ]);

  normalizeSecurityReviewArtifacts(root);
  assert.equal(fs.readFileSync(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), 'utf8'), '');
});

test('controller refuses crypto group projection when reviewed counts do not match inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-crypto-groups-invalid-'));
  writeJsonLines(path.join(root, 'inventory/crypto-operations.jsonl'), [
    { key: 'main.go:1:crypto-operation', rule: 'crypto-operation' },
  ]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-operation-dispositions.jsonl'), [{
    inventory_entry_count: 2, rule: 'crypto-operation', inventory_entries: 2,
    disposition: 'TESTED_NEGATIVE', rationale: 'Mismatched review.', evidence: { result: 'Invalid count.' },
  }]);
  writeJsonLines(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), []);

  normalizeSecurityReviewArtifacts(root);

  assert.equal(fs.readFileSync(path.join(root, 'tracks/cryptography-suppressions/crypto-matrix.jsonl'), 'utf8'), '\n');
});

test('controller bootstraps a missing exact-set coverage ledger without inventing review evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-coverage-bootstrap-'));
  writeJsonLines(path.join(root, 'inventory/files.jsonl'), [
    { key: 'main.go', path: 'main.go', binary: false },
    { key: 'logo.png', path: 'logo.png', binary: true },
  ]);
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), []);

  const normalized = normalizeSecurityReviewArtifacts(root);
  const coverage = fs.readFileSync(path.join(root, 'discovery/coverage-ledger.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));

  assert.deepEqual(normalized.changed, ['discovery/coverage-ledger.jsonl']);
  assert.deepEqual(coverage.map(row => row.path), ['main.go', 'logo.png']);
  assert.ok(coverage.every(row => row.disposition === 'DEFERRED'));
  assert.ok(coverage.every(row => row.review_method === 'controller-inventory-bootstrap'));
  assert.ok(coverage.every(row => !row.finding_ids && !row.evidence_locations));
});

test('controller aggregates contiguous exact-order coverage partitions deterministically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-coverage-partitions-'));
  writeJsonLines(path.join(root, 'inventory/files.jsonl'), [
    { key: 'a', path: 'a' }, { key: 'b', path: 'b' }, { key: 'c', path: 'c' },
  ]);
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), []);
  writeJsonLines(path.join(root, 'discovery/coverage-ledger.jsonl'), [
    { key: 'a', path: 'a', disposition: 'DEFERRED' },
    { key: 'b', path: 'b', disposition: 'DEFERRED' },
    { key: 'c', path: 'c', disposition: 'DEFERRED' },
  ]);
  writeJsonLines(path.join(root, 'discovery/coverage-partitions/001-002.jsonl'), [
    { key: 'a', path: 'a', disposition: 'TESTED_NEGATIVE', review_method: 'file-specific-review' },
    { key: 'b', path: 'b', disposition: 'NOT_APPLICABLE', review_method: 'file-specific-review' },
  ]);
  writeJsonLines(path.join(root, 'discovery/coverage-partitions/003-003.jsonl'), [
    { key: 'c', path: 'c', disposition: 'FINDING', review_method: 'file-specific-review' },
  ]);

  normalizeSecurityReviewArtifacts(root);
  const rows = fs.readFileSync(path.join(root, 'discovery/coverage-ledger.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'discovery/coverage-aggregation.json'), 'utf8'));

  assert.deepEqual(rows.map(row => row.key), ['a', 'b', 'c']);
  assert.equal(receipt.exact_key_and_ordinal_equality, true);
  assert.deepEqual(receipt.partitions, ['001-002.jsonl', '003-003.jsonl']);
});

test('controller leaves a partition boundary gap deferred instead of inventing review evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-coverage-gap-'));
  writeJsonLines(path.join(root, 'inventory/files.jsonl'), [
    { key: 'a', path: 'a' }, { key: 'b', path: 'b' }, { key: 'c', path: 'c' },
  ]);
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), []);
  writeJsonLines(path.join(root, 'discovery/coverage-ledger.jsonl'), [
    { key: 'a', path: 'a', disposition: 'DEFERRED', review_method: 'controller-inventory-bootstrap' },
    { key: 'b', path: 'b', disposition: 'DEFERRED', review_method: 'controller-inventory-bootstrap' },
    { key: 'c', path: 'c', disposition: 'DEFERRED', review_method: 'controller-inventory-bootstrap' },
  ]);
  writeJsonLines(path.join(root, 'discovery/coverage-partitions/001-001.jsonl'), [
    { key: 'a', path: 'a', disposition: 'TESTED_NEGATIVE', review_method: 'file-specific-review' },
  ]);
  writeJsonLines(path.join(root, 'discovery/coverage-partitions/003-003.jsonl'), [
    { key: 'c', path: 'c', disposition: 'TESTED_NEGATIVE', review_method: 'file-specific-review' },
  ]);

  normalizeSecurityReviewArtifacts(root);
  const rows = fs.readFileSync(path.join(root, 'discovery/coverage-ledger.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows[1].disposition, 'DEFERRED');
  assert.equal(fs.existsSync(path.join(root, 'discovery/coverage-aggregation.json')), false);
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

test('controller binds reportable candidate ids to unique existing source findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-finding-links-'));
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'worker-003-C0003', summary: 'Unverified Gradle distribution bootstrap',
    locations: [{ path: 'gradle/wrapper/gradle-wrapper.properties', start_line: 1, end_line: 4, role: 'source' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'BLD-001', title: 'Gradle bootstrap lacks content verification', severity: 'medium',
    locations: [{ path: 'gradle/wrapper/gradle-wrapper.properties', start_line: 1, end_line: 5, role: 'source' }],
  }, {
    finding_id: 'OTHER-001', title: 'Unrelated issue', severity: 'medium',
    locations: [{ path: 'src/main.java', start_line: 1, end_line: 2, role: 'source' }],
  }]);
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'worker-003-C0003', disposition: 'REPORTABLE', issue_key: 'GRADLE-DISTRIBUTION-INTEGRITY',
    finding_ids: ['worker-003-C0003'], validation_method: 'source review', evidence: 'evidence', counterevidence: 'unknown', proof_gaps: [],
  }, {
    candidate_id: 'OTHER-001', disposition: 'REPORTABLE', issue_key: 'OTHER',
    finding_ids: ['OTHER-001'], validation_method: 'source review', evidence: 'evidence', counterevidence: 'unknown', proof_gaps: [],
  }]);
  writeJsonLines(path.join(root, 'validation/attack-paths.jsonl'), [{
    candidate_id: 'worker-003-C0003', disposition: 'REPORTABLE', finding_ids: ['worker-003-C0003'], rationale: 'r', reachability: 'reachable',
  }, {
    candidate_id: 'OTHER-001', disposition: 'REPORTABLE', finding_ids: ['OTHER-001'], rationale: 'r', reachability: 'reachable',
  }]);
  writeJson(path.join(root, 'validation/challenge-matrix.json'), { outcomes: [{
    id: 'worker-003-C0003', subject_id: 'worker-003-C0003', outcome: 'CONFIRMED_WITH_CORRECTION',
    finding_ids: ['worker-003-C0003'],
  }, { id: 'OTHER-001', outcome: 'CONFIRMED' }] });

  normalizeSecurityReviewArtifacts(root);
  const closure = fs.readFileSync(path.join(root, 'validation/candidate-closure.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const attacks = fs.readFileSync(path.join(root, 'validation/attack-paths.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const challenge = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));
  assert.deepEqual(closure[0].finding_ids, ['BLD-001']);
  assert.deepEqual(attacks[0].finding_ids, ['BLD-001']);
  assert.deepEqual(challenge.outcomes.find(row => row.id === 'worker-003-C0003').finding_ids, ['BLD-001']);
  assert.equal(challenge.outcomes.filter(row => row.id === 'BLD-001').length, 1);
});

test('controller refuses to omit a specialist finding from candidate closure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-unclosed-specialist-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), []);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), []);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/findings.jsonl'), [{
    finding_id: 'AUTHZ-001', title: 'Missing object authorization', severity: 'high',
  }]);

  assert.throws(
    () => generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng-1' }),
    /source findings are missing candidate closure: AUTHZ-001/
  );
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

test('controller extracts CVSS vector and score from retained precondition text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-cvss-preconditions-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'REPORTABLE', finding_ids: ['F-1'],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', summary: 'Candidate', sink: 'Sink',
    locations: [{ path: 'main.go', start_line: 1, end_line: 1, role: 'sink' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'F-1', title: 'Finding', severity: 'high', cwe_ids: ['CWE-287'],
    cvss_preconditions: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:L (9.4). Requires network reachability.',
  }]);

  const finding = generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng' }).findings[0];
  assert.equal(finding.cvss_vector, 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:L');
  assert.equal(finding.cvss_score, 9.4);
});

test('controller normalizes the canonical cvss_v3_1 compatibility field', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-cvss-v31-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'REPORTABLE', finding_ids: ['F-1'],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', summary: 'Candidate', sink: 'Sink',
    locations: [{ path: 'main.go', start_line: 1, end_line: 1, role: 'sink' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'F-1', title: 'Finding', severity: 'high', cwe_ids: ['CWE-287'],
    cvss_v3_1: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N (8.1)',
  }]);

  const finding = generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng' }).findings[0];
  assert.equal(finding.cvss_vector, 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N');
  assert.equal(finding.cvss_score, 8.1);
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

test('controller projects validator evidence into observations when the retained candidate lacks it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-observation-fallback-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'OBSERVATION', observation_ids: ['O-1'],
    observation_category: 'conditional-authorization-design',
    reportability_rationale: 'The required attacker capability is not established.',
    evidence: 'The permission is present in the immutable source snapshot.',
    reachability: 'Requires authenticated preproduction group membership.',
    counterevidence: 'Effective membership and deployed policy are not established.',
    proof_gaps: ['Inspect effective membership and deployed policy.'],
    confidence: 'medium',
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', cwe_ids: ['CWE-269'], summary: 'Conditional entitlement concern',
    locations: [{ path: 'iam.tf', start_line: 10, end_line: 12, role: 'source' }],
  }]);

  const observation = generateCanonicalObservations(root, {
    head: 'snapshot:test', engagementId: 'eng-1',
  }).observations[0];

  assert.equal(observation.evidence, 'The permission is present in the immutable source snapshot.');
  assert.equal(observation.reachability, 'Requires authenticated preproduction group membership.');
  assert.equal(observation.counterevidence, 'Effective membership and deployed policy are not established.');
  assert.deepEqual(observation.proof_gaps, ['Inspect effective membership and deployed policy.']);
  assert.equal(observation.confidence, 'medium');
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

test('controller converts retained structured closure and attack-path evidence to gate strings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-structured-evidence-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', evidence: { source: 'main.go:1' }, counterevidence: { blocker: 'gateway unknown' },
  }]);
  writeJsonLines(path.join(root, 'validation/attack-paths.jsonl'), [{
    candidate_id: 'C-1', rationale: { attack_path: 'input to sink' }, reachability: { status: 'conditional' },
  }]);

  normalizeSecurityReviewArtifacts(root);
  const closure = JSON.parse(fs.readFileSync(path.join(root, 'validation/candidate-closure.jsonl'), 'utf8'));
  const attack = JSON.parse(fs.readFileSync(path.join(root, 'validation/attack-paths.jsonl'), 'utf8'));

  assert.equal(typeof closure.evidence, 'string');
  assert.equal(typeof closure.counterevidence, 'string');
  assert.equal(typeof attack.rationale, 'string');
  assert.equal(typeof attack.reachability, 'string');
});

test('controller normalizes validator subject identities for deterministic gate matching', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-validator-subject-'));
  writeJson(path.join(root, 'validation/challenge-matrix.json'), {
    outcomes: [{
      subject_id: 'F-1', subject_type: 'source_finding', outcome: 'CONFIRMED_WITH_CORRECTION',
      rationale: 'Independently reproduced from source.',
    }],
  });

  normalizeSecurityReviewArtifacts(root);
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));

  assert.equal(matrix.outcomes[0].id, 'F-1');
  assert.equal(matrix.outcomes[0].subject_id, 'F-1');
  assert.equal(matrix.outcomes[0].outcome, 'CONFIRMED_WITH_CORRECTION');
});

test('controller binds candidate validator outcomes to their unambiguous source findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-validator-finding-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'REPORTABLE', finding_ids: ['F-1'],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    candidate_id: 'C-1', finding_id: 'F-1', title: 'Confirmed issue',
  }]);
  writeJson(path.join(root, 'validation/challenge-matrix.json'), {
    outcomes: [{ candidate_id: 'C-1', outcome: 'CONFIRMED_WITH_CORRECTION', rationale: 'Reproduced.' }],
  });

  normalizeSecurityReviewArtifacts(root);
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));
  const finding = matrix.outcomes.find(row => row.id === 'F-1');

  assert.equal(finding.finding_id, 'F-1');
  assert.equal(finding.source_candidate_id, 'C-1');
  assert.equal(finding.outcome, 'CONFIRMED_WITH_CORRECTION');
});

test('controller canonicalizes closure and attack-path disposition aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-disposition-aliases-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [
    { candidate_id: 'C-1', disposition: 'IGNORE' },
    { candidate_id: 'C-2', disposition: 'IGNORE', duplicate_of_issue_key: 'ROOT-1' },
  ]);
  writeJsonLines(path.join(root, 'validation/attack-paths.jsonl'), [
    { candidate_id: 'C-1', decision: 'IGNORE', closure_disposition: 'IGNORE', rationale: 'Not applicable.', reachability: 'None.' },
    { candidate_id: 'C-2', decision: 'SUPPRESSED', rationale: 'Duplicate.', reachability: 'Same path.' },
  ]);

  normalizeSecurityReviewArtifacts(root);
  const closure = fs.readFileSync(path.join(root, 'validation/candidate-closure.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const attacks = fs.readFileSync(path.join(root, 'validation/attack-paths.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);

  assert.deepEqual(closure.map(row => row.disposition), ['NOT_APPLICABLE', 'SUPPRESSED']);
  assert.deepEqual(attacks.map(row => row.disposition), ['NOT_APPLICABLE', 'IGNORE']);
});

test('controller copies lossless specialist filename aliases to canonical artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-track-filename-aliases-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [{ key: 'Controller.java:12:java-route' }]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-authorization-matrix.jsonl'), [{
    inventory_key: 'Controller.java:12:java-route', authentication: 'JWT', scope: 'read',
    ownership: 'owner', repository_orm_operation: 'findByOwner', terminal_disposition: 'TESTED_NEGATIVE',
  }]);
  writeJson(path.join(root, 'tracks/data-flow-injection/source-sink-matrix.json'), {
    route_inventory: [{ route: 'GET /items', status: 'TESTED_NEGATIVE' }],
  });
  writeJson(path.join(root, 'tracks/secrets-history/head-history-receipt.json'), {
    head_scan: { completed: true }, history_scan: { completed: false, blocked: true },
  });

  normalizeSecurityReviewArtifacts(root);
  const route = JSON.parse(fs.readFileSync(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), 'utf8'));
  const dataFlow = JSON.parse(fs.readFileSync(path.join(root, 'tracks/data-flow-injection/source-sink-matrix.jsonl'), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(root, 'tracks/secrets-history/history-receipt.json'), 'utf8'));

  assert.equal(route.inventory_key, 'Controller.java:12:java-route');
  assert.equal(route.scope_role, 'read');
  assert.deepEqual(dataFlow.route_inventory, [{ route: 'GET /items', status: 'TESTED_NEGATIVE' }]);
  assert.equal(history.head_scan.completed, true);
});

test('controller losslessly closes retained final-gate artifact variants', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-retained-gate-'));
  writeJsonLines(path.join(root, 'inventory/routes.jsonl'), [{ key: 'Controller.java:10:route' }]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), [{
    inventory_key: 'Controller.java:10:route', authn: 'JWT', scope_role: 'read', ownership: 'owner',
    repository_filter: 'findByOwner', disposition: 'TESTED_NEGATIVE',
    evidence: [{ path: 'Controller.java', start_line: 10, end_line: 12, role: 'route' }],
  }]);
  writeJsonLines(path.join(root, 'tracks/data-flow-injection/input-to-sink-matrix.jsonl'), [{ matrix_id: 'DF-1' }]);
  writeJsonLines(path.join(root, 'tracks/iac-config-manifests/coverage.jsonl'), [{ inventory_key: 'manifest.yml', disposition: 'FINDING' }]);
  writeJsonLines(path.join(root, 'inventory/security-sensitive.jsonl'), [{
    inventory_key: 'Controller.java:query-builder', check_id: 'directory-query-filter-injection',
    file: 'Controller.java', rule: 'query-builder', line_ranges: [{ start_line: 20, end_line: 24 }],
  }]);
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [{
    finding_id: 'F-1', title: 'Unescaped query construction',
    locations: [{ path: 'Controller.java', start_line: 20, end_line: 24, role: 'sink' }],
  }]);
  writeJsonLines(path.join(root, 'discovery/candidates.jsonl'), [{
    candidate_id: 'C-1', summary: 'Unescaped query construction',
    locations: [{ path: 'Controller.java', start_line: 20, end_line: 24, role: 'sink' }],
  }]);
  writeJsonLines(path.join(root, 'validation/new-candidates.jsonl'), [{ candidate_id: 'validator-C1', locations: [] }]);
  writeJson(path.join(root, 'validation/semantic-coverage.json'), {
    checks: [{
      id: 'directory-query-filter-injection', status: 'FINDING', analysis: 'Unescaped query.', finding_ids: ['F-1'],
      evidence: [{ file: 'Controller.java', line_range: { start: 20, end: 24 }, rule: 'query-builder', observed_evidence: 'Input reaches query.', result: 'F-1' }],
    }],
    candidate_dispositions: [{
      inventory_key: 'Controller.java:query-builder', check_id: 'directory-query-filter-injection',
      status: 'FINDING', file: 'Controller.java', line_range: { start: 20, end: 24 }, rule: 'query-builder',
      observed_evidence: 'Input reaches query.', result: 'F-1',
    }],
    referrals: [{
      id: 'R-1', status: 'TESTED_NEGATIVE',
      evidence: { file: 'Controller.java', line_range: { start: 10, end: 12 }, rule: 'referral', observed_evidence: 'Reviewed.', result: 'Closed.' },
    }],
  });
  writeJson(path.join(root, 'validation/challenge-matrix.json'), {
    outcomes: [
      { subject_type: 'canonical_candidate', subject_id: 'C-1', outcome: 'CONFIRMED', rationale: 'Reproduced.' },
      { subject_type: 'validator_candidate', subject_id: 'validator-C1', outcome: 'NEW', rationale: 'New candidate.' },
    ],
  });
  writeJson(path.join(root, 'regression/delta.json'), {
    dispositions: [{
      prior_finding_id: 'OLD-1', disposition: 'CONFIRMED',
      current_evidence: [{ path: 'Controller.java', start_line: 20, end_line: 24, detail: 'Still present.' }],
    }],
  });

  normalizeSecurityReviewArtifacts(root);

  const route = JSON.parse(fs.readFileSync(path.join(root, 'tracks/authorization-access-control/route-authz-matrix.jsonl'), 'utf8'));
  const semantic = JSON.parse(fs.readFileSync(path.join(root, 'validation/semantic-coverage.json'), 'utf8'));
  const challenge = JSON.parse(fs.readFileSync(path.join(root, 'validation/challenge-matrix.json'), 'utf8'));
  const regression = JSON.parse(fs.readFileSync(path.join(root, 'regression/delta.json'), 'utf8'));
  assert.equal(typeof route.trace, 'string');
  assert.equal(fs.existsSync(path.join(root, 'tracks/data-flow-injection/source-sink-matrix.jsonl')), true);
  assert.equal(fs.existsSync(path.join(root, 'tracks/iac-config-manifests/disposition-matrix.jsonl')), true);
  assert.equal(semantic.checks[0].evidence[0].line_range, '20-24');
  assert.equal(semantic.candidate_dispositions[0].evidence.line_range, '20-24');
  assert.deepEqual(semantic.candidate_dispositions[0].finding_ids, ['F-1']);
  assert.equal(semantic.referrals[0].evidence.line_range, '10-12');
  assert.equal(challenge.outcomes.find(row => row.id === 'F-1').source_candidate_id, 'C-1');
  assert.equal(challenge.outcomes.find(row => row.id === 'validator-C1').candidate_id, 'validator-C1');
  assert.equal(regression.status, 'COMPLETE');
  assert.equal(typeof regression.dispositions[0].evidence, 'string');
});

test('controller repairs concatenated model-owned JSONL values without changing their evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-concatenated-jsonl-'));
  const file = path.join(root, 'validation/candidate-closure.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    '{"candidate_id":"C-1","evidence":"brace } inside string"}{"candidate_id":"C-2","evidence":"retained"}\n');

  normalizeSecurityReviewArtifacts(root);
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);

  assert.deepEqual(rows, [
    { candidate_id: 'C-1', evidence: 'brace } inside string' },
    { candidate_id: 'C-2', evidence: 'retained' },
  ]);
});

test('controller repairs a JSONL object split across physical lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-split-jsonl-'));
  const file = path.join(root, 'validation', 'candidate-closure.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"candidate_id":"C-1","disposition":"REPORTABLE",\n"finding_ids":["F-1"],"evidence":"retained"}\n{"candidate_id":"C-2","disposition":"SUPPRESSED","evidence":"duplicate"}\n');

  normalizeSecurityReviewArtifacts(root);

  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].finding_ids, ['F-1']);
  assert.equal(rows[0].evidence, 'retained');
});

test('controller repairs a prematurely closed JSONL object without dropping trailing fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-premature-jsonl-'));
  const file = path.join(root, 'validation/candidate-closure.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    '{"candidate_id":"F-1","validator_confirmation":{"outcome":"CONFIRMED"}},"disposition":"SUPPRESSED","duplicate_of_issue_key":"ROOT-1"}\n');

  normalizeSecurityReviewArtifacts(root);
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.deepEqual(row, {
    candidate_id: 'F-1', validator_confirmation: { outcome: 'CONFIRMED' },
    disposition: 'SUPPRESSED', duplicate_of_issue_key: 'ROOT-1',
  });
});

test('controller normalizes historical regression aliases and suppressed attack paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-terminal-aliases-'));
  writeJson(path.join(root, 'regression/delta.json'), {
    status: 'COMPLETE',
    dispositions: [{ prior_id: 'OLD-1', status: 'CONFIRMED', current_source_evidence: { path: 'main.tf:1' } }],
  });
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [{
    candidate_id: 'C-1', disposition: 'SUPPRESSED', duplicate_of_issue_key: 'ROOT-1',
  }]);
  writeJsonLines(path.join(root, 'validation/attack-paths.jsonl'), [{
    candidate_id: 'C-1', disposition: 'SUPPRESSED', rationale: 'Duplicate root.', reachability: 'Same path.',
  }]);

  normalizeSecurityReviewArtifacts(root);
  const regression = JSON.parse(fs.readFileSync(path.join(root, 'regression/delta.json'), 'utf8'));
  const attack = JSON.parse(fs.readFileSync(path.join(root, 'validation/attack-paths.jsonl'), 'utf8'));

  assert.equal(regression.dispositions[0].prior_finding_id, 'OLD-1');
  assert.equal(regression.dispositions[0].disposition, 'CONFIRMED');
  assert.match(regression.dispositions[0].evidence, /main\.tf:1/);
  assert.equal(attack.disposition, 'IGNORE');
  assert.equal(attack.duplicate_of_issue_key, 'ROOT-1');
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

test('controller keeps aggregate discovery finding titles aligned with specialist authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-finding-titles-'));
  writeJsonLines(path.join(root, 'discovery/findings.jsonl'), [
    { finding_id: 'AUTHZ-1', title: 'Short aggregate title', severity: 'high' },
    { finding_id: 'DISCOVERY-ONLY', title: 'Discovery-only title', severity: 'medium' },
  ]);
  writeJsonLines(path.join(root, 'tracks/authorization-access-control/findings.jsonl'), [
    { finding_id: 'AUTHZ-1', title: 'Canonical specialist title', severity: 'high' },
  ]);

  normalizeSecurityReviewArtifacts(root);
  const rows = fs.readFileSync(path.join(root, 'discovery/findings.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows[0].title, 'Canonical specialist title');
  assert.equal(rows[1].title, 'Discovery-only title');
});

test('controller derives dedupe counters from authoritative worker order and mappings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-dedupe-counters-'));
  writeJsonLines(path.join(root, 'discovery/deep/workers.jsonl'), [
    { worker_id: 'worker-001', sequence: 1, status: 'SUCCEEDED' },
    { worker_id: 'worker-002', sequence: 2, status: 'FAILED' },
    { worker_id: 'worker-003', sequence: 3, status: 'SUCCEEDED' },
  ]);
  writeJson(path.join(root, 'discovery/deep/dedupe.json'), {
    input_worker_ids: ['worker-003'],
    mappings: [
      { worker_id: 'worker-003', source_candidate_id: '3-1', canonical_candidate_id: 'C-1' },
      { worker_id: 'worker-001', source_candidate_id: '1-1', canonical_candidate_id: 'C-1' },
      { worker_id: 'worker-003', source_candidate_id: '3-2', canonical_candidate_id: 'C-2' },
    ],
    new_candidate_counts: { 'worker-003': 99 },
    no_new_streak: 99,
  });

  normalizeSecurityReviewArtifacts(root);
  const dedupe = JSON.parse(fs.readFileSync(path.join(root, 'discovery/deep/dedupe.json'), 'utf8'));
  assert.deepEqual(dedupe.input_worker_ids, ['worker-001', 'worker-003']);
  assert.deepEqual(dedupe.new_candidate_counts, { 'worker-001': 1, 'worker-003': 1 });
  assert.equal(dedupe.no_new_streak, 0);
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

test('canonical projection refuses duplicate active issue keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-finalize-duplicate-issue-'));
  writeJsonLines(path.join(root, 'validation/candidate-closure.jsonl'), [
    { candidate_id: 'C-1', disposition: 'REPORTABLE', issue_key: 'same-root', finding_ids: ['F-1'] },
    { candidate_id: 'C-2', disposition: 'REPORTABLE', issue_key: 'same-root', finding_ids: ['F-2'] },
  ]);
  assert.throws(
    () => generateCanonicalFindings(root, { head: 'snapshot:test', engagementId: 'eng' }),
    /duplicate active issue_key same-root/,
  );
});

test('invalidating a security-review seal removes both integrity receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-invalidate-seal-'));
  writeJson(path.join(root, 'scan-manifest.json'), { terminal_state: 'SATURATED' });
  writeJson(path.join(root, 'completion-receipt.json'), { status: 'SEALED' });
  invalidateSecurityReviewSeal(root);
  assert.equal(fs.existsSync(path.join(root, 'scan-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'completion-receipt.json')), false);
});
