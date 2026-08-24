const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { loadCompletedSecurityReview, resolveCompletedSecurityReview, safeEngagementId } = require('../lib/security-review-report.cjs');
const dashboardDeliverables = require('../../dashboard/lib/security-review/deliverables');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('security-review PDF export accepts only one safe engagement path component', () => {
  assert.equal(safeEngagementId('eng-123'), 'eng-123');
  assert.throws(() => safeEngagementId('../escape'), /invalid/);
  assert.throws(() => safeEngagementId('eng/child'), /invalid/);
});

test('security-review PDF export resolves a Finder-renamed folder by sealed engagement identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-desktop-renamed-review-'));
  const review = path.join(root, 'friendly-folder', 'security-review');
  fs.mkdirSync(path.join(root, 'eng-123', 'security-review'), { recursive: true });
  fs.mkdirSync(review, { recursive: true });
  fs.writeFileSync(path.join(review, 'completion-receipt.json'), '{"engagement_id":"eng-123","status":"SEALED","terminal_state":"SATURATED"}\n');
  assert.equal(resolveCompletedSecurityReview(root, 'eng-123'), review);
});

test('security-review report HTML is self-contained and escapes finding content', () => {
  const html = dashboardDeliverables.reportHtml({
    repository: 'repo<script>', revision: 'snapshot:test', engagementId: 'eng', filesReviewed: 1,
    purpose: '<img src=x onerror=alert(1)>', counts: { critical: 0, high: 1, medium: 0, low: 0 },
    findings: [{ id: 'F-1', title: '<script>alert(1)</script>', severity: 'high', cwe_ids: ['CWE-79'], locations: [] }],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/cwe\.mitre\.org\/data\/definitions\/79\.html"/);
});

test('security-review PDF input verifies every sealed artifact and publication digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-desktop-review-integrity-'));
  const deliveryRoot = path.join(root, 'deliverables');
  fs.mkdirSync(path.join(root, 'context'), { recursive: true });
  fs.mkdirSync(deliveryRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'run.json'), '{"deepScan":{"completedAt":"2026-01-01T00:00:00.000Z"}}\n');
  fs.writeFileSync(path.join(root, 'context', 'threat-model.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'findings.json'), '{"findings":[]}\n');
  fs.writeFileSync(path.join(root, 'coverage.json'), '{"files":[]}\n');
  fs.writeFileSync(path.join(root, 'observations.json'), '{"observations":[]}\n');
  fs.writeFileSync(path.join(root, 'scan-manifest.json'), '{}\n');
  fs.writeFileSync(path.join(deliveryRoot, 'security-review-report.html'), '<h1>Review</h1>\n');
  const artifactNames = ['run.json', 'context/threat-model.json', 'findings.json', 'coverage.json', 'observations.json'];
  const receipt = {
    engagement_id: 'eng', status: 'SEALED', terminal_state: 'SATURATED', repository_head: 'snapshot:test',
    artifact_sha256: Object.fromEntries(artifactNames.map(relative => [relative, sha256(path.join(root, relative))])),
    scan_manifest_sha256: sha256(path.join(root, 'scan-manifest.json')),
  };
  fs.writeFileSync(path.join(root, 'completion-receipt.json'), `${JSON.stringify(receipt)}\n`);
  fs.copyFileSync(path.join(root, 'completion-receipt.json'), path.join(deliveryRoot, 'completion-receipt.json'));
  dashboardDeliverables.writeDeliverablesManifest(deliveryRoot, { receipt, completedAt: '2026-01-01T00:00:00.000Z' });

  assert.match(loadCompletedSecurityReview(root).html, /Review/);
  fs.writeFileSync(path.join(root, 'observations.json'), '{"observations":[{"id":"changed"}]}\n');
  assert.throws(() => loadCompletedSecurityReview(root), /digest mismatch for observations\.json/);
});
