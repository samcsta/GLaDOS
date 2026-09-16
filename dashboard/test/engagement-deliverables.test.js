const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  generateEngagementDeliverables,
  markdownFiles,
  normalizeDradisHeadings,
  rewriteLocalLinks,
} = require('../lib/engagement-deliverables');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-engagement-pdf-'));
  const engagementId = 'eng-test';
  const reportRoot = path.join(root, engagementId, 'reports');
  fs.mkdirSync(path.join(reportRoot, 'RT'), { recursive: true });
  fs.mkdirSync(path.join(reportRoot, 'CWEs', 'High'), { recursive: true });
  fs.mkdirSync(path.join(root, engagementId, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, engagementId, 'evidence', 'proof.png'), 'image');
  fs.writeFileSync(path.join(reportRoot, 'RT', 'ExecSummary.md'), '# Executive Summary\nSafe summary.\n');
  fs.writeFileSync(path.join(reportRoot, 'RT', 'Writeup.md'), '# Writeup\n<script>bad()</script>\n');
  fs.writeFileSync(path.join(reportRoot, 'RT', 'Timeline.md'), '# Timeline\nDone.\n');
  fs.writeFileSync(path.join(reportRoot, 'CWEs', 'High', 'CWE-639.md'), '#CWE-639: Finding#\n#Summary#\nSafe.\n#Evidence 1: Proof#\n![proof](../../../evidence/proof.png)\n');
  const dbPath = path.join(root, 'blackboard.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE engagements (id TEXT PRIMARY KEY, target_name TEXT, scope TEXT, status TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE findings (engagement_id TEXT, severity TEXT, priority TEXT);
    CREATE TABLE plans (id TEXT, engagement_id TEXT, state TEXT, approved_at TEXT, completed_at TEXT, created_at TEXT);
    CREATE TABLE tasks (engagement_id TEXT, status TEXT);
  `);
  db.prepare('INSERT INTO engagements VALUES (?,?,?,?,?,?)').run(engagementId, 'Fixture target', '["http://127.0.0.1/"]', 'complete', 'start', 'finish');
  db.prepare('INSERT INTO findings VALUES (?,?,?)').run(engagementId, 'high', 'HIGH');
  db.prepare('INSERT INTO plans VALUES (?,?,?,?,?,?)').run('plan-1', engagementId, 'complete', 'approved', 'complete', 'created');
  db.prepare('INSERT INTO tasks VALUES (?,?)').run(engagementId, 'completed');
  db.close();
  return { root, engagementId, reportRoot, dbPath };
}

test('generic engagement deliverables order reports and publish HTML, PDF, and manifest', () => {
  const f = fixture();
  const ordered = markdownFiles(f.reportRoot).map(file => path.relative(f.reportRoot, file).replaceAll('\\', '/'));
  assert.deepEqual(ordered, ['RT/ExecSummary.md', 'RT/Writeup.md', 'CWEs/High/CWE-639.md', 'RT/Timeline.md']);
  const result = generateEngagementDeliverables(f.engagementId, {
    investigationsRoot: f.root,
    dbPath: f.dbPath,
    generatedAt: '2026-01-02T03:04:05.000Z',
    pdfGenerator: (_html, output) => fs.writeFileSync(output, '%PDF-fixture'),
  });
  assert.equal(fs.existsSync(result.htmlPath), true);
  assert.equal(fs.existsSync(result.pdfPath), true);
  assert.equal(fs.existsSync(result.manifestPath), true);
  const html = fs.readFileSync(result.htmlPath, 'utf8');
  assert.match(html, /Fixture target/);
  assert.match(html, /Red Team Report/);
  assert.match(html, /Table of Contents/);
  assert.match(html, /Executive Summary/);
  assert.match(html, /General Information/);
  assert.match(html, /Vulnerabilities Summary/);
  assert.match(html, /Technical Details/);
  assert.match(html, /Security Risk Matrix/);
  assert.match(html, /Vulnerability Remediation SLA/);
  assert.match(html, /Learning References/);
  assert.match(html, /severity-badge risk-high/);
  assert.match(html, /Security Assessment/);
  assert.match(html, /Security Engagement Report/);
  assert.doesNotMatch(html, /GLaDOS Ops/);
  assert.doesNotMatch(html, /GLaDOS handoff/);
  assert.doesNotMatch(html, /glados-logo/);
  assert.match(html, /file:\/\//);
  assert.match(html, /<h1>CWE-639: Finding<\/h1>/);
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<h3>Evidence 1: Proof<\/h3>/);
  assert.doesNotMatch(html, /#CWE-639: Finding#/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /Ford/);
  assert.equal(result.manifest.report_style, 'red-team-report-standard-v2');
  assert.equal(result.manifest.files['ENGAGEMENT-REPORT.pdf'].sha256.length, 64);
});

test('Dradis heading normalization does not rewrite fenced command comments', () => {
  const markdown = '#Summary#\n```sh\n#leave this#\n```\n#Evidence 1: Proof#\n';
  assert.equal(normalizeDradisHeadings(markdown), '## Summary\n```sh\n#leave this#\n```\n### Evidence 1: Proof\n');
});

test('generic engagement link rewriting blocks paths outside the engagement root', () => {
  const f = fixture();
  const source = path.join(f.reportRoot, 'RT', 'Writeup.md');
  const engagementRoot = path.join(f.root, f.engagementId);
  assert.match(rewriteLocalLinks('[proof](../../evidence/proof.png)', source, engagementRoot), /file:\/\//);
  assert.match(rewriteLocalLinks('[escape](../../../../etc/passwd)', source, engagementRoot), /#blocked-local-path/);
});
