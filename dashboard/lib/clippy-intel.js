const path = require('node:path');
const { createHash } = require('node:crypto');
const { Agent: HttpAgent, fetch: httpFetch } = require('undici');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { CLIPPY_URL, loadClippyToken } = require('./secrets/clippy-mcp');
const { createClippyIndex, defaultIndexPath, emptyCounts } = require('./clippy-index');

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];
const DASHBOARD_TOOLS = new Set(['search', 'read', 'list_repos', 'list_files', 'projects_search']);
const REQUIRED_TOOLS = ['search', 'read', 'list_repos', 'list_files'];
const SEARCH_LIMIT = 100; // The upstream server clamps search to 100 and exposes no cursor.
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

class ClippyError extends Error {
  constructor(code, message, status = 502) { super(message); this.name = 'ClippyError'; this.code = code; this.status = status; }
}
function normalizeError(error) {
  if (error instanceof ClippyError) return error;
  if (error?.code === 'invalid_input') return new ClippyError('invalid_input', error.message, 400);
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === -32001) return new ClippyError('timeout', 'Clippy did not respond in time. Try again.', 504);
  if (error?.code === 401 || error?.code === 403) return new ClippyError('authentication_failed', 'Clippy rejected the saved API key. Reconnect Clippy in Connectors.', 502);
  return new ClippyError('upstream_error', 'Clippy could not complete this request. Try again or check the connection in Connectors.');
}
function input(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new ClippyError('invalid_input', `Choose a valid ${label}.`, 400);
  return value.trim();
}
function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new ClippyError('invalid_input', 'Enter a valid page range.', 400);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ClippyError('invalid_input', 'Enter a valid page range.', 400);
  return number;
}
function repoName(value) {
  const repo = input(value, 'engagement repo', 255);
  if (/[\\/]/.test(repo) || repo === '.' || repo === '..') throw new ClippyError('invalid_input', 'Choose a valid engagement repo.', 400);
  return repo;
}
function filePath(value, repo) {
  const filename = input(value, 'file', 2048);
  if (filename.startsWith('/') || filename.includes('\\') || filename.split('/').some(part => part === '.' || part === '..' || !part)) throw new ClippyError('invalid_input', 'Choose a valid file.', 400);
  if (repo && !filename.startsWith(`${repo}/`)) throw new ClippyError('invalid_input', 'The file must belong to the selected engagement repo.', 400);
  if (filename.split('/').length < 2) throw new ClippyError('invalid_input', 'Choose a file within an engagement repo.', 400);
  return filename;
}
function findingId(filename) { return Buffer.from(filename, 'utf8').toString('base64url'); }
function findingPath(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,4096}$/.test(id)) throw new ClippyError('invalid_input', 'Choose a valid finding.', 400);
  const filename = Buffer.from(id, 'base64url').toString('utf8');
  if (findingId(filename) !== id || !/\/findings\/.+\.md$/i.test(filename)) throw new ClippyError('invalid_input', 'Choose a valid finding.', 400);
  return filePath(filename);
}
function unnumber(content) { return String(content || '').replace(/^\d+: ?/gm, ''); }
function plain(value) { return String(value || '').replace(/<\/?mark>/gi, '').replace(/[*_`]/g, '').trim(); }
function severity(value) {
  const level = plain(value).toLowerCase().match(/^(critical|high|medium|moderate|low|info(?:rmational)?|none)\b/)?.[1];
  return level === 'moderate' ? 'medium' : level === 'informational' || level === 'none' ? 'info' : level || 'unknown';
}
function metadataValue(content, names) {
  const namesPattern = names.join('|');
  for (const line of content.split(/\r?\n/).slice(0, 150)) {
    const normalized = line.replace(/[*_`]/g, '').trim();
    const table = normalized.match(new RegExp(`^\\|?\\s*(?:${namesPattern})\\s*\\|\\s*([^|]+)`, 'i'));
    const field = normalized.match(new RegExp(`^(?:[-+]\\s*)?(?:${namesPattern})\\s*:\\s*(.+)$`, 'i'));
    if (table || field) return plain((table || field)[1]).replace(/^['"]|['"]$/g, '');
  }
  return null;
}
function domainName(value) {
  if (typeof value !== 'string' || value.length > 253) return null;
  const domain = value.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? domain : null;
}
function targetMetadata(content) {
  const targets = new Set();
  const targetSources = [];
  const lines = content.split(/\r?\n/).slice(0, 150);
  let targetSection = null;
  function addTargets(value, field, line) {
    const values = value.match(/(?<![a-z0-9_.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![a-z0-9_.-])/gi) || [];
    for (const value of values) {
      const domain = domainName(value);
      if (!domain || /\.(?:md|png|jpg|jpeg|json|html|js|css|pdf|txt)$/i.test(domain)) continue;
      targets.add(domain);
      targetSources.push({ domain, field, line });
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\*\*|__|`/g, '').trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) targetSection = /^(?:affected\s+)?(?:targets?|assets?|hosts?|domains?|endpoints?)(?:\s*[:—-].*)?$/i.test(heading[1]) ? heading[1] : null;
    if (targetSection) addTargets(line, targetSection, index + 1);
    const field = line.match(/^\|?\s*(?:[-+]\s*)?(target(?: url| domain| host|s)?|affected (?:asset|host|domain|url|endpoint)s?|asset(?: url)?|domain|hostname|host|url|endpoint)\s*(?:\||:)\s*(.*)$/i);
    if (field) addTargets(field[2], field[1], index + 1);
  }
  return { targets: [...targets].slice(0, 50), targetSources: targetSources.slice(0, 50) };
}
function parseFinding(filename, result = {}, document = {}) {
  const content = unnumber(document.content || '');
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  return {
    id: findingId(filename), path: filename, repo: result.repo || filename.split('/')[0],
    title: plain(metadataValue(content, ['title']) || heading || path.posix.basename(filename, '.md').replace(/[-_]/g, ' ')),
    severity: severity(metadataValue(content, ['severity', 'risk(?: level)?']) || ''),
    category: metadataValue(content, ['category', 'finding type', 'type']) || null,
    snippet: plain(result.snippet || ''), line: result.line || 1,
    total_lines: document.total_lines ?? result.total_lines ?? null,
    ...targetMetadata(content),
    ...(document.content !== undefined ? { content, truncated: Boolean(document.truncated), is_text: document.is_text !== false } : {}),
  };
}
function unwrapToolResult(result) {
  if (result?.isError) throw new ClippyError('tool_error', 'Clippy could not read this data. It may be unavailable or outside this key’s access.');
  let data = result?.structuredContent;
  if (data === undefined) {
    const texts = result?.content?.filter(block => block.type === 'text').map(block => block.text) || [];
    for (const text of texts) { try { data = JSON.parse(text); break; } catch {} }
  }
  if (data === undefined || data === null) throw new ClippyError('invalid_response', 'Clippy returned an unreadable response.');
  // Python MCP list results are wrapped in {result:[...]}; dict results are unwrapped.
  return data && !Array.isArray(data) && Object.keys(data).length === 1 && 'result' in data ? data.result : data;
}
function boundedFetch(fetchImpl, timeoutMs, maxBytes) {
  return async (url, init = {}) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]) });
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new ClippyError('response_too_large', 'Clippy returned more data than this view can display. Narrow the search.');
    }
    if (!response.body) return response;
    let size = 0;
    const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ClippyError('response_too_large', 'Clippy returned more data than this view can display. Narrow the search.');
      controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
async function connectClient(token, { fetchImpl = httpFetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const client = new Client({ name: 'glados-clippy-dashboard', version: '1.0.0' });
  // Own this connection's sockets so disconnect/rotation cannot leave an idle
  // MCP SSE connection keeping the process or a credential alive.
  const dispatcher = new HttpAgent({ keepAliveTimeout: 1000, keepAliveMaxTimeout: 1000 });
  const closeClient = client.close.bind(client);
  client.close = async () => { try { await closeClient(); } finally { await dispatcher.destroy(); } };
  const transport = new StreamableHTTPClientTransport(new URL(CLIPPY_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: boundedFetch((url, init) => fetchImpl(url, { ...init, dispatcher }), timeoutMs, maxResponseBytes),
    reconnectionOptions: { maxRetries: 0 },
  });
  try { await client.connect(transport, { timeout: timeoutMs }); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}
async function mapConcurrent(rows, concurrency, action) {
  const output = new Array(rows.length);
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (!failed && cursor < rows.length) { const index = cursor++; try { output[index] = await action(rows[index], index); } catch (error) { failed = true; throw error; } }
  }));
  return output;
}

function createClippyService({ env = process.env, client: injectedClient, clientFactory = connectClient, tokenProvider = () => loadClippyToken(env), timeoutMs = DEFAULT_TIMEOUT_MS, cacheMs = 120000, fetchImpl = httpFetch, indexPath = injectedClient ? null : defaultIndexPath(env) } = {}) {
  let connection, connectionToken, connecting;
  let connectionGeneration = 0;
  const cache = new Map();
  const index = createClippyIndex({ call, ensureConnection: currentClient, parseFinding, safePath: filePath, storePath: indexPath });
  async function currentClient() {
    if (injectedClient) { index.activate('injected-test-client'); return injectedClient; }
    let token;
    try { token = tokenProvider(); }
    catch { throw new ClippyError('credential_error', 'Clippy’s saved API key could not be read. Reconnect Clippy in Connectors.', 503); }
    if (!token) {
      await close();
      throw new ClippyError('not_connected', 'Connect Clippy in Connectors to browse its findings and engagement repos.', 503);
    }
    index.activate(createHash('sha256').update(token).digest('hex'));
    if (connectionToken === token) {
      if (connection) return connection;
      if (connecting) return connecting;
    }
    // Publish the in-flight connection before the first await. Concurrent requests
    // share it; a rotation/disconnect invalidates its generation immediately.
    const generation = ++connectionGeneration;
    const old = connection;
    connection = undefined;
    connectionToken = token;
    cache.clear();
    const pending = Promise.resolve().then(() => clientFactory(token, { timeoutMs, fetchImpl })).then(async active => {
      if (generation !== connectionGeneration || connectionToken !== token) {
        await active?.close?.().catch(() => {});
        throw new ClippyError('connection_changed', 'The Clippy connection changed. Try again.', 503);
      }
      connection = active;
      return active;
    }).catch(error => {
      if (generation === connectionGeneration) { connectionToken = undefined; connection = undefined; }
      throw normalizeError(error);
    }).finally(() => { if (connecting === pending) connecting = undefined; });
    connecting = pending;
    if (old?.close) await old.close().catch(() => {});
    return pending;
  }
  async function close() {
    ++connectionGeneration;
    const old = connection;
    connection = undefined; connectionToken = undefined; connecting = undefined; cache.clear();
    index.deactivate();
    // Pending factories close their own discarded client after they resolve.
    if (old?.close) await old.close().catch(() => {});
  }
  async function call(name, args, signal) {
    if (!DASHBOARD_TOOLS.has(name)) throw new ClippyError('tool_denied', 'This view supports read-only Clippy tools.', 400);
    try {
      signal?.throwIfAborted();
      const active = await currentClient();
      const generation = connectionGeneration;
      const result = await active.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal });
      await currentClient();
      if (generation !== connectionGeneration) throw new ClippyError('connection_changed', 'The Clippy connection changed. Try again.', 503);
      return unwrapToolResult(result);
    } catch (error) { throw normalizeError(error); }
  }
  async function cached(key, action) {
    // Check credentials even for cached data so disconnects take effect immediately.
    await currentClient();
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    const generation = connectionGeneration;
    const value = await action();
    if (generation !== connectionGeneration) throw new ClippyError('connection_changed', 'The Clippy connection changed. Try again.', 503);
    if (cache.size >= 120) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + cacheMs });
    return value;
  }
  async function status({ signal } = {}) {
    try {
      const active = await currentClient();
      const tools = await active.listTools({}, { timeout: timeoutMs, signal });
      const names = new Set(tools.tools?.map(tool => tool.name));
      const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
      if (missing.length) throw new ClippyError('unsupported_server', 'This Clippy connection does not provide the read tools this dashboard needs.');
      return { connected: true, status: 'connected', source: 'clippy-mcp', toolCount: tools.tools.length, reportCoverageAvailable: names.has('projects_search'), index: index.progress() };
    } catch (error) {
      const safe = normalizeError(error);
      return { connected: false, status: safe.code === 'not_connected' ? 'disconnected' : 'error', source: 'clippy-mcp', code: safe.code, message: safe.message };
    }
  }
  async function repos({ q = '', signal } = {}) {
    if (q && (typeof q !== 'string' || q.length > 200)) throw new ClippyError('invalid_input', 'Use a shorter repo filter.', 400);
    const all = await cached('repos', async () => {
      const result = await call('list_repos', {}, signal);
      if (!Array.isArray(result)) throw new ClippyError('invalid_response', 'Clippy returned an unreadable repo list.');
      return result.filter(row => typeof row?.name === 'string').map(row => ({ ...row, id: row.name }));
    });
    const filtered = all.filter(repo => repo.name.toLowerCase().includes(q.toLowerCase()));
    return { repos: filtered, total: filtered.length, source: 'clippy-mcp' };
  }
  async function files({ repo, signal } = {}) {
    const selected = repoName(repo);
    return cached(`files:${selected}`, async () => {
      const result = await call('list_files', { repo: selected, limit: 500 }, signal);
      if (!Array.isArray(result)) throw new ClippyError('invalid_response', 'Clippy returned an unreadable file list.');
      return { files: result, repo: selected, limit: 500, partial: result.length >= 500, source: 'clippy-mcp' };
    });
  }
  async function file({ repo, path: filename, offset, limit, signal } = {}) {
    const selected = repoName(repo);
    const safePath = filePath(filename, selected);
    const start = integer(offset, 1, 1, 10000000);
    const count = integer(limit, 500, 1, 1000);
    const result = await call('read', { path: safePath, offset: start, limit: count }, signal);
    if (!result || typeof result !== 'object' || typeof result.content !== 'string') throw new ClippyError('invalid_response', 'Clippy returned an unreadable file.');
    return { ...result, path: safePath, repo: selected, offset: start, limit: count, source: 'clippy-mcp', lineNumbered: true };
  }
  async function finding({ id, signal } = {}) {
    const filename = findingPath(id);
    const result = await file({ repo: filename.split('/')[0], path: filename, limit: 1000, signal });
    return { finding: parseFinding(filename, {}, result), source: 'clippy-mcp' };
  }
  async function findings({ q = '', repo = '', severity: selectedSeverity = '', category = '', offset, limit, signal } = {}) {
    if (typeof q !== 'string' || q.length > 300 || /[\0\r\n]/.test(q)) throw new ClippyError('invalid_input', 'Use a shorter finding search.', 400);
    if (q.trim() && q.trim().length < 3) throw new ClippyError('invalid_input', 'Use at least three characters to search Clippy findings.', 400);
    if (selectedSeverity && !SEVERITIES.includes(selectedSeverity)) throw new ClippyError('invalid_input', 'Choose a valid severity.', 400);
    if (category && (typeof category !== 'string' || category.length > 200)) throw new ClippyError('invalid_input', 'Choose a valid category.', 400);
    const selectedRepo = repo ? repoName(repo) : '';
    const start = integer(offset, 0, 0, 1000000);
    const count = integer(limit, 25, 1, 25);
    await currentClient();
    // Once an explicit inventory job has made progress, browse the accumulated
    // catalog instead of repeatedly asking the same capped FTS query.
    if (index.progress().calls > 0) {
      const needle = q.trim().toLowerCase();
      const loaded = index.rows({ includePending: true }).filter(row => (!selectedRepo || row.repo === selectedRepo) && (!needle || [row.title, row.path, row.snippet, ...(row.targets || [])].join(' ').toLowerCase().includes(needle)));
      const base = loaded.filter(row => !category || row.category === category);
      const counts = emptyCounts();
      for (const row of base) if (!row.metadataPending) counts[row.severity]++;
      const filtered = base.filter(row => !selectedSeverity || (!row.metadataPending && row.severity === selectedSeverity)).sort((a, b) => Number(Boolean(a.metadataPending)) - Number(Boolean(b.metadataPending)) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.path.localeCompare(b.path));
      const progress = index.progress();
      const metadataPending = base.filter(row => row.metadataPending).length;
      return { findings: filtered.slice(start, start + count), total: filtered.length, counts, severityCounts: counts, countsScope: 'parsed_indexed_findings', totalUnfiltered: base.length, baseTotal: base.length, metadataPending, metadataLoaded: base.length - metadataPending, categories: [...new Set(loaded.map(row => row.category).filter(Boolean))].sort(), repos: [...new Set(loaded.map(row => row.repo))].sort(), offset: start, limit: count, hasMore: start + count < filtered.length, nextOffset: start + count, indexedMatches: progress.findings, partial: progress.partial, sampled: progress.metadataLoaded, unavailable: loaded.filter(row => row.metadataUnavailable).length, upstreamLimit: SEARCH_LIMIT, index: progress, source: 'clippy-mcp', note: `Showing all discovered finding paths across engagement repos, including ${metadataPending} awaiting metadata. Severity counts and severity/category filters include parsed metadata only; pending rows are not classified as unspecified. ${progress.note} Text filters search the indexed title, path, target, and snippet.` };
    }
    const terms = q.trim() ? [`"${q.trim().replace(/"/g, '""')}"`] : ['severity'];
    if (selectedSeverity && selectedSeverity !== 'unknown') terms.push(selectedSeverity === 'info' ? '(info OR informational)' : selectedSeverity);
    const query = terms.join(' AND ');
    const key = `findings:${JSON.stringify([query, selectedRepo])}`;
    const sample = await cached(key, async () => {
      const hits = await call('search', { query, limit: SEARCH_LIMIT, path_glob: `${selectedRepo || '*'}/*findings/*.md` }, signal);
      if (!Array.isArray(hits)) throw new ClippyError('invalid_response', 'Clippy returned an unreadable findings list.');
      const unique = [...new Map(hits.filter(hit => typeof hit?.path === 'string' && /\/findings\/.+\.md$/i.test(hit.path) && (!selectedRepo || hit.path.startsWith(`${selectedRepo}/`))).map(hit => [hit.path, hit])).values()];
      return { hits: unique, metadata: new Map() };
    });
    // Only read metadata for this upstream page, including filtered views.
    // Severity is taken from the document, never guessed from its FTS match.
    const selectedHits = sample.hits.slice(start, start + count);
    await mapConcurrent(selectedHits.filter(hit => !sample.metadata.has(hit.path)), 6, async hit => {
      filePath(hit.path, selectedRepo || undefined);
      try {
        const result = await cached(`header:${hit.path}`, () => call('read', { path: hit.path, offset: 1, limit: 150 }, signal));
        const { content, ...metadata } = parseFinding(hit.path, hit, result);
        sample.metadata.set(hit.path, metadata);
      } catch (error) {
        if (signal?.aborted || ['authentication_failed', 'timeout', 'not_connected', 'credential_error'].includes(error.code)) throw error;
        sample.metadata.set(hit.path, { ...parseFinding(hit.path, hit), metadataUnavailable: true });
      }
    });
    const loaded = [...sample.metadata.values()];
    index.record(sample.hits, loaded);
    const base = loaded.filter(row => !category || row.category === category);
    const counts = Object.fromEntries(SEVERITIES.map(level => [level, base.filter(row => row.severity === level).length]));
    const filtered = base.filter(row => !selectedSeverity || row.severity === selectedSeverity);
    const visiblePaths = new Set(selectedHits.map(hit => hit.path));
    const page = filtered.filter(row => visiblePaths.has(row.path)).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.title.localeCompare(b.title));
    const total = filtered.length;
    return {
      findings: page, total, counts, severityCounts: counts, countsScope: 'loaded_matches',
      categories: [...new Set(loaded.map(row => row.category).filter(Boolean))].sort(),
      repos: [...new Set(sample.hits.map(row => row.repo || row.path.split('/')[0]))].sort(), offset: start, limit: count,
      hasMore: start + count < sample.hits.length, nextOffset: start + count, indexedMatches: sample.hits.length, partial: true, sampled: loaded.length,
      unavailable: loaded.filter(row => row.metadataUnavailable).length, upstreamLimit: SEARCH_LIMIT, index: index.progress(), source: 'clippy-mcp',
      note: `Clippy caps each search at ${SEARCH_LIMIT} matches and provides no page cursor. Index intelligence to browse across engagement repositories beyond that ceiling. Counts currently describe the ${loaded.length} loaded matches.`,
    };
  }
  async function opportunities({ q = '', severity: selectedSeverity = '', reportCoverage = 'all', offset, limit } = {}) {
    await currentClient();
    if (typeof q !== 'string' || q.length > 300) throw new ClippyError('invalid_input', 'Use a shorter opportunity filter.', 400);
    if (selectedSeverity && !SEVERITIES.includes(selectedSeverity)) throw new ClippyError('invalid_input', 'Choose a valid severity.', 400);
    if (!['all', 'missing', 'found'].includes(reportCoverage)) throw new ClippyError('invalid_input', 'Choose a valid report coverage filter.', 400);
    const start = integer(offset, 0, 0, 1000000);
    const count = integer(limit, 25, 1, 100);
    const groups = new Map();
    for (const finding of index.rows()) for (const domain of finding.targets || []) {
      if (!groups.has(domain)) groups.set(domain, { domain, counts: emptyCounts(), repos: [], findings: [], sources: [], reportCoverage: index.coverage(domain) });
      const row = groups.get(domain);
      row.counts[finding.severity]++;
      if (!row.repos.includes(finding.repo)) row.repos.push(finding.repo);
      // Counts retain the entire local scope while response evidence is bounded.
      if (row.findings.length < 10) row.findings.push({ id: finding.id, title: finding.title, severity: finding.severity, repo: finding.repo, path: finding.path });
      if (row.sources.length < 10) row.sources.push({ path: finding.path, repo: finding.repo, line: finding.targetSources?.find(source => source.domain === domain)?.line || 1 });
    }
    const rows = [...groups.values()].filter(row => (!q || `${row.domain} ${row.repos.join(' ')}`.toLowerCase().includes(q.toLowerCase())) && (!selectedSeverity || row.counts[selectedSeverity] > 0) && (reportCoverage === 'all' || (reportCoverage === 'found' ? row.reportCoverage.status === 'reported' : row.reportCoverage.status !== 'reported')));
    for (const row of rows) row.priority = row.counts.critical * 100 + row.counts.high * 10 + row.counts.medium;
    rows.sort((a, b) => b.priority - a.priority || a.domain.localeCompare(b.domain));
    return { opportunities: rows.slice(start, start + count), total: rows.length, offset: start, limit: count, nextOffset: start + count, hasMore: start + count < rows.length, index: index.progress(), source: 'clippy-mcp', note: 'Historical leads are ranked by indexed critical and high findings. Domains come from explicit target metadata; findings without target metadata cannot be grouped. Report coverage is unknown until checked against Clippy’s cached Dradis project feed. A missing match does not prove that no Dradis report exists, and these leads do not authorize testing.' };
  }
  async function reportCoverage({ domain: value, signal } = {}) {
    const domain = domainName(value);
    if (!domain) throw new ClippyError('invalid_input', 'Choose a valid target domain.', 400);
    const result = await call('projects_search', { query: domain, limit: 100 }, signal);
    if (!Array.isArray(result?.projects) || !Number.isSafeInteger(result.total_matched)) throw new ClippyError('invalid_response', 'Clippy returned an unreadable report coverage result.');
    const projects = result.projects.slice(0, 100).map(project => {
      let url = null;
      try { const parsed = new URL(project.project_url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch {}
      return { id: project.project_id, name: String(project.name || '').slice(0, 500), status: String(project.status || 'Unknown').slice(0, 100), url, dates: project.dates || null };
    });
    const delivered = projects.some(project => /^report (?:delivered|closed)$/i.test(project.status));
    const coverage = { status: delivered ? 'reported' : result.total_matched > 0 ? 'in_progress' : 'no_match', label: delivered ? 'Delivered report recorded in cached feed' : result.total_matched > 0 ? 'Project found; delivered report unverified' : 'No matching project in cached feed', projects, totalMatched: result.total_matched, partial: result.total_matched > projects.length, cacheAgeSeconds: Number.isFinite(result.cache_age_seconds) ? result.cache_age_seconds : null, checkedAt: new Date().toISOString(), note: 'This is a text match against Clippy’s cached Dradis project feed. Verify the linked project’s target scope and report before acting; an absent match is not proof that no report exists.' };
    index.saveCoverage(domain, coverage);
    return { domain, reportCoverage: coverage, source: 'clippy-mcp' };
  }
  return { status, findings, finding, repos, files, file, close, opportunities, reportCoverage, indexStatus: index.status, syncIndex: index.start, cancelIndex: index.cancel, waitForIndex: index.waitForIdle };
}
module.exports = { createClippyService, ClippyError, normalizeError, unwrapToolResult, parseFinding, findingId, findingPath, boundedFetch, SEVERITIES, domainName };
