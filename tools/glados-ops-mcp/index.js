#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const GLADOS_RUNTIME_DIR = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados');
const BLACKBOARD_DB = process.env.BLACKBOARD_DB || path.join(GLADOS_RUNTIME_DIR, 'blackboard', 'blackboard.db');
const WATCHDOG_DB = process.env.WATCHDOG_DB || path.join(GLADOS_RUNTIME_DIR, 'watchdog', 'watchdog.db');
const INVESTIGATIONS = process.env.GLADOS_INVESTIGATIONS_DIR || path.join(GLADOS_RUNTIME_DIR, 'investigations');
const OPERATOR_CONTEXT = process.env.GLADOS_OPERATOR_CONTEXT || path.join(GLADOS_RUNTIME_DIR, 'operator-context.json');
const LOCAL_AUTH = process.env.GLADOS_LOCAL_AUTH || path.join(GLADOS_RUNTIME_DIR, 'secrets', 'local-auth.json');

const blackboard = fs.existsSync(BLACKBOARD_DB) ? new Database(BLACKBOARD_DB, { readonly: true }) : null;
const watchdog = fs.existsSync(WATCHDOG_DB) ? new Database(WATCHDOG_DB, { readonly: true }) : null;

const PHASE1_AGENTS = new Set([
  'osint',
  'origin-ip',
  'net-recon',
  'webapp-recon',
  'source-code',
  'plan-synthesizer',
  'js-reverser',
  'mobile-api-recon',
]);
const META_AGENTS = new Set([
  'glados',
  'atlas',
  'ai-specialist',
  'report-writer',
  'report-validator',
  'webapp-validator',
  'api-validator',
  'poc-validator',
  'postex-validator',
  'ad-validator',
  'c2-validator',
  'phish-validator',
  'evidence-curator',
  'scope-guardian',
]);

const TOOLS = [
  {
    name: 'scope_guard_check',
    description: 'Check whether a proposed agent action is in scope, target-healthy, and plan-approved when required. Does not execute the action.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'target_url'],
      properties: {
        agent_id: { type: 'string' },
        target_url: { type: 'string' },
        engagement_id: { type: 'string' },
        action: { type: 'string' },
        method: { type: 'string' },
        risk_to_target: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
    },
  },
  {
    name: 'operator_context',
    description: 'Read the non-secret local operator context, such as owned-domain background knowledge, auth flow cues, and reporting paths.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'local_auth_status',
    description: 'Report which local credential profiles are configured without returning usernames, passwords, tokens, or secret values.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'adfs_active_directory_login',
    description: 'Use a local credential profile to complete Ford ADFS Active Directory login inside an existing browser MCP/CDP page. Secret values are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Local auth profile id, default ford-sso.' },
        target_id: { type: 'string', description: 'Browser MCP targetId from browser.open/snapshot.' },
        ws_url: { type: 'string', description: 'Optional CDP websocket URL from browser.open.' },
      },
    },
  },
  {
    name: 'evidence_bundle_create',
    description: 'Create a redacted evidence manifest under ~/.glados/investigations/<target>/evidence. Use for suspected or validated findings.',
    inputSchema: {
      type: 'object',
      required: ['target', 'title'],
      properties: {
        target: { type: 'string' },
        title: { type: 'string' },
        engagement_id: { type: 'string' },
        finding_id: { type: 'number' },
        agent_id: { type: 'string' },
        proxy_ids: { type: 'array', items: { type: 'number' } },
        screenshots: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        redactions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'js_endpoint_extract',
    description: 'Extract likely URLs, API routes, GraphQL operations, and secret-like key names from JavaScript text or a local file. Values are redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        file_path: { type: 'string' },
        max_results: { type: 'number' },
      },
    },
  },
  {
    name: 'openapi_inventory',
    description: 'Summarize an OpenAPI/Swagger JSON document from source text or a local file: paths, methods, auth schemes, and server URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        file_path: { type: 'string' },
        max_paths: { type: 'number' },
      },
    },
  },
  {
    name: 'tool_availability',
    description: 'Report whether common red-team helper CLIs are installed locally. Does not run scans.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'safe_ffuf_command',
    description: 'Produce a low-rate ffuf command plan for operator review. Does not execute ffuf.',
    inputSchema: {
      type: 'object',
      required: ['url_with_fuZZ', 'wordlist'],
      properties: {
        url_with_fuZZ: { type: 'string', description: 'URL containing FUZZ, e.g. https://example.com/FUZZ' },
        wordlist: { type: 'string' },
        rate: { type: 'number' },
        headers: { type: 'object' },
        proxy: { type: 'string' },
      },
    },
  },
];

function json(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function safeName(s) {
  return String(s || 'target')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'target';
}

function readInput(args) {
  if (args.source) return String(args.source);
  if (!args.file_path) throw new Error('source or file_path required');
  const p = path.resolve(args.file_path);
  if (!fs.existsSync(p)) throw new Error('file_path not found');
  return fs.readFileSync(p, 'utf8');
}

function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function redactedUrl(u) {
  try {
    const parsed = new URL(u);
    parsed.search = parsed.search ? '?[redacted]' : '';
    parsed.hash = parsed.hash ? '#[redacted]' : '';
    return parsed.toString();
  } catch {
    return u || null;
  }
}

function operatorContext() {
  const context = readJsonFile(OPERATOR_CONTEXT, null);
  if (!context) {
    return {
      configured: false,
      path: OPERATOR_CONTEXT,
      reason: 'operator context file not found or invalid JSON',
    };
  }
  return {
    configured: true,
    path: OPERATOR_CONTEXT,
    context,
    note: 'Operator context is non-secret background knowledge. It does not expand active testing scope by itself.',
  };
}

function localAuthStatus() {
  const auth = readJsonFile(LOCAL_AUTH, null);
  if (!auth?.profiles || typeof auth.profiles !== 'object') {
    return {
      configured: false,
      path: LOCAL_AUTH,
      profiles: [],
      note: 'Run scripts/setup-local-secrets.sh to create local credential profiles.',
    };
  }
  const profiles = Object.entries(auth.profiles).map(([id, profile]) => ({
    id,
    username_set: !!profile?.username,
    password_set: !!profile?.password,
    allowed_hosts: Array.isArray(profile?.allowed_hosts) ? profile.allowed_hosts : [],
    notes: profile?.notes || '',
  }));
  return {
    configured: true,
    path: LOCAL_AUTH,
    profiles,
    redaction: 'Credential values are intentionally never returned by this tool.',
  };
}

async function resolveBrowserWsUrl(args) {
  if (args.ws_url) return args.ws_url;
  if (!args.target_id) throw new Error('target_id or ws_url required');
  const res = await fetch('http://127.0.0.1:18800/json/list', { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`browser target list failed: HTTP ${res.status}`);
  const targets = await res.json();
  const target = (Array.isArray(targets) ? targets : []).find(t => t.id === args.target_id || t.targetId === args.target_id);
  const wsUrl = target?.webSocketDebuggerUrl || target?.webSocketUrl || target?.wsUrl;
  if (!wsUrl) throw new Error(`browser target not found for target_id ${args.target_id}`);
  return wsUrl;
}

function cdpCall(ws, method, params = {}, timeoutMs = 5000) {
  const id = ++cdpCall.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
    }
    function onMessage(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      cleanup();
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
cdpCall.nextId = 0;

function waitForWsOpen(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket open timed out')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')); }, { once: true });
  });
}

async function adfsActiveDirectoryLogin(args) {
  const profileId = args.profile_id || 'ford-sso';
  const auth = readJsonFile(LOCAL_AUTH, null);
  const profile = auth?.profiles?.[profileId];
  if (!profile?.username || !profile?.password) {
    return { ok: false, status: 'missing_profile', profile_id: profileId, redaction: 'No credential values returned.' };
  }

  const wsUrl = await resolveBrowserWsUrl(args);
  const ws = new WebSocket(wsUrl);
  await waitForWsOpen(ws);
  try {
    await cdpCall(ws, 'Runtime.enable');
    const locationResult = await cdpCall(ws, 'Runtime.evaluate', {
      expression: '({ href: location.href, host: location.hostname, title: document.title, text: document.body ? document.body.innerText.slice(0, 1000) : "" })',
      returnByValue: true,
    });
    const current = locationResult.result?.value || {};
    const allowedHosts = Array.isArray(profile.allowed_hosts) ? profile.allowed_hosts : [];
    if (!allowedHosts.includes(current.host)) {
      return {
        ok: false,
        status: 'host_not_allowed_for_profile',
        profile_id: profileId,
        host: current.host || null,
        allowed_hosts: allowedHosts,
        redaction: 'No credential values returned.',
      };
    }
    if (!/Active Directory|ADFS|Sign in with one of these accounts/i.test(`${current.title}\n${current.text}\n${current.href}`)) {
      return {
        ok: false,
        status: 'not_on_adfs_choice_page',
        profile_id: profileId,
        host: current.host || null,
        url: redactedUrl(current.href),
        redaction: 'No credential values returned.',
      };
    }

    const script = `(async (username, password) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const fire = el => {
        for (const type of ['input', 'change', 'keyup', 'blur']) {
          el.dispatchEvent(new Event(type, { bubbles: true }));
        }
      };
      const docs = () => {
        const out = [document];
        for (const frame of Array.from(window.frames || [])) {
          try {
            if (frame.document) out.push(frame.document);
          } catch {}
        }
        return out;
      };
      const textOf = el => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      const all = selector => docs().flatMap(doc => Array.from(doc.querySelectorAll(selector)));
      const byText = text => {
        const re = new RegExp(text, 'i');
        const selector = 'button,a,input[type=button],input[type=submit],[role=button],div,span';
        return all(selector).find(el => visible(el) && re.test(textOf(el)));
      };
      const click = el => {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const clickSubmit = () => click(byText('next|sign in|continue|submit|log in|login')) || false;

      const clickedActiveDirectory = click(byText('Active Directory'));
      await sleep(1800);

      let userInput = all('input')
        .find(el => visible(el) && !/password|hidden|submit|button|checkbox|radio/i.test(el.type || '') && !el.disabled);
      if (userInput) {
        userInput.focus();
        userInput.value = username;
        fire(userInput);
        clickSubmit();
        await sleep(1800);
      }

      let passwordInput = all('input[type=password]').find(el => visible(el) && !el.disabled);
      if (passwordInput) {
        passwordInput.focus();
        passwordInput.value = password;
        fire(passwordInput);
        clickSubmit();
        await sleep(3000);
      }

      return {
        clickedActiveDirectory,
        usernameFieldFound: !!userInput,
        passwordFieldFound: !!passwordInput,
        finalUrl: location.href,
        finalHost: location.hostname,
        title: document.title
      };
    })(${JSON.stringify(profile.username)}, ${JSON.stringify(profile.password)})`;
    const loginResult = await cdpCall(ws, 'Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    }, 15000);
    const value = loginResult.result?.value || {};
    const submittedCredentials = !!value.passwordFieldFound;
    return {
      ok: submittedCredentials,
      status: value.passwordFieldFound
        ? 'submitted_credentials'
        : (value.usernameFieldFound
          ? 'submitted_username_only'
          : (value.clickedActiveDirectory ? 'active_directory_selected_no_form' : 'adfs_form_not_found')),
      auth_complete: submittedCredentials,
      requires_operator: !submittedCredentials,
      profile_id: profileId,
      clicked_active_directory: !!value.clickedActiveDirectory,
      username_field_found: !!value.usernameFieldFound,
      password_field_found: !!value.passwordFieldFound,
      final_host: value.finalHost || null,
      final_url: redactedUrl(value.finalUrl),
      title: value.title || null,
      redaction: 'Credential values were read from the local secret profile and submitted through CDP, but are never returned.',
    };
  } finally {
    try { ws.close(); } catch {}
  }
}

function engagementScope(engagementId) {
  if (!blackboard || !engagementId) return null;
  const row = blackboard.prepare('SELECT scope FROM engagements WHERE id = ?').get(engagementId);
  if (!row?.scope) return null;
  try { return JSON.parse(row.scope); } catch { return row.scope; }
}

function targetHealth(targetUrl) {
  if (!watchdog) return { state: 'unknown', reason: 'watchdog db missing' };
  return watchdog.prepare('SELECT * FROM target_health WHERE target_url = ?').get(targetUrl) || { state: 'unknown', reason: 'no target health row' };
}

function latestApprovedPlan(agentId, engagementId) {
  if (!blackboard) return null;
  const rows = engagementId
    ? blackboard.prepare("SELECT * FROM plans WHERE engagement_id = ? AND state IN ('approved','executing') ORDER BY approved_at DESC, created_at DESC").all(engagementId)
    : blackboard.prepare("SELECT * FROM plans WHERE state IN ('approved','executing') ORDER BY approved_at DESC, created_at DESC LIMIT 10").all();
  for (const row of rows) {
    try {
      const plan = JSON.parse(row.plan_json);
      const chain = new Set(plan.agent_chain || []);
      const vectorAgents = new Set((plan.proposed_vectors || []).flatMap(v => v.agents || []));
      if (chain.has(agentId) || vectorAgents.has(agentId)) return { id: row.id, engagement_id: row.engagement_id, plan };
    } catch {}
  }
  return null;
}

function inScope(targetUrl, scope) {
  if (!scope) return { ok: true, reason: 'no explicit scope found' };
  const host = (() => { try { return new URL(targetUrl).hostname.toLowerCase(); } catch { return ''; } })();
  const items = Array.isArray(scope) ? scope : [String(scope)];
  for (const item of items) {
    const s = typeof item === 'string' ? item : (item.host || item.url || item.domain || '');
    if (!s) continue;
    if (targetUrl.includes(s) || host === s.toLowerCase() || host.endsWith('.' + s.toLowerCase())) {
      return { ok: true, reason: `matched scope ${s}` };
    }
  }
  return { ok: false, reason: 'target_url did not match engagement scope' };
}

function scopeGuard(args) {
  const health = targetHealth(args.target_url);
  const scope = engagementScope(args.engagement_id);
  const scopeResult = inScope(args.target_url, scope);
  const isPhase1 = PHASE1_AGENTS.has(args.agent_id);
  const isMeta = META_AGENTS.has(args.agent_id);
  const preApprovedClass = isPhase1 || isMeta;
  const approved = preApprovedClass ? null : latestApprovedPlan(args.agent_id, args.engagement_id);
  const missing = [];
  if (!scopeResult.ok) missing.push(scopeResult.reason);
  if (!['healthy', 'unknown'].includes(health.state)) missing.push(`target health is ${health.state}`);
  if (!preApprovedClass && !approved) missing.push('no approved plan includes this agent');
  const actionText = String(args.action || '');
  const riskyAction = /post|exploit|mutat|delete|write|send|phish/i.test(actionText);
  const clearlyNegatedRisk = /\b(no|without|non[- ]?)\s+(post|exploit|exploitation|mutation|mutating|delete|write|send|phish|phishing|fuzzing)\b/i.test(actionText);
  const requiresOperator = args.risk_to_target === 'high'
    || (riskyAction && !clearlyNegatedRisk && !(preApprovedClass && args.risk_to_target === 'low'));
  return {
    allowed: missing.length === 0 && !requiresOperator,
    requires_operator: missing.length === 0 && requiresOperator,
    phase: isMeta ? 'meta' : (isPhase1 ? 'phase1' : 'phase3'),
    agent_id: args.agent_id,
    target_url: args.target_url,
    engagement_id: args.engagement_id || null,
    health,
    scope: scopeResult,
    approved_plan: approved ? { id: approved.id, engagement_id: approved.engagement_id } : null,
    missing,
    reason: missing.length ? missing.join('; ') : (requiresOperator ? 'operator approval required for this action' : 'allowed'),
  };
}

function evidenceBundle(args) {
  const targetDir = path.join(INVESTIGATIONS, safeName(args.target), 'evidence');
  fs.mkdirSync(targetDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${args.finding_id ? `finding-${args.finding_id}` : 'evidence'}-${stamp}`;
  const manifest = {
    created_at: new Date().toISOString(),
    target: args.target,
    title: args.title,
    engagement_id: args.engagement_id || null,
    finding_id: args.finding_id || null,
    agent_id: args.agent_id || null,
    proxy_ids: args.proxy_ids || [],
    screenshots: args.screenshots || [],
    notes: args.notes || '',
    redactions: args.redactions || [],
  };
  const jsonPath = path.join(targetDir, `${base}.json`);
  const mdPath = path.join(targetDir, `${base}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(mdPath, `# Evidence Bundle - ${args.title}

- Target: ${args.target}
- Engagement: ${args.engagement_id || '(none)'}
- Finding ID: ${args.finding_id || '(none)'}
- Agent: ${args.agent_id || '(none)'}
- Created: ${manifest.created_at}
- Proxy IDs: ${(args.proxy_ids || []).join(', ') || '(none)'}
- Screenshots: ${(args.screenshots || []).join(', ') || '(none)'}
- Redactions: ${(args.redactions || []).join(', ') || '(none)'}

## Notes

${args.notes || '(none)'}
`);
  return { ok: true, jsonPath, mdPath, manifest };
}

function jsExtract(args) {
  const text = readInput(args);
  const max = Math.max(1, Math.min(1000, Number(args.max_results) || 200));
  const urls = new Set();
  const routes = new Set();
  const gql = new Set();
  const secretKeys = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+/g)) urls.add(m[0]);
  for (const m of text.matchAll(/["'`]((?:\/api|\/graphql|\/v\d+|\/[a-zA-Z0-9_.-]+\/)[^"'`\\\s]{1,180})["'`]/g)) routes.add(m[1]);
  for (const m of text.matchAll(/\b(query|mutation)\s+([A-Za-z0-9_]+)/g)) gql.add(`${m[1]} ${m[2]}`);
  for (const m of text.matchAll(/\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|client[_-]?id|client[_-]?secret)[A-Za-z0-9_]*)\b/gi)) secretKeys.add(m[1]);
  return {
    urls: [...urls].slice(0, max),
    routes: [...routes].slice(0, max),
    graphql_operations: [...gql].slice(0, max),
    secret_like_key_names: [...secretKeys].slice(0, max),
    redaction: 'Only key names are returned; values are intentionally not extracted.',
  };
}

function openapiInventory(args) {
  const text = readInput(args);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('OpenAPI inventory currently expects JSON source: ' + e.message); }
  const max = Math.max(1, Math.min(1000, Number(args.max_paths) || 200));
  const paths = [];
  for (const [p, spec] of Object.entries(doc.paths || {})) {
    for (const method of Object.keys(spec || {})) {
      if (/^(get|post|put|patch|delete|head|options)$/i.test(method)) {
        paths.push({ method: method.toUpperCase(), path: p, summary: spec[method]?.summary || '' });
      }
    }
  }
  return {
    title: doc.info?.title || null,
    version: doc.info?.version || null,
    servers: (doc.servers || []).map(s => s.url).filter(Boolean),
    security_schemes: Object.keys(doc.components?.securitySchemes || {}),
    path_count: paths.length,
    paths: paths.slice(0, max),
  };
}

function which(cmd) {
  try { return cp.execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function toolAvailability() {
  const tools = ['ffuf', 'httpx', 'nuclei', 'semgrep', 'ghidraRun', 'ghidra', 'analyzeHeadless', 'jadx', 'apktool', 'bloodhound-python', 'certipy', 'nmap', 'sqlmap'];
  const found = Object.fromEntries(tools.map(t => [t, which(t)]));
  found.ghidra = found.ghidra || found.ghidraRun || firstExisting([
    '/opt/homebrew/opt/ghidra/bin/ghidraRun',
    '/usr/local/opt/ghidra/bin/ghidraRun',
  ]);
  found.analyzeHeadless = firstExisting([
    path.join(ROOT, 'tools', 'bin', 'analyzeHeadless'),
  ]) || found.analyzeHeadless || firstExisting([
    '/opt/homebrew/opt/ghidra/libexec/support/analyzeHeadless',
    '/usr/local/opt/ghidra/libexec/support/analyzeHeadless',
  ]);
  found.sqlmap = firstExisting([path.join(ROOT, 'tools', 'bin', 'sqlmap')]) || found.sqlmap;
  found['bloodhound-python'] = found['bloodhound-python'] || firstExisting([path.join(os.homedir(), '.local', 'bin', 'bloodhound-python')]);
  found.certipy = found.certipy || firstExisting([path.join(os.homedir(), '.local', 'bin', 'certipy')]);
  return found;
}

function safeFfuf(args) {
  if (!args.url_with_fuZZ.includes('FUZZ')) throw new Error('url_with_fuZZ must contain FUZZ');
  const rate = Math.max(1, Math.min(20, Number(args.rate) || 2));
  const proxy = args.proxy || 'http://127.0.0.1:8080';
  const headers = Object.entries(args.headers || {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  const cmd = ['ffuf', '-u', args.url_with_fuZZ, '-w', args.wordlist, '-rate', String(rate), '-timeout', '10', '-x', proxy, ...headers];
  return {
    executable_available: !!which('ffuf'),
    command: cmd,
    shell_preview: cmd.map(v => /[\s"'$]/.test(v) ? `'${String(v).replace(/'/g, `'\\''`)}'` : v).join(' '),
    note: 'Review scope, target_health, and operator approval before running. This tool does not execute ffuf.',
  };
}

const server = new Server({ name: 'glados-ops-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case 'scope_guard_check': return json(scopeGuard(args));
      case 'operator_context': return json(operatorContext());
      case 'local_auth_status': return json(localAuthStatus());
      case 'adfs_active_directory_login': return json(await adfsActiveDirectoryLogin(args));
      case 'evidence_bundle_create': return json(evidenceBundle(args));
      case 'js_endpoint_extract': return json(jsExtract(args));
      case 'openapi_inventory': return json(openapiInventory(args));
      case 'tool_availability': return json(toolAvailability());
      case 'safe_ffuf_command': return json(safeFfuf(args));
      default: throw new Error(`unknown tool: ${name}`);
    }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch(err => { console.error(err); process.exit(1); });
