const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { GLADOS_REPORTS_DIR, GLADOS_INVESTIGATIONS_DIR } = require('./config');
const { isLoosePlaywrightArtifact } = require('./runtime-reset');

const REPORTS_ROOT = path.resolve(GLADOS_REPORTS_DIR || path.join(os.homedir(), '.glados', 'reports'));
const INVESTIGATIONS_ROOT = path.resolve(
  GLADOS_INVESTIGATIONS_DIR || path.join(os.homedir(), '.glados', 'investigations')
);
const REPORT_LABELS_FILE = path.join(path.dirname(REPORTS_ROOT), 'report-labels.json');
const ROOTS = [
  { key: 'reports', name: 'Published Reports', root: REPORTS_ROOT },
  { key: 'security-reviews', name: 'Completed Security Reviews', root: INVESTIGATIONS_ROOT, virtual: true },
  { key: 'investigations', name: 'Investigation Workspaces', root: INVESTIGATIONS_ROOT },
];
// Directory rows are rendered lazily, but the complete index still crosses the
// process boundary as JSON. Keep the default payload bounded for large evidence
// corpora; operators can raise the limit explicitly when they need deep history.
const MAX_TREE_ENTRIES = Math.max(100, Number(process.env.GLADOS_REPORT_TREE_MAX_ENTRIES || 3000));
const MAX_TREE_DEPTH = Math.max(1, Number(process.env.GLADOS_REPORT_TREE_MAX_DEPTH || 16));
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git', '.hg', '.svn',
  '.venv', 'venv', 'env', '.env',
  'node_modules', 'site-packages', '__pycache__',
  '.tox', '.nox',
  'repo', 'repos', 'repository', 'repositories',
]);
const SECURITY_REVIEW_REPORT_NAMES = new Set([
  'README.md', 'EXECUTIVE-SUMMARY.md', 'SECURITY-REVIEW.md', 'OBSERVATIONS.md',
  'COVERAGE-AND-LIMITATIONS.md', 'REMEDIATION-PLAN.md', 'security-review-report.html',
  'security-review-report.pdf', 'completion-receipt.json', 'scan-manifest.json',
  'DELIVERABLES-MANIFEST.json',
]);

function securityReviewDirectories() {
  let entries = [];
  try { entries = fs.readdirSync(INVESTIGATIONS_ROOT, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => {
    const reviewRoot = path.join(INVESTIGATIONS_ROOT, entry.name, 'security-review');
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(reviewRoot, 'completion-receipt.json'), 'utf8'));
      return { directory: entry.name, reviewRoot, engagementId: receipt.engagement_id || null, receipt };
    } catch { return null; }
  }).filter(Boolean);
}

function resolveSecurityReviewDirectory(identity) {
  const exact = path.join(INVESTIGATIONS_ROOT, identity, 'security-review');
  if (fs.existsSync(path.join(exact, 'completion-receipt.json'))) return { directory: identity, reviewRoot: exact };
  const matches = securityReviewDirectories().filter(row => row.engagementId === identity);
  if (matches.length > 1) throw new Error(`security-review identity ${identity} is ambiguous across renamed folders`);
  return matches[0] || { directory: identity, reviewRoot: exact };
}

// Extensions previewed inline as text (syntax-highlighting is client-side / off).
const TEXT_EXTS = new Set([
  '.md', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.sh', '.bash', '.zsh', '.go', '.rs', '.rb',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.pl', '.lua',
  '.html', '.htm', '.css', '.scss', '.xml', '.svg',
  '.csv', '.tsv', '.sql', '.graphql', '.proto', '.env', '.gitignore',
  '.diff', '.patch',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function kindForExt(ext) {
  if (ext === '.md') return 'markdown';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

function shouldIgnoreDirectory(name, fullPath) {
  const normalizedName = String(name || '').toLowerCase();
  if (IGNORED_DIRECTORY_NAMES.has(normalizedName)) return true;
  if (/^(?:(?:github|gitlab|bitbucket|gh)[\s._-]*)?(?:repo|repos|repository|repositories)$/.test(normalizedName)) return true;
  try {
    if (fs.existsSync(path.join(fullPath, '.git'))) return true;
    if (fs.existsSync(path.join(fullPath, 'pyvenv.cfg'))) return true;
  } catch {}
  return false;
}

function shouldIgnoreFile(name, rel = '') {
  const depth = String(rel || '').split('/').filter(Boolean).length;
  return depth <= 1 && isLoosePlaywrightArtifact(name);
}

function walk(dir, rel = '', state = { count: 0, truncated: false }, depth = 0) {
  if (state.count >= MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) {
    state.truncated = true;
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (state.count >= MAX_TREE_ENTRIES) {
      state.truncated = true;
      break;
    }
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (shouldIgnoreDirectory(e.name, full)) continue;
      state.count += 1;
      const children = walk(full, r, state, depth + 1);
      if (children.length) out.push({ type: 'dir', name: e.name, path: r, children });
    } else if (e.isFile()) {
      // Playwright MCP emits disposable page snapshots and console captures at
      // its output root. Evidence saved inside an engagement remains visible.
      if (shouldIgnoreFile(e.name, rel)) continue;
      state.count += 1;
      const ext = path.extname(e.name).toLowerCase();
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      out.push({ type: 'file', name: e.name, path: r, size, mtime, kind: kindForExt(ext) });
    }
  }
  return out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function completedSecurityReviews(state = { count: 0, truncated: false }) {
  const nodes = [];
  for (const engagement of securityReviewDirectories().sort((a, b) => a.directory.localeCompare(b.directory))) {
    if (state.count >= MAX_TREE_ENTRIES) continue;
    const { reviewRoot, receipt } = engagement;
    if (receipt?.status !== 'SEALED' || receipt?.terminal_state !== 'SATURATED') continue;
    const identity = receipt.engagement_id || engagement.directory;
    state.count += 1;
    const deliveryRoot = path.join(reviewRoot, 'deliverables');
    let children = walk(deliveryRoot, identity, state, 1);
    children = children.filter(node => node.type === 'dir' || SECURITY_REVIEW_REPORT_NAMES.has(node.name));
    const rawChildren = walk(reviewRoot, `${identity}/raw`, state, 1).filter(node => node.name !== 'deliverables');
    if (rawChildren.length) children.push({ type: 'dir', name: 'Artifacts & Source Data', path: `${identity}/raw`, children: rawChildren });
    if (children.length) nodes.push({ type: 'dir', name: engagement.directory, path: identity, children });
  }
  if (state.count >= MAX_TREE_ENTRIES) state.truncated = true;
  return nodes;
}

function tree() {
  const labels = readLabels();
  const prefixNodes = (nodes, key) => nodes.map(n => ({
    ...n,
    path: `${key}/${n.path}`,
    children: n.children ? prefixNodes(n.children, key) : undefined,
  }));
  const applyLabels = nodes => nodes.map(node => ({
    ...node,
    name: labels[node.path] || node.name,
    children: node.children ? applyLabels(node.children) : undefined,
  }));
  const rootStates = {};
  const nodes = ROOTS.map(r => {
    const state = { count: 0, truncated: false };
    const children = prefixNodes(r.virtual ? completedSecurityReviews(state) : walk(r.root, '', state), r.key);
    rootStates[r.key] = state;
    return { type: 'dir', name: labels[r.key] || r.name, path: r.key, children: applyLabels(children) };
  }).filter(n => n.children.length);
  const truncatedRoots = Object.entries(rootStates).filter(([, state]) => state.truncated).map(([key]) => key);
  return {
    root: `reports: ${REPORTS_ROOT} | investigations: ${INVESTIGATIONS_ROOT}`,
    roots: Object.fromEntries(ROOTS.map(r => [r.key, r.root])),
    tree: nodes,
    truncated: truncatedRoots.length > 0,
    truncatedRoots,
    maxEntries: MAX_TREE_ENTRIES,
  };
}

function safeResolve(relPath) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  const key = parts.shift();
  const rootInfo = ROOTS.find(r => r.key === key);
  if (!rootInfo) throw new Error('path must start with reports/ or investigations/');
  let virtualSuffix = parts;
  if (rootInfo.virtual && parts.length) {
    const engagementId = parts.shift();
    const resolvedReview = resolveSecurityReviewDirectory(engagementId);
    if (parts[0] === 'raw') {
      parts.shift();
      virtualSuffix = [resolvedReview.directory, 'security-review', ...parts];
    } else {
      virtualSuffix = [resolvedReview.directory, 'security-review', 'deliverables', ...parts];
    }
  }
  const resolved = path.resolve(rootInfo.root, virtualSuffix.join('/'));
  if (resolved !== rootInfo.root && !resolved.startsWith(rootInfo.root + path.sep)) {
    throw new Error(`path escapes ${key} root`);
  }
  assertRealPathWithin(rootInfo.root, resolved, key);
  return resolved;
}

function assertRealPathWithin(root, target, label) {
  const realRoot = fs.realpathSync(root);
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`${label} path has no existing parent`);
    existing = parent;
  }
  const realTarget = fs.realpathSync(existing);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`path escapes ${label} root through a symbolic link`);
  }
}

function rootKey(relPath) {
  return String(relPath || '').split('/').filter(Boolean)[0] || '';
}

function readLabels() {
  try {
    const value = JSON.parse(fs.readFileSync(REPORT_LABELS_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeLabels(labels) {
  fs.mkdirSync(path.dirname(REPORT_LABELS_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${REPORT_LABELS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(labels, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, REPORT_LABELS_FILE);
}

function validEntryName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/\0\r\n]/.test(name)) {
    throw new Error('name must be a single non-empty path component no longer than 255 characters');
  }
  return name;
}

function isIdentityBoundPath(relPath) {
  return /^(?:reports|investigations|security-reviews)$/.test(String(relPath || ''))
    || /^(?:investigations|security-reviews)\/[^/]+$/.test(String(relPath || ''))
    || /^security-reviews\/[^/]+\/raw$/.test(String(relPath || ''));
}

function renamePath(relPath, requestedName) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  const key = parts[0];
  if (!ROOTS.some(root => root.key === key)) throw new Error('path must start with reports/, security-reviews/, or investigations/');
  const name = validEntryName(requestedName);
  const labels = readLabels();
  if (isIdentityBoundPath(relPath)) {
    labels[relPath] = name;
    writeLabels(labels);
    return { ok: true, path: relPath, name, alias: true };
  }

  const source = deleteTarget(relPath);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('refusing to rename unsupported filesystem object');
  const destination = path.join(path.dirname(source), name);
  if (destination === source) return { ok: true, path: relPath, name, alias: false };
  if (fs.existsSync(destination)) throw new Error(`an entry named ${name} already exists`);
  fs.renameSync(source, destination);
  const oldPrefix = String(relPath);
  const newPath = [...parts.slice(0, -1), name].join('/');
  const migrated = {};
  for (const [labelPath, label] of Object.entries(labels)) {
    migrated[labelPath === oldPrefix || labelPath.startsWith(`${oldPrefix}/`)
      ? `${newPath}${labelPath.slice(oldPrefix.length)}`
      : labelPath] = label;
  }
  if (JSON.stringify(migrated) !== JSON.stringify(labels)) writeLabels(migrated);
  return { ok: true, path: newPath, previousPath: relPath, name, alias: false };
}

function deleteTarget(relPath) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  const key = parts.shift();
  if (!ROOTS.some(root => root.key === key)) throw new Error('path must start with reports/, security-reviews/, or investigations/');
  if (!parts.length) return ROOTS.find(root => root.key === key).root;
  if (key !== 'security-reviews') return safeResolve(relPath);

  const engagementId = parts.shift();
  const reviewRoot = path.resolve(resolveSecurityReviewDirectory(engagementId).reviewRoot);
  if (!reviewRoot.startsWith(`${INVESTIGATIONS_ROOT}${path.sep}`)) throw new Error('path escapes security-reviews root');
  if (!parts.length) return reviewRoot;
  const suffix = parts[0] === 'raw' ? parts.slice(1) : ['deliverables', ...parts];
  const resolved = path.resolve(reviewRoot, suffix.join('/'));
  if (resolved !== reviewRoot && !resolved.startsWith(`${reviewRoot}${path.sep}`)) throw new Error('path escapes security-reviews root');
  assertRealPathWithin(INVESTIGATIONS_ROOT, resolved, 'security-reviews');
  return resolved;
}

// Returns { path, kind, content } for text/markdown, or { kind } meta for binary/image/pdf.
function readFile(relPath) {
  const resolved = safeResolve(relPath);
  const ext = path.extname(resolved).toLowerCase();
  const kind = kindForExt(ext);
  if (kind === 'markdown' || kind === 'text') {
    return { path: relPath, kind, ext, content: fs.readFileSync(resolved, 'utf8') };
  }
  // For image/pdf/binary, client should hit the raw endpoint.
  return { path: relPath, kind, ext };
}

// Streams raw bytes for images / pdfs / binary previews and downloads.
function sendRaw(relPath, res) {
  const resolved = safeResolve(relPath);
  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(resolved);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = String(res.req?.headers?.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(resolved, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(resolved).pipe(res);
}

function deletePath(relPath) {
  if (String(relPath || '') === 'security-reviews') {
    for (const engagement of fs.readdirSync(INVESTIGATIONS_ROOT, { withFileTypes: true })) {
      if (!engagement.isDirectory() || engagement.isSymbolicLink()) continue;
      const reviewRoot = path.join(INVESTIGATIONS_ROOT, engagement.name, 'security-review');
      if (!fs.existsSync(reviewRoot)) continue;
      if (fs.lstatSync(reviewRoot).isSymbolicLink()) throw new Error(`refusing to delete symbolic link ${engagement.name}/security-review`);
      fs.rmSync(reviewRoot, { recursive: true, force: false });
    }
    const labels = readLabels();
    const retained = Object.fromEntries(Object.entries(labels)
      .filter(([labelPath]) => labelPath !== relPath && !labelPath.startsWith(`${relPath}/`)));
    if (Object.keys(retained).length !== Object.keys(labels).length) writeLabels(retained);
    return { ok: true, deleted: relPath, type: 'collection' };
  }
  const resolved = deleteTarget(relPath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const labels = readLabels();
    const retained = Object.fromEntries(Object.entries(labels)
      .filter(([labelPath]) => labelPath !== relPath && !labelPath.startsWith(`${relPath}/`)));
    if (Object.keys(retained).length !== Object.keys(labels).length) writeLabels(retained);
    return { ok: true, deleted: relPath, type: 'missing', alreadyMissing: true };
  }
  if (stat.isSymbolicLink()) throw new Error('refusing to delete symbolic link');
  const key = String(relPath || '').split('/').filter(Boolean)[0];
  const collectionRoot = ROOTS.find(root => root.key === key && root.root === resolved);
  if (collectionRoot) {
    for (const entry of fs.readdirSync(resolved)) fs.rmSync(path.join(resolved, entry), { recursive: true, force: false });
  } else if (stat.isDirectory()) fs.rmSync(resolved, { recursive: true, force: false });
  else if (stat.isFile()) fs.unlinkSync(resolved);
  else throw new Error('refusing to delete unsupported filesystem object');
  const labels = readLabels();
  const retained = Object.fromEntries(Object.entries(labels)
    .filter(([labelPath]) => labelPath !== relPath && !labelPath.startsWith(`${relPath}/`)));
  if (Object.keys(retained).length !== Object.keys(labels).length) writeLabels(retained);
  return { ok: true, deleted: relPath, type: collectionRoot ? 'collection' : stat.isDirectory() ? 'directory' : 'file' };
}

// Edit is restricted to .md to avoid accidental clobbering of code/binaries.
function writeMarkdown(relPath, content) {
  const resolved = safeResolve(relPath);
  if (!/\.md$/i.test(resolved)) throw new Error('editing is only allowed for .md files');
  fs.writeFileSync(resolved, content, 'utf8');
  const st = fs.statSync(resolved);
  return { ok: true, path: relPath, size: st.size, mtime: st.mtimeMs };
}

module.exports = {
  tree,
  readFile,
  sendRaw,
  deletePath,
  deleteTarget,
  renamePath,
  completedSecurityReviews,
  writeMarkdown,
  walk,
  shouldIgnoreDirectory,
  shouldIgnoreFile,
  INVESTIGATIONS_ROOT,
  REPORTS_ROOT,
};
