const test = require('node:test');
const assert = require('node:assert/strict');
const { safeEngagementId } = require('../lib/security-review-report.cjs');
const dashboardDeliverables = require('../../dashboard/lib/security-review/deliverables');

test('security-review PDF export accepts only one safe engagement path component', () => {
  assert.equal(safeEngagementId('eng-123'), 'eng-123');
  assert.throws(() => safeEngagementId('../escape'), /invalid/);
  assert.throws(() => safeEngagementId('eng/child'), /invalid/);
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
