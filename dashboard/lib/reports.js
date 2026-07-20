const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { GLADOS_REPORTS_DIR, GLADOS_INVESTIGATIONS_DIR } = require('./config');
const { isLoosePlaywrightArtifact } = require('./runtime-reset');

const REPORTS_ROOT = path.resolve(GLADOS_REPORTS_DIR || path.join(os.homedir(), '.glados', 'reports'));
const INVESTIGATIONS_ROOT = path.resolve(
  GLADOS_INVESTIGATIONS_DIR || path.join(os.homedir(), '.glados', 'investigations')
);
const ROOTS = [
  { key: 'reports', name: 'Published Reports', root: REPORTS_ROOT },
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

// Extensions previewed inline as text (syntax-highlighting is client-side / off).
const TEXT_EXTS = new Set([
  '.md', '.txt', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
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
  if (/(?:^|[\s._-])(?:repo|repos|repository|repositories)(?:$|[\s._-])/.test(normalizedName)) return true;
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

function tree() {
  const prefixNodes = (nodes, key) => nodes.map(n => ({
    ...n,
    path: `${key}/${n.path}`,
    children: n.children ? prefixNodes(n.children, key) : undefined,
  }));
  const rootStates = {};
  const nodes = ROOTS.map(r => {
    const state = { count: 0, truncated: false };
    const children = prefixNodes(walk(r.root, '', state), r.key);
    rootStates[r.key] = state;
    return { type: 'dir', name: r.name, path: r.key, children };
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
  const resolved = path.resolve(rootInfo.root, parts.join('/'));
  if (resolved !== rootInfo.root && !resolved.startsWith(rootInfo.root + path.sep)) {
    throw new Error(`path escapes ${key} root`);
  }
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
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(resolved).pipe(res);
}

function deleteFile(relPath) {
  const resolved = safeResolve(relPath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new Error('refusing to delete directory');
  fs.unlinkSync(resolved);
  return { ok: true, deleted: relPath };
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
  deleteFile,
  writeMarkdown,
  walk,
  shouldIgnoreDirectory,
  shouldIgnoreFile,
  INVESTIGATIONS_ROOT,
  REPORTS_ROOT,
};
