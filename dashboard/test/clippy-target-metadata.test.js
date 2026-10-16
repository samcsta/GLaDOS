const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFinding } = require('../lib/clippy-intel');
const { candidateFromDocument } = require('../lib/clippy-leads');

const hit = { path: 'example-qa/full-assessment/findings/F-001.md', repo: 'example-qa' };
const finding = content => parseFinding(hit.path, hit, { content, truncated: false });

test('Criticality is accepted as explicit severity metadata in finding documents', () => {
  assert.equal(finding('# Historical assessment\n\n**Criticality:** critical\n').severity, 'critical');
  assert.equal(finding('1: # Historical assessment\n2: **Criticality:** high\n').severity, 'high');
  assert.equal(finding('# Historical assessment\n\n**Criticality:** speculative\n').severity, 'unknown');
});

test('Severity headings outside fenced examples support the assessment format', () => {
  assert.equal(finding('# Historical assessment\n\n## Severity: CRITICAL (9/12)\n').severity, 'critical');
  assert.equal(finding('# Historical assessment\n\n### **Severity:** HIGH (7/12)\n').severity, 'high');
});

test('fenced examples cannot supply severity metadata or target declarations', () => {
  const content = [
    '# Assessment',
    '```markdown',
    '**Criticality:** critical',
    '## Severity: CRITICAL (9/12)',
    '**Target:** unrelated.example.test',
    '```',
    '~~~markdown',
    '| Severity | Critical |',
    '~~~',
    '## Severity: HIGH (7/12)',
  ].join('\n');
  const parsed = finding(content);
  assert.equal(parsed.severity, 'high');
  assert.deepEqual(parsed.targets, []);
  assert.equal(finding(content.replace('## Severity: HIGH (7/12)', '')).severity, 'unknown');
});

test('canonical Severity metadata takes precedence over Criticality and headings', () => {
  for (const severity of ['**Severity:** low', '| Severity | Low |']) {
    const parsed = finding([
      '# Assessment',
      '**Criticality:** critical',
      '## Severity: CRITICAL (9/12)',
      severity,
    ].join('\n'));
    assert.equal(parsed.severity, 'low');
    assert.equal(candidateFromDocument(hit, { content: parsed.content }, parseFinding), null);
  }
});

function multiTargetDocument() {
  return {
    truncated: false,
    content: [
      '# Historical finding with two documented environments',
      '**Criticality:** critical',
      '**Target:** qa.example.test, www.example.test, declared-only.example.test',
      '**Date:** 2026-04-20',
      '## Severity: CRITICAL (9/12)',
      '## Evidence',
      'The source records a historical response and a comparison against the expected access control behavior.',
      'QA evidence: https://qa.example.test/api/example',
      'Production evidence: https://www.example.test/api/example',
      'Reference documentation: https://docs.example.test/reference',
      '## Remediation',
      'Apply the documented access policy and verify the current deployment.',
    ].join('\n'),
  };
}

test('preferred declared domain selects its own recorded endpoint and scope', () => {
  const document = multiTargetDocument();
  const primary = candidateFromDocument(hit, document, parseFinding);
  const preferred = candidateFromDocument(hit, document, parseFinding, null, { domain: 'www.example.test' });
  assert.equal(primary.domain, 'qa.example.test');
  assert.equal(preferred.domain, 'www.example.test');
  assert.equal(preferred.endpoint, 'https://www.example.test/api/example');
  assert.equal(preferred.scope, 'www.example.test');
  assert.equal(preferred.targetKey, 'domain:www.example.test');
  assert.deepEqual(preferred.targetDomains, ['qa.example.test', 'www.example.test']);
  assert.notEqual(preferred.id, primary.id);
  assert.equal(preferred.evidenceDigest, primary.evidenceDigest);
  assert.equal(preferred.historical, true);
  assert.equal(preferred.reportCoverage.status, 'needs_verification');
  assert.equal(primary.reportCoverage.status, 'needs_verification');
});

test('references and declared targets without a recorded URL cannot become preferred endpoints', () => {
  const document = multiTargetDocument();
  for (const domain of ['docs.example.test', 'declared-only.example.test', 'unmentioned.example.test']) {
    const candidate = candidateFromDocument(hit, document, parseFinding, null, { domain });
    assert.equal(candidate.domain, 'qa.example.test');
    assert.ok(!candidate.targetDomains.includes(domain));
    assert.equal(candidate.reportCoverage.status, 'needs_verification');
  }
});

test('recognizing Criticality does not bypass document and evidence requirements', () => {
  const document = multiTargetDocument();
  assert.equal(candidateFromDocument(hit, { ...document, truncated: true }, parseFinding), null);
  assert.equal(candidateFromDocument(hit, { ...document, is_text: false }, parseFinding), null);
  assert.equal(candidateFromDocument(hit, { content: '# Assessment\n**Criticality:** critical\n**Target:** qa.example.test\n' }, parseFinding), null);
});

test('affected-instance lists declare exact targets without absorbing nearby prose or examples', () => {
  const document = multiTargetDocument();
  document.content = document.content.replace('**Target:** qa.example.test, www.example.test, declared-only.example.test', [
    '**Target:** qa.example.test (and related applications)',
    '**Affected instances (all confirmed):**',
    '- `qa.example.test` — QA instance',
    '- `www.example.test` — Production instance',
    '',
    'A separate service is narrative.example.test.',
    '- unrelated-list.example.test is not part of the target declaration.',
    '```markdown',
    '**Affected instances:**',
    '- fenced.example.test',
    '```',
  ].join('\n'));
  assert.deepEqual(finding(document.content).targets, ['qa.example.test', 'www.example.test']);
  const candidate = candidateFromDocument(hit, document, parseFinding, null, { domain: 'www.example.test' });
  assert.equal(candidate.domain, 'www.example.test');
  assert.equal(candidate.reportCoverage.status, 'needs_verification');
});
