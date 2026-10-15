const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const LEVELS = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];
const emptyCounts = () => Object.fromEntries(LEVELS.map(level => [level, 0]));
const isFinding = filename => typeof filename === 'string' && /\/findings\/.+\.md$/i.test(filename);
const fresh = () => ({ version: VERSION, createdAt: new Date().toISOString(), updatedAt: null, repos: null, searches: [{ prefix: '' }], scannedRepos: {}, paths: {}, coverage: {}, discoveryComplete: false, calls: 0, lastError: null, pauseReason: null });
const globEscape = value => value.replace(/[?*\[]/g, character => character === '[' ? '[[]' : `[${character}]`);

// Only the local, owner-readable index is persisted. Neither the bearer token nor
// source document bodies enter this file. Credential fingerprints isolate accounts.
function createClippyIndex({ call, ensureConnection, parseFinding, safePath, storePath = null } = {}) {
  let account = null;
  let state = fresh();
  let loaded = false;
  let job = null;
  let controller = null;
  let runState = 'idle';
  let revision = 0;
  function persist() {
    if (!storePath || !account) return;
    const directory = path.dirname(storePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.clippy-index-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...state, account }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, storePath);
      if (process.platform !== 'win32') fs.chmodSync(storePath, 0o600);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function activate(fingerprint) {
    if (account === fingerprint && loaded) return;
    controller?.abort();
    revision++;
    account = fingerprint;
    loaded = true;
    state = fresh();
    runState = 'idle';
    if (!storePath) return;
    try {
      const stat = fs.lstatSync(storePath);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) return;
      const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (saved.version === VERSION && saved.account === account && saved.paths && saved.scannedRepos && Array.isArray(saved.searches) && (!saved.repos || Array.isArray(saved.repos))) state = saved;
    } catch {}
  }
  function deactivate() {
    controller?.abort();
    revision++;
    account = null;
    loaded = false;
    state = fresh();
    runState = 'idle';
  }
  function rows({ includePending = false } = {}) {
    return Object.values(state.paths).map(entry => entry.metadata || (includePending ? { ...parseFinding(entry.hit.path, entry.hit), metadataPending: true } : null)).filter(Boolean);
  }
  function progress() {
    const entries = Object.values(state.paths);
    const metadataLoaded = entries.filter(entry => entry.metadata).length;
    const reposScanned = Object.keys(state.scannedRepos).length;
    const saturatedRepos = Object.values(state.scannedRepos).filter(repo => !repo.complete).length;
    const repoTotal = state.repos?.length ?? null;
    const complete = Boolean(state.repos && state.discoveryComplete && reposScanned === repoTotal && !saturatedRepos && metadataLoaded === entries.length && !entries.some(entry => entry.metadata?.metadataUnavailable));
    return {
      state: runState, running: runState === 'running', findings: entries.length, metadataLoaded,
      metadataPending: entries.length - metadataLoaded, reposScanned, reposTotal: repoTotal, saturatedRepos,
      unavailable: entries.filter(entry => entry.metadata?.metadataUnavailable).length,
      searchPartitionsPending: state.searches.length, discoveryComplete: state.discoveryComplete,
      complete, partial: !complete, calls: state.calls, createdAt: state.createdAt, updatedAt: state.updatedAt,
      lastUpdated: state.updatedAt, lastError: state.lastError, pauseReason: state.pauseReason || null,
      note: complete ? 'All finding files returned by the indexed engagement inventory have been loaded. This is a Clippy snapshot, not proof of current target or Dradis state.' : 'This incremental inventory is incomplete. Continue indexing to discover more findings and load their metadata. Saturated or unreadable repositories remain explicitly incomplete.',
    };
  }
  function addHit(hit) {
    if (!isFinding(hit?.path)) return;
    try { safePath(hit.path); } catch { return; }
    if (!state.paths[hit.path]) state.paths[hit.path] = { hit: { path: hit.path, repo: hit.repo || hit.path.split('/')[0], snippet: String(hit.snippet || '').slice(0, 1500), line: hit.line || 1, total_lines: hit.total_lines ?? null } };
  }
  function record(hits, metadata = []) {
    for (const hit of hits || []) addHit(hit);
    for (const row of metadata) {
      addHit(row);
      if (state.paths[row.path]) { const { content, ...header } = row; state.paths[row.path].metadata = header; }
    }
    state.updatedAt = new Date().toISOString();
    try { persist(); } catch { state.lastError = 'The local intelligence index could not be saved.'; }
  }
  function nextTask(preferDiscovery = false) {
    if (!state.repos) return { kind: 'repos' };
    const pending = Object.values(state.paths).find(entry => !entry.metadata);
    if (preferDiscovery && state.searches.length) return { kind: 'search', ...state.searches[0] };
    // Yield a visible header regularly while subdividing large search branches.
    // A bounded first batch must produce useful rows, not only queued paths.
    if (state.searches.length && pending && state.calls % 3 === 0) return { kind: 'read', entry: pending };
    if (state.searches.length) return { kind: 'search', ...state.searches[0] };
    const touched = [...new Set(Object.values(state.paths).map(entry => entry.hit.repo))].find(repo => !state.scannedRepos[repo]);
    if (touched && (!pending || state.calls % 4 === 0)) return { kind: 'files', repo: touched };
    if (pending) return { kind: 'read', entry: pending };
    const untouched = state.repos.find(repo => !state.scannedRepos[repo.name]);
    if (untouched) return { kind: 'files', repo: untouched.name };
    return null;
  }
  async function perform(task, signal) {
    if (task.kind === 'repos') {
      const result = await call('list_repos', {}, signal);
      if (!Array.isArray(result)) throw new Error('invalid_index_response');
      return () => { state.repos = result.filter(row => typeof row?.name === 'string' && !/[\\/\0\r\n]/.test(row.name)).map(row => ({ name: row.name, files: row.files, last_indexed_at: row.last_indexed_at, gitea_updated_at: row.gitea_updated_at })); };
    }
    if (task.kind === 'search') {
      const names = state.repos.map(repo => repo.name).filter(name => name.startsWith(task.prefix));
      // Once the partition contains a single repo, file enumeration covers even
      // findings without a severity field and avoids the 100-result FTS ceiling.
      if (names.length === 1) {
        const apply = await perform({ kind: 'files', repo: names[0] }, signal);
        return () => { apply(); state.searches.shift(); state.discoveryComplete = state.searches.length === 0; };
      }
      const result = await call('search', { query: 'severity', limit: 100, path_glob: `${globEscape(task.prefix)}*/*findings/*.md` }, signal);
      if (!Array.isArray(result)) throw new Error('invalid_index_response');
      return () => {
        result.forEach(addHit);
        state.searches.shift();
        if (result.length >= 100 && names.length > 1) {
          const children = [...new Set(names.filter(name => name.length > task.prefix.length).map(name => name.slice(0, task.prefix.length + 1)))].sort().map(prefix => {
            const branch = names.filter(name => name.startsWith(prefix));
            let end = prefix.length;
            while (branch.every(name => name.length > end && name[end] === branch[0][end])) end++;
            return branch[0].slice(0, end);
          });
          // An exact repo may share its name with a prefix; it is enumerated in
          // the later repo phase, so the trie cannot lose that branch.
          state.searches.unshift(...children.map(prefix => ({ prefix })));
        }
        state.discoveryComplete = state.searches.length === 0;
      };
    }
    if (task.kind === 'files') {
      const result = await call('list_files', { repo: task.repo, path_glob: `${globEscape(task.repo)}/*findings/*.md`, limit: 500 }, signal);
      if (!Array.isArray(result)) throw new Error('invalid_index_response');
      return () => {
        result.filter(row => row?.path?.startsWith(`${task.repo}/`)).forEach(addHit);
        state.scannedRepos[task.repo] = { complete: result.length < 500, count: result.length, checkedAt: new Date().toISOString() };
      };
    }
    const hit = task.entry.hit;
    const document = await call('read', { path: hit.path, offset: 1, limit: 150 }, signal);
    if (typeof document?.content !== 'string') throw new Error('invalid_index_response');
    const { content, ...metadata } = parseFinding(hit.path, hit, document);
    return () => { state.paths[hit.path].metadata = metadata; };
  }
  async function start({ maxCalls = 100, maxDurationMs = 120000, reset = false } = {}) {
    await ensureConnection();
    if (job && runState === 'running') return { index: progress() };
    if (reset && typeof reset !== 'boolean') { const error = new Error('Choose a valid refresh option.'); error.code = 'invalid_input'; throw error; }
    const budget = Number(maxCalls);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 500) { const error = new Error('Choose an index budget between 1 and 500 calls.'); error.code = 'invalid_input'; error.status = 400; throw error; }
    const duration = Number(maxDurationMs);
    if (!Number.isSafeInteger(duration) || duration < 10 || duration > 120000) { const error = new Error('Choose an index duration between 10 and 120000 milliseconds.'); error.code = 'invalid_input'; throw error; }
    if (reset) { state = fresh(); revision++; }
    else for (const entry of Object.values(state.paths)) if (entry.metadata?.metadataUnavailable) delete entry.metadata;
    const epoch = revision;
    const activeState = state;
    const abort = new AbortController();
    controller = abort;
    runState = 'running';
    state.lastError = null;
    state.pauseReason = null;
    const deadline = setTimeout(() => {
      if (controller !== abort || epoch !== revision) return;
      state.pauseReason = 'time_budget';
      runState = 'paused';
      revision++;
      abort.abort(new DOMException('Clippy index batch reached its time budget', 'TimeoutError'));
      try { persist(); } catch { state.lastError = 'The local intelligence index could not be saved.'; }
    }, duration);
    deadline.unref?.();
    // Detached from the HTTP request on purpose: clients can poll or cancel this
    // explicit bounded job without an open request owning the credential lifetime.
    job = (async () => {
      let used = 0;
      let previousReadBatch = false;
      while (!abort.signal.aborted && epoch === revision && used < budget) {
        const task = nextTask(previousReadBatch);
        if (!task) break;
        const tasks = task.kind === 'read' ? Object.values(state.paths).filter(entry => !entry.metadata).slice(0, Math.min(6, budget - used)).map(entry => ({ kind: 'read', entry })) : [task];
        previousReadBatch = task.kind === 'read';
        // Reserve every lookup before launching a batch, including failures.
        // Discovery remains serial; only independent document headers fan out.
        used += tasks.length;
        const results = await Promise.allSettled(tasks.map(async activeTask => {
          state.calls++;
          try {
            const apply = await perform(activeTask, abort.signal);
            if (abort.signal.aborted || epoch !== revision) return;
            apply();
            state.updatedAt = new Date().toISOString();
          } catch (error) {
            if (abort.signal.aborted || epoch !== revision) return;
            if (activeTask.kind === 'read' && ['tool_error', 'invalid_response'].includes(error.code)) {
              state.paths[activeTask.entry.hit.path].metadata = { ...parseFinding(activeTask.entry.hit.path, activeTask.entry.hit), metadataUnavailable: true };
              return;
            }
            throw error;
          }
        }));
        if (abort.signal.aborted || epoch !== revision) break;
        if (results.some(result => result.status === 'rejected')) {
          state.lastError = 'Indexing stopped because Clippy or the local index was unavailable. Your loaded findings are retained; retry to continue.';
          state.pauseReason = 'upstream_error';
          runState = 'error';
          break;
        }
        try { persist(); } catch { state.lastError = 'The local intelligence index could not be saved.'; runState = 'error'; break; }
      }
      if (epoch === revision && state === activeState) {
        if (runState !== 'error') runState = abort.signal.aborted ? 'paused' : progress().complete ? 'complete' : 'paused';
        if (runState === 'paused' && !state.pauseReason) state.pauseReason = used >= budget ? 'call_budget' : 'incomplete_inventory';
        try { persist(); } catch { state.lastError = 'The local intelligence index could not be saved.'; }
      }
    })().finally(() => { clearTimeout(deadline); if (controller === abort) { controller = null; job = null; } });
    return { index: progress() };
  }
  async function status() { await ensureConnection(); return { index: progress() }; }
  async function cancel() { await ensureConnection(); controller?.abort(); revision++; if (runState === 'running') { runState = 'paused'; state.pauseReason = 'cancelled'; } return { index: progress() }; }
  async function waitForIdle() { if (job) await job; return progress(); }
  function coverage(domain) { return state.coverage[domain] || { status: 'unknown', label: 'Report coverage not checked', projects: [], note: 'No report lookup has been performed against the cached Dradis feed.' }; }
  function saveCoverage(domain, value) { state.coverage[domain] = value; persist(); }
  return { activate, deactivate, record, rows, progress, start, status, cancel, waitForIdle, coverage, saveCoverage };
}
function defaultIndexPath(env = process.env) { return path.join(path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados')), 'clippy-intel', 'findings-index.json'); }
module.exports = { createClippyIndex, defaultIndexPath, emptyCounts, globEscape };
