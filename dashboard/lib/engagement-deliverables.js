const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');
const { Marked, Renderer } = require('marked');
const { BLACKBOARD_DB, GLADOS_INVESTIGATIONS_DIR } = require('./config');
const { generatePdf } = require('./security-review/deliverables');

const OUTPUT_NAMES = new Set([
  'ENGAGEMENT-REPORT.html',
  'ENGAGEMENT-REPORT.pdf',
  'DELIVERABLES-MANIFEST.json',
]);

const REPORT_STYLE = 'red-team-report-standard-v2';
const SEVERITY_ORDER = new Map([
  ['critical', 0],
  ['high', 1],
  ['medium', 2],
  ['low', 3],
  ['informational', 4],
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function redactReportText(value) {
  let text = String(value ?? '');
  text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/ig, '$1[REDACTED]');
  text = text.replace(/((?:password|passwd|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|private[_-]?key|credential)\s*[:=]\s*)(["'])[^"']*\2/ig, '$1[REDACTED]');
  text = text.replace(/(\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@/]+:)[^\s@/]+@/ig, '$1[REDACTED]@');
  return text;
}

function validEngagementId(value) {
  const id = String(value || '').trim();
  if (!id || id === '.' || id === '..' || id.length > 180 || /[\\/\0\r\n]/.test(id)) {
    throw new Error('engagement id must be a single safe path component');
  }
  return id;
}

function markdownOrder(relative) {
  const normalized = relative.replaceAll('\\', '/');
  if (normalized === 'RT/ExecSummary.md') return 10;
  if (normalized === 'RT/Writeup.md') return 20;
  if (/^CWEs\/Critical\//i.test(normalized)) return 30;
  if (/^CWEs\/High\//i.test(normalized)) return 40;
  if (/^CWEs\/Medium\//i.test(normalized)) return 50;
  if (/^CWEs\/Low\//i.test(normalized)) return 60;
  if (/^CWEs\//i.test(normalized)) return 70;
  if (normalized === 'RT/Timeline.md') return 90;
  if (normalized === 'RT/Errors.md') return 100;
  return 80;
}

function markdownFiles(root) {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') files.push(absolute);
    }
  };
  walk(root);
  return files.sort((a, b) => {
    const left = path.relative(root, a);
    const right = path.relative(root, b);
    return markdownOrder(left) - markdownOrder(right) || left.localeCompare(right);
  });
}

function rewriteLocalLinks(markdown, sourceFile, engagementRoot) {
  return markdown.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (whole, prefix, rawTarget, suffix) => {
    const target = rawTarget.replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole;
    const absolute = path.resolve(path.dirname(sourceFile), decodeURIComponent(target));
    if (absolute !== engagementRoot && !absolute.startsWith(`${engagementRoot}${path.sep}`)) {
      return `${prefix}#blocked-local-path${suffix}`;
    }
    return `${prefix}<${pathToFileURL(absolute).href}>${suffix}`;
  });
}

function normalizeDradisHeadings(markdown) {
  let inFence = false;
  return String(markdown ?? '').split('\n').map(line => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const match = line.match(/^#([^#\r\n]+)#\s*$/);
    if (!match) return line;
    const label = match[1].trim();
    if (/^CWE-\d+/i.test(label)) return `# ${label}`;
    if (/^Evidence\s+\d+:/i.test(label)) return `### ${label}`;
    return `## ${label}`;
  }).join('\n');
}

function stripRedundantWorkflowLabels(markdown) {
  let fence = null;
  return String(markdown ?? '').split('\n').filter(line => {
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      fence = fence === fenceMatch[1] ? null : (fence || fenceMatch[1]);
      return true;
    }
    if (fence) return true;
    return !/^\s*\[(?:Action\s+\d+|Final\s+Result)\]\s*$/i.test(line);
  }).join('\n');
}

function renderMarkdown(markdown) {
  const renderer = new Renderer();
  renderer.html = html => `<pre class="raw-html">${escapeHtml(html)}</pre>`;
  const marked = new Marked({ renderer, gfm: true, breaks: false });
  const normalized = normalizeDradisHeadings(markdown);
  return marked.parse(redactReportText(stripRedundantWorkflowLabels(normalized)));
}

function engagementMetadata(engagementId, dbPath = BLACKBOARD_DB) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const engagement = db.prepare(`
      SELECT id, target_name, scope, status, started_at, completed_at
      FROM engagements WHERE id=?
    `).get(engagementId) || { id: engagementId, target_name: engagementId, status: 'not recorded' };
    const findings = db.prepare(`
      SELECT lower(COALESCE(severity, priority, 'informational')) AS severity, COUNT(*) AS count
      FROM findings WHERE engagement_id=? GROUP BY lower(COALESCE(severity, priority, 'informational'))
    `).all(engagementId);
    const plans = db.prepare(`
      SELECT id, state, approved_at, completed_at FROM plans
      WHERE engagement_id=? ORDER BY datetime(created_at) ASC
    `).all(engagementId);
    const tasks = db.prepare('SELECT status, COUNT(*) AS count FROM tasks WHERE engagement_id=? GROUP BY status').all(engagementId);
    return { engagement, findings, plans, tasks };
  } catch {
    return {
      engagement: { id: engagementId, target_name: engagementId, status: 'not recorded' },
      findings: [], plans: [], tasks: [],
    };
  } finally {
    try { db?.close(); } catch {}
  }
}

function normalizedScope(value) {
  const raw = String(value || '').trim();
  if (!raw) return ['Not recorded'];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed.map(item => String(item));
  } catch {}
  return [raw];
}

function displayDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Not recorded';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(parsed);
}

function reportEntry(file, reportRoot, engagementRoot) {
  const relative = path.relative(reportRoot, file).replaceAll('\\', '/');
  const raw = fs.readFileSync(file, 'utf8');
  const markdown = rewriteLocalLinks(raw, file, engagementRoot);
  const normalized = normalizeDradisHeadings(raw);
  const title = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relative, '.md');
  const severity = relative.match(/^CWEs\/([^/]+)\//i)?.[1]?.toLowerCase() || null;
  const score = normalized.match(/(?:^|\n)#{1,4}\s*CVSS[^\n]*\n+\s*(?:\*\*)?(\d{1,2}(?:\.\d)?)/i)?.[1]
    || normalized.match(/CVSS\s*3\.1[^\n]{0,80}?(\d{1,2}(?:\.\d)?)/i)?.[1]
    || null;
  const cwes = [...new Set((title.match(/CWE-\d+/gi) || []).map(value => value.toUpperCase()))];
  const id = relative.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { file, relative, markdown, title, severity, score, cwes, id };
}

function findingSummaryRows(entries) {
  if (!entries.length) return '<tr><td colspan="3">No reportable findings were recorded.</td></tr>';
  return entries.map(entry => `<tr><td class="risk-cell risk-${escapeHtml(entry.severity || 'informational')}">${escapeHtml(entry.severity || 'Informational')}</td><td class="score-cell">${escapeHtml(entry.score || 'N/A')}</td><td>${escapeHtml(entry.title)}</td></tr>`).join('');
}

function contentsRows(findings, supporting) {
  const rows = [
    ['01', 'Executive Summary'],
    ['02', 'General Information'],
    ['03', 'Technical Details'],
  ];
  findings.forEach((entry, index) => rows.push([`03.${index + 1}`, entry.title]));
  if (supporting.length) {
    rows.push(['04', 'Supporting Engagement Record']);
    supporting.forEach((entry, index) => rows.push([`04.${index + 1}`, entry.title]));
  }
  rows.push(['05', 'Appendix'], ['05.1', 'Security Risk Matrix'], ['05.2', 'Vulnerability Remediation SLA'], ['06', 'Learning References']);
  return rows.map(([number, label]) => `<li class="${number.includes('.') ? 'toc-child' : ''}"><span>${escapeHtml(label)}</span><b>${escapeHtml(number)}</b></li>`).join('');
}

function riskMatrixHtml() {
  return `<section class="document-page appendix-page"><h1>Appendix</h1><h2>Security Risk Matrix</h2>
  <table class="risk-matrix"><thead><tr><th rowspan="2">Likelihood</th><th colspan="4">Level of impact</th></tr><tr><th>Low</th><th>Medium</th><th>High</th><th>Critical</th></tr></thead><tbody>
  <tr><th>Critical</th><td class="risk-low">Low</td><td class="risk-medium">Medium</td><td class="risk-high">High</td><td class="risk-critical">Critical</td></tr>
  <tr><th>High</th><td class="risk-low">Low</td><td class="risk-medium">Medium</td><td class="risk-high">High</td><td class="risk-critical">Critical</td></tr>
  <tr><th>Medium</th><td class="risk-low">Low</td><td class="risk-medium">Medium</td><td class="risk-high">High</td><td class="risk-high">High</td></tr>
  <tr><th>Low</th><td class="risk-low">Low</td><td class="risk-low">Low</td><td class="risk-low">Low</td><td class="risk-medium">Medium</td></tr></tbody></table>
  <p class="table-note">Risk ratings should be reviewed by the engagement owner against business rules, asset criticality, exposure, and compensating controls.</p>
  <h2>Risk Matrix Legend</h2><table class="legend-table"><thead><tr><th>Qualitative value</th><th>Description</th></tr></thead><tbody>
  <tr><th>Critical</th><td>Severe or systemic impact that can materially affect sensitive data, privileged operations, or critical business services.</td></tr>
  <tr><th>High</th><td>Substantial compromise of confidentiality, integrity, or availability with a credible and repeatable attack path.</td></tr>
  <tr><th>Medium</th><td>Meaningful but constrained impact, commonly requiring additional access, conditions, or user interaction.</td></tr>
  <tr><th>Low</th><td>Limited security degradation or a weakness whose practical impact is narrowly bounded.</td></tr></tbody></table>
  <h2>Common Vulnerability Scoring System</h2><p>Scores and vectors use CVSS 3.1 unless the finding states otherwise. See <a href="https://www.first.org/cvss/v3.1/user-guide">FIRST CVSS v3.1 User Guide</a> and <a href="https://www.first.org/cvss/calculator/3.1">CVSS Calculator</a>.</p></section>`;
}

function remediationSlaHtml() {
  return `<section class="document-page appendix-page"><h1>Vulnerability Remediation SLA</h1><p class="policy-note">Use the organization-approved vulnerability management policy for binding deadlines. The workflow below is the standard remediation handoff structure and does not replace local policy.</p>
  <table class="sla-table"><thead><tr><th>Severity</th><th>Required handling</th><th>Completion evidence</th></tr></thead><tbody>
  <tr><th class="risk-critical">Critical</th><td>Immediate owner assignment, containment review, and expedited remediation under the applicable emergency process.</td><td>Fix, regression test, and independent validation.</td></tr>
  <tr><th class="risk-high">High</th><td>Prioritized remediation in the nearest approved release window, with compensating controls documented when delayed.</td><td>Fix and independent validation.</td></tr>
  <tr><th class="risk-medium">Medium</th><td>Scheduled remediation under the product vulnerability backlog and applicable component SLA.</td><td>Fix and regression evidence.</td></tr>
  <tr><th class="risk-low">Low</th><td>Risk-owner review and remediation through normal engineering maintenance.</td><td>Closure rationale or regression evidence.</td></tr></tbody></table>
  <h2>Retest Expectations</h2><ul><li>Reproduce the original attack path after remediation and retain request-level evidence.</li><li>Test adjacent authorization, parser, validation, and error-handling paths for bypasses.</li><li>Record the fixed version, deployment, tester, date, and terminal disposition.</li></ul></section>`;
}

function learningReferencesHtml(findings) {
  const cwes = [...new Set(findings.flatMap(entry => entry.cwes))];
  const specific = cwes.length
    ? cwes.map(cwe => `<li><strong>${escapeHtml(cwe)}</strong> - <a href="https://cwe.mitre.org/data/definitions/${escapeHtml(cwe.slice(4))}.html">MITRE ${escapeHtml(cwe)}</a></li>`).join('')
    : '<li>No CWE-specific references were recorded.</li>';
  return `<section class="document-page references-page"><h1>Learning References</h1><h2>References Specific to Reported Findings</h2><ul class="reference-list">${specific}</ul><h2>General Learning Resources</h2><ul class="reference-list"><li><a href="https://owasp.org/www-project-web-security-testing-guide/">OWASP Web Security Testing Guide</a></li><li><a href="https://owasp.org/www-project-application-security-verification-standard/">OWASP Application Security Verification Standard</a></li><li><a href="https://owasp.org/www-project-top-ten/">OWASP Top 10</a></li><li><a href="https://www.first.org/cvss/v3.1/user-guide">FIRST CVSS v3.1 User Guide</a></li></ul></section>`;
}

function reportHtml({ engagementId, reportRoot, files, metadata, generatedAt }) {
  const engagementRoot = path.dirname(reportRoot);
  const entries = files.map(file => reportEntry(file, reportRoot, engagementRoot));
  const execEntry = entries.find(entry => entry.relative === 'RT/ExecSummary.md');
  const findings = entries.filter(entry => entry.severity)
    .sort((left, right) => (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99) || left.title.localeCompare(right.title));
  const supporting = entries.filter(entry => entry !== execEntry && !entry.severity);
  const execSection = execEntry
    ? `<section class="document-page executive-page" id="executive-summary" data-source="${escapeHtml(execEntry.relative)}">${renderMarkdown(execEntry.markdown)}</section>`
    : '<section class="document-page executive-page"><h1>Executive Summary</h1><p>No executive summary was provided.</p></section>';
  const findingSections = findings.map((entry, index) => {
    const findingBody = renderMarkdown(entry.markdown).replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/, '');
    return `<section class="document-page finding finding-${escapeHtml(entry.severity)}" id="${escapeHtml(entry.id)}" data-source="${escapeHtml(entry.relative)}"><div class="finding-intro">${index === 0 ? '<div class="section-kicker">Technical Details</div>' : ''}<h1>${escapeHtml(entry.title)}</h1><div class="severity-badge risk-${escapeHtml(entry.severity)}"><strong>${escapeHtml(entry.score || 'N/A')}</strong><span>${escapeHtml(entry.severity)}</span></div></div>${findingBody}</section>`;
  }).join('\n');
  const supportingSections = supporting.map((entry, index) => `<section class="document-page supporting-page" id="${escapeHtml(entry.id)}" data-source="${escapeHtml(entry.relative)}">${index === 0 ? '<div class="section-kicker">Supporting Engagement Record</div>' : ''}<div class="source-label">Supporting record · ${escapeHtml(entry.relative)}</div>${renderMarkdown(entry.markdown)}</section>`).join('\n');
  const target = metadata.engagement.target_name || engagementId;
  const scope = normalizedScope(metadata.engagement.scope);
  const completedTasks = Number(metadata.tasks.find(row => row.status === 'completed')?.count || 0);
  const approvedPlans = metadata.plans.filter(row => row.approved_at).length;
  const completedDate = displayDate(metadata.engagement.completed_at || generatedAt);
  const pageEngagementId = JSON.stringify(engagementId);
  const pageIssueLine = JSON.stringify(`Issued ${completedDate} · Secrets redacted`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(target)} — Red Team Report</title>
<style>
@page {
  size: Letter;
  margin: .82in .66in .82in;
  @top-left { content:"Red Team Report"; vertical-align:bottom; padding-bottom:.05in; border-bottom:1px solid #e4e7ed; color:#202633; font:700 7.5pt Arial,Helvetica,sans-serif; letter-spacing:.02em; text-transform:uppercase; }
  @top-center { content:""; border-bottom:1px solid #e4e7ed; }
  @top-right { content:${pageEngagementId}; vertical-align:bottom; padding-bottom:.05in; border-bottom:1px solid #e4e7ed; color:#202633; font:700 7.5pt Arial,Helvetica,sans-serif; letter-spacing:.02em; text-transform:uppercase; }
  @bottom-left { content:"Security Engagement Report"; vertical-align:top; padding-top:.05in; border-top:1px solid #eef0f4; color:#586174; font:6.4pt/1.15 Arial,Helvetica,sans-serif; }
  @bottom-center { content:""; border-top:1px solid #eef0f4; }
  @bottom-right { content:${pageIssueLine}; vertical-align:top; padding-top:.05in; border-top:1px solid #eef0f4; color:#586174; font:6.4pt/1.15 Arial,Helvetica,sans-serif; }
}
@page cover {
  size: Letter;
  margin:0;
  @top-left { content:none; border:0; }
  @top-center { content:none; border:0; }
  @top-right { content:none; border:0; }
  @bottom-left { content:none; border:0; }
  @bottom-center { content:none; border:0; }
  @bottom-right { content:none; border:0; }
}
:root { color-scheme: light; --ink:#121722; --muted:#657184; --line:#c7ceda; --accent:#222f84; --navy:#07135f; --red:#9f2738; --cover-ink:#24272d; --cover-charcoal:#1c2028; --cover-crimson:#9f2738; --cover-copper:#d16b3f; --critical:#111827; --high:#dc2f2f; --medium:#f2b824; --low:#16a85a; }
* { box-sizing:border-box; }
body { margin:0; color:var(--ink); background:#fff; font:9.5pt/1.34 Arial,Helvetica,sans-serif; }
.cover { page:cover; position:relative; z-index:5; min-height:11in; margin:0; padding:2.25in .86in 2.55in; overflow:hidden; background:#fff; page-break-after:always; }
.cover-copy { position:relative; z-index:4; max-width:5.5in; }
.cover h1 { margin:0 0 .08in; color:var(--cover-ink); font-size:29pt; line-height:1.05; }
.cover .subtitle { color:var(--red); font-size:14pt; font-weight:700; font-style:italic; }
.cover .engagement-id,.cover .date { margin-top:.07in; font-size:12pt; font-weight:700; }
.cover-wave { position:absolute; z-index:2; left:-.35in; right:-.35in; bottom:-.78in; height:2.75in; border-radius:55% 48% 0 0 / 28% 24% 0 0; background:var(--cover-charcoal); transform:rotate(1deg); }
.cover-wave::before { content:""; position:absolute; left:35%; right:-8%; top:.22in; height:.62in; border-radius:55% 10% 0 0; background:var(--cover-crimson); transform:rotate(7deg); }
.cover-wave::after { content:""; position:absolute; left:50%; right:-7%; top:.04in; height:.48in; border-radius:55% 10% 0 0; background:var(--cover-copper); transform:rotate(5deg); }
.cover-label { position:absolute; z-index:4; left:.9in; bottom:.57in; color:#fff; font-size:12pt; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
.document-page { position:relative; page-break-before:always; }
.contents-page { page-break-before:auto; }
.source-label { float:right; margin:0 0 .08in .12in; color:var(--muted); font-size:6.8pt; }
.section-kicker { margin:0 0 .17in; padding-bottom:.07in; border-bottom:1.5px solid var(--navy); color:var(--navy); font-size:15pt; font-variant:small-caps; letter-spacing:.015em; }
h1,h2,h3,h4 { color:var(--navy); line-height:1.16; page-break-after:avoid; }
h1 { margin:0 0 .2in; padding-bottom:.07in; border-bottom:1.5px solid var(--navy); font-size:15pt; font-weight:500; font-variant:small-caps; letter-spacing:.015em; }
h2 { margin:.18in 0 .08in; padding-bottom:.035in; border-bottom:1px solid var(--navy); font-size:11pt; font-weight:500; font-variant:small-caps; }
h3 { margin:.15in 0 .06in; font-size:9.4pt; }
h4 { margin:.12in 0 .04in; font-size:9pt; }
p { margin:.06in 0 .1in; }
p,li { orphans:3; widows:3; }
ul,ol { margin:.06in 0 .14in; padding-left:.25in; }
li { margin:.025in 0; }
.toc-list { margin:.2in 0 0; padding:0; list-style:none; }
.toc-list li { display:flex; align-items:flex-end; gap:.08in; margin:.075in 0; color:#1c2230; }
.toc-list li::after { content:""; order:2; flex:1; border-bottom:1px dotted #5b6270; transform:translateY(-.04in); }
.toc-list span { order:1; max-width:5.9in; font-weight:600; }
.toc-list b { order:3; color:var(--navy); font-size:8pt; }
.toc-list .toc-child { padding-left:.16in; margin:.045in 0; font-size:8.6pt; font-style:italic; }
.information-grid { display:grid; grid-template-columns:1fr 1fr; gap:.08in .22in; margin:.05in 0 .12in; }
.information-grid div { padding:.08in; border:1px solid var(--line); }
.information-grid span { display:block; color:var(--muted); font-size:7pt; text-transform:uppercase; }
.information-grid strong { display:block; margin-top:.03in; }
table { width:100%; border-collapse:collapse; margin:.1in 0 .16in; font-size:8pt; page-break-inside:auto; }
tr { page-break-inside:avoid; }
th,td { padding:.055in .07in; border:1px solid #565d6a; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
thead th { color:#fff; background:var(--navy); text-align:center; font-variant:small-caps; }
.risk-cell { width:.92in; color:#fff; text-align:center; font-weight:700; text-transform:capitalize; }
.score-cell { width:.58in; text-align:center; font-weight:700; }
.risk-critical { color:#fff !important; background:var(--critical) !important; }
.risk-high { color:#fff !important; background:var(--high) !important; }
.risk-medium { color:#111 !important; background:var(--medium) !important; }
.risk-low { color:#061a0e !important; background:var(--low) !important; }
.risk-informational { color:#111 !important; background:#dce4ef !important; }
.finding { padding-top:.02in; }
.finding-intro { display:grid; grid-template-columns:minmax(0,1fr) .64in; gap:0 .18in; align-items:center; margin:0 0 .14in; border-bottom:1.5px solid var(--navy); }
.finding-intro .section-kicker { grid-column:1 / -1; width:100%; margin:0; }
.finding-intro h1 { margin:0; padding:.14in 0 .13in; border:0; font-size:13pt; font-weight:600; font-variant:normal; letter-spacing:0; overflow-wrap:anywhere; }
.severity-badge { width:.64in; height:.64in; display:flex; flex-direction:column; align-items:center; justify-content:center; margin:0; border-radius:.09in; text-align:center; }
.severity-badge strong { font-size:13pt; line-height:1; }
.severity-badge span { margin-top:.025in; font-size:5.5pt; font-weight:800; text-transform:uppercase; }
.finding img { display:block; max-width:100%; max-height:4.85in; margin:.08in auto .06in; border:1px solid #c8ced8; object-fit:contain; page-break-inside:avoid; }
pre { padding:.1in; overflow-wrap:anywhere; white-space:pre-wrap; background:#10141c; color:#f1f4f8; border:1px solid #252c38; font:7.1pt/1.34 ui-monospace,SFMono-Regular,Menlo,monospace; page-break-inside:avoid; }
code { padding:1px 3px; background:#eef1f5; font:7.7pt ui-monospace,SFMono-Regular,Menlo,monospace; }
pre code { padding:0; background:transparent; color:inherit; }
blockquote { margin:.1in 0; padding:.06in .12in; border-left:3px solid var(--accent); color:#334155; background:#f5f7fb; }
img { max-width:100%; height:auto; page-break-inside:avoid; }
a { color:#175da6; }
.raw-html { color:#475569; background:#f8fafc; border:1px solid var(--line); }
.risk-matrix th,.risk-matrix td { text-align:center; }
.risk-matrix th:first-child { width:2.2in; }
.table-note,.policy-note { color:#4f596b; font-size:8pt; font-style:italic; }
.legend-table th:first-child,.sla-table th:first-child { width:1.15in; text-align:center; }
.reference-list { margin-top:.12in; }
.reference-list li { margin:.12in 0; }
.supporting-page table { font-size:6.7pt; }
.supporting-page th,.supporting-page td { padding:.035in .045in; }
@media print { a { color:inherit; text-decoration:none; } }
</style></head><body>
<section class="cover"><div class="cover-copy"><h1>Red Team Report</h1><div class="subtitle">${escapeHtml(target)}</div><div class="engagement-id">${escapeHtml(engagementId)}</div><div class="date">${escapeHtml(completedDate)}</div></div><div class="cover-wave"></div><div class="cover-label">Security Assessment</div></section>
<section class="document-page contents-page"><h1>Table of Contents</h1><ol class="toc-list">${contentsRows(findings, supporting)}</ol></section>
${execSection}
<section class="document-page general-page"><h1>General Information</h1><h2>Testing Scope</h2><ul>${scope.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h2>Testing Period</h2><p>The assessment was performed between <strong>${escapeHtml(displayDate(metadata.engagement.started_at))}</strong> and <strong>${escapeHtml(displayDate(metadata.engagement.completed_at))}</strong>.</p><div class="information-grid"><div><span>Engagement status</span><strong>${escapeHtml(metadata.engagement.status || 'Not recorded')}</strong></div><div><span>Approved plans</span><strong>${approvedPlans}</strong></div><div><span>Completed tasks</span><strong>${completedTasks}</strong></div><div><span>Reported vulnerabilities</span><strong>${findings.length}</strong></div></div><h2>Vulnerabilities Summary</h2><table class="vulnerability-summary"><thead><tr><th>Risk</th><th>Score</th><th>Vulnerability</th></tr></thead><tbody>${findingSummaryRows(findings)}</tbody></table></section>
${findingSections}
${supportingSections}
${riskMatrixHtml()}
${remediationSlaHtml()}
${learningReferencesHtml(findings)}
</body></html>`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function generateEngagementDeliverables(engagementId, options = {}) {
  const id = validEngagementId(engagementId);
  const investigationsRoot = path.resolve(options.investigationsRoot || GLADOS_INVESTIGATIONS_DIR);
  const engagementRoot = path.resolve(investigationsRoot, id);
  if (!engagementRoot.startsWith(`${investigationsRoot}${path.sep}`)) throw new Error('engagement path escapes investigations root');
  const reportRoot = path.join(engagementRoot, 'reports');
  if (!fs.existsSync(reportRoot) || !fs.statSync(reportRoot).isDirectory()) throw new Error(`report tree not found for engagement ${id}`);
  const files = markdownFiles(reportRoot).filter(file => !OUTPUT_NAMES.has(path.basename(file)));
  if (!files.length) throw new Error(`no Markdown reports found for engagement ${id}`);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const metadata = engagementMetadata(id, options.dbPath || BLACKBOARD_DB);
  const htmlPath = path.join(reportRoot, 'ENGAGEMENT-REPORT.html');
  const pdfPath = path.join(reportRoot, 'ENGAGEMENT-REPORT.pdf');
  fs.writeFileSync(htmlPath, reportHtml({ engagementId: id, reportRoot, files, metadata, generatedAt }), { mode: 0o600 });
  const pdfGenerator = options.pdfGenerator || generatePdf;
  pdfGenerator(htmlPath, pdfPath);
  if (!fs.existsSync(pdfPath) || fs.readFileSync(pdfPath).subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('engagement PDF generator did not produce a valid PDF');
  }
  fs.chmodSync(pdfPath, 0o600);
  const manifestPath = path.join(reportRoot, 'DELIVERABLES-MANIFEST.json');
  const published = [...files, htmlPath, pdfPath].sort();
  const manifest = {
    report_style: REPORT_STYLE,
    engagement_id: id,
    generated_at: generatedAt,
    source_reports: files.map(file => path.relative(reportRoot, file).replaceAll('\\', '/')),
    files: Object.fromEntries(published.map(file => [path.relative(reportRoot, file).replaceAll('\\', '/'), {
      size: fs.statSync(file).size,
      sha256: sha256(file),
    }])),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { engagementId: id, reportRoot, htmlPath, pdfPath, manifestPath, manifest };
}

module.exports = {
  generateEngagementDeliverables,
  markdownFiles,
  normalizeDradisHeadings,
  reportHtml,
  rewriteLocalLinks,
  stripRedundantWorkflowLabels,
};
