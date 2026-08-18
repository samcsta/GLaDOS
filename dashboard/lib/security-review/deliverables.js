const fs = require('node:fs');
const path = require('node:path');

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CWE_NAMES = Object.freeze({
  'CWE-639': 'Authorization Bypass Through User-Controlled Key',
  'CWE-703': 'Improper Check or Handling of Exceptional Conditions',
  'CWE-862': 'Missing Authorization',
  'CWE-918': 'Server-Side Request Forgery (SSRF)',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownText(value) {
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
  return `${safeSlug(cwe, 'CWE-Unknown')}-${safeSlug(finding.title)}.md`;
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

function cvssScore(finding) {
  const recorded = Number(finding.cvss_score ?? finding.cvss?.score);
  return Number.isFinite(recorded) ? recorded : cvss31Score(finding.cvss_vector || finding.cvss?.vector);
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
  const redacted = lines.slice(start - 1, end).map((line, index) => {
    let safe = line.replace(/((?:password|passwd|secret|api[_-]?key)\s*[:=]\s*)(["'])[^"']*\2/ig, '$1[REDACTED]');
    safe = safe.replace(/((?:password|passwd|secret|api[_-]?key)\s*:\s*)(?!\$|\{|[A-Za-z_][\w.]*\()[^\s,#]+/ig, '$1[REDACTED]');
    return `${String(start + index).padStart(5)} | ${safe}`;
  }).join('\n');
  return { start, end, code: redacted, language: path.extname(location.path).slice(1) || 'text' };
}

function actionMarkdown(finding, repositoryPath) {
  const locations = Array.isArray(finding.locations) ? finding.locations : [];
  const sections = [
    `Red Team AI agents analyzed the code paths below and identified ${cweLabel(primaryCwe(finding))} because ${sentence(finding.description || finding.source_to_sink_evidence || 'the cited security control is incomplete')}`,
    `The weakness can be exercised through ${sentence(finding.reachability || finding.cvss_preconditions || 'the documented execution path')} By exploiting or triggering the code in this way, an attacker or adverse runtime condition can produce the outcome described in the security impact section.`,
  ];
  for (const location of locations) {
    sections.push(`**Evidence location:** \`${locationText(location)}\`${location.role ? ` (${location.role})` : ''}`);
    const snippet = snippetForLocation(repositoryPath, location);
    if (snippet) sections.push(`\n\`\`\`${snippet.language}\n${snippet.code}\n\`\`\``);
  }
  return sections.join('\n\n');
}

function validationStatus(finding) {
  return String(finding.status || finding.validation_status || 'SOURCE_REVIEWED').replaceAll('_', ' ');
}

function limitationsMarkdown(finding) {
  const counterevidence = markdownText(finding.counterevidence || 'No additional counterevidence was recorded.');
  const gaps = Array.isArray(finding.proof_gaps) && finding.proof_gaps.length
    ? finding.proof_gaps.map(item => `- ${markdownText(item)}`).join('\n')
    : '- No additional proof gaps were recorded.';
  return `**Counterevidence.** ${counterevidence}\n\n**Proof gaps.**\n\n${gaps}`;
}

function cvssMarkdown(finding) {
  const score = cvssScore(finding);
  const vector = markdownText(finding.cvss_vector || finding.cvss?.vector || '');
  if (score != null && vector) return `${score.toFixed(1)} - \`${vector}\``;
  return `**Not assigned.** This source-only review did not establish every required CVSS 3.1 base metric without relying on unverified deployment or external-control assumptions. Preconditions that must be resolved before scoring: ${markdownText(finding.cvss_preconditions || finding.reachability || 'runtime reachability and security impact were not validated')}`;
}

function resultMarkdown(finding) {
  const highLevel = markdownText(finding.impact || finding.cvss_preconditions || finding.reachability || 'The vulnerable path can violate the affected security property.');
  const detail = [
    markdownText(finding.description || finding.source_to_sink_evidence || ''),
    finding.reachability ? `The affected path is ${sentence(finding.reachability)}` : null,
    finding.validation_correction ? markdownText(finding.validation_correction) : null,
    finding.counterevidence ? `Limiting conditions: ${markdownText(finding.counterevidence)}` : null,
    finding.validation_status ? `Validation status: ${finding.validation_status}.` : null,
    finding.confidence ? `Confidence: ${finding.confidence}.` : null,
  ].filter(Boolean).join(' ');
  return `**High-level impact.** ${highLevel}\n\n**Technical result.** ${detail || highLevel}`;
}

function findingMarkdown(finding, repositoryPath = null) {
  return [
    `#${cweLabel(primaryCwe(finding))}#`,
    '',
    `**Finding:** ${markdownText(finding.title)}`,
    '',
    '#Description#',
    '',
    markdownText(finding.description || finding.source_to_sink_evidence || 'Not recorded.'),
    '',
    '#Recommendation#',
    '',
    markdownText(finding.remediation || finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.'),
    '',
    '#Action#',
    '',
    actionMarkdown(finding, repositoryPath),
    '',
    '#Result#',
    '',
    resultMarkdown(finding),
    '',
    '#Validation Status#',
    '',
    `${validationStatus(finding)}. Confidence: ${finding.confidence || 'not recorded'}.`,
    '',
    '#Assumptions and Limitations#',
    '',
    limitationsMarkdown(finding),
    '',
    '#CVSS 3.1 Score#',
    '',
    cvssMarkdown(finding),
    '',
    '#CWE References#',
    '',
    cweReferencesMarkdown(finding),
    '',
  ].join('\n');
}

function buildReportModel({ run, threatModel, findingsDocument, observationsDocument = {}, coverageDocument, receipt, dynamicValidation = [] }) {
  const findings = [...(findingsDocument.findings || [])].filter(item => SEVERITIES.includes(String(item.severity || '').toLowerCase())).sort((left, right) => {
    const severityDelta = SEVERITIES.indexOf(severity(left.severity)) - SEVERITIES.indexOf(severity(right.severity));
    return severityDelta || String(left.id || '').localeCompare(String(right.id || ''));
  });
  const counts = Object.fromEntries(SEVERITIES.map(level => [level, findings.filter(item => severity(item.severity) === level).length]));
  return {
    engagementId: findingsDocument.engagement_id || receipt.engagement_id,
    repository: path.basename(run.repositoryPath || 'repository'),
    revision: run.head || receipt.repository_head,
    purpose: repositorySummary(threatModel, run),
    findings,
    observations: observationsDocument.observations || [],
    counts,
    filesReviewed: Array.isArray(coverageDocument.files) ? coverageDocument.files.length : Number(run.fileCount || 0),
    completedAt: run.deepScan?.completedAt || receipt.completed_at || null,
    repositoryPath: run.repositoryPath || null,
    sourceType: run.sourceType || null,
    gitHistoryAvailable: run.gitHistoryAvailable === true,
    dynamicValidationCount: dynamicValidation.length,
    blockedValidationCount: dynamicValidation.filter(row => /BLOCKED|DEFERRED/i.test(String(row.disposition || row.status || ''))).length,
  };
}

function executiveSummaryMarkdown(model) {
  const highest = SEVERITIES.find(level => model.counts[level] > 0) || 'none';
  return [
    `# ${model.repository} Security Review`,
    '',
    '## Executive Summary',
    '',
    model.purpose,
    '',
    `The review completed with **${model.findings.length} reportable finding${model.findings.length === 1 ? '' : 's'}** across **${model.filesReviewed} reviewed files**. The highest recorded severity is **${highest.toUpperCase()}**.`,
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
    '',
    '## Scope and Limitations',
    '',
    `This was a source-only review of the immutable ${model.sourceType || 'repository'} revision. No production traffic, cloud/IAM inspection, broker testing, CI runner inspection, registry validation, or external dependency implementation was available. Git history was ${model.gitHistoryAvailable ? 'available' : 'not available'}.`,
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
    `${model.dynamicValidationCount} candidate${model.dynamicValidationCount === 1 ? '' : 's'} received dynamic-validation dispositions; ${model.blockedValidationCount} were blocked or deferred by the source-only boundary. “Source validated” confirms the code path, not production exploitability.`,
    '',
    '## Remediation Priorities',
    '',
    '1. Address externally reachable input-to-sink paths and authorization boundaries first.',
    '2. Correct integrity and availability defects with confirmed reportable execution paths.',
    '3. Retest remediated findings against representative identities and deployment controls.',
    '',
    '## Retest Guidance',
    '',
    'Retest against an isolated deployment with representative identities, egress controls, a Pub/Sub emulator or test project, and external FFM authorization behavior. Recalculate CVSS only after those controls and impacts are observed.',
    '',
  ].join('\n');
}

function combinedReportMarkdown(model) {
  const sections = [executiveSummaryMarkdown(model)];
  for (const level of SEVERITIES) {
    const rows = model.findings.filter(item => severity(item.severity) === level);
    if (!rows.length) continue;
    sections.push(`\n## ${level[0].toUpperCase()}${level.slice(1)} Findings\n`);
    for (const finding of rows) {
      sections.push([
        `### ${cweLabel(primaryCwe(finding))}`,
        '',
        `**Finding:** ${markdownText(finding.title)}`,
        '',
        markdownText(finding.description || finding.source_to_sink_evidence || 'Not recorded.'),
        '',
        '#### Recommendation',
        '',
        markdownText(finding.remediation || finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.'),
        '',
        '#### Red Team AI Analysis',
        '',
        actionMarkdown(finding, model.repositoryPath),
        '',
        '#### Security Impact',
        '',
        resultMarkdown(finding),
        '',
        '#### Validation Status',
        '',
        `${validationStatus(finding)}. Confidence: ${finding.confidence || 'not recorded'}.`,
        '',
        '#### Assumptions and Limitations',
        '',
        limitationsMarkdown(finding),
        '',
        '#### CVSS 3.1',
        '',
        cvssMarkdown(finding),
        '',
        '#### CWE References',
        '',
        cweReferencesMarkdown(finding),
        '',
      ].join('\n'));
    }
  }
  return sections.join('\n');
}

function reportHtml(model) {
  const findingSections = SEVERITIES.flatMap(level => model.findings.filter(item => severity(item.severity) === level).map(finding => {
    const locations = (finding.locations || []).map(item => `<li><code>${escapeHtml(locationText(item))}</code>${item.role ? ` <span>${escapeHtml(item.role)}</span>` : ''}</li>`).join('');
    const cwes = Array.isArray(finding.cwe_ids) && finding.cwe_ids.length ? finding.cwe_ids.join(', ') : 'CWE not recorded';
    return `<section class="finding ${level}"><header><div><span class="severity">${level.toUpperCase()}</span><span class="confidence">${escapeHtml(finding.confidence || 'confidence not recorded')}</span></div><h2>${escapeHtml(cwes)}: ${escapeHtml(finding.title)}</h2></header><p>${escapeHtml(finding.description || finding.source_to_sink_evidence || 'Not recorded.')}</p><h3>Vulnerable locations</h3><ul>${locations || '<li>Not recorded</li>'}</ul><h3>Impact</h3><p>${escapeHtml(finding.impact || finding.cvss_preconditions || finding.reachability || 'Not recorded.')}</p><h3>Recommendation</h3><p>${escapeHtml(finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.')}</p></section>`;
  })).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(model.repository)} Security Review</title><style>@page{size:A4;margin:15mm 14mm 16mm}*{box-sizing:border-box}body{margin:0;color:#172033;background:#fff;font:10pt/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header.cover{padding:15mm 0 10mm;border-bottom:3px solid #173d6b}h1{margin:0 0 3mm;font-size:26pt;color:#102a4c}h2{margin:2mm 0 3mm;font-size:15pt;color:#173d6b}h3{margin:4mm 0 1mm;font-size:9pt;text-transform:uppercase;letter-spacing:.05em;color:#53647a}p{margin:0 0 3mm;white-space:pre-wrap}.meta{color:#627086;font-size:8.5pt}.summary{margin:7mm 0;padding:6mm;border:1px solid #d9e1eb;border-radius:3mm;background:#f7f9fc}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin-top:5mm}.count{padding:3mm;border-radius:2mm;background:#edf2f7;text-align:center}.count strong{display:block;font-size:17pt}.finding{break-inside:avoid;margin:0 0 7mm;padding:5mm;border:1px solid #d8e0ea;border-left:4px solid #8291a4;border-radius:2mm}.finding.critical{border-left-color:#ad1737}.finding.high{border-left-color:#d65a2e}.finding.medium{border-left-color:#d39b24}.finding.low{border-left-color:#31866f}.finding header>div{display:flex;gap:3mm}.severity{font-weight:700}.confidence{color:#65758a}ul{margin:1mm 0 3mm;padding-left:5mm}code{font:8.5pt ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.integrity{margin-top:8mm;padding-top:3mm;border-top:1px solid #d8e0ea;color:#68758a;font-size:8pt}</style></head><body><header class="cover"><h1>Security Review</h1><h2>${escapeHtml(model.repository)}</h2><div class="meta">Revision ${escapeHtml(model.revision)}<br>Engagement ${escapeHtml(model.engagementId)}</div></header><section class="summary"><h2>Executive Summary</h2><p>${escapeHtml(model.purpose)}</p><p>${model.findings.length} reportable finding${model.findings.length === 1 ? '' : 's'} across ${model.filesReviewed} reviewed files.</p><div class="counts">${SEVERITIES.map(level => `<div class="count"><strong>${model.counts[level]}</strong>${level[0].toUpperCase()}${level.slice(1)}</div>`).join('')}</div></section>${findingSections}<div class="integrity">Generated deterministically from the sealed GLaDOS security-review artifacts. Status: SATURATED / SEALED.</div></body></html>`;
}

function structuredFindingHtml(finding, model, level) {
  const actions = (finding.locations || []).map(location => {
    const snippet = snippetForLocation(model.repositoryPath, location);
    const code = snippet ? `<pre><code>${escapeHtml(snippet.code)}</code></pre>` : '<p>Code snippet unavailable.</p>';
    return `<div class="code-evidence"><div class="reference">Evidence location: <code>${escapeHtml(locationText(location))}</code>${location.role ? ` <span>(${escapeHtml(location.role)})</span>` : ''}</div>${code}</div>`;
  }).join('');
  const score = cvssScore(finding);
  const vector = finding.cvss_vector || finding.cvss?.vector || 'Not recorded';
  const highLevel = finding.impact || finding.cvss_preconditions || finding.reachability || 'The vulnerable path can violate the affected security property.';
  const detail = [
    finding.description || finding.source_to_sink_evidence || null,
    finding.reachability ? `The affected path is ${sentence(finding.reachability)}` : null,
    finding.validation_correction || null,
    finding.counterevidence ? `Limiting conditions: ${finding.counterevidence}` : null,
    finding.validation_status ? `Validation status: ${finding.validation_status}.` : null,
    finding.confidence ? `Confidence: ${finding.confidence}.` : null,
  ].filter(Boolean).join(' ');
  const analysis = `Red Team AI agents analyzed the code paths below and identified ${cweLabel(primaryCwe(finding))} because ${sentence(finding.description || finding.source_to_sink_evidence || 'the cited security control is incomplete')} The weakness can be exercised through ${sentence(finding.reachability || finding.cvss_preconditions || 'the documented execution path')} By exploiting or triggering the code in this way, an attacker or adverse runtime condition can produce the security impact described below.`;
  return `<section class="finding ${level}"><header><div><span class="severity">${level.toUpperCase()}</span><span class="confidence">${escapeHtml(finding.confidence || 'confidence not recorded')}</span></div><h2>${escapeHtml(cweLabel(primaryCwe(finding)))}</h2><p class="finding-title"><strong>Finding:</strong> ${escapeHtml(finding.title)}</p></header><p class="finding-summary">${escapeHtml(finding.description || finding.source_to_sink_evidence || 'Not recorded.')}</p><h3>Recommendation</h3><p>${escapeHtml(finding.remediation || finding.recommendation || 'Remediate the cited control failure and verify the fix in an isolated environment.')}</p><h3>Red Team AI Analysis</h3><p>${escapeHtml(analysis)}</p><div class="code-evidence-list">${actions || '<p>No code snippet was available for this location.</p>'}</div><h3>Security Impact</h3><p><strong>High-level impact.</strong> ${escapeHtml(highLevel)}</p><p><strong>Technical result.</strong> ${escapeHtml(detail || highLevel)}</p><h3>Validation Status</h3><p>${escapeHtml(validationStatus(finding))}. Confidence: ${escapeHtml(finding.confidence || 'not recorded')}.</p><h3>Assumptions and Limitations</h3><p>${escapeHtml(finding.counterevidence || 'No additional counterevidence was recorded.')}</p><p>${escapeHtml((finding.proof_gaps || []).join(' '))}</p><h3>CVSS 3.1</h3><p>${score == null ? escapeHtml(cvssMarkdown(finding)) : `${score.toFixed(1)} - <code>${escapeHtml(vector)}</code>`}</p><div class="cwe-reference"><h3>CWE References</h3>${cweReferencesHtml(finding)}</div></section>`;
}

function structuredReportHtml(model) {
  const findings = SEVERITIES.flatMap(level => model.findings
    .filter(item => severity(item.severity) === level)
    .map(finding => structuredFindingHtml(finding, model, level))).join('');
  const counts = SEVERITIES.map(level => `<div class="count"><strong>${model.counts[level]}</strong>${level.toUpperCase()}</div>`).join('');
  const empty = '<section class="finding"><h2>No reportable findings</h2><p>The sealed review produced no reportable findings.</p></section>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(model.repository)} Security Review</title><style>@page{size:A4;margin:15mm 14mm 16mm}*{box-sizing:border-box}body{margin:0;color:#172033;background:#fff;font:10pt/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header.cover{padding:15mm 0 10mm;border-bottom:3px solid #173d6b}h1{margin:0 0 3mm;font-size:26pt;color:#102a4c}h2{margin:2mm 0 3mm;font-size:15pt;color:#173d6b}h3{margin:5mm 0 1.5mm;font-size:9pt;text-transform:uppercase;letter-spacing:.05em;color:#53647a}p{margin:0 0 3mm;white-space:pre-wrap}.meta{color:#627086;font-size:8.5pt}.summary{margin:7mm 0;padding:6mm;border:1px solid #d9e1eb;border-radius:3mm;background:#f7f9fc}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin-top:5mm}.count{padding:3mm;border-radius:2mm;background:#edf2f7;text-align:center}.count strong{display:block;font-size:17pt}.finding{break-before:page;margin:0 0 7mm;padding:5mm;border:1px solid #d8e0ea;border-left:4px solid #8291a4;border-radius:2mm}.finding.critical{border-left-color:#ad1737}.finding.high{border-left-color:#d65a2e}.finding.medium{border-left-color:#d39b24}.finding.low{border-left-color:#31866f}.finding header>div{display:flex;gap:3mm}.severity{font-weight:700}.confidence,.reference,.cwe-reference{color:#65758a}.finding-summary{margin-top:4mm}.code-evidence{break-inside:avoid;margin:0 0 4mm}.code-evidence-list{margin-top:3mm}pre{margin:2mm 0 0;padding:3mm;border:1px solid #d9e1eb;border-radius:2mm;background:#f5f7fa;white-space:pre-wrap;overflow-wrap:anywhere}code{font:8pt ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.integrity{margin-top:8mm;padding-top:3mm;border-top:1px solid #d8e0ea;color:#68758a;font-size:8pt}</style></head><body><header class="cover"><h1>Security Review</h1><h2>${escapeHtml(model.repository)}</h2><div class="meta">Revision ${escapeHtml(model.revision)}<br>Engagement ${escapeHtml(model.engagementId)}</div></header><section class="summary"><h2>Executive Summary</h2><p>${escapeHtml(model.purpose)}</p><p>${model.findings.length} reportable finding${model.findings.length === 1 ? '' : 's'} across ${model.filesReviewed} reviewed files.</p><div class="counts">${counts}</div></section>${findings || empty}<footer class="integrity">Generated from sealed GLaDOS security-review artifacts. Terminal state: SATURATED.</footer></body></html>`;
}

function loadReportModel(artifactRoot) {
  const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
  const threatModel = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'context', 'threat-model.json'), 'utf8'));
  const findingsDocument = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'findings.json'), 'utf8'));
  const coverageDocument = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'coverage.json'), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'completion-receipt.json'), 'utf8'));
  const observationsFile = path.join(artifactRoot, 'observations.json');
  const observationsDocument = fs.existsSync(observationsFile) ? JSON.parse(fs.readFileSync(observationsFile, 'utf8')) : { observations: [] };
  const candidateFile = path.join(artifactRoot, 'discovery', 'candidates.jsonl');
  const candidates = new Map(fs.readFileSync(candidateFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(row => [row.candidate_id, row]));
  findingsDocument.findings = (findingsDocument.findings || []).map(finding => ({
    ...candidates.get(finding.canonical_candidate_id || finding.id),
    ...finding,
  }));
  const dynamicFile = path.join(artifactRoot, 'dynamic-validation', 'matrix.jsonl');
  const dynamicValidation = fs.existsSync(dynamicFile)
    ? fs.readFileSync(dynamicFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  if (receipt.status !== 'SEALED' || receipt.terminal_state !== 'SATURATED') throw new Error('security review is not sealed and saturated');
  return buildReportModel({ run, threatModel, findingsDocument, observationsDocument, coverageDocument, receipt, dynamicValidation });
}

function generateSecurityReviewDeliverables(artifactRoot) {
  const model = loadReportModel(artifactRoot);
  const deliveryRoot = path.join(artifactRoot, 'deliverables');
  fs.mkdirSync(deliveryRoot, { recursive: true, mode: 0o700 });
  const reports = {
    'EXECUTIVE-SUMMARY.md': `${executiveSummaryMarkdown(model)}\n`,
    'SECURITY-REVIEW.md': `${combinedReportMarkdown(model)}\n`,
    'security-review-report.html': structuredReportHtml(model),
  };
  for (const [name, content] of Object.entries(reports)) {
    fs.writeFileSync(path.join(deliveryRoot, name), content, { mode: 0o600 });
    fs.writeFileSync(path.join(artifactRoot, name), content, { mode: 0o600 });
  }
  for (const root of [deliveryRoot, artifactRoot]) {
    fs.rmSync(path.join(root, 'findings'), { recursive: true, force: true });
    for (const level of SEVERITIES) {
      const severityDirectory = `${level[0].toUpperCase()}${level.slice(1)}`;
      fs.mkdirSync(path.join(root, 'findings', severityDirectory), { recursive: true, mode: 0o700 });
    }
  }
  for (const finding of model.findings) {
    const severityDirectory = `${severity(finding.severity)[0].toUpperCase()}${severity(finding.severity).slice(1)}`;
    const markdown = `${findingMarkdown(finding, model.repositoryPath)}\n`;
    for (const root of [deliveryRoot, artifactRoot]) {
      const directory = path.join(root, 'findings', severityDirectory);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, findingFilename(finding)), markdown, { mode: 0o600 });
    }
  }
  return { model, deliveryRoot, htmlPath: path.join(deliveryRoot, 'security-review-report.html') };
}

module.exports = {
  SEVERITIES,
  buildReportModel,
  cvss31Score,
  combinedReportMarkdown,
  executiveSummaryMarkdown,
  findingFilename,
  findingMarkdown,
  generateSecurityReviewDeliverables,
  loadReportModel,
  reportHtml: structuredReportHtml,
};
