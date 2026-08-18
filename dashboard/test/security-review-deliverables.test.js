const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReportModel, combinedReportMarkdown, cvss31Score, executiveSummaryMarkdown, findingFilename, findingMarkdown, reportHtml } = require('../lib/security-review/deliverables');

test('security-review deliverables group findings and render concise human output', () => {
  const model = buildReportModel({
    run: { repositoryPath: '/tmp/example-api', head: 'snapshot:test', fileCount: 2 },
    threatModel: { summary: 'Example API processes vehicle requests.' },
    findingsDocument: { engagement_id: 'eng-1', findings: [{
      id: 'F-1', title: 'Unsafe URL fetch', severity: 'high', confidence: 'high', cwe_ids: ['CWE-918'],
      description: 'A caller-controlled URL reaches an HTTP client.', impact: 'Internal resources may be exposed.',
      recommendation: 'Validate destinations.', reachability: 'Authenticated route.',
      locations: [{ path: 'src/client.kt', start_line: 10, end_line: 12, role: 'sink' }],
    }, {
      id: 'F-2', title: 'Informational note', severity: 'informational', cwe_ids: ['CWE-829'],
    }] },
    coverageDocument: { files: [{ path: 'a' }, { path: 'b' }] },
    receipt: { engagement_id: 'eng-1' },
    dynamicValidation: [{ disposition: 'BLOCKED' }],
    observationsDocument: { observations: [{
      id: 'O-1', title: 'Mutable image', cwe_ids: ['CWE-829'], category: 'supply-chain-hardening',
      rationale: 'Registry mutability is unproven.', confidence: 'low', evidence: 'No digest.',
      counterevidence: 'Private registry policy is unknown.', recommendation: 'Pin a digest.',
    }] },
  });
  assert.match(executiveSummaryMarkdown(model), /Example API processes vehicle requests/);
  assert.equal(model.findings.length, 1);
  assert.match(executiveSummaryMarkdown(model), /Scope and Limitations/);
  assert.match(executiveSummaryMarkdown(model), /Risk Rating and CVSS/);
  assert.match(executiveSummaryMarkdown(model), /1 candidate received dynamic-validation dispositions/);
  assert.doesNotMatch(executiveSummaryMarkdown(model), /conditional or hardening observation/);
  assert.match(findingMarkdown(model.findings[0]), /^#CWE-918: Server-Side Request Forgery \(SSRF\)#/);
  assert.match(findingMarkdown(model.findings[0]), /\*\*Finding:\*\* Unsafe URL fetch/);
  assert.match(findingMarkdown(model.findings[0]), /Confidence: high\./);
  assert.match(findingMarkdown(model.findings[0]), /#Action#/);
  assert.match(findingMarkdown(model.findings[0]), /#CVSS 3\.1 Score#/);
  assert.match(findingMarkdown(model.findings[0]), /Not assigned/);
  assert.match(findingMarkdown(model.findings[0]), /#Assumptions and Limitations#/);
  assert.match(findingMarkdown(model.findings[0]), /Red Team AI agents analyzed/);
  assert.doesNotMatch(findingMarkdown(model.findings[0]), /\[Action \d+\]/);
  assert.doesNotMatch(combinedReportMarkdown(model), /#(?:Description|Action|Result)#|\[Action \d+\]/);
  assert.match(combinedReportMarkdown(model), /#### Red Team AI Analysis/);
  assert.match(combinedReportMarkdown(model), /#### Security Impact/);
  assert.doesNotMatch(combinedReportMarkdown(model), /Conditional and Hardening Observations|Mutable image/);
  assert.match(combinedReportMarkdown(model), /\[CWE-918: Server-Side Request Forgery \(SSRF\)\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/918\.html\)/);
  assert.equal(findingFilename(model.findings[0]), 'CWE-918-Unsafe-URL-fetch.md');
  assert.match(reportHtml(model), /Unsafe URL fetch/);
  assert.match(reportHtml(model), /CWE-918: Server-Side Request Forgery \(SSRF\)/);
  assert.match(reportHtml(model), /href="https:\/\/cwe\.mitre\.org\/data\/definitions\/918\.html"/);
  assert.match(reportHtml(model), /Evidence location/);
  assert.doesNotMatch(reportHtml(model), />Action \d+</);
  assert.doesNotMatch(reportHtml(model), />Description</);
  assert.doesNotMatch(reportHtml(model), /<script>/);
});

test('security-review deliverables name and link every CWE on a consolidated finding', () => {
  const finding = {
    title: 'Object authorization is missing',
    cwe_ids: ['CWE-639', 'CWE-862'],
  };
  const markdown = findingMarkdown(finding);
  assert.match(markdown, /^#CWE-639: Authorization Bypass Through User-Controlled Key#/);
  assert.match(markdown, /\[CWE-639: Authorization Bypass Through User-Controlled Key\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/639\.html\)/);
  assert.match(markdown, /\[CWE-862: Missing Authorization\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/862\.html\)/);
});

test('security-review snippet redaction preserves code structure while removing literal secrets', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib/security-review/deliverables.js'), 'utf8');
  assert.doesNotMatch(source, /token\|api\[_-\]\?key\)\\s\*\[:=\]/);
  assert.match(source, /password\|passwd\|secret\|api/);
});

test('security-review deliverables calculate missing CVSS 3.1 base scores', () => {
  assert.equal(cvss31Score('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H'), 6.5);
  assert.equal(cvss31Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N'), 9.1);
  assert.equal(cvss31Score('not-a-vector'), null);
});
