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

function renderMarkdown(markdown) {
  const renderer = new Renderer();
  renderer.html = html => `<pre class="raw-html">${escapeHtml(html)}</pre>`;
  const marked = new Marked({ renderer, gfm: true, breaks: false });
  return marked.parse(redactReportText(normalizeDradisHeadings(markdown)));
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

function summaryCards(metadata) {
  const findingCount = metadata.findings.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const completedTasks = metadata.tasks.find(row => row.status === 'completed')?.count || 0;
  const approvedPlans = metadata.plans.filter(row => row.approved_at).length;
  return [
    ['Status', metadata.engagement.status || 'not recorded'],
    ['Findings', findingCount],
    ['Completed tasks', completedTasks],
    ['Approved plans', approvedPlans],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function reportHtml({ engagementId, reportRoot, files, metadata, generatedAt }) {
  const engagementRoot = path.dirname(reportRoot);
  const sections = files.map((file, index) => {
    const relative = path.relative(reportRoot, file).replaceAll('\\', '/');
    const markdown = rewriteLocalLinks(fs.readFileSync(file, 'utf8'), file, engagementRoot);
    return `<section class="report-section${index ? ' page-break' : ''}" data-source="${escapeHtml(relative)}"><div class="source-label">${escapeHtml(relative)}</div>${renderMarkdown(markdown)}</section>`;
  }).join('\n');
  const target = metadata.engagement.target_name || engagementId;
  const scope = metadata.engagement.scope || 'Not recorded';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(target)} — GLaDOS Engagement Report</title>
<style>
@page { size: Letter; margin: 0.65in; }
:root { color-scheme: light; --ink:#152033; --muted:#64748b; --line:#dbe3ee; --accent:#2563eb; --navy:#07111f; }
* { box-sizing:border-box; }
body { margin:0; color:var(--ink); background:#fff; font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.cover { min-height:9.3in; padding:0.25in 0; display:flex; flex-direction:column; justify-content:center; page-break-after:always; }
.brand { color:var(--accent); font-size:13px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
.cover h1 { margin:.18in 0 .08in; color:var(--navy); font-size:38px; line-height:1.08; }
.subtitle { color:var(--muted); font-size:18px; }
.meta { margin:.35in 0; padding:.2in; border:1px solid var(--line); border-radius:12px; background:#f8fafc; }
.meta p { margin:.06in 0; overflow-wrap:anywhere; }
.cards { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
.cards div { border-top:3px solid var(--accent); padding:12px; background:#f8fafc; }
.cards span { display:block; color:var(--muted); font-size:10px; letter-spacing:.08em; text-transform:uppercase; }
.cards strong { display:block; margin-top:4px; font-size:18px; }
.footer-note { margin-top:.45in; color:var(--muted); font-size:11px; }
.report-section { position:relative; }
.page-break { page-break-before:always; }
.source-label { float:right; margin:0 0 10px 12px; padding:3px 8px; color:var(--muted); border:1px solid var(--line); border-radius:999px; font-size:9px; }
h1,h2,h3,h4 { color:var(--navy); line-height:1.25; page-break-after:avoid; }
h1 { padding-bottom:8px; border-bottom:2px solid var(--accent); font-size:27px; }
h2 { margin-top:25px; font-size:21px; }
h3 { font-size:16px; }
p,li { orphans:3; widows:3; }
table { width:100%; border-collapse:collapse; margin:14px 0; font-size:11px; page-break-inside:auto; }
tr { page-break-inside:avoid; }
th,td { padding:7px; border:1px solid var(--line); text-align:left; vertical-align:top; overflow-wrap:anywhere; }
th { background:#eef4ff; }
pre { padding:12px; overflow-wrap:anywhere; white-space:pre-wrap; background:#0b1220; color:#e2e8f0; border-radius:8px; font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
code { padding:1px 4px; background:#eef2f7; border-radius:4px; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
pre code { padding:0; background:transparent; color:inherit; }
blockquote { margin:14px 0; padding:3px 16px; border-left:4px solid var(--accent); color:#334155; background:#f8fafc; }
img { max-width:100%; height:auto; page-break-inside:avoid; }
a { color:#1d4ed8; }
.raw-html { color:#475569; background:#f8fafc; border:1px solid var(--line); }
@media print { a { color:inherit; text-decoration:none; } }
</style></head><body>
<section class="cover"><div class="brand">GLaDOS Ops</div><h1>${escapeHtml(target)}</h1><div class="subtitle">Security Engagement Report</div>
<div class="meta"><p><strong>Engagement:</strong> ${escapeHtml(engagementId)}</p><p><strong>Scope:</strong> ${escapeHtml(scope)}</p><p><strong>Started:</strong> ${escapeHtml(metadata.engagement.started_at || 'Not recorded')}</p><p><strong>Completed:</strong> ${escapeHtml(metadata.engagement.completed_at || 'Not recorded')}</p></div>
<div class="cards">${summaryCards(metadata)}</div><p class="footer-note">Generated ${escapeHtml(generatedAt)} from the final GLaDOS report tree. Local credential values and bearer secrets are redacted from this publication artifact.</p></section>
${sections}</body></html>`;
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
};
