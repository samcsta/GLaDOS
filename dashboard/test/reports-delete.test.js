const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

function loadReports(runtimeDir) {
  process.env.GLADOS_RUNTIME_DIR = runtimeDir;
  process.env.GLADOS_REPORTS_DIR = path.join(runtimeDir, 'reports');
  process.env.GLADOS_INVESTIGATIONS_DIR = path.join(runtimeDir, 'investigations');
  for (const modulePath of ['../lib/reports', '../lib/config']) delete require.cache[require.resolve(modulePath)];
  return require('../lib/reports');
}

test('Reports indexes sealed security reviews as a dedicated collection', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-security-review-'));
  const review = path.join(runtime, 'investigations', 'eng-1', 'security-review');
  fs.mkdirSync(review, { recursive: true });
  fs.mkdirSync(path.join(review, 'deliverables'));
  fs.writeFileSync(path.join(review, 'findings.json'), '{"findings":[]}\n');
  fs.writeFileSync(path.join(review, 'workers.jsonl'), '{"worker":"one"}\n');
  fs.writeFileSync(path.join(review, 'completion-receipt.json'), '{"status":"SEALED","terminal_state":"SATURATED"}\n');
  fs.writeFileSync(path.join(review, 'EXECUTIVE-SUMMARY.md'), '# Summary\n');
  fs.writeFileSync(path.join(review, 'deliverables', 'EXECUTIVE-SUMMARY.md'), '# Summary\n');
  fs.writeFileSync(path.join(review, 'deliverables', 'security-review-report.pdf'), '%PDF-1.4 test\n');
  const reports = loadReports(runtime);
  const index = reports.tree();
  const security = index.tree.find(node => node.path === 'security-reviews');
  assert.ok(security);
  assert.match(JSON.stringify(security), /security-reviews\/eng-1\/EXECUTIVE-SUMMARY\.md/);
  assert.match(JSON.stringify(security), /security-reviews\/eng-1\/raw\/workers\.jsonl/);
  assert.equal(reports.readFile('security-reviews/eng-1/raw/workers.jsonl').kind, 'text');
  assert.equal(reports.readFile('security-reviews/eng-1/security-review-report.pdf').kind, 'pdf');
  assert.equal(reports.readFile('investigations/eng-1/security-review/EXECUTIVE-SUMMARY.md').kind, 'markdown');
});

test('Reports can delete published reports, investigation workspaces, security reviews, and collection contents', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-delete-'));
  const folder = path.join(runtime, 'reports', 'old-report');
  const review = path.join(runtime, 'investigations', 'eng-1', 'security-review');
  const evidence = path.join(runtime, 'investigations', 'eng-1', 'evidence');
  const investigation = path.join(runtime, 'investigations', 'eng-2');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(review, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(investigation, { recursive: true });
  fs.writeFileSync(path.join(folder, 'report.md'), '# report\n');
  fs.writeFileSync(path.join(review, 'findings.json'), '{}\n');
  fs.writeFileSync(path.join(evidence, 'request.txt'), 'evidence\n');
  fs.writeFileSync(path.join(investigation, 'notes.md'), '# notes\n');
  const reports = loadReports(runtime);
  assert.deepEqual(reports.deletePath('reports/old-report'), { ok: true, deleted: 'reports/old-report', type: 'directory' });
  assert.equal(fs.existsSync(folder), false);
  assert.deepEqual(reports.deletePath('security-reviews/eng-1'), { ok: true, deleted: 'security-reviews/eng-1', type: 'directory' });
  assert.equal(fs.existsSync(review), false);
  assert.equal(fs.existsSync(evidence), true);
  assert.deepEqual(reports.deletePath('investigations/eng-2'), { ok: true, deleted: 'investigations/eng-2', type: 'directory' });
  assert.equal(fs.existsSync(investigation), false);
  fs.mkdirSync(path.join(runtime, 'reports', 'clear-me'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'reports', 'clear-me', 'report.md'), '# report\n');
  assert.deepEqual(reports.deletePath('reports'), { ok: true, deleted: 'reports', type: 'collection' });
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'reports')), []);
  assert.equal(fs.existsSync(path.join(runtime, 'reports')), true);

  const retainedEvidence = path.join(runtime, 'investigations', 'eng-3', 'evidence');
  const clearedReview = path.join(runtime, 'investigations', 'eng-3', 'security-review');
  fs.mkdirSync(retainedEvidence, { recursive: true });
  fs.mkdirSync(clearedReview, { recursive: true });
  fs.writeFileSync(path.join(retainedEvidence, 'request.txt'), 'retain\n');
  fs.writeFileSync(path.join(clearedReview, 'findings.json'), '{}\n');
  assert.deepEqual(reports.deletePath('security-reviews'), { ok: true, deleted: 'security-reviews', type: 'collection' });
  assert.equal(fs.existsSync(clearedReview), false);
  assert.equal(fs.existsSync(retainedEvidence), true);
});

test('Reports can delete individual files through virtual security-review paths', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-delete-review-file-'));
  const review = path.join(runtime, 'investigations', 'eng-1', 'security-review');
  fs.mkdirSync(path.join(review, 'deliverables'), { recursive: true });
  fs.writeFileSync(path.join(review, 'deliverables', 'SECURITY-REVIEW.md'), '# report\n');
  fs.writeFileSync(path.join(review, 'findings.json'), '{}\n');
  const reports = loadReports(runtime);
  assert.deepEqual(reports.deletePath('security-reviews/eng-1/SECURITY-REVIEW.md'), {
    ok: true, deleted: 'security-reviews/eng-1/SECURITY-REVIEW.md', type: 'file',
  });
  assert.equal(fs.existsSync(path.join(review, 'deliverables', 'SECURITY-REVIEW.md')), false);
  assert.deepEqual(reports.deletePath('security-reviews/eng-1/raw/findings.json'), {
    ok: true, deleted: 'security-reviews/eng-1/raw/findings.json', type: 'file',
  });
  assert.equal(fs.existsSync(path.join(review, 'findings.json')), false);
});

test('Reports treats deletion of a stale missing entry as successful', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-delete-stale-'));
  const review = path.join(runtime, 'investigations', 'eng-1', 'security-review');
  fs.mkdirSync(path.join(review, 'deliverables', 'findings', 'Medium'), { recursive: true });
  const reports = loadReports(runtime);
  assert.deepEqual(reports.deletePath('security-reviews/eng-1/findings/Medium/stale.md'), {
    ok: true,
    deleted: 'security-reviews/eng-1/findings/Medium/stale.md',
    type: 'missing',
    alreadyMissing: true,
  });
});

test('Reports refuses paths that traverse a symbolic link outside the configured roots', t => {
  if (process.platform === 'win32') return t.skip('symbolic-link permissions differ on Windows');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-outside-'));
  fs.mkdirSync(path.join(runtime, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), '# outside\n');
  fs.symlinkSync(outside, path.join(runtime, 'reports', 'escape'));
  const reports = loadReports(runtime);
  assert.throws(() => reports.readFile('reports/escape/secret.md'), /symbolic link/);
  assert.throws(() => reports.deletePath('reports/escape/secret.md'), /symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, 'secret.md')), true);
});

test('Reports renames physical entries and preserves identity-bound folders with display aliases', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-rename-'));
  const report = path.join(runtime, 'reports', 'draft.md');
  const investigation = path.join(runtime, 'investigations', 'eng-1');
  const review = path.join(investigation, 'security-review');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.mkdirSync(path.join(review, 'deliverables'), { recursive: true });
  fs.writeFileSync(report, '# draft\n');
  fs.writeFileSync(path.join(investigation, 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(review, 'deliverables', 'SECURITY-REVIEW.md'), '# review\n');
  fs.writeFileSync(path.join(review, 'completion-receipt.json'), '{"status":"SEALED","terminal_state":"SATURATED"}\n');
  const reports = loadReports(runtime);

  assert.deepEqual(reports.renamePath('reports/draft.md', 'final.md'), {
    ok: true, path: 'reports/final.md', previousPath: 'reports/draft.md', name: 'final.md', alias: false,
  });
  assert.equal(fs.existsSync(path.join(runtime, 'reports', 'final.md')), true);
  assert.deepEqual(reports.renamePath('investigations/eng-1', 'Customer Investigation'), {
    ok: true, path: 'investigations/eng-1', name: 'Customer Investigation', alias: true,
  });
  assert.deepEqual(reports.renamePath('security-reviews/eng-1', 'Customer Security Review'), {
    ok: true, path: 'security-reviews/eng-1', name: 'Customer Security Review', alias: true,
  });
  assert.equal(fs.existsSync(investigation), true);
  const index = JSON.stringify(reports.tree());
  assert.match(index, /Customer Investigation/);
  assert.match(index, /Customer Security Review/);
});

test('Reports rename supports collection aliases and rejects invalid names and collisions', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-rename-invalid-'));
  fs.mkdirSync(path.join(runtime, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'reports', 'one.md'), 'one\n');
  fs.writeFileSync(path.join(runtime, 'reports', 'two.md'), 'two\n');
  const reports = loadReports(runtime);
  assert.deepEqual(reports.renamePath('reports', 'Customer Reports'), {
    ok: true, path: 'reports', name: 'Customer Reports', alias: true,
  });
  assert.match(JSON.stringify(reports.tree()), /Customer Reports/);
  assert.throws(() => reports.renamePath('reports/one.md', '../escape.md'), /single non-empty path component/);
  assert.throws(() => reports.renamePath('reports/one.md', 'two.md'), /already exists/);
});

test('raw report delivery supports byte ranges used by inline PDF viewers', async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-reports-range-'));
  const report = path.join(runtime, 'reports', 'report.pdf');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, '0123456789');
  const reports = loadReports(runtime);
  const headers = {};
  let body = '';
  const response = new Writable({ write(chunk, _encoding, callback) { body += chunk.toString(); callback(); } });
  response.req = { headers: { range: 'bytes=2-5' } };
  response.setHeader = (name, value) => { headers[name] = value; };
  reports.sendRaw('reports/report.pdf', response);
  await new Promise(resolve => response.on('finish', resolve));
  assert.equal(response.statusCode, 206);
  assert.equal(headers['Content-Range'], 'bytes 2-5/10');
  assert.equal(headers['Content-Length'], 4);
  assert.equal(body, '2345');
});
