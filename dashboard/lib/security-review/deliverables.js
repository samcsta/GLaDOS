const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CWE_NAMES = Object.freeze({
  'CWE-16': 'Configuration',
  'CWE-117': 'Improper Output Neutralization for Logs',
  'CWE-20': 'Improper Input Validation',
  'CWE-200': 'Exposure of Sensitive Information to an Unauthorized Actor',
  'CWE-201': 'Insertion of Sensitive Information Into Sent Data',
  'CWE-209': 'Generation of Error Message Containing Sensitive Information',
  'CWE-287': 'Improper Authentication',
  'CWE-294': 'Authentication Bypass by Capture-replay',
  'CWE-295': 'Improper Certificate Validation',
  'CWE-306': 'Missing Authentication for Critical Function',
  'CWE-345': 'Insufficient Verification of Data Authenticity',
  'CWE-400': 'Uncontrolled Resource Consumption',
  'CWE-494': 'Download of Code Without Integrity Check',
  'CWE-613': 'Insufficient Session Expiration',
  'CWE-636': "Not Failing Securely ('Failing Open')",
  'CWE-639': 'Authorization Bypass Through User-Controlled Key',
  'CWE-668': 'Exposure of Resource to Wrong Sphere',
  'CWE-693': 'Protection Mechanism Failure',
  'CWE-770': 'Allocation of Resources Without Limits or Throttling',
  'CWE-732': 'Incorrect Permission Assignment for Critical Resource',
  'CWE-269': 'Improper Privilege Management',
  'CWE-284': 'Improper Access Control',
  'CWE-78': 'Improper Neutralization of Special Elements Used in an OS Command',
  'CWE-74': "Improper Neutralization of Special Elements in Output Used by a Downstream Component ('Injection')",
  'CWE-79': 'Improper Neutralization of Input During Web Page Generation',
  'CWE-532': 'Insertion of Sensitive Information into Log File',
  'CWE-703': 'Improper Check or Handling of Exceptional Conditions',
  'CWE-749': 'Exposed Dangerous Method or Function',
  'CWE-754': 'Improper Check for Unusual or Exceptional Conditions',
  'CWE-778': 'Insufficient Logging',
  'CWE-829': 'Inclusion of Functionality from Untrusted Control Sphere',
  'CWE-862': 'Missing Authorization',
  'CWE-863': 'Incorrect Authorization',
  'CWE-918': 'Server-Side Request Forgery (SSRF)',
  'CWE-922': 'Insecure Storage of Sensitive Information',
  'CWE-943': 'Improper Neutralization of Special Elements in Data Query Logic',
  'CWE-1188': 'Initialization of a Resource with an Insecure Default',
  'CWE-1236': 'Improper Neutralization of Formula Elements in a CSV File',
  'CWE-1357': 'Reliance on Insufficiently Trustworthy Component',
  'CWE-359': 'Exposure of Private Personal Information to an Unauthorized Actor',
  'CWE-601': 'URL Redirection to Untrusted Site',
  'CWE-522': 'Insufficiently Protected Credentials',
  'CWE-835': 'Loop with Unreachable Exit Condition',
  'CWE-841': 'Improper Enforcement of Behavioral Workflow',
});

const DELIVERY_FILES = Object.freeze([
  'README.md',
  'EXECUTIVE-SUMMARY.md',
  'SECURITY-REVIEW.md',
  'OBSERVATIONS.md',
  'HISTORICAL-REGRESSION.md',
  'COVERAGE-AND-LIMITATIONS.md',
  'REMEDIATION-PLAN.md',
  'security-review-report.html',
  'security-review-report.pdf',
  'completion-receipt.json',
  'scan-manifest.json',
  'DELIVERABLES-MANIFEST.json',
]);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows || []) {
    const value = String(row?.[field] || 'NOT_RECORDED').toUpperCase();
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function browserExecutable() {
  const configured = String(process.env.GLADOS_PDF_BROWSER || '').trim();
  const candidates = [
    configured,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function pdfCapabilityAvailable() {
  return process.versions.electron != null || browserExecutable() != null;
}

function generatePdf(htmlPath, outputPath) {
  const browser = browserExecutable();
  if (!browser) throw new Error('security-review PDF generation requires Chrome, Edge, Chromium, or GLADOS_PDF_BROWSER');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-security-review-pdf-'));
  let child = null;
  try {
    fs.rmSync(outputPath, { force: true });
    child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pdf-header-footer',
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${outputPath}`,
      `file://${htmlPath}`,
    ], { stdio: 'ignore' });
    const deadline = Date.now() + 120_000;
    let previousSize = -1;
    let stableChecks = 0;
    while (Date.now() < deadline) {
      const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      if (size > 5 && size === previousSize) stableChecks += 1;
      else stableChecks = 0;
      if (stableChecks >= 2 && fs.readFileSync(outputPath).subarray(0, 5).toString('ascii') === '%PDF-') break;
      previousSize = size;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  } finally {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (child.exitCode == null && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  const header = fs.existsSync(outputPath) ? fs.readFileSync(outputPath).subarray(0, 5).toString('ascii') : '';
  if (header !== '%PDF-') throw new Error('security-review PDF generation did not produce a valid PDF');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownText(value) {
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${Array.isArray(item) ? item.join(' ') : item}`).join('; ');
  }
  return String(value ?? '').replace(/\r/g, '').trim();
}

function sentence(value) {
  const text = markdownText(value);
  return !text || /[.!?]$/.test(text) ? text : `${text}.`;
}

function safeSlug(value, fallback = 'finding') {
  return String(value || fallback)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback;
}

function severity(value) {
  const normalized = String(value || '').toLowerCase();
  return SEVERITIES.includes(normalized) ? normalized : 'low';
}

function repositorySummary(threatModel, run) {
  const summary = threatModel?.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  if (summary && typeof summary === 'object') {
    for (const key of ['application', 'description', 'purpose', 'summary']) {
      if (typeof summary[key] === 'string' && summary[key].trim()) return summary[key].trim();
    }
  }
  if (typeof threatModel?.description === 'string' && threatModel.description.trim()) return threatModel.description.trim();
  return `${path.basename(run.repositoryPath || 'The repository')} was reviewed for source-level security weaknesses across application code, configuration, dependencies, CI/CD, and infrastructure.`;
}

function locationText(location) {
  const start = location.start_line || location.line_range || '?';
  const end = location.end_line && location.end_line !== location.start_line ? `-${location.end_line}` : '';
  return `${location.path || 'unknown'}:${start}${end}`;
}

function findingFilename(finding) {
  const cwe = Array.isArray(finding.cwe_ids) && finding.cwe_ids.length ? finding.cwe_ids[0] : 'CWE-Unknown';
  const id = safeSlug(finding.id, 'finding');
  return `${id}-${safeSlug(cwe, 'CWE-Unknown')}-${safeSlug(finding.title)}.md`;
}

function observationFilename(observation) {
  return `${safeSlug(observation.id, 'observation')}-${safeSlug(observation.title)}.md`;
}

function primaryCwe(finding) {
  return Array.isArray(finding.cwe_ids) && finding.cwe_ids.length ? finding.cwe_ids[0] : 'CWE-Unknown';
}

function cweName(cwe) {
  return CWE_NAMES[String(cwe || '').toUpperCase()] || null;
}

function cweLabel(cwe) {
  const id = String(cwe || 'CWE-Unknown').toUpperCase();
  const name = cweName(id);
  return name ? `${id}: ${name}` : id;
}

function findingCwes(finding) {
  const ids = Array.isArray(finding.cwe_ids) ? finding.cwe_ids : [];
  return [...new Set(ids.map(item => String(item || '').toUpperCase()).filter(Boolean))];
}

function redactReportText(value) {
  let text = markdownText(value);
  text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/ig, '$1[REDACTED]');
  text = text.replace(/((?:password|passwd|client[_-]?secret|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key|credential)\s*[:=]\s*)(["'])[^"']*\2/ig, '$1[REDACTED]');
  text = text.replace(/(\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@/]+:)[^\s@/]+@/ig, '$1[REDACTED]@');
  return text;
}

function cvss31Score(vector) {
  const metrics = Object.fromEntries(String(vector || '').split('/').slice(1).map(part => part.split(':')));
  const values = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    UI: { N: 0.85, R: 0.62 },
    C: { H: 0.56, L: 0.22, N: 0 },
    I: { H: 0.56, L: 0.22, N: 0 },
    A: { H: 0.56, L: 0.22, N: 0 },
  };
  const scope = metrics.S;
  const privilege = scope === 'C'
    ? { N: 0.85, L: 0.68, H: 0.5 }[metrics.PR]
    : { N: 0.85, L: 0.62, H: 0.27 }[metrics.PR];
  const factors = [values.AV[metrics.AV], values.AC[metrics.AC], privilege, values.UI[metrics.UI], values.C[metrics.C], values.I[metrics.I], values.A[metrics.A]];
  if (!factors.every(Number.isFinite) || !['U', 'C'].includes(scope)) return null;
  const [av, ac, pr, ui, confidentiality, integrity, availability] = factors;
  const impactBase = 1 - ((1 - confidentiality) * (1 - integrity) * (1 - availability));
  const impact = scope === 'U' ? 6.42 * impactBase : 7.52 * (impactBase - 0.029) - 3.25 * ((impactBase - 0.02) ** 15);
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const base = scope === 'U' ? Math.min(impact + exploitability, 10) : Math.min(1.08 * (impact + exploitability), 10);
  return Math.ceil((base * 10) - 1e-10) / 10;
}

function cvssVector(finding) {
  const value = finding.cvss_vector || finding.cvss?.vector || finding.cvss_v3_1 || '';
  return String(value).match(/CVSS:3\.1(?:\/[A-Z]+:[A-Z])+/)?.[0] || '';
}

function cvssScore(finding) {
  const recorded = Number(finding.cvss_score ?? finding.cvss?.score);
  if (Number.isFinite(recorded)) return recorded;
  return cvss31Score(cvssVector(finding));
}

function findingPreconditions(finding) {
  if (Array.isArray(finding.preconditions) && finding.preconditions.length) {
    return redactReportText(finding.preconditions.join('; '));
  }
  return redactReportText(finding.cvss_preconditions || finding.cvss?.preconditions || finding.exploitability_assumptions || finding.reachability || 'Not recorded.');
}

function minimumAttackerAccess(finding) {
  if (typeof finding.minimum_attacker_access === 'string' && finding.minimum_attacker_access.trim()) {
    return redactReportText(finding.minimum_attacker_access);
  }
  const vector = cvssVector(finding);
  const metrics = Object.fromEntries(vector.split('/').slice(1).map(part => part.split(':')));
  const access = {
    N: 'Network-reachable attacker',
    A: 'Adjacent-network attacker',
    L: 'Local user or process',
    P: 'Attacker with physical access',
  }[metrics.AV] || 'Attacker access not recorded';
  const privilege = {
    N: 'no application privileges required',
    L: 'authenticated or low-privilege application access required',
    H: 'privileged application access required',
  }[metrics.PR];
  const qualifiers = [
    privilege,
    metrics.UI === 'R' ? 'user interaction required' : null,
    metrics.AC === 'H' ? 'additional environmental or positioning conditions required' : null,
  ].filter(Boolean);
  return qualifiers.length ? `${access}; ${qualifiers.join('; ')}` : access;
}

function markdownCell(value) {
  return redactReportText(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function isoDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function cweReference(cwe) {
  const number = String(cwe || '').match(/^CWE-(\d+)$/i)?.[1];
  return number ? `https://cwe.mitre.org/data/definitions/${number}.html` : 'Not recorded';
}

function cweReferencesMarkdown(finding) {
  const cwes = findingCwes(finding);
  if (!cwes.length) return 'Not recorded.';
  return cwes.map(cwe => `- [${cweLabel(cwe)}](${cweReference(cwe)})`).join('\n');
}

function cweReferencesHtml(finding) {
  const cwes = findingCwes(finding);
  if (!cwes.length) return '<p>Not recorded.</p>';
  return `<ul>${cwes.map(cwe => `<li><strong>${escapeHtml(cweLabel(cwe))}</strong>: <a href="${escapeHtml(cweReference(cwe))}">${escapeHtml(cweReference(cwe))}</a></li>`).join('')}</ul>`;
}

function snippetForLocation(repositoryPath, location) {
  if (!repositoryPath || !location?.path || !Number(location.start_line)) return null;
  const repositoryRoot = path.resolve(repositoryPath);
  const file = path.resolve(repositoryRoot, location.path);
  if (file !== repositoryRoot && !file.startsWith(`${repositoryRoot}${path.sep}`)) return null;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return null; }
  const start = Math.max(1, Number(location.start_line));
  const requestedEnd = Number(location.end_line || start);
  const end = Math.min(lines.length, Math.max(start, Math.min(requestedEnd, start + 11)));
  let inPrivateKey = false;
  const redacted = lines.slice(start - 1, end).map((line, index) => {
    let safe = line;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(safe)) inPrivateKey = true;
    if (inPrivateKey) safe = '[REDACTED PRIVATE KEY]';
    if (/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) inPrivateKey = false;
    safe = safe.replace(/((?:password|passwd|client[_-]?secret|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key|credential)\s*[:=]\s*)(["'])[^"']*\2/ig, '$1[REDACTED]');
    safe = safe.replace(/((?:password|passwd|client[_-]?secret|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key|credential)\s*:\s*)(?!\$|\{|[A-Za-z_][\w.]*\()[^\s,#]+/ig, '$1[REDACTED]');
    safe = safe.replace(/((?:password|passwd|client[_-]?secret|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key|credential)\s*=\s*)(?!\$|\{|[A-Za-z_][\w.]*\()[^\s,#]+/ig, '$1[REDACTED]');
    safe = safe.replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/ig, '$1[REDACTED]');
    safe = safe.replace(/(\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@/]+:)[^\s@/]+@/ig, '$1[REDACTED]@');
    return `${String(start + index).padStart(5)} | ${safe}`;
  }).join('\n');
  return { start, end, code: redacted, language: path.extname(location.path).slice(1) || 'text' };
}

function evidenceMarkdown(finding, repositoryPath) {
  const locations = Array.isArray(finding.locations) ? finding.locations : [];
  const sections = [];
  for (const location of locations) {
    sections.push(`**Evidence location:** \`${locationText(location)}\`${location.role ? ` (${location.role})` : ''}`);
    const snippet = snippetForLocation(repositoryPath, location);
    if (snippet) sections.push(`\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\``);
  }
  return sections.join('\n\n') || 'No source location was retained.';
}

function validationStatus(finding) {
  return String(finding.status || finding.validation_status || 'SOURCE_REVIEWED').replaceAll('_', ' ');
}

function limitationsMarkdown(finding) {
  const counterevidence = redactReportText(finding.counterevidence || 'Not recorded.');
  const gaps = Array.isArray(finding.proof_gaps) && finding.proof_gaps.length
    ? finding.proof_gaps.map(item => `- ${redactReportText(item)}`).join('\n')
    : '- None recorded in the retained finding artifact.';
  return `**Counterevidence.** ${counterevidence}\n\n**Proof gaps.**\n\n${gaps}`;
}

function cvssMarkdown(finding) {
  const score = cvssScore(finding);
  const vector = cvssVector(finding);
  if (score != null && vector) return `${score.toFixed(1)} - \`${vector}\``;
  return `**Not assigned.** The retained evidence does not support every CVSS 3.1 base metric. Preconditions requiring validation: ${findingPreconditions(finding)}`;
}

function dynamicValidationMarkdown(finding) {
  const row = finding.dynamic_validation_result;
  if (!row) return 'No dynamic-validation disposition was retained for this finding.';
  return [
    `- **Status:** ${markdownCell(row.status || row.disposition || row.terminal_disposition || 'NOT_RECORDED')}`,
    `- **Method:** ${markdownCell(row.method || row.validation || finding.dynamic_validation || 'Not recorded')}`,
    row.blocker ? `- **Blocker:** ${markdownCell(row.blocker)}` : null,
  ].filter(Boolean).join('\n');
}

function findingMarkdown(finding, repositoryPath = null) {
  return [
    `# ${finding.id || 'Finding'} - ${redactReportText(finding.title || cweLabel(primaryCwe(finding)))}`,
    '',
    `- **Severity:** ${severity(finding.severity).toUpperCase()}`,
    `- **Confidence:** ${finding.confidence || 'not recorded'}`,
    `- **CWE:** ${findingCwes(finding).map(cweLabel).join('; ') || 'Not recorded'}`,
    `- **Validation class:** ${validationStatus(finding)}`,
    '',
    '## Summary',
    '',
    redactReportText(finding.description || finding.source_to_sink_evidence || 'Not recorded.'),
    '',
    '## Attacker prerequisites',
    '',
    `- **Minimum access:** ${minimumAttackerAccess(finding)}`,
    `- **Additional preconditions:** ${findingPreconditions(finding)}`,
    '',
    '## Reachability and attack path',
    '',
    redactReportText(finding.reachability || 'Not recorded.'),
    '',
    '## Security impact',
    '',
    redactReportText(finding.impact || 'Not recorded.'),
    '',
    '## Recommendation',
    '',
    redactReportText(finding.remediation || finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.'),
    '',
    '## Validation status',
    '',
    `${validationStatus(finding)}. “Source reviewed” confirms the retained code path, not deployment reachability or successful exploitation.`,
    '',
    dynamicValidationMarkdown(finding),
    '',
    '## Assumptions, counterevidence, and proof gaps',
    '',
    limitationsMarkdown(finding),
    '',
    '## CVSS 3.1',
    '',
    cvssMarkdown(finding),
    '',
    '## Technical evidence',
    '',
    evidenceMarkdown(finding, repositoryPath),
    '',
    '## CWE references',
    '',
    cweReferencesMarkdown(finding),
    '',
  ].join('\n');
}

function buildReportModel({
  run,
  threatModel,
  findingsDocument,
  observationsDocument = {},
  coverageDocument,
  receipt,
  dynamicValidation = [],
  scopeDocument = {},
  semanticCoverage = {},
  inventoryCounts = {},
  scanStatus = {},
  finalSummary = {},
  regressionDelta = {},
  priorContext = {},
}) {
  const findings = [...(findingsDocument.findings || [])].filter(item => SEVERITIES.includes(String(item.severity || '').toLowerCase())).sort((left, right) => {
    const severityDelta = SEVERITIES.indexOf(severity(left.severity)) - SEVERITIES.indexOf(severity(right.severity));
    return severityDelta || String(left.id || '').localeCompare(String(right.id || ''));
  });
  const counts = Object.fromEntries(SEVERITIES.map(level => [level, findings.filter(item => severity(item.severity) === level).length]));
  const observations = [...(observationsDocument.observations || [])].sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
  const validationBySubject = new Map();
  for (const row of dynamicValidation) {
    for (const subject of [row.finding_id, row.id, row.candidate_id].filter(Boolean)) {
      validationBySubject.set(subject, row);
    }
  }
  for (const finding of findings) {
    finding.dynamic_validation_result = [finding.id, finding.finding_id, finding.candidate_id, finding.canonical_candidate_id]
      .map(subject => validationBySubject.get(subject))
      .find(Boolean) || null;
  }
  const coverageRows = Array.isArray(coverageDocument.files) ? coverageDocument.files : [];
  const semanticChecks = Array.isArray(semanticCoverage.checks) ? semanticCoverage.checks : [];
  const scope = Array.isArray(scopeDocument.scope) ? scopeDocument.scope : [];
  const exclusions = Array.isArray(scopeDocument.exclusions) ? scopeDocument.exclusions : [];
  return {
    engagementId: findingsDocument.engagement_id || receipt.engagement_id,
    repository: path.basename(run.repositoryPath || 'repository'),
    revision: run.head || receipt.repository_head,
    purpose: repositorySummary(threatModel, run),
    findings,
    observations,
    counts,
    filesReviewed: coverageRows.length || Number(run.fileCount || 0),
    completedAt: run.deepScan?.completedAt || receipt.completed_at || null,
    startedAt: run.deepScan?.startedAt || null,
    repositoryPath: run.repositoryPath || null,
    sourceType: run.sourceType || null,
    gitHistoryAvailable: run.gitHistoryAvailable === true,
    reviewProfile: run.reviewProfile || 'not recorded',
    contextMode: run.contextMode || run.context_mode || finalSummary.context_mode || 'not recorded',
    scope,
    exclusions,
    threatModel: threatModel || {},
    coverageDispositionCounts: countBy(coverageRows, 'disposition'),
    semanticStatusCounts: countBy(semanticChecks, 'status'),
    semanticChecks,
    inventoryCounts,
    scanStatus,
    dependencyAnalysisPerformed: Number(inventoryCounts.dependencies || 0) > 0,
    dynamicValidationCount: dynamicValidation.length,
    blockedValidationCount: dynamicValidation.filter(row => /BLOCKED|DEFERRED/i.test(String(row.terminal_disposition || row.disposition || row.status || ''))).length,
    dynamicValidation,
    regressionDelta,
    priorContext,
  };
}

function executiveSummaryMarkdown(model) {
  const highest = SEVERITIES.find(level => model.counts[level] > 0) || 'none';
  const findingRows = model.findings.length
    ? model.findings.map(finding => `| ${markdownCell(finding.id)} | ${severity(finding.severity).toUpperCase()} | ${markdownCell(finding.title)} | ${markdownCell(finding.dynamic_validation_result?.status || validationStatus(finding))} |`).join('\n')
    : '| - | - | No reportable findings | - |';
  return [
    `# ${model.repository} Security Review`,
    '',
    '## Executive Summary',
    '',
    model.purpose,
    '',
    `The review completed with **${model.findings.length} reportable finding${model.findings.length === 1 ? '' : 's'}** and **${model.observations.length} observation or hardening note${model.observations.length === 1 ? '' : 's'}** across **${model.filesReviewed} reviewed files**. The highest recorded severity is **${highest.toUpperCase()}**.`,
    '',
    '## Severity Summary',
    '',
    '| Critical | High | Medium | Low |',
    '|---:|---:|---:|---:|',
    `| ${model.counts.critical} | ${model.counts.high} | ${model.counts.medium} | ${model.counts.low} |`,
    '',
    `- **Repository revision:** \`${model.revision}\``,
    `- **Engagement:** \`${model.engagementId}\``,
    '- **Status:** SATURATED and SEALED',
    `- **Review window:** ${isoDate(model.startedAt)} to ${isoDate(model.completedAt)}`,
    `- **Review profile/context:** ${model.reviewProfile} / ${model.contextMode}`,
    '',
    '## Finding Overview',
    '',
    '| ID | Severity | Title | Validation |',
    '|---|---|---|---|',
    findingRows,
    '',
    '## Scope and Limitations',
    '',
    `This was a source-only review of the immutable ${model.sourceType || 'repository'} revision. Included repository scope: ${model.scope.length ? model.scope.join(', ') : 'not explicitly recorded'}. Explicit exclusions: ${model.exclusions.length ? model.exclusions.join(', ') : 'none recorded'}.`,
    '',
    `No live target exploitation, deployed ingress verification, runtime identity/IAM inspection, external service control validation, CI runner inspection, or registry-policy validation was performed. Git history was ${model.gitHistoryAvailable ? 'available' : 'not available'}. Dependency CVE/SBOM analysis was ${model.dependencyAnalysisPerformed ? 'represented by retained dependency inventory' : 'not performed by this workflow and must not be inferred from file coverage'}.`,
    '',
    '## Methodology',
    '',
    'The review combined deterministic file and route inventory, repeated blind discovery to measured saturation, six specialist tracks, centralized deduplication and candidate closure, independent validator challenge, and deterministic sealing gates.',
    '',
    '## Risk Rating and CVSS',
    '',
    'Severity reflects source-visible risk and is conditional where deployment reachability or inherited controls were unavailable. CVSS 3.1 is reported only when every base metric is supportable from retained evidence; otherwise the finding states why scoring is withheld and lists the assumptions requiring validation.',
    '',
    '## Validation Status',
    '',
    `${model.dynamicValidationCount} candidate${model.dynamicValidationCount === 1 ? '' : 's'} received dynamic-validation dispositions; ${model.blockedValidationCount} were blocked or deferred by the source-only boundary. “Source reviewed” confirms the retained code path, not production reachability, attacker access, or successful exploitation.`,
    '',
    '## Remediation Priorities',
    '',
    '1. Address externally reachable input-to-sink paths and authorization boundaries first.',
    '2. Correct integrity and availability defects with confirmed reportable execution paths.',
    '3. Retest remediated findings against representative identities and deployment controls.',
    '',
  ].join('\n');
}

function scopeAndThreatModelMarkdown(model) {
  const boundaries = Array.isArray(model.threatModel.trust_boundaries) ? model.threatModel.trust_boundaries : [];
  const entries = Array.isArray(model.threatModel.entry_points) ? model.threatModel.entry_points : [];
  const assets = Array.isArray(model.threatModel.assets) ? model.threatModel.assets : [];
  const goals = Array.isArray(model.threatModel.attacker_goals) ? model.threatModel.attacker_goals : [];
  const profiles = Array.isArray(model.threatModel.attacker_profiles) ? model.threatModel.attacker_profiles : [];
  return [
    '## Scope and Threat Model',
    '',
    `- **Repository type:** ${model.sourceType || 'not recorded'}`,
    `- **Included scope:** ${model.scope.length ? model.scope.join(', ') : 'not explicitly recorded'}`,
    `- **Exclusions:** ${model.exclusions.length ? model.exclusions.join(', ') : 'none recorded'}`,
    `- **Git-history analysis:** ${model.gitHistoryAvailable ? 'available' : `unavailable${model.scanStatus.historyReason ? ` - ${model.scanStatus.historyReason}` : ''}`}`,
    `- **Dependency CVE/SBOM analysis:** ${model.dependencyAnalysisPerformed ? 'retained' : 'not performed'}`,
    '',
    '### Trust boundaries',
    '',
    ...(boundaries.length ? boundaries.map(item => `- **${markdownCell(item.boundary || 'Boundary')}:** ${markdownCell((item.assets || []).join(', ') || item.description || 'No assets recorded')}`) : ['- Not recorded.']),
    '',
    '### Entry points',
    '',
    ...(entries.length ? entries.map(item => `- \`${markdownCell(item.path || 'unknown')}${item.lines ? `:${markdownCell(item.lines)}` : ''}\` - ${markdownCell(item.description || 'No description recorded')}`) : ['- Not recorded.']),
    '',
    '### Protected assets',
    '',
    ...(assets.length ? assets.map(item => `- ${markdownCell(item)}`) : ['- Not recorded.']),
    '',
    '### Modeled attacker goals',
    '',
    ...(goals.length ? goals.map(item => `- ${markdownCell(item)}`) : ['- Not recorded.']),
    '',
    '### Modeled attacker profiles',
    '',
    ...(profiles.length ? profiles.map(profile => `- **${markdownCell(profile.id || 'attacker')}:** minimum access: ${markdownCell(profile.minimum_access || 'not recorded')}; entry points: ${markdownCell(profile.entry_points || [])}; goals: ${markdownCell(profile.goals || [])}`) : ['- Not recorded.']),
    '',
  ].join('\n');
}

function attackerPrerequisitesMarkdown(model) {
  return [
    '## Attacker Prerequisites',
    '',
    'These are minimum modeled conditions, not claims that an attacker currently possesses the access or that the affected deployment is reachable.',
    '',
    '| Finding | Minimum attacker access | Additional preconditions |',
    '|---|---|---|',
    ...(model.findings.length ? model.findings.map(finding => `| ${markdownCell(finding.id)} | ${markdownCell(minimumAttackerAccess(finding))} | ${markdownCell(findingPreconditions(finding))} |`) : ['| - | - | No reportable findings |']),
    '',
  ].join('\n');
}

function coverageMarkdown(model) {
  const inventory = [
    ['Files', model.filesReviewed],
    ['Route candidates', model.inventoryCounts.routes || 0],
    ['HTTP-client candidates', model.inventoryCounts.httpClients || 0],
    ['Cryptographic-operation candidates', model.inventoryCounts.cryptoOperations || 0],
    ['Suppression candidates', model.inventoryCounts.suppressions || 0],
    ['Security-sensitive semantic candidates', model.inventoryCounts.securitySensitive || 0],
  ];
  const checks = model.semanticChecks.filter(row => ['TESTED_NEGATIVE', 'NOT_APPLICABLE'].includes(String(row.status || '').toUpperCase()));
  return [
    '## Coverage and Negative Assurance',
    '',
    'Inventory counts are deterministic work-queue counts; they are not assertions that every candidate represents a real endpoint or weakness.',
    '',
    '| Inventory | Count |',
    '|---|---:|',
    ...inventory.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    `File dispositions: ${Object.entries(model.coverageDispositionCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'not recorded'}.`,
    '',
    `Semantic check dispositions: ${Object.entries(model.semanticStatusCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'not recorded'}.`,
    '',
    '### Tested-negative and not-applicable semantic checks',
    '',
    ...(checks.length ? checks.map(row => `- **${markdownCell(row.id || row.check_id || 'unnamed-check')} (${String(row.status).toUpperCase()}):** ${markdownCell(row.analysis || row.reason || 'See retained evidence.')}`) : ['- None recorded.']),
    '',
    `HEAD secret scan: ${model.scanStatus.headCompleted ? 'completed' : 'not completed'} with ${model.scanStatus.headCandidates || 0} redacted candidate${model.scanStatus.headCandidates === 1 ? '' : 's'}.`,
    '',
    `Git-history secret scan: ${model.scanStatus.historyCompleted ? 'completed' : `unavailable${model.scanStatus.historyReason ? ` - ${model.scanStatus.historyReason}` : ''}`}.`,
    '',
  ].join('\n');
}

function observationMarkdown(observation) {
  return [
    `# ${observation.id || 'Observation'} - ${redactReportText(observation.title || 'Untitled observation')}`,
    '',
    `- **Category:** ${observation.category || 'not recorded'}`,
    `- **Confidence:** ${observation.confidence || 'not recorded'}`,
    `- **CWE:** ${findingCwes(observation).map(cweLabel).join('; ') || 'Not recorded'}`,
    '',
    '## Why this is an observation',
    '',
    redactReportText(observation.rationale || 'Reportability depends on facts outside the reviewed source.'),
    '',
    '## Evidence',
    '',
    redactReportText(observation.evidence || 'Not recorded.'),
    '',
    '## Reachability and unresolved conditions',
    '',
    redactReportText(observation.reachability || 'Not recorded.'),
    '',
    '## Recommendation',
    '',
    redactReportText(observation.recommendation || 'Validate the unresolved deployment condition and harden the cited control.'),
    '',
    '## Source locations',
    '',
    ...((observation.locations || []).length ? observation.locations.map(location => `- \`${locationText(location)}\`${location.role ? ` (${location.role})` : ''}`) : ['- Not recorded.']),
    '',
  ].join('\n');
}

function observationsMarkdown(model) {
  return [
    `# ${model.repository} Security Review Observations`,
    '',
    'Observations are hardening, operational, or unresolved concerns that do not establish all three reportability elements: a source security-control failure, a plausible attacker, and security impact.',
    '',
    ...(model.observations.length ? model.observations.map(observationMarkdown) : ['No observations were retained.']),
    '',
  ].join('\n');
}

function historicalRegressionMarkdown(model) {
  const delta = model.regressionDelta || {};
  const dispositions = Array.isArray(delta.dispositions) ? delta.dispositions : [];
  if (delta.status === 'NOT_REQUESTED_BLIND_MODE') {
    return '## Historical Regression\n\nNot requested: this run was explicitly or automatically resolved to blind mode because no matching sealed prior review was available.\n';
  }
  return [
    '## Historical Regression',
    '',
    `- **Status:** ${markdownCell(delta.status || 'not recorded')}`,
    `- **Prior engagement:** ${markdownCell(model.priorContext?.prior_engagement_id || 'not recorded')}`,
    `- **Match basis:** ${markdownCell(model.priorContext?.match_basis || 'not recorded')}`,
    '',
    '| Prior finding | Disposition | Current-source evidence |',
    '|---|---|---|',
    ...(dispositions.length ? dispositions.map(row => `| ${markdownCell(row.prior_finding_id)} | ${markdownCell(row.disposition)} | ${markdownCell(row.evidence)} |`) : ['| - | - | No prior-finding dispositions were retained |']),
    '',
  ].join('\n');
}

function retestMarkdown(model) {
  return [
    '## Validation and Retest Plan',
    '',
    'Use an isolated environment with representative identities and controlled substitutes for external systems. Do not treat a source-only finding as dynamically reproduced until the retained test method succeeds.',
    '',
    '| Finding | Current status | Proposed method | Blocker |',
    '|---|---|---|---|',
    ...(model.findings.length ? model.findings.map(finding => {
      const row = finding.dynamic_validation_result || {};
      return `| ${markdownCell(finding.id)} | ${markdownCell(row.status || row.disposition || validationStatus(finding))} | ${markdownCell(row.method || row.validation || finding.dynamic_validation || 'Derive an isolated test from the documented attack path')} | ${markdownCell(row.blocker || 'None recorded')} |`;
    }) : ['| - | - | No reportable findings | - |']),
    '',
    'Recalculate CVSS only after deployment reachability, effective identities/privileges, inherited controls, and observed impact are established.',
    '',
  ].join('\n');
}

function remediationMarkdown(model) {
  const byPriority = SEVERITIES.flatMap(level => model.findings.filter(item => severity(item.severity) === level));
  return [
    `# ${model.repository} Remediation Plan`,
    '',
    'Priorities are severity-led and should be adjusted for deployment reachability and compensating controls after validation.',
    '',
    '| Order | Finding | Severity | Remediation outcome | Owner | Status |',
    '|---:|---|---|---|---|---|',
    ...(byPriority.length ? byPriority.map((finding, index) => `| ${index + 1} | ${markdownCell(finding.id)} | ${severity(finding.severity).toUpperCase()} | ${markdownCell(finding.recommendation || 'Remediate the cited control failure')} | Unassigned | Open |`) : ['| - | - | - | No reportable findings | - | - |']),
    '',
    'Deployment-gated observations should be assigned after their unresolved reachability or control assumptions are validated.',
    '',
  ].join('\n');
}

function combinedReportMarkdown(model) {
  const sections = [
    executiveSummaryMarkdown(model),
    '\n## Table of Contents\n\n- Executive Summary\n- Scope and Threat Model\n- Attacker Prerequisites\n- Coverage and Negative Assurance\n- Historical Regression\n- Findings\n- Observations and Hardening Notes\n- Validation and Retest Plan\n- Remediation Plan\n- Integrity and Evidence\n',
    scopeAndThreatModelMarkdown(model),
    attackerPrerequisitesMarkdown(model),
    coverageMarkdown(model),
    historicalRegressionMarkdown(model),
  ];
  for (const level of SEVERITIES) {
    const rows = model.findings.filter(item => severity(item.severity) === level);
    if (!rows.length) continue;
    sections.push(`\n## ${level[0].toUpperCase()}${level.slice(1)} Findings\n`);
    for (const finding of rows) {
      sections.push([
        `### ${finding.id || 'Finding'} - ${redactReportText(finding.title)}`,
        '',
        `**Severity:** ${level.toUpperCase()}  `,
        `**Confidence:** ${finding.confidence || 'not recorded'}  `,
        `**CWE:** ${findingCwes(finding).map(cweLabel).join('; ') || 'Not recorded'}`,
        '',
        redactReportText(finding.description || finding.source_to_sink_evidence || 'Not recorded.'),
        '',
        '#### Attacker Prerequisites',
        '',
        `**Minimum access:** ${minimumAttackerAccess(finding)}  `,
        `**Additional preconditions:** ${findingPreconditions(finding)}`,
        '',
        '#### Reachability and Attack Path',
        '',
        redactReportText(finding.reachability || 'Not recorded.'),
        '',
        '#### Security Impact',
        '',
        redactReportText(finding.impact || 'Not recorded.'),
        '',
        '#### Recommendation',
        '',
        redactReportText(finding.remediation || finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.'),
        '',
        '#### Validation Status',
        '',
        `${validationStatus(finding)}. “Source reviewed” confirms the retained code path, not successful exploitation.`,
        '',
        dynamicValidationMarkdown(finding),
        '',
        '#### Assumptions and Limitations',
        '',
        limitationsMarkdown(finding),
        '',
        '#### CVSS 3.1',
        '',
        cvssMarkdown(finding),
        '',
        '#### Technical Evidence',
        '',
        evidenceMarkdown(finding, model.repositoryPath),
        '',
        '#### CWE References',
        '',
        cweReferencesMarkdown(finding),
        '',
      ].join('\n'));
    }
  }
  sections.push('\n## Observations and Hardening Notes\n');
  if (model.observations.length) {
    for (const observation of model.observations) sections.push(observationMarkdown(observation).replace(/^# /, '### '));
  } else sections.push('No observations were retained.');
  sections.push(retestMarkdown(model));
  sections.push(remediationMarkdown(model).replace(/^# /, '## '));
  sections.push([
    '## Integrity and Evidence',
    '',
    'The publication bundle includes the source completion receipt, scan manifest, and a deliverables manifest containing SHA-256 digests for every published file. The source receipt seals evidence artifacts; the deliverables manifest separately protects the rendered publication bundle.',
    '',
  ].join('\n'));
  return sections.join('\n');
}

function structuredFindingHtml(finding, model, level) {
  const actions = (finding.locations || []).map(location => {
    const snippet = snippetForLocation(model.repositoryPath, location);
    const code = snippet ? `<pre><code>${escapeHtml(snippet.code)}</code></pre>` : '<p>Code snippet unavailable.</p>';
    return `<div class="code-evidence"><div class="reference">Evidence location: <code>${escapeHtml(locationText(location))}</code>${location.role ? ` <span>(${escapeHtml(location.role)})</span>` : ''}</div>${code}</div>`;
  }).join('');
  const score = cvssScore(finding);
  const vector = cvssVector(finding);
  const dynamic = finding.dynamic_validation_result || {};
  const proofGaps = Array.isArray(finding.proof_gaps) && finding.proof_gaps.length
    ? `<ul>${finding.proof_gaps.map(item => `<li>${escapeHtml(redactReportText(item))}</li>`).join('')}</ul>`
    : '<p>None recorded in the retained finding artifact.</p>';
  return `<section class="finding ${level}" id="${escapeHtml(finding.id || '')}"><header class="finding-header"><div class="badges"><span class="severity">${level.toUpperCase()}</span><span class="confidence">CONFIDENCE ${escapeHtml(String(finding.confidence || 'not recorded').toUpperCase())}</span><span class="finding-id">${escapeHtml(finding.id || 'ID not recorded')}</span></div><h2>${escapeHtml(redactReportText(finding.title || cweLabel(primaryCwe(finding))))}</h2><p class="cwe-line">${escapeHtml(findingCwes(finding).map(cweLabel).join('; ') || 'CWE not recorded')}</p></header><div class="callout"><h3>Summary</h3><p>${escapeHtml(redactReportText(finding.description || finding.source_to_sink_evidence || 'Not recorded.'))}</p></div><div class="two-column"><div><h3>Minimum attacker access</h3><p>${escapeHtml(minimumAttackerAccess(finding))}</p></div><div><h3>Additional preconditions</h3><p>${escapeHtml(findingPreconditions(finding))}</p></div></div><h3>Reachability and attack path</h3><p>${escapeHtml(redactReportText(finding.reachability || 'Not recorded.'))}</p><h3>Security impact</h3><p>${escapeHtml(redactReportText(finding.impact || 'Not recorded.'))}</p><h3>Recommendation</h3><p>${escapeHtml(redactReportText(finding.remediation || finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.'))}</p><h3>Validation status</h3><p><strong>${escapeHtml(validationStatus(finding))}.</strong> Source review confirms the retained code path, not deployment reachability or successful exploitation.</p><dl class="validation"><dt>Dynamic status</dt><dd>${escapeHtml(dynamic.status || dynamic.disposition || dynamic.terminal_disposition || 'Not recorded')}</dd><dt>Method</dt><dd>${escapeHtml(redactReportText(dynamic.method || dynamic.validation || finding.dynamic_validation || 'Not recorded'))}</dd>${dynamic.blocker ? `<dt>Blocker</dt><dd>${escapeHtml(redactReportText(dynamic.blocker))}</dd>` : ''}</dl><h3>Assumptions, counterevidence, and proof gaps</h3><p><strong>Counterevidence:</strong> ${escapeHtml(redactReportText(finding.counterevidence || 'Not recorded.'))}</p>${proofGaps}<h3>CVSS 3.1</h3><p>${score == null || !vector ? escapeHtml(redactReportText(cvssMarkdown(finding))) : `<strong>${score.toFixed(1)}</strong> - <code>${escapeHtml(vector)}</code>`}</p><h3>Technical evidence</h3><div class="code-evidence-list">${actions || '<p>No code snippet was available for the retained locations.</p>'}</div><div class="cwe-reference"><h3>CWE references</h3>${cweReferencesHtml(finding)}</div></section>`;
}

function observationHtml(observation) {
  const locations = (observation.locations || []).map(location => `<li><code>${escapeHtml(locationText(location))}</code>${location.role ? ` (${escapeHtml(location.role)})` : ''}</li>`).join('');
  return `<article class="observation" id="${escapeHtml(observation.id || '')}"><div class="badges"><span class="observation-badge">OBSERVATION</span><span class="finding-id">${escapeHtml(observation.id || 'ID not recorded')}</span><span class="confidence">CONFIDENCE ${escapeHtml(String(observation.confidence || 'not recorded').toUpperCase())}</span></div><h3>${escapeHtml(redactReportText(observation.title || 'Untitled observation'))}</h3><p><strong>Category:</strong> ${escapeHtml(observation.category || 'not recorded')}</p><p><strong>Why this is not a reportable vulnerability:</strong> ${escapeHtml(redactReportText(observation.rationale || 'Reportability depends on unresolved facts outside the reviewed source.'))}</p><p><strong>Evidence:</strong> ${escapeHtml(redactReportText(observation.evidence || 'Not recorded.'))}</p><p><strong>Reachability and unresolved conditions:</strong> ${escapeHtml(redactReportText(observation.reachability || 'Not recorded.'))}</p><p><strong>Recommendation:</strong> ${escapeHtml(redactReportText(observation.recommendation || 'Validate the unresolved condition and harden the cited control.'))}</p><ul>${locations || '<li>Source location not recorded.</li>'}</ul></article>`;
}

function structuredReportHtml(model) {
  model = {
    observations: [], scope: [], exclusions: [], semanticChecks: [], inventoryCounts: {},
    coverageDispositionCounts: {}, semanticStatusCounts: {}, scanStatus: {}, dynamicValidationCount: 0,
    blockedValidationCount: 0, threatModel: {}, reviewProfile: 'not recorded', contextMode: 'not recorded',
    ...model,
  };
  const findings = SEVERITIES.flatMap(level => model.findings
    .filter(item => severity(item.severity) === level)
    .map(finding => structuredFindingHtml(finding, model, level))).join('');
  const counts = SEVERITIES.map(level => `<div class="count"><strong>${model.counts[level]}</strong>${level.toUpperCase()}</div>`).join('');
  const empty = '<section class="finding"><h2>No reportable findings</h2><p>The sealed review produced no reportable findings.</p></section>';
  const findingRows = model.findings.map(finding => `<tr><td><a href="#${escapeHtml(finding.id || '')}">${escapeHtml(finding.id || '-')}</a></td><td>${severity(finding.severity).toUpperCase()}</td><td>${escapeHtml(redactReportText(finding.title))}</td><td>${escapeHtml(finding.dynamic_validation_result?.status || validationStatus(finding))}</td></tr>`).join('') || '<tr><td>-</td><td>-</td><td>No reportable findings</td><td>-</td></tr>';
  const attackerRows = model.findings.map(finding => `<tr><td>${escapeHtml(finding.id || '-')}</td><td>${escapeHtml(minimumAttackerAccess(finding))}</td><td>${escapeHtml(findingPreconditions(finding))}</td></tr>`).join('');
  const boundaryRows = (model.threatModel.trust_boundaries || []).map(item => `<li><strong>${escapeHtml(item.boundary || 'Boundary')}:</strong> ${escapeHtml((item.assets || []).join(', ') || item.description || 'No assets recorded')}</li>`).join('');
  const entryRows = (model.threatModel.entry_points || []).map(item => `<li><code>${escapeHtml(item.path || 'unknown')}${item.lines ? `:${escapeHtml(item.lines)}` : ''}</code> - ${escapeHtml(item.description || 'No description recorded')}</li>`).join('');
  const checkRows = model.semanticChecks.filter(row => ['TESTED_NEGATIVE', 'NOT_APPLICABLE'].includes(String(row.status || '').toUpperCase())).map(row => `<li><strong>${escapeHtml(row.id || row.check_id || 'unnamed-check')} (${escapeHtml(String(row.status).toUpperCase())}):</strong> ${escapeHtml(redactReportText(row.analysis || row.reason || 'See retained evidence.'))}</li>`).join('');
  const validationRows = model.findings.map(finding => { const row = finding.dynamic_validation_result || {}; return `<tr><td>${escapeHtml(finding.id || '-')}</td><td>${escapeHtml(row.status || row.disposition || validationStatus(finding))}</td><td>${escapeHtml(redactReportText(row.method || row.validation || finding.dynamic_validation || 'Derive an isolated test from the documented attack path'))}</td><td>${escapeHtml(redactReportText(row.blocker || 'None recorded'))}</td></tr>`; }).join('');
  const remediationRows = model.findings.map((finding, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(finding.id || '-')}</td><td>${severity(finding.severity).toUpperCase()}</td><td>${escapeHtml(redactReportText(finding.recommendation || 'Remediate the cited control failure'))}</td><td>Unassigned</td><td>Open</td></tr>`).join('');
  const observations = model.observations.map(observationHtml).join('') || '<p>No observations were retained.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(model.repository)} Security Review</title><style>@page{size:A4;margin:17mm 14mm 18mm;@top-left{content:"GLaDOS Security Review";font:7.5pt -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#708096}@bottom-left{content:"${escapeHtml(model.repository)}";font:7.5pt -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#708096}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:7.5pt -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#708096}}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:#172033;background:#fff;font:9.5pt/1.47 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:#174f82;text-decoration:none}h1{margin:0 0 3mm;font-size:27pt;line-height:1.08;color:#102a4c}h2{margin:2mm 0 3mm;font-size:16pt;line-height:1.2;color:#173d6b}h3{margin:5mm 0 1.5mm;font-size:9pt;text-transform:uppercase;letter-spacing:.055em;color:#53647a}p{margin:0 0 3mm;white-space:pre-wrap}ul{margin:1.5mm 0 4mm;padding-left:5mm}li{margin-bottom:1mm}code{font:7.6pt ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.cover{min-height:245mm;padding:25mm 0 10mm;break-after:page}.cover-rule{width:24mm;height:2mm;margin-bottom:10mm;background:#173d6b}.cover .subtitle{font-size:14pt;color:#4f6179}.meta{margin-top:16mm;padding-top:5mm;border-top:1px solid #cfd8e4;color:#627086;font-size:9pt}.summary-card,.callout{margin:5mm 0;padding:5mm;border:1px solid #d9e1eb;border-radius:2.5mm;background:#f7f9fc}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:5mm 0}.count{padding:3mm;border-radius:2mm;background:#edf2f7;text-align:center}.count strong{display:block;font-size:17pt}.report-section{break-before:page}.finding{break-before:page;border-top:2mm solid #8291a4;padding-top:5mm}.finding.critical{border-top-color:#ad1737}.finding.high{border-top-color:#d65a2e}.finding.medium{border-top-color:#d39b24}.finding.low{border-top-color:#31866f}.finding-header{margin-bottom:5mm}.badges{display:flex;gap:2mm;align-items:center;flex-wrap:wrap}.severity,.observation-badge{font-weight:700}.confidence,.finding-id,.cwe-line,.reference,.cwe-reference{color:#65758a}.two-column{display:grid;grid-template-columns:1fr 1fr;gap:5mm;margin:3mm 0}.code-evidence{break-inside:avoid;margin:0 0 4mm}.code-evidence-list{margin-top:3mm}pre{margin:2mm 0 0;padding:3mm;border:1px solid #d9e1eb;border-radius:2mm;background:#f5f7fa;white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;margin:3mm 0 5mm;font-size:8.6pt}th,td{padding:2mm;border:1px solid #d9e1eb;vertical-align:top;text-align:left}th{background:#edf2f7;color:#263a54}tr{break-inside:avoid}.observation{break-inside:avoid;margin:0 0 5mm;padding:4mm;border:1px solid #d8e0ea;border-left:3px solid #5a7f9e;border-radius:2mm}.validation{display:grid;grid-template-columns:32mm 1fr;gap:1mm 3mm}.validation dt{font-weight:700}.validation dd{margin:0}.integrity{margin-top:8mm;padding-top:3mm;border-top:1px solid #d8e0ea;color:#68758a;font-size:8pt}</style></head><body><section class="cover"><div class="cover-rule"></div><h1>Security Review</h1><p class="subtitle">${escapeHtml(model.repository)}</p><div class="summary-card"><h2>Executive Summary</h2><p>${escapeHtml(model.purpose)}</p><p><strong>${model.findings.length}</strong> reportable findings and <strong>${model.observations.length}</strong> deployment-gated or hardening observations across <strong>${model.filesReviewed}</strong> reviewed files.</p><div class="counts">${counts}</div></div><div class="meta"><strong>Revision</strong><br>${escapeHtml(model.revision)}<br><br><strong>Engagement</strong><br>${escapeHtml(model.engagementId)}<br><br><strong>Review window</strong><br>${escapeHtml(isoDate(model.startedAt))} to ${escapeHtml(isoDate(model.completedAt))}<br><br><strong>Status</strong><br>SATURATED / SEALED</div></section><section class="report-section" id="overview"><h2>Report Overview</h2><h3>Finding overview</h3><table><thead><tr><th>ID</th><th>Severity</th><th>Title</th><th>Validation</th></tr></thead><tbody>${findingRows}</tbody></table><h3>Scope and limitations</h3><p>This was a source-only review of the immutable ${escapeHtml(model.sourceType || 'repository')} revision. Included scope: ${escapeHtml(model.scope.length ? model.scope.join(', ') : 'not explicitly recorded')}. Exclusions: ${escapeHtml(model.exclusions.length ? model.exclusions.join(', ') : 'none recorded')}.</p><p>No live target exploitation, deployed ingress verification, runtime identity/IAM inspection, external service control validation, CI runner inspection, or registry-policy validation was performed. Git history was ${model.gitHistoryAvailable ? 'available' : 'not available'}. Dependency CVE/SBOM analysis was ${model.dependencyAnalysisPerformed ? 'represented by retained inventory' : 'not performed'}.</p><h3>Validation meaning</h3><p>${model.dynamicValidationCount} candidates received dynamic-validation dispositions; ${model.blockedValidationCount} were blocked or deferred. “Source reviewed” confirms a retained code path, not production reachability, attacker access, or successful exploitation.</p><h3>Table of contents</h3><ul><li><a href="#scope">Scope and Threat Model</a></li><li><a href="#prerequisites">Attacker Prerequisites</a></li><li><a href="#coverage">Coverage and Negative Assurance</a></li><li>Detailed Findings</li><li><a href="#observations">Deployment-Gated and Hardening Observations</a></li><li><a href="#validation">Validation and Retest Plan</a></li><li><a href="#remediation">Remediation Plan</a></li><li><a href="#integrity">Integrity and Evidence</a></li></ul></section><section class="report-section" id="scope"><h2>Scope and Threat Model</h2><h3>Trust boundaries</h3><ul>${boundaryRows || '<li>Not recorded.</li>'}</ul><h3>Entry points</h3><ul>${entryRows || '<li>Not recorded.</li>'}</ul><h3>Protected assets</h3><ul>${(model.threatModel.assets || []).map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>Not recorded.</li>'}</ul><h3>Modeled attacker goals</h3><ul>${(model.threatModel.attacker_goals || []).map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>Not recorded.</li>'}</ul></section><section class="report-section" id="prerequisites"><h2>Attacker Prerequisites</h2><p>These are minimum modeled conditions, not claims that an attacker currently possesses the access or that the affected deployment is reachable.</p><table><thead><tr><th>Finding</th><th>Minimum attacker access</th><th>Additional preconditions</th></tr></thead><tbody>${attackerRows || '<tr><td>-</td><td>-</td><td>No reportable findings</td></tr>'}</tbody></table></section><section class="report-section" id="coverage"><h2>Coverage and Negative Assurance</h2><p>Deterministic inventory counts are work-queue counts, not assertions that every candidate represents a real endpoint or weakness.</p><table><tbody><tr><th>Files</th><td>${model.filesReviewed}</td></tr><tr><th>Route candidates</th><td>${model.inventoryCounts.routes || 0}</td></tr><tr><th>HTTP-client candidates</th><td>${model.inventoryCounts.httpClients || 0}</td></tr><tr><th>Cryptographic-operation candidates</th><td>${model.inventoryCounts.cryptoOperations || 0}</td></tr><tr><th>Suppression candidates</th><td>${model.inventoryCounts.suppressions || 0}</td></tr><tr><th>Security-sensitive semantic candidates</th><td>${model.inventoryCounts.securitySensitive || 0}</td></tr></tbody></table><p><strong>File dispositions:</strong> ${escapeHtml(Object.entries(model.coverageDispositionCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'not recorded')}.</p><p><strong>Semantic check dispositions:</strong> ${escapeHtml(Object.entries(model.semanticStatusCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'not recorded')}.</p><h3>Tested-negative and not-applicable checks</h3><ul>${checkRows || '<li>None recorded.</li>'}</ul><h3>Secret scanning</h3><p>HEAD scan: ${model.scanStatus.headCompleted ? 'completed' : 'not completed'} with ${model.scanStatus.headCandidates || 0} redacted candidates. Git-history scan: ${model.scanStatus.historyCompleted ? 'completed' : `unavailable${model.scanStatus.historyReason ? ` - ${escapeHtml(model.scanStatus.historyReason)}` : ''}`}.</p></section>${findings || empty}<section class="report-section" id="observations"><h2>Deployment-Gated and Hardening Observations</h2><p>These concerns are source-confirmed, but reportability depends on unresolved attacker capability, deployment reachability, inherited controls, or impact.</p>${observations}</section><section class="report-section" id="validation"><h2>Validation and Retest Plan</h2><p>Use an isolated environment with representative identities and controlled substitutes for external systems. Do not treat a source-only finding as dynamically reproduced until the retained test method succeeds.</p><table><thead><tr><th>Finding</th><th>Status</th><th>Proposed method</th><th>Blocker</th></tr></thead><tbody>${validationRows || '<tr><td>-</td><td>-</td><td>No reportable findings</td><td>-</td></tr>'}</tbody></table><p>Recalculate CVSS only after deployment reachability, effective identities/privileges, inherited controls, and observed impact are established.</p></section><section class="report-section" id="remediation"><h2>Remediation Plan</h2><p>Priorities are severity-led and should be adjusted for deployment reachability and compensating controls after validation.</p><table><thead><tr><th>Order</th><th>Finding</th><th>Severity</th><th>Remediation outcome</th><th>Owner</th><th>Status</th></tr></thead><tbody>${remediationRows || '<tr><td>-</td><td>-</td><td>-</td><td>No reportable findings</td><td>-</td><td>-</td></tr>'}</tbody></table></section><section class="report-section" id="integrity"><h2>Integrity and Evidence</h2><p>The publication bundle includes the source completion receipt, scan manifest, and a deliverables manifest containing SHA-256 digests for every published file. The source receipt seals evidence artifacts; the deliverables manifest separately protects this rendered publication bundle.</p><p class="integrity">Generated deterministically from sealed GLaDOS security-review artifacts. Terminal state: SATURATED. Publication bundle: deliverables/.</p></section></body></html>`;
}

function completeReportHtml(model) {
  const delta = model.regressionDelta || {};
  const dispositions = Array.isArray(delta.dispositions) ? delta.dispositions : [];
  const attackerProfiles = Array.isArray(model.threatModel?.attacker_profiles) ? model.threatModel.attacker_profiles : [];
  const attackerProfileHtml = `<h3>Modeled attacker profiles</h3><ul>${attackerProfiles.map(profile => `<li><strong>${escapeHtml(profile.id || 'attacker')}:</strong> minimum access: ${escapeHtml(markdownText(profile.minimum_access || 'not recorded'))}; entry points: ${escapeHtml(Array.isArray(profile.entry_points) ? profile.entry_points.join(', ') : markdownText(profile.entry_points || 'not recorded'))}; goals: ${escapeHtml(Array.isArray(profile.goals) ? profile.goals.join(', ') : markdownText(profile.goals || 'not recorded'))}</li>`).join('') || '<li>Not recorded.</li>'}</ul>`;
  const regression = delta.status === 'NOT_REQUESTED_BLIND_MODE'
    ? '<section class="report-section" id="regression"><h2>Historical Regression</h2><p>Not requested: no matching sealed prior review was available or blind mode was explicitly selected.</p></section>'
    : `<section class="report-section" id="regression"><h2>Historical Regression</h2><p><strong>Status:</strong> ${escapeHtml(delta.status || 'not recorded')}<br><strong>Prior engagement:</strong> ${escapeHtml(model.priorContext?.prior_engagement_id || 'not recorded')}<br><strong>Match basis:</strong> ${escapeHtml(model.priorContext?.match_basis || 'not recorded')}</p><table><thead><tr><th>Prior finding</th><th>Disposition</th><th>Current-source evidence</th></tr></thead><tbody>${dispositions.map(row => `<tr><td>${escapeHtml(row.prior_finding_id || '-')}</td><td>${escapeHtml(row.disposition || '-')}</td><td>${escapeHtml(redactReportText(row.evidence || 'Not recorded'))}</td></tr>`).join('') || '<tr><td>-</td><td>-</td><td>No prior-finding dispositions retained</td></tr>'}</tbody></table></section>`;
  return structuredReportHtml(model)
    .replace('</section><section class="report-section" id="prerequisites">', `${attackerProfileHtml}</section><section class="report-section" id="prerequisites">`)
    .replace('<section class="report-section" id="validation">', `${regression}<section class="report-section" id="validation">`)
    .replace('These concerns are source-confirmed, but reportability depends on unresolved attacker capability, deployment reachability, inherited controls, or impact.', 'These hardening, operational, or unresolved concerns do not establish every required vulnerability element: a source security-control failure, a plausible attacker, and security impact.')
    .replaceAll('deployment-gated or hardening observations', 'observations or hardening notes')
    .replaceAll('Deployment-Gated and Hardening Observations', 'Observations and Hardening Notes')
    .replace('<li><a href="#coverage">Coverage and Negative Assurance</a></li>', '<li><a href="#coverage">Coverage and Negative Assurance</a></li><li><a href="#regression">Historical Regression</a></li>');
}

function loadReportModel(artifactRoot) {
  const run = readJson(path.join(artifactRoot, 'run.json'));
  const threatModel = readJson(path.join(artifactRoot, 'context', 'threat-model.json'));
  const findingsDocument = readJson(path.join(artifactRoot, 'findings.json'));
  const coverageDocument = readJson(path.join(artifactRoot, 'coverage.json'));
  const receipt = readJson(path.join(artifactRoot, 'completion-receipt.json'));
  if (!run || !threatModel || !findingsDocument || !coverageDocument || !receipt) {
    throw new Error('security-review report inputs are incomplete');
  }
  const observationsFile = path.join(artifactRoot, 'observations.json');
  const observationsDocument = readJson(observationsFile, { observations: [] });
  const candidateFile = path.join(artifactRoot, 'discovery', 'candidates.jsonl');
  const candidates = new Map(readJsonLines(candidateFile).map(row => [row.candidate_id, row]));
  const closureFile = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
  const closureByFinding = new Map();
  for (const row of readJsonLines(closureFile)) {
    for (const findingId of row.finding_ids || []) closureByFinding.set(findingId, row);
  }
  findingsDocument.findings = (findingsDocument.findings || []).map(finding => {
    const candidate = candidates.get(finding.candidate_id || finding.canonical_candidate_id || finding.id) || {};
    const closure = closureByFinding.get(finding.id || finding.finding_id) || {};
    return {
      ...candidate,
      ...finding,
      counterevidence: finding.counterevidence || candidate.counterevidence || closure.counterevidence,
      proof_gaps: Array.isArray(finding.proof_gaps) && finding.proof_gaps.length
        ? finding.proof_gaps
        : Array.isArray(candidate.proof_gaps) && candidate.proof_gaps.length
          ? candidate.proof_gaps
          : closure.proof_gaps,
      minimum_attacker_access: finding.minimum_attacker_access || closure.minimum_attacker_access,
      preconditions: Array.isArray(finding.preconditions) && finding.preconditions.length
        ? finding.preconditions
        : closure.preconditions,
    };
  });
  const dynamicFile = path.join(artifactRoot, 'dynamic-validation', 'matrix.jsonl');
  const dynamicValidation = fs.existsSync(dynamicFile)
    ? readJsonLines(dynamicFile) : [];
  if (receipt.status !== 'SEALED' || receipt.terminal_state !== 'SATURATED') throw new Error('security review is not sealed and saturated');
  const scopeDocument = readJson(path.join(artifactRoot, 'intake', 'scope.json'), {});
  const semanticCoverage = readJson(path.join(artifactRoot, 'validation', 'semantic-coverage.json'), {});
  const finalSummary = readJson(path.join(artifactRoot, 'context', 'final-summary.json'), {});
  const regressionDelta = readJson(path.join(artifactRoot, 'regression', 'delta.json'), {});
  const priorContext = readJson(path.join(artifactRoot, 'regression', 'prior-context.json'), {});
  const secretsHead = readJson(path.join(artifactRoot, 'inventory', 'secrets-head.json'), {});
  const secretsHistory = readJson(path.join(artifactRoot, 'inventory', 'secrets-history.json'), {});
  const inventoryCounts = {
    routes: readJsonLines(path.join(artifactRoot, 'inventory', 'routes.jsonl')).length,
    httpClients: readJsonLines(path.join(artifactRoot, 'inventory', 'http-clients.jsonl')).length,
    cryptoOperations: readJsonLines(path.join(artifactRoot, 'inventory', 'crypto-operations.jsonl')).length,
    suppressions: readJsonLines(path.join(artifactRoot, 'inventory', 'suppressions.jsonl')).length,
    securitySensitive: readJsonLines(path.join(artifactRoot, 'inventory', 'security-sensitive.jsonl')).length,
    dependencies: [
      'inventory/dependencies.jsonl', 'inventory/sbom.json', 'validation/dependencies.json',
    ].filter(relative => fs.existsSync(path.join(artifactRoot, relative))).length,
  };
  const scanStatus = {
    headCompleted: secretsHead.completed === true,
    headCandidates: Array.isArray(secretsHead.findings) ? secretsHead.findings.length : 0,
    historyCompleted: secretsHistory.completed === true,
    historyReason: secretsHistory.reason || null,
  };
  return buildReportModel({
    run, threatModel, findingsDocument, observationsDocument, coverageDocument, receipt,
    dynamicValidation, scopeDocument, semanticCoverage, inventoryCounts, scanStatus, finalSummary,
    regressionDelta, priorContext,
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function publishedFiles(deliveryRoot, relative = '') {
  const directory = path.join(deliveryRoot, relative);
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return publishedFiles(deliveryRoot, child);
    if (!entry.isFile() || child === 'DELIVERABLES-MANIFEST.json') return [];
    return [child];
  }).sort();
}

function writeDeliverablesManifest(deliveryRoot, { receipt = null, completedAt = null } = {}) {
  const sourceReceipt = receipt
    || readJson(path.join(deliveryRoot, 'completion-receipt.json'))
    || readJson(path.join(path.dirname(deliveryRoot), 'completion-receipt.json'));
  if (!sourceReceipt) throw new Error('completion receipt is required for deliverables manifest');
  const files = Object.fromEntries(publishedFiles(deliveryRoot).map(relative => [relative, sha256File(path.join(deliveryRoot, relative))]));
  const sourceReceiptFile = fs.existsSync(path.join(deliveryRoot, 'completion-receipt.json'))
    ? path.join(deliveryRoot, 'completion-receipt.json')
    : path.join(path.dirname(deliveryRoot), 'completion-receipt.json');
  const manifest = {
    schema_version: 1,
    engagement_id: sourceReceipt.engagement_id,
    repository_head: sourceReceipt.repository_head,
    source_receipt_sha256: sha256File(sourceReceiptFile),
    generated_at: completedAt || null,
    files,
  };
  fs.writeFileSync(path.join(deliveryRoot, 'DELIVERABLES-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function packageReadme(model) {
  return [
    `# ${model.repository} Security Review Deliverables`,
    '',
    'This directory is the authoritative publication bundle generated from the sealed source-review evidence.',
    '',
    '## Start Here',
    '',
    '- `security-review-report.pdf` - complete client-facing report when desktop PDF rendering is available.',
    '- `security-review-report.html` - self-contained complete report.',
    '- `EXECUTIVE-SUMMARY.md` - concise decision-maker summary.',
    '- `SECURITY-REVIEW.md` - complete Markdown report.',
    '- `OBSERVATIONS.md` - observations and hardening notes.',
    '- `HISTORICAL-REGRESSION.md` - exact dispositions for a matched sealed prior review, or the recorded blind-mode status.',
    '- `COVERAGE-AND-LIMITATIONS.md` - scope, threat model, negative assurance, and validation boundaries.',
    '- `REMEDIATION-PLAN.md` - prioritized remediation tracker.',
    '- `findings/` and `observations/` - individual issue records.',
    '',
    '## Integrity',
    '',
    '- `completion-receipt.json` and `scan-manifest.json` verify the retained source-review evidence.',
    '- `DELIVERABLES-MANIFEST.json` contains SHA-256 digests for every file in this publication bundle.',
    '- A source-reviewed finding confirms a code path. It does not, by itself, prove deployment reachability, attacker access, or successful exploitation.',
    '',
  ].join('\n');
}

function generateSecurityReviewDeliverables(artifactRoot, { includePdf = false } = {}) {
  const model = loadReportModel(artifactRoot);
  const deliveryRoot = path.join(artifactRoot, 'deliverables');
  fs.mkdirSync(deliveryRoot, { recursive: true, mode: 0o700 });
  for (const directory of ['findings', 'observations']) {
    fs.rmSync(path.join(deliveryRoot, directory), { recursive: true, force: true });
  }
  for (const name of DELIVERY_FILES) {
    try { fs.unlinkSync(path.join(deliveryRoot, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const reports = {
    'README.md': `${packageReadme(model)}\n`,
    'EXECUTIVE-SUMMARY.md': `${executiveSummaryMarkdown(model)}\n`,
    'SECURITY-REVIEW.md': `${combinedReportMarkdown(model)}\n`,
    'OBSERVATIONS.md': `${observationsMarkdown(model)}\n`,
    'HISTORICAL-REGRESSION.md': `${historicalRegressionMarkdown(model)}\n`,
    'COVERAGE-AND-LIMITATIONS.md': `${[`# ${model.repository} Coverage and Limitations`, '', scopeAndThreatModelMarkdown(model), attackerPrerequisitesMarkdown(model), coverageMarkdown(model), retestMarkdown(model)].join('\n')}\n`,
    'REMEDIATION-PLAN.md': `${remediationMarkdown(model)}\n`,
    'security-review-report.html': completeReportHtml(model),
  };
  for (const [name, content] of Object.entries(reports)) {
    fs.writeFileSync(path.join(deliveryRoot, name), content, { mode: 0o600 });
  }
  for (const level of SEVERITIES) {
    const severityDirectory = `${level[0].toUpperCase()}${level.slice(1)}`;
    fs.mkdirSync(path.join(deliveryRoot, 'findings', severityDirectory), { recursive: true, mode: 0o700 });
  }
  for (const finding of model.findings) {
    const severityDirectory = `${severity(finding.severity)[0].toUpperCase()}${severity(finding.severity).slice(1)}`;
    const markdown = `${findingMarkdown(finding, model.repositoryPath)}\n`;
    const directory = path.join(deliveryRoot, 'findings', severityDirectory);
    fs.writeFileSync(path.join(directory, findingFilename(finding)), markdown, { mode: 0o600 });
  }
  fs.mkdirSync(path.join(deliveryRoot, 'observations'), { recursive: true, mode: 0o700 });
  for (const observation of model.observations) {
    fs.writeFileSync(path.join(deliveryRoot, 'observations', observationFilename(observation)), `${observationMarkdown(observation)}\n`, { mode: 0o600 });
  }
  for (const name of ['completion-receipt.json', 'scan-manifest.json']) {
    fs.copyFileSync(path.join(artifactRoot, name), path.join(deliveryRoot, name));
    fs.chmodSync(path.join(deliveryRoot, name), 0o600);
  }
  const htmlPath = path.join(deliveryRoot, 'security-review-report.html');
  let pdfPath = null;
  if (includePdf) {
    pdfPath = path.join(deliveryRoot, 'security-review-report.pdf');
    generatePdf(htmlPath, pdfPath);
  }
  const manifest = writeDeliverablesManifest(deliveryRoot, { receipt: readJson(path.join(artifactRoot, 'completion-receipt.json')), completedAt: model.completedAt });
  for (const name of ['EXECUTIVE-SUMMARY.md', 'SECURITY-REVIEW.md', 'security-review-report.html', 'security-review-report.pdf']) {
    try { fs.unlinkSync(path.join(artifactRoot, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.rmSync(path.join(artifactRoot, 'findings'), { recursive: true, force: true });
  return { model, deliveryRoot, htmlPath, pdfPath, manifest };
}

module.exports = {
  SEVERITIES,
  buildReportModel,
  cvss31Score,
  combinedReportMarkdown,
  executiveSummaryMarkdown,
  findingFilename,
  findingMarkdown,
  generatePdf,
  generateSecurityReviewDeliverables,
  loadReportModel,
  observationFilename,
  observationMarkdown,
  observationsMarkdown,
  pdfCapabilityAvailable,
  reportHtml: completeReportHtml,
  writeDeliverablesManifest,
};
