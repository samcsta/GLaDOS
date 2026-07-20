const fs = require('node:fs');
const path = require('node:path');
const { proxyBackendConfig } = require('./mitmproxy-runner');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function ensureTrafficStore(config = proxyBackendConfig()) {
  fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.trafficDir, 0o700);
  if (!fs.existsSync(config.trafficJsonl)) {
    fs.writeFileSync(config.trafficJsonl, '', { mode: 0o600 });
  }
  fs.chmodSync(config.trafficJsonl, 0o600);
  return config.trafficJsonl;
}

function clearProxyTraffic(config = proxyBackendConfig()) {
  ensureTrafficStore(config);
  let filesRemoved = 0;
  let bytesRemoved = 0;
  const errors = [];
  let entries = [];
  try { entries = fs.readdirSync(config.trafficDir, { withFileTypes: true }); }
  catch (error) { return { ok: false, filesRemoved, bytesRemoved, errors: [error.message] }; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(config.trafficDir, entry.name);
    if (file === config.trafficJsonl) continue;
    if (!/^(?:proxy-events-.+\.jsonl|mitmproxy-.+\.flows)$/i.test(entry.name)) continue;
    try {
      try { bytesRemoved += fs.statSync(file).size; } catch {}
      fs.rmSync(file, { force: true });
      filesRemoved += 1;
    } catch (error) {
      errors.push(`${entry.name}: ${error.message}`);
    }
  }

  try {
    try { bytesRemoved += fs.statSync(config.trafficJsonl).size; } catch {}
    fs.truncateSync(config.trafficJsonl, 0);
    fs.chmodSync(config.trafficJsonl, 0o600);
  } catch (error) {
    errors.push(`${path.basename(config.trafficJsonl)}: ${error.message}`);
  }

  return { ok: errors.length === 0, filesRemoved, bytesRemoved, errors };
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return normalizeEvent(parsed);
  } catch {
    return null;
  }
}

function normalizeEvent(event) {
  const request = event.request || {};
  const response = event.response || {};
  const headers = lowerHeaders(request.headers || {});
  const responseHeaders = lowerHeaders(response.headers || {});
  const url = event.url || request.url || '';
  const host = event.host || (() => { try { return new URL(url).host; } catch { return ''; } })();
  return {
    id: event.id,
    ts: Number(event.ts || Date.now()),
    method: event.method || request.method || 'GET',
    url,
    host,
    status: Number(event.status || response.status || 0),
    error: String(event.error || ''),
    reqLen: Number(event.reqLen || request.bodyLen || byteLen(request.body || '')),
    respLen: Number(event.respLen || response.bodyLen || byteLen(response.body || '')),
    mime: event.mime || responseHeaders['content-type'] || '',
    agentTag: event.agentTag || headers['x-glados-agent'] || '',
    requestLine: request.line || '',
    requestHeaders: request.headers || {},
    requestBody: request.body || '',
    requestBodyTruncated: !!request.bodyTruncated,
    requestBodyLen: Number(request.bodyLen || byteLen(request.body || '')),
    statusLine: response.line || '',
    responseHeaders: response.headers || {},
    responseBody: response.body || '',
    responseBodyTruncated: !!response.bodyTruncated,
    responseBodyLen: Number(response.bodyLen || byteLen(response.body || '')),
  };
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[String(key).toLowerCase()] = String(value);
  return out;
}

function byteLen(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function rowForHistory(event) {
  return {
    id: event.id,
    ts: event.ts,
    method: event.method,
    url: event.url,
    host: event.host,
    status: event.status,
    reqLen: event.reqLen,
    respLen: event.respLen,
    mime: event.mime,
    agentTag: event.agentTag,
  };
}

function trafficFilesNewestFirst(config = proxyBackendConfig()) {
  ensureTrafficStore(config);
  let archives = [];
  try {
    archives = fs.readdirSync(config.trafficDir)
      .filter(name => /^proxy-events-.+\.jsonl$/i.test(name))
      .map(name => path.join(config.trafficDir, name))
      .sort()
      .reverse();
  } catch {}
  return [config.trafficJsonl, ...archives];
}

// Read JSONL from the end in bounded chunks. Dashboard polling used to parse
// every active and archived capture synchronously every two seconds; a long
// assessment could therefore block the Node event loop long enough that even
// /api/healthz timed out.
function forEachLineReverse(file, onLine, chunkSize = 64 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return true; }
  try {
    let position = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(index + 1, end).toString('utf8').replace(/\r$/, '');
        if (line && onLine(line) === false) return false;
        end = index;
      }
      carry = combined.subarray(0, end);
    }
    const firstLine = carry.toString('utf8').replace(/\r$/, '');
    if (firstLine && onLine(firstLine) === false) return false;
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function scanEventsReverse(config, onEvent) {
  for (const file of trafficFilesNewestFirst(config)) {
    const completed = forEachLineReverse(file, line => {
      const event = parseLine(line);
      return !event || onEvent(event) !== false;
    });
    if (!completed) return;
  }
}

function proxyHistory({ since = 0, limit = DEFAULT_LIMIT, config = proxyBackendConfig() } = {}) {
  const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const sinceNum = Number(since) || 0;
  const rows = [];
  scanEventsReverse(config, event => {
    const eventId = Number(event.id);
    if (sinceNum && Number.isFinite(eventId) && eventId <= sinceNum) return false;
    if (!sinceNum || eventId > sinceNum) rows.push(rowForHistory(event));
    return rows.length < lim;
  });
  return rows.reverse();
}

function proxyDetail(id, config = proxyBackendConfig()) {
  const wanted = String(id || '');
  if (!wanted) return null;
  let match = null;
  scanEventsReverse(config, event => {
    if (String(event.id) !== wanted) return true;
    match = event;
    return false;
  });
  return match;
}

function proxyMetrics({ windowSec = 10, config = proxyBackendConfig() } = {}) {
  const windowMs = Math.max(1, Number(windowSec) || 10) * 1000;
  const cutoff = Date.now() - windowMs;
  const rows = [];
  scanEventsReverse(config, event => {
    if (Number(event.ts) < cutoff) return false;
    rows.push(event);
    return true;
  });
  const byAgent = new Map();
  for (const row of rows) {
    const agent = row.agentTag || '(untagged)';
    const rec = byAgent.get(agent) || { agent, requests: 0, errors: 0, rps: 0, errorRate: 0 };
    rec.requests += 1;
    if (row.error || row.status === 0 || row.status >= 400) rec.errors += 1;
    byAgent.set(agent, rec);
  }
  const agents = [...byAgent.values()]
    .map(rec => ({
      ...rec,
      rps: rec.requests / (windowMs / 1000),
      errorRate: rec.requests ? rec.errors / rec.requests : 0,
    }))
    .sort((a, b) => b.requests - a.requests);
  return {
    backend: config.backend,
    rps: rows.length / (windowMs / 1000),
    agents,
  };
}

function watchProxyEvents({ config = proxyBackendConfig(), fromEnd = true, onEvent }) {
  ensureTrafficStore(config);
  let position = fromEnd ? fs.statSync(config.trafficJsonl).size : 0;
  let carry = '';
  let closed = false;

  function readNew() {
    if (closed) return;
    let stat;
    try { stat = fs.statSync(config.trafficJsonl); } catch { return; }
    if (stat.size < position) {
      position = 0;
      carry = '';
    }
    if (stat.size === position) return;
    const fd = fs.openSync(config.trafficJsonl, 'r');
    try {
      const len = stat.size - position;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, position);
      position = stat.size;
      const text = carry + buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        const event = parseLine(line);
        if (event) onEvent(rowForHistory(event));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  const timer = setInterval(readNew, 500);
  fs.watchFile(config.trafficJsonl, { interval: 500 }, readNew);
  return () => {
    closed = true;
    clearInterval(timer);
    fs.unwatchFile(config.trafficJsonl, readNew);
  };
}

function proxyHealth(config = proxyBackendConfig()) {
  try {
    ensureTrafficStore(config);
    fs.accessSync(config.trafficDir, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(config.trafficJsonl, fs.constants.R_OK | fs.constants.W_OK);
    return {
      healthy: true,
      backend: config.backend,
      trafficDir: config.trafficDir,
      trafficJsonl: config.trafficJsonl,
    };
  } catch (e) {
    return {
      healthy: false,
      backend: config.backend,
      trafficDir: config.trafficDir,
      trafficJsonl: config.trafficJsonl,
      error: e.message,
    };
  }
}

function combineProxyRuntimeHealth(store, runtime, { supervised = false } = {}) {
  const processHealthy = !supervised || runtime?.status === 'running';
  return {
    ...store,
    healthy: !!store?.healthy && processHealthy,
    processStatus: supervised ? runtime?.status || 'stopped' : 'external',
    pid: supervised ? runtime?.pid || null : null,
    startedAt: supervised ? runtime?.startedAt || null : null,
    error: store?.error || (!processHealthy ? runtime?.error || 'native proxy is not running' : null),
    stderr: !processHealthy ? runtime?.stderr : undefined,
  };
}

module.exports = {
  clearProxyTraffic,
  ensureTrafficStore,
  normalizeEvent,
  proxyHistory,
  proxyDetail,
  proxyMetrics,
  watchProxyEvents,
  proxyHealth,
  combineProxyRuntimeHealth,
};
