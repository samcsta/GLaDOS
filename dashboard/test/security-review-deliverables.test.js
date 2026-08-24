const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReportModel, combinedReportMarkdown, cvss31Score, executiveSummaryMarkdown, findingFilename, findingMarkdown, generateSecurityReviewDeliverables, observationFilename, observationsMarkdown, reportHtml, writeDeliverablesManifest } = require('../lib/security-review/deliverables');

test('security-review deliverables group findings and render concise human output', () => {
  const model = buildReportModel({
    run: { repositoryPath: '/tmp/example-api', head: 'snapshot:test', fileCount: 2 },
    threatModel: { summary: 'Example API processes vehicle requests.' },
    findingsDocument: { engagement_id: 'eng-1', findings: [{
      id: 'F-1', candidate_id: 'C-1', title: 'Unsafe URL fetch', severity: 'high', confidence: 'high', cwe_ids: ['CWE-918'],
      description: 'A caller-controlled URL reaches an HTTP client.', impact: 'Internal resources may be exposed.',
      recommendation: 'Validate destinations.', reachability: 'Authenticated route.',
      minimum_attacker_access: 'Authenticated API caller', preconditions: ['Route is deployed', 'Destination is reachable'],
      locations: [{ path: 'src/client.kt', start_line: 10, end_line: 12, role: 'sink' }],
    }, {
      id: 'F-2', title: 'Informational note', severity: 'informational', cwe_ids: ['CWE-829'],
    }] },
    coverageDocument: { files: [{ path: 'a' }, { path: 'b' }] },
    receipt: { engagement_id: 'eng-1' },
    dynamicValidation: [{ candidate_id: 'C-1', disposition: 'BLOCKED', validation: 'Local mock was unavailable.', blocker: 'No isolated harness.' }],
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
  assert.match(executiveSummaryMarkdown(model), /1 were blocked or deferred/);
  assert.match(executiveSummaryMarkdown(model), /1 observation or hardening note/);
  assert.match(findingMarkdown(model.findings[0]), /^# F-1 - Unsafe URL fetch/);
  assert.match(findingMarkdown(model.findings[0]), /\*\*Confidence:\*\* high/);
  assert.match(findingMarkdown(model.findings[0]), /## Attacker prerequisites/);
  assert.match(findingMarkdown(model.findings[0]), /Authenticated API caller/);
  assert.match(findingMarkdown(model.findings[0]), /Route is deployed; Destination is reachable/);
  assert.match(findingMarkdown(model.findings[0]), /Local mock was unavailable/);
  assert.match(findingMarkdown(model.findings[0]), /No isolated harness/);
  assert.match(findingMarkdown(model.findings[0]), /## Technical evidence/);
  assert.match(findingMarkdown(model.findings[0]), /## CVSS 3\.1/);
  assert.match(findingMarkdown(model.findings[0]), /Not assigned/);
  assert.match(findingMarkdown(model.findings[0]), /## Assumptions, counterevidence, and proof gaps/);
  assert.doesNotMatch(findingMarkdown(model.findings[0]), /Red Team AI agents analyzed/);
  assert.doesNotMatch(findingMarkdown(model.findings[0]), /\[Action \d+\]/);
  assert.doesNotMatch(combinedReportMarkdown(model), /#(?:Description|Action|Result)#|\[Action \d+\]/);
  assert.match(combinedReportMarkdown(model), /#### Attacker Prerequisites/);
  assert.match(combinedReportMarkdown(model), /#### Security Impact/);
  assert.match(combinedReportMarkdown(model), /Observations and Hardening Notes/);
  assert.match(combinedReportMarkdown(model), /Mutable image/);
  assert.match(observationsMarkdown(model), /O-1 - Mutable image/);
  assert.match(combinedReportMarkdown(model), /\[CWE-918: Server-Side Request Forgery \(SSRF\)\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/918\.html\)/);
  assert.equal(findingFilename(model.findings[0]), 'F-1-CWE-918-Unsafe-URL-fetch.md');
  assert.equal(observationFilename(model.observations[0]), 'O-1-Mutable-image.md');
  assert.match(reportHtml(model), /Unsafe URL fetch/);
  assert.match(reportHtml(model), /Mutable image/);
  assert.match(reportHtml(model), /Attacker Prerequisites/);
  assert.match(reportHtml(model), /Coverage and Negative Assurance/);
  assert.match(reportHtml(model), /CWE-918: Server-Side Request Forgery \(SSRF\)/);
  assert.match(reportHtml(model), /href="https:\/\/cwe\.mitre\.org\/data\/definitions\/918\.html"/);
  assert.match(reportHtml(model), /Evidence location/);
  assert.doesNotMatch(reportHtml(model), />Action \d+</);
  assert.doesNotMatch(reportHtml(model), />Description</);
  assert.doesNotMatch(reportHtml(model), /<script>/);
});

test('security-review deliverables name and link every CWE on a consolidated finding', () => {
  const finding = {
    id: 'AUTHZ-1', title: 'Object authorization is missing',
    cwe_ids: ['CWE-639', 'CWE-862'],
  };
  const markdown = findingMarkdown(finding);
  assert.match(markdown, /^# AUTHZ-1 - Object authorization is missing/);
  assert.match(markdown, /\[CWE-639: Authorization Bypass Through User-Controlled Key\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/639\.html\)/);
  assert.match(markdown, /\[CWE-862: Missing Authorization\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/862\.html\)/);
});

test('security-review deliverables use official names for current report CWE identifiers', () => {
  const expected = {
    'CWE-16': 'Configuration',
    'CWE-287': 'Improper Authentication',
    'CWE-294': 'Authentication Bypass by Capture-replay',
    'CWE-306': 'Missing Authentication for Critical Function',
    'CWE-345': 'Insufficient Verification of Data Authenticity',
    'CWE-400': 'Uncontrolled Resource Consumption',
    'CWE-494': 'Download of Code Without Integrity Check',
    'CWE-613': 'Insufficient Session Expiration',
    'CWE-636': "Not Failing Securely ('Failing Open')",
    'CWE-668': 'Exposure of Resource to Wrong Sphere',
    'CWE-732': 'Incorrect Permission Assignment for Critical Resource',
    'CWE-74': "Improper Neutralization of Special Elements in Output Used by a Downstream Component ('Injection')",
    'CWE-770': 'Allocation of Resources Without Limits or Throttling',
    'CWE-841': 'Improper Enforcement of Behavioral Workflow',
    'CWE-863': 'Incorrect Authorization',
    'CWE-922': 'Insecure Storage of Sensitive Information',
    'CWE-1357': 'Reliance on Insufficiently Trustworthy Component',
    'CWE-359': 'Exposure of Private Personal Information to an Unauthorized Actor',
  };
  for (const [cwe, name] of Object.entries(expected)) {
    assert.match(findingMarkdown({ id: 'F-1', title: 'Finding', cwe_ids: [cwe] }), new RegExp(`\\*\\*CWE:\\*\\* ${cwe}: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('security-review deliverables preserve an unmapped CWE identifier without inventing a name', () => {
  const report = buildReportModel({
    run: { repositoryPath: '/tmp/example', head: 'snapshot:test' },
    threatModel: { summary: 'Example.' },
    findingsDocument: { findings: [{ id: 'F-1', title: 'Finding', severity: 'high', cwe_ids: ['CWE-99999'] }] },
    coverageDocument: { files: [] }, receipt: { engagement_id: 'eng' },
  });
  assert.deepEqual(report.findings[0].cwe_ids, ['CWE-99999']);
  assert.match(findingMarkdown(report.findings[0]), /\[CWE-99999\]\(https:\/\/cwe\.mitre\.org\/data\/definitions\/99999\.html\)/);
});

test('security-review deliverables render official names and structured CVSS preconditions', () => {
  const finding = {
    title: 'Logged secret', cwe_ids: ['CWE-532'],
    cvss_preconditions: { attack_path: 'CI log access is available.', impact: 'A credential is exposed.' },
  };
  const markdown = findingMarkdown(finding);
  assert.match(markdown, /\*\*CWE:\*\* CWE-532: Insertion of Sensitive Information into Log File/);
  assert.match(markdown, /attack path: CI log access is available\.; impact: A credential is exposed\./);
  assert.doesNotMatch(markdown, /\[object Object\]/);
});

test('security-review deliverables redact bearer credentials from all human report formats', () => {
  const secret = 'Authorization: Bearer abc.def.ghi';
  const model = buildReportModel({
    run: { repositoryPath: '/tmp/example', head: 'snapshot:test', fileCount: 1 },
    threatModel: { summary: 'Example.' },
    findingsDocument: { engagement_id: 'eng', findings: [{
      id: 'F-1', title: secret, severity: 'high', cwe_ids: ['CWE-532'], description: secret,
      recommendation: secret, impact: secret, reachability: secret, counterevidence: secret,
      proof_gaps: [secret], locations: [],
    }] },
    coverageDocument: { files: [{ path: 'a' }] }, receipt: { engagement_id: 'eng' },
  });
  for (const report of [findingMarkdown(model.findings[0]), combinedReportMarkdown(model), reportHtml(model)]) {
    assert.doesNotMatch(report, /abc\.def\.ghi/);
    assert.match(report, /\[REDACTED\]/);
  }
});

test('security-review snippet redaction preserves code structure while removing literal secrets', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib/security-review/deliverables.js'), 'utf8');
  assert.match(source, /access\[_-\]\?token/);
  assert.match(source, /Authorization\\s\*:\\s\*Bearer/);
  assert.match(source, /REDACTED PRIVATE KEY/);
});

test('security-review deliverables calculate missing CVSS 3.1 base scores', () => {
  assert.equal(cvss31Score('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H'), 6.5);
  assert.equal(cvss31Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N'), 9.1);
  assert.equal(cvss31Score('not-a-vector'), null);
});

test('security-review deliverables accept the canonical cvss_v3_1 compatibility field', () => {
  const markdown = findingMarkdown({
    id: 'F-1', title: 'Finding', cwe_ids: ['CWE-400'], severity: 'high',
    cvss_v3_1: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H (6.5)',
  });
  assert.match(markdown, /6\.5 - `CVSS:3\.1\/AV:N\/AC:L\/PR:L\/UI:N\/S:U\/C:N\/I:N\/A:H`/);
});

test('deliverables manifest covers every published file and binds the source receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-deliverables-manifest-'));
  const deliveryRoot = path.join(root, 'deliverables');
  fs.mkdirSync(path.join(deliveryRoot, 'findings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'completion-receipt.json'), JSON.stringify({ engagement_id: 'eng', repository_head: 'snapshot:test' }));
  fs.copyFileSync(path.join(root, 'completion-receipt.json'), path.join(deliveryRoot, 'completion-receipt.json'));
  fs.writeFileSync(path.join(deliveryRoot, 'SECURITY-REVIEW.md'), '# Review\n');
  fs.writeFileSync(path.join(deliveryRoot, 'findings', 'F-1.md'), '# Finding\n');
  const manifest = writeDeliverablesManifest(deliveryRoot, { completedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(Object.keys(manifest.files), ['SECURITY-REVIEW.md', 'completion-receipt.json', 'findings/F-1.md']);
  assert.equal(manifest.engagement_id, 'eng');
  assert.equal(manifest.generated_at, '2026-01-01T00:00:00.000Z');
});

test('security-review publication bundle is complete, self-verifying, and not duplicated at artifact root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-deliverables-bundle-'));
  const writeJson = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson('run.json', {
    repositoryPath: '/tmp/example', head: 'snapshot:test', sourceType: 'directory-snapshot',
    gitHistoryAvailable: false, deepScan: { terminalState: 'SATURATED', completedAt: '2026-01-01T00:00:00.000Z' },
  });
  writeJson('context/threat-model.json', { summary: 'Example application.', trust_boundaries: [], entry_points: [], assets: [], attacker_goals: [] });
  writeJson('findings.json', { engagement_id: 'eng', findings: [{ id: 'F-1', title: 'Unsafe fetch', severity: 'high', cwe_ids: ['CWE-918'], locations: [] }] });
  writeJson('observations.json', { engagement_id: 'eng', observations: [{ id: 'O-1', title: 'Mutable image', category: 'hardening', cwe_ids: ['CWE-829'], locations: [] }] });
  writeJson('coverage.json', { files: [{ path: 'main.js', disposition: 'FINDING' }] });
  writeJson('completion-receipt.json', { engagement_id: 'eng', repository_head: 'snapshot:test', status: 'SEALED', terminal_state: 'SATURATED' });
  writeJson('scan-manifest.json', { engagement_id: 'eng', terminal_state: 'SATURATED' });
  fs.writeFileSync(path.join(root, 'SECURITY-REVIEW.md'), 'legacy duplicate\n');

  const result = generateSecurityReviewDeliverables(root);

  for (const relative of ['README.md', 'EXECUTIVE-SUMMARY.md', 'SECURITY-REVIEW.md', 'OBSERVATIONS.md', 'HISTORICAL-REGRESSION.md', 'COVERAGE-AND-LIMITATIONS.md', 'REMEDIATION-PLAN.md', 'security-review-report.html', 'completion-receipt.json', 'scan-manifest.json', 'DELIVERABLES-MANIFEST.json']) {
    assert.equal(fs.existsSync(path.join(result.deliveryRoot, relative)), true, relative);
  }
  assert.equal(fs.existsSync(path.join(result.deliveryRoot, 'observations', 'O-1-Mutable-image.md')), true);
  assert.equal(fs.existsSync(path.join(result.deliveryRoot, 'findings', 'High', 'F-1-CWE-918-Unsafe-fetch.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'SECURITY-REVIEW.md')), false);
  assert.equal(Object.hasOwn(result.manifest.files, 'security-review-report.pdf'), false);
});
