const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalRemote, findPriorSecurityReview } = require('../lib/security-review/prior-review');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function priorReview(root, engagementId, repositoryPath, completedAt, findingId) {
  const review = path.join(root, engagementId, 'security-review');
  writeJson(path.join(review, 'run.json'), {
    repositoryPath, head: `snapshot:${findingId}`, deepScan: { completedAt },
  });
  writeJson(path.join(review, 'findings.json'), {
    findings: [{ id: findingId, title: `Finding ${findingId}`, severity: 'medium', cwe_ids: ['CWE-829'], locations: [] }],
  });
  writeJson(path.join(review, 'completion-receipt.json'), {
    engagement_id: engagementId, status: 'SEALED', terminal_state: 'SATURATED', repository_head: `snapshot:${findingId}`,
  });
}

test('automatic prior matching uses exact repository identity and newest sealed review', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-prior-review-'));
  const investigations = path.join(root, 'investigations');
  const repository = path.join(root, 'team-a', 'service');
  const sameBasename = path.join(root, 'team-b', 'service');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(sameBasename, { recursive: true });
  priorReview(investigations, 'old-match', repository, '2026-08-01T00:00:00.000Z', 'F-OLD');
  priorReview(investigations, 'new-match', repository, '2026-08-20T00:00:00.000Z', 'F-NEW');
  priorReview(investigations, 'wrong-repository', sameBasename, '2026-08-21T00:00:00.000Z', 'F-WRONG');

  const prior = findPriorSecurityReview({ investigationsRoot: investigations, repositoryPath: repository });
  assert.equal(prior.prior_engagement_id, 'new-match');
  assert.deepEqual(prior.findings.map(row => row.id), ['F-NEW']);
  assert.equal(prior.match_basis, 'canonical-repository-path');
});

test('canonical remote matching normalizes SSH and HTTPS Git URLs', () => {
  assert.equal(canonicalRemote('git@github.com:Acme/Repo.git'), 'github.com/Acme/Repo');
  assert.equal(canonicalRemote('https://github.com/Acme/Repo.git'), 'github.com/Acme/Repo');
});
