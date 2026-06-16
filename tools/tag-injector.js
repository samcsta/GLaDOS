// tag-injector.js — Node preload for the openclaw gateway process.
//
// Loaded once via NODE_OPTIONS=--require=/path/to/tag-injector.js on the gateway
// plist. Provides per-agent outbound HTTP tagging for Burp history.
//
// How it works
// ------------
// 1. Creates an AsyncLocalStorage on globalThis.__gladosAgentALS.
// 2. Patches openclaw's internal tool wrapper so every per-agent tool.execute()
//    call is wrapped in als.run(agentId, …). (See tools/patch-openclaw-bundle.sh
//    for the corresponding bundle edit.)
// 3. Patches http.request / https.request / globalThis.fetch / undici dispatch
//    to read als.getStore() on every outbound call and:
//      - inject "X-GLaDOS-Agent: <agent>" header if agent is in SCOPE_SET
//      - bypass proxy for out-of-scope agents (glados/atlas LLM traffic stays off Burp)
//      - tag untraceable calls (no ALS store) as "gateway"
//
// Does NOT cover
// --------------
// - Chromium child processes launched by browser MCP. Chromium traffic uses
//   the global --proxy-server=Burp:8080 via browser.extraArgs and lands in Burp
//   untagged (falls under the "gateway" sentinel for correlation).
// - Raw TCP/UDP.

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const https = require('node:https');

const HEADER_NAME = 'X-GLaDOS-Agent';
const SIGNED_HEADER_NAME = 'X-GLaDOS-Agent-Signed';
const BURP_PROXY_HOST = '127.0.0.1';
const BURP_PROXY_PORT = 8080;

// v3.1 Tier 3 #12 — HMAC-signed agent header.
// Read once at process start from ~/.openclaw/glados-secret. If absent or
// unreadable, signing is disabled and only the plain X-GLaDOS-Agent header
// is sent. Signed format: "<agent>.<ts_ms>.<hex_hmac_sha256>" over
// "agent:ts_ms". Verifier on the Burp extension side recomputes the HMAC
// and rejects outside a 120s skew window.
let HMAC_SECRET = null;
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const secretPath = path.join(os.homedir(), '.openclaw/glados-secret');
  HMAC_SECRET = fs.readFileSync(secretPath, 'utf8').trim();
  if (HMAC_SECRET.length < 32) HMAC_SECRET = null; // ignore stub/empty files
} catch { HMAC_SECRET = null; }

function signAgent(agent) {
  if (!HMAC_SECRET || !agent) return null;
  try {
    const crypto = require('node:crypto');
    const ts = Date.now();
    const mac = crypto.createHmac('sha256', HMAC_SECRET)
      .update(`${agent}:${ts}`).digest('hex');
    return `${agent}.${ts}.${mac}`;
  } catch { return null; }
}
// v3.1.04242026 Blockers F+G — expose signing + ACL helpers to the patched
// SSRF dispatcher (GLADOS_SSRF_ROUTE_V2). Bundle code can't easily require()
// secrets/files itself; using global hooks keeps the canonical impl in one
// place and the bundle patch tiny.
globalThis.__gladosSignAgent = signAgent;

// Agents whose outbound HTTP must route through Burp + carry the agent tag.
// Everyone else (glados, atlas, report-writer, report-validator, ai-specialist)
// gets direct egress, bypassing Burp entirely — keeps LLM traffic off Burp history.
const SCOPE_SET = new Set([
  'osint', 'origin-ip', 'net-recon', 'webapp-recon', 'source-code',
  'webapp-vuln', 'webapp-validator', 'api-expert', 'api-validator',
  'poc-coder', 'poc-validator', 'postex', 'postex-validator',
  'ad-expert', 'ad-validator', 'c2-builder', 'c2-validator',
  'phisherman', 'phish-validator',
]);

// Hosts that bypass the proxy regardless of agent scope (already in NO_PROXY but
// belt-and-suspenders for hostnames that can't be expressed as CIDR).
const BYPASS_HOSTS = /^(localhost|127\.0\.0\.1|::1|api\.anthropic\.com|.*\.internal)$/i;

// --- ALS ---
const als = new AsyncLocalStorage();
globalThis.__gladosAgentALS = als;

// -----------------------------------------------------------------------------
// v3.1.04242026 Blocker C — Hard plan-gate at sessions_spawn.
//
// `watchdog/lib/plan-gate.js` already implements the policy. We install a
// best-effort sync wrapper on globalThis.__gladosPlanGate so the patched
// sessions_spawn execute body can call it and refuse the spawn at the
// runtime layer (not just by SOUL.md prompt). Sync because better-sqlite3
// is sync — no await / no event-loop hop, ~5ms even on a cold sentinel.
//
// Resolution rules:
//   - require() the watchdog/lib path absolutely so the gateway preload
//     doesn't depend on cwd.
//   - if the require fails (dev/setup before watchdog is built), expose
//     a stub that returns { allowed: true, reason: 'plan-gate-unavailable' }
//     for meta agents only and { allowed: false } for any exploitation
//     agent — fail-closed for the dangerous class.
// -----------------------------------------------------------------------------
(function installPlanGate() {
  let gate = null;
  try {
    const path = require('node:path');
    const repoRoot = process.env.GLADOS_REPO_ROOT || path.resolve(__dirname, '..');
    const watchdogLib = process.env.GLADOS_PLAN_GATE_MODULE ||
      path.join(repoRoot, 'watchdog/lib/plan-gate.js');
    const m = require(watchdogLib);
    gate = m.planCheckDispatch;
  } catch (e) {
    try { process.stderr.write(`[tag-injector] plan-gate require failed: ${e.message}\n`); } catch {}
  }
  globalThis.__gladosPlanGate = function gladosPlanGate(agentId, engagementId) {
    try {
      if (gate) return gate(agentId, engagementId);
    } catch (e) {
      // Any failure = fail-closed for unknown/exploitation, fail-open for meta.
      return { allowed: false, reason: 'plan-gate-error: ' + (e.message || e), phase: 'unknown' };
    }
    // Stub fallback when watchdog isn't available.
    const META = new Set(['glados','atlas','ai-specialist','report-writer','report-validator','webapp-validator','api-validator','poc-validator','postex-validator','ad-validator','c2-validator','phish-validator']);
    const PHASE1 = new Set(['osint','origin-ip','net-recon','webapp-recon','source-code','plan-synthesizer']);
    if (META.has(agentId) || PHASE1.has(agentId)) {
      return { allowed: true, reason: 'plan-gate-unavailable; permitting non-exploitation', phase: 'fallback' };
    }
    return { allowed: false, reason: 'plan-gate-unavailable; refusing exploitation by default', phase: 'fallback' };
  };
})();

// -----------------------------------------------------------------------------
// v3.1 Tier 2 — Per-agent fetch ACL.
//
// ~/.openclaw/glados-fetch-acl.json maps agent-id → allow-list of host globs.
// A compromised / over-eager in-scope agent can't SSRF outside its permitted
// surface. Denies return ECONN-style errors tagged GLADOS_ACL_DENY so Burp
// history and dashboard LIVE EVENTS both surface the block.
//
// Format (example):
//   {
//     "version": 1,
//     "enabled": true,
//     "default": "deny",     // or "allow" if no entry for the agent
//     "agents": {
//       "osint":       { "allow": ["*.shodan.io", "*.censys.io", "crt.sh"] },
//       "webapp-vuln": { "allow": ["juice-shop.local", "*.juice-shop.local"] }
//     }
//   }
//
// Reload semantics: file is read on each request via a tiny cache keyed on mtime,
// so operator edits take effect within ~1s without a gateway restart.
// -----------------------------------------------------------------------------
const aclPath = require('node:path').join(require('node:os').homedir(), '.openclaw/glados-fetch-acl.json');
let aclCache = { mtimeMs: 0, acl: null };
function loadAcl() {
  try {
    const fs = require('node:fs');
    const stat = fs.statSync(aclPath);
    if (stat.mtimeMs === aclCache.mtimeMs && aclCache.acl) return aclCache.acl;
    const raw = fs.readFileSync(aclPath, 'utf8');
    const parsed = JSON.parse(raw);
    aclCache = { mtimeMs: stat.mtimeMs, acl: parsed };
    return parsed;
  } catch {
    // No file → ACL disabled (fail-open). Operator must explicitly opt in.
    aclCache = { mtimeMs: 0, acl: null };
    return null;
  }
}
function globMatch(pattern, host) {
  if (!pattern || !host) return false;
  if (pattern === host) return true;
  if (pattern === '*') return true;
  // *.example.com matches foo.example.com but not example.com
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .example.com
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}
function aclAllows(agent, host) {
  const acl = loadAcl();
  if (!acl || !acl.enabled) return { allowed: true, reason: 'acl-disabled' };
  const defaultDeny = (acl.default || 'deny') === 'deny';
  const entry = (acl.agents || {})[agent];
  if (!entry) return { allowed: !defaultDeny, reason: defaultDeny ? 'default-deny' : 'default-allow' };
  const allow = entry.allow || [];
  const deny = entry.deny || [];
  for (const pat of deny) if (globMatch(pat, host)) return { allowed: false, reason: `deny:${pat}` };
  for (const pat of allow) if (globMatch(pat, host)) return { allowed: true, reason: `allow:${pat}` };
  return { allowed: !defaultDeny, reason: defaultDeny ? 'no-match' : 'default-allow' };
}
function aclDenyError(agent, host, reason) {
  const err = new Error(`GLADOS_ACL_DENY agent=${agent} host=${host} reason=${reason}`);
  err.code = 'GLADOS_ACL_DENY';
  err.agent = agent;
  err.host = host;
  try { process.stderr.write(`[tag-injector] ACL DENY ${agent} → ${host} (${reason})\n`); } catch {}
  return err;
}
// Expose ACL check to the patched SSRF dispatcher (Blocker G).
globalThis.__gladosAclAllows = aclAllows;

function currentAgent() {
  const a = als.getStore();
  if (typeof a === 'string' && a.length) return a;
  return null;
}

function shouldProxy(agent, host) {
  if (host && BYPASS_HOSTS.test(host)) return false;
  if (!agent) return false; // untagged calls: direct, don't pollute Burp
  return SCOPE_SET.has(agent);
}

// --- http/https.request: inject header + rewrite to go through Burp ---
// Note: HTTPS_PROXY env is set globally at the plist level so undici picks it up
// for fetch(). For node:http and node:https direct callers, we rewrite the opts
// manually here so we can also selectively bypass.
function patchRequestFn(mod, protocolDefaultPort) {
  const orig = mod.request;
  mod.request = function patchedRequest(urlOrOpts, optsOrCb, cb) {
    let opts;
    let callback;
    if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
      const u = typeof urlOrOpts === 'string' ? new URL(urlOrOpts) : urlOrOpts;
      if (typeof optsOrCb === 'function') {
        callback = optsOrCb;
        opts = {};
      } else {
        opts = { ...(optsOrCb || {}) };
        callback = cb;
      }
      opts.protocol = u.protocol;
      opts.hostname = u.hostname;
      opts.port = u.port || undefined;
      opts.path = (u.pathname || '/') + (u.search || '');
    } else {
      opts = { ...(urlOrOpts || {}) };
      callback = optsOrCb;
    }
    const host = opts.hostname || opts.host;
    const agent = currentAgent();
    // v3.1 Tier 2 — ACL gate BEFORE any outbound work. Only applies to
    // in-scope red-team agents; out-of-scope (glados/atlas/etc.) is unaffected.
    if (agent && SCOPE_SET.has(agent) && host && !BYPASS_HOSTS.test(host)) {
      const verdict = aclAllows(agent, host);
      if (!verdict.allowed) {
        const err = aclDenyError(agent, host, verdict.reason);
        // Mimic a socket error surface: return a request object that errors on
        // the next tick so callers' .on('error') handlers still fire.
        const req = new (require('node:events').EventEmitter)();
        req.abort = () => {};
        req.end = () => {};
        req.destroy = () => {};
        req.setTimeout = () => req;
        setImmediate(() => req.emit('error', err));
        return req;
      }
    }
    opts.headers = { ...(opts.headers || {}) };
    if (agent && SCOPE_SET.has(agent)) {
      // Case-insensitive dedup: don't overwrite explicit caller-set header.
      const has = Object.keys(opts.headers).some(k => k.toLowerCase() === HEADER_NAME.toLowerCase());
      if (!has) opts.headers[HEADER_NAME] = agent;
      // v3.1 Tier 3 #12 — also attach signed header if secret is available.
      const signed = signAgent(agent);
      if (signed) {
        const hasSig = Object.keys(opts.headers).some(k => k.toLowerCase() === SIGNED_HEADER_NAME.toLowerCase());
        if (!hasSig) opts.headers[SIGNED_HEADER_NAME] = signed;
      }
    }
    if (shouldProxy(agent, host)) {
      // Route through Burp as an HTTP proxy. For HTTPS, Node's http.request
      // doesn't natively support CONNECT tunneling inline, but if this module
      // is being called, it's almost always for plain HTTP — actual HTTPS calls
      // go through globalThis.fetch (undici) which respects HTTPS_PROXY env.
      if (opts.protocol === 'http:' || !opts.protocol) {
        opts.path = `http://${host}${opts.port ? ':' + opts.port : ''}${opts.path || '/'}`;
        opts.hostname = BURP_PROXY_HOST;
        opts.host = BURP_PROXY_HOST;
        opts.port = BURP_PROXY_PORT;
      }
      // HTTPS via http.request: let it through; fetch/https.request with proxy
      // requires extra plumbing. Most HTTPS in openclaw goes via undici+fetch.
    }
    return orig.call(this, opts, callback);
  };
}
patchRequestFn(http, 80);
patchRequestFn(https, 443);

// --- globalThis.fetch: inject header only; routing is handled by undici's
// ProxyAgent + HTTPS_PROXY env (set at plist level).
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function patchedFetch(input, init) {
    const agent = currentAgent();
    const i = init ? { ...init } : {};
    // v3.1 Tier 2 — ACL for fetch(). Parse the target URL to get the host.
    if (agent && SCOPE_SET.has(agent)) {
      let host = '';
      try {
        const u = typeof input === 'string'
          ? new URL(input)
          : (input instanceof URL ? input : (input && input.url ? new URL(input.url) : null));
        host = u ? u.hostname.toLowerCase() : '';
      } catch { /* leave host empty; aclAllows with empty host is treated as bypass-eligible */ }
      if (host && !BYPASS_HOSTS.test(host)) {
        const verdict = aclAllows(agent, host);
        if (!verdict.allowed) {
          return Promise.reject(aclDenyError(agent, host, verdict.reason));
        }
      }
    }
    if (agent && SCOPE_SET.has(agent)) {
      const existing = i.headers || (input && typeof input === 'object' && input.headers) || {};
      const h = existing instanceof Headers ? new Headers(existing) : new Headers(existing || {});
      if (!h.has(HEADER_NAME)) h.set(HEADER_NAME, agent);
      // v3.1 Tier 3 #12 — signed header for the fetch path as well.
      const signed = signAgent(agent);
      if (signed && !h.has(SIGNED_HEADER_NAME)) h.set(SIGNED_HEADER_NAME, signed);
      i.headers = h;
    } else if (agent && !SCOPE_SET.has(agent)) {
      // Out-of-scope agent (glados/atlas/report-*): explicitly bypass the
      // process-global proxy by setting a no-op dispatcher for this call.
      try {
        const undici = require('undici');
        if (undici && undici.Agent) {
          i.dispatcher = new undici.Agent();
        }
      } catch (_) { /* undici not available; fall through */ }
    }
    return origFetch(input, i);
  };
}

// --- One-line startup banner; helpful for confirming the preload loaded.
try {
  process.stderr.write(`[tag-injector] ALS-aware tagging active (scope=${SCOPE_SET.size} agents, proxy=${BURP_PROXY_HOST}:${BURP_PROXY_PORT})\n`);
} catch (_) {}

// ---------------------------------------------------------------------------
// v3.1 — Startup healthcheck + patch-integrity check.
//
// Writes a JSON sentinel the dashboard polls (GET /api/health/burp). The
// sentinel reports:
//   - burpProxy: is :8080 reachable (TCP connect)
//   - burpExtApi: is :1338/health OK
//   - patchAls: is GLADOS_ALS_PATCH_V1 marker present in pi-embedded bundle
//   - patchSsrf: is GLADOS_SSRF_ROUTE_V1 marker present in ssrf bundle
// Failures are also written as a LIVE EVENT line to the gateway.err.log so
// the dashboard's event feed surfaces them immediately.
//
// Runs non-blocking: the first probe fires ~200ms after preload so the
// gateway's own startup isn't delayed, then re-runs every 60s.
// ---------------------------------------------------------------------------
(function startHealthcheck() {
  const fs = require('node:fs');
  const net = require('node:net');
  const path = require('node:path');
  const os = require('node:os');
  const cp = require('node:child_process');

  const LOGS_DIR = path.join(os.homedir(), '.openclaw/logs');
  const SENTINEL = path.join(LOGS_DIR, 'tag-injector-health.json');
  const DIST = (() => {
    if (process.env.OPENCLAW_DIST) return process.env.OPENCLAW_DIST;
    try {
      return path.join(cp.execSync('npm root -g', { encoding: 'utf8' }).trim(), 'openclaw', 'dist');
    } catch (_) {
      for (const p of [
        '/opt/homebrew/lib/node_modules/openclaw/dist',
        '/usr/local/lib/node_modules/openclaw/dist',
      ]) {
        if (fs.existsSync(p)) return p;
      }
      return '/opt/homebrew/lib/node_modules/openclaw/dist';
    }
  })();
  const MARKER_ALS = 'GLADOS_ALS_PATCH_V1';
  // SSRF marker: prefer V2 (HMAC + ACL), accept V1 as legacy.
  const MARKER_SSRF_V1 = 'GLADOS_SSRF_ROUTE_V1';
  const MARKER_SSRF_V2 = 'GLADOS_SSRF_ROUTE_V2';
  const MARKER_PLAN_GATE_V1 = 'GLADOS_PLAN_GATE_V1';
  const MARKER_PLAN_GATE_V2 = 'GLADOS_PLAN_GATE_V2';

  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (_) {}

  function tcpProbe(host, port, timeoutMs) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      let done = false;
      const finish = ok => { if (!done) { done = true; try { sock.destroy(); } catch(_){} resolve(ok); } };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
      try { sock.connect(port, host); } catch (_) { finish(false); }
    });
  }

  async function httpGet(url, timeoutMs) {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(to);
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // v3.1.04242026 fix: pi-embedded-*.js matches multiple bundles (block-chunker,
  // helpers, utils, compaction.runtime, plus the actual primary pi-embedded
  // bundle). The patcher writes the marker into the bundle that actually owns
  // the proxy fetch path, which can be any of them. Old code did
  // `entries.find()` and returned the first alphabetical match, which is often
  // an auxiliary chunk that doesn't carry the marker — producing a false
  // als-patch-missing alarm even though the patch is correctly applied.
  // New behaviour: scan ALL files matching the prefix; report ok if any one
  // contains the marker, and surface the bundle filename that did.
  function checkMarker(globPrefix, marker) {
    try {
      const entries = fs.readdirSync(DIST);
      const candidates = entries.filter(n => n.startsWith(globPrefix) && n.endsWith('.js'));
      if (!candidates.length) return { ok: false, error: `bundle not found: ${globPrefix}*.js` };
      const scanned = [];
      for (const name of candidates) {
        try {
          const content = fs.readFileSync(path.join(DIST, name), 'utf8');
          scanned.push(name);
          if (content.includes(marker)) return { ok: true, bundle: name, scannedCount: candidates.length };
        } catch (_) { /* skip unreadable */ }
      }
      return { ok: false, bundle: scanned[0] || candidates[0], scannedCount: candidates.length, error: `marker ${marker} not found in any of ${candidates.length} ${globPrefix}*.js bundle(s)` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function runProbe() {
    const t0 = Date.now();
    const [burpProxy, burpExtApi] = await Promise.all([
      tcpProbe(BURP_PROXY_HOST, BURP_PROXY_PORT, 2000),
      httpGet('http://127.0.0.1:1338/health', 2000),
    ]);
    const patchAls = checkMarker('pi-embedded-', MARKER_ALS);
    // Try V2 first; fall back to V1 (still functional, just no HMAC/ACL).
    let patchSsrf = checkMarker('ssrf-', MARKER_SSRF_V2);
    let ssrfVersion = 'v2';
    if (!patchSsrf.ok) {
      const v1 = checkMarker('ssrf-', MARKER_SSRF_V1);
      if (v1.ok) { patchSsrf = v1; ssrfVersion = 'v1'; }
      else ssrfVersion = patchSsrf.ok ? 'v2' : 'missing';
    }
    patchSsrf.version = ssrfVersion;
    let patchPlanGate = checkMarker('pi-embedded-', MARKER_PLAN_GATE_V2);
    let planGateVersion = 'v2';
    if (!patchPlanGate.ok) {
      const v1 = checkMarker('pi-embedded-', MARKER_PLAN_GATE_V1);
      if (v1.ok) { patchPlanGate = v1; planGateVersion = 'v1'; }
      else planGateVersion = 'missing';
    }
    patchPlanGate.version = planGateVersion;

    const sentinel = {
      ts: Date.now(),
      elapsedMs: Date.now() - t0,
      healthy: burpProxy && burpExtApi.ok && patchAls.ok && patchSsrf.ok && patchPlanGate.ok,
      burpProxy: { ok: burpProxy, host: BURP_PROXY_HOST, port: BURP_PROXY_PORT },
      burpExtApi: { ok: burpExtApi.ok, status: burpExtApi.status || null, error: burpExtApi.error || null, url: 'http://127.0.0.1:1338/health' },
      patchAls,
      patchSsrf,
      patchPlanGate,
      pid: process.pid,
      node: process.version,
    };

    try {
      fs.writeFileSync(SENTINEL, JSON.stringify(sentinel, null, 2));
    } catch (e) {
      try { process.stderr.write(`[tag-injector] sentinel write failed: ${e.message}\n`); } catch(_){}
    }

    if (!sentinel.healthy) {
      const issues = [];
      if (!burpProxy) issues.push('burp-proxy-down:8080');
      if (!burpExtApi.ok) issues.push('burp-ext-down:1338');
      if (!patchAls.ok) issues.push('als-patch-missing');
      if (!patchSsrf.ok) issues.push('ssrf-patch-missing');
      if (!patchPlanGate.ok) issues.push('plan-gate-patch-missing');
      try {
        process.stderr.write(`[tag-injector] HEALTH FAIL: ${issues.join(', ')}\n`);
      } catch (_) {}
    }
  }

  // First probe after 200ms so we don't block startup; re-run every 60s.
  setTimeout(() => { runProbe().catch(() => {}); }, 200);
  setInterval(() => { runProbe().catch(() => {}); }, 60_000).unref();
})();
