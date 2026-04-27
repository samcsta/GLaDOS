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
  const requiresOperator = args.risk_to_target === 'high' || /post|exploit|mutat|delete|write|send|phish/i.test(args.action || '');
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
