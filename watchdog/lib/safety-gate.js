const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { agentStatus } = require('./halt');
const {
  planCheckDispatch,
  PHASE1_AGENTS,
  EXPLOITATION_AGENTS,
  META_AGENTS,
} = require('./plan-gate');

const GLADOS_RUNTIME_DIR = path.resolve(
  process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados')
);
const BLACKBOARD_DB = path.resolve(
  process.env.BLACKBOARD_DB || path.join(GLADOS_RUNTIME_DIR, 'blackboard', 'blackboard.db')
);
const WATCHDOG_DB = path.resolve(
  process.env.WATCHDOG_DB || path.join(GLADOS_RUNTIME_DIR, 'watchdog', 'watchdog.db')
);
const FETCH_ACL = path.resolve(
  process.env.GLADOS_FETCH_ACL || path.join(GLADOS_RUNTIME_DIR, 'policy', 'glados-fetch-acl.json')
);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'httpx', 'ffuf', 'nuclei', 'katana', 'sqlmap', 'feroxbuster',
  'gobuster', 'nikto', 'nmap', 'masscan', 'netexec', 'crackmapexec', 'certipy',
  'bloodhound-python', 'subfinder', 'amass', 'gau', 'waybackurls', 'ssh', 'scp',
  'nc', 'ncat', 'openssl',
]);
const HTTP_COMMANDS = new Set([
  'curl', 'wget', 'httpx', 'ffuf', 'nuclei', 'katana', 'sqlmap', 'feroxbuster',
  'gobuster', 'nikto',
]);
const PASSIVE_HOSTS = [
  'shodan.io', 'censys.io', 'crt.sh', 'api.github.com', 'github.com', 'gitlab.com',
  'archive.org', 'web.archive.org', 'virustotal.com', 'dns.google', 'cloudflare-dns.com',
];
const PRIVILEGED_WATCHDOG_TOOLS = new Set([
  'mcp__watchdog__agent_halt',
  'mcp__watchdog__agent_resume',
  'mcp__watchdog__target_mark',
]);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function normalizeHost(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return '';
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase(); }
  catch { return ''; }
}

function isLoopback(value) {
  const host = normalizeHost(value);
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.local');
}

function extractTargets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  const found = new Set();
  const urlPattern = /https?:\/\/[^\s'"`<>]+/gi;
  const urlSpans = [];
  for (const match of text.matchAll(urlPattern)) {
    const cleaned = match[0].replace(/[),.;]+$/, '');
    urlSpans.push([match.index, match.index + match[0].length]);
    if (!isLoopback(cleaned)) found.add(cleaned);
  }
  const bareTargetText = [...text].map((char, index) => (
    urlSpans.some(([start, end]) => index >= start && index < end) ? ' ' : char
  )).join('');
  for (const match of bareTargetText.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi)) {
    const host = match[0].toLowerCase();
    if (!isLoopback(host)) found.add(`https://${host}`);
  }
  for (const match of bareTargetText.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!isLoopback(match[0])) found.add(`https://${match[0]}`);
  }
  return [...found];
}

function shellCommandName(command) {
  const commandText = String(command || '').trim();
  const first = commandText.split(/\s+/).find(token => token && !/^\w+=/.test(token)) || '';
  return path.basename(first.replace(/^['"]|['"]$/g, '')).toLowerCase();
}

function classifyToolUse(toolName, input = {}) {
  const name = String(toolName || '');
  const command = name === 'Bash' ? String(input.command || input.cmd || '') : '';
  const commandName = shellCommandName(command);
  const browser = /mcp__browser(?:-[a-z0-9._-]+)?__browser_/i.test(name);
  const browserNavigation = browser && /__browser_(?:navigate|tabs|click|press_key|fill_form|type|select_option|evaluate)$/i.test(name);
  const browserNavigateToUrl = browser && /__browser_navigate$/i.test(name);
  const webFetch = name === 'WebFetch';
  const networkShell = name === 'Bash' && NETWORK_COMMANDS.has(commandName) && !/\s--?(?:version|help)\b/.test(command);
  const mutating = /(?:\s|^)(?:-X\s*)?(?:POST|PUT|PATCH|DELETE)\b/i.test(command)
    || /(?:--data(?:-raw|-binary)?|-d)\s/.test(command)
    || /\b(?:sqlmap|ffuf|nuclei|masscan|nikto|gobuster|feroxbuster)\b/i.test(command)
    || (browser && /__browser_(?:click|fill_form|type|select_option|file_upload|evaluate)$/i.test(name));
  const targetCapable = webFetch || networkShell || browserNavigation
    || name === 'mcp__glados-ops__adfs_active_directory_login';
  return {
    command,
    commandName,
    browser,
    webFetch,
    networkShell,
    httpShell: networkShell && HTTP_COMMANDS.has(commandName),
    mutating,
    targetCapable,
    // Current-page browser tools (click, fill, evaluate, and so on) contain
    // selectors or JavaScript, not network targets. Scope them to the targets
    // extracted from the operator turn instead of parsing expressions such as
    // document.cookie as hostnames.
    targets: browserNavigateToUrl
      ? extractTargets(input.url)
      : ((webFetch || networkShell) ? extractTargets(input) : []),
  };
}

function forbiddenSecretAccess(toolName, input = {}) {
  const text = JSON.stringify(input || {});
  const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const secretPath = new RegExp(`(?:${home}|~)?\\/?\\.glados\\/secrets(?:\\/|["'])`, 'i');
  const haltPath = new RegExp(`(?:${home}|~)?\\/?\\.glados\\/halts(?:\\/|["'])`, 'i');
  const browserConfigPath = new RegExp(`(?:${home}|~)?\\/?\\.glados\\/browser-mcp(?:\\/|["'])`, 'i');
  if (secretPath.test(text)) return 'agent tools may not access ~/.glados/secrets';
  if (haltPath.test(text)) return 'agent tools may not modify or inspect ~/.glados/halts';
  if (browserConfigPath.test(text)) return 'agent tools may not modify or inspect per-agent browser attribution config';
  if (toolName === 'Bash' && /\b(?:ANTHROPIC_AUTH_TOKEN|LLMAPI_API_KEY)\b|security\s+find-generic-password/i.test(text)) {
    return 'agent shell may not read LLM or Keychain secret material';
  }
  return null;
}

function hostMatches(host, rule) {
  const clean = String(rule || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean) return false;
  if (clean.startsWith('*.')) return host === clean.slice(2) || host.endsWith(clean.slice(1));
  return host === clean || host.endsWith(`.${clean}`);
}

function activeScopes() {
  if (!fs.existsSync(BLACKBOARD_DB)) return [];
  let db;
  try {
    db = new Database(BLACKBOARD_DB, { readonly: true, fileMustExist: true });
    return db.prepare("SELECT id, scope FROM engagements WHERE status = 'active' ORDER BY started_at DESC").all()
      .flatMap(row => {
        let scope = row.scope;
        try { scope = JSON.parse(scope); } catch {}
        return (Array.isArray(scope) ? scope : [scope]).filter(Boolean).map(item => ({ engagementId: row.id, item }));
      });
  } catch { return []; }
  finally { try { db?.close(); } catch {} }
}

function targetAllowed(agentId, target, turnTargets = []) {
  const host = normalizeHost(target);
  if (!host) return { allowed: false, reason: `could not determine target host from ${target}` };
  if (PASSIVE_HOSTS.some(rule => hostMatches(host, rule)) && PHASE1_AGENTS.has(agentId)) {
    return { allowed: true, reason: `phase-1 passive surface ${host}` };
  }

  const acl = readJson(FETCH_ACL, null);
  const aclRules = acl?.enabled === true ? acl?.agents?.[agentId]?.allow || [] : [];
  if (aclRules.some(rule => hostMatches(host, rule))) {
    return { allowed: true, reason: `approved plan ACL includes ${host}` };
  }

  const promptRules = (turnTargets || []).map(normalizeHost).filter(Boolean);
  if (promptRules.some(rule => hostMatches(host, rule))) {
    return { allowed: true, reason: `operator prompt explicitly named ${host}` };
  }

  const scope = activeScopes();
  const matched = scope.find(entry => {
    const item = typeof entry.item === 'string'
      ? entry.item
      : entry.item?.host || entry.item?.url || entry.item?.domain || '';
    return hostMatches(host, normalizeHost(item));
  });
  if (matched) return { allowed: true, reason: `active engagement ${matched.engagementId} includes ${host}`, engagementId: matched.engagementId };
  return { allowed: false, reason: `${host} is not in an active engagement, approved plan ACL, or the current operator prompt` };
}

function targetHealthDecision(target) {
  if (!fs.existsSync(WATCHDOG_DB)) return { allowed: true, state: 'unknown' };
  let db;
  try {
    db = new Database(WATCHDOG_DB, { readonly: true, fileMustExist: true });
    const host = normalizeHost(target);
    const rows = db.prepare('SELECT * FROM target_health ORDER BY updated_at DESC LIMIT 200').all();
    const row = rows.find(candidate => normalizeHost(candidate.target_url) === host);
    if (!row) return { allowed: true, state: 'unknown' };
    if (['paused', 'down'].includes(row.state)) return { allowed: false, state: row.state, reason: `watchdog target health is ${row.state}` };
    return { allowed: true, state: row.state || 'unknown' };
  } catch { return { allowed: true, state: 'unknown' }; }
  finally { try { db?.close(); } catch {} }
}

function hasRequiredHttpAttribution(agentId, classification) {
  if (!classification.httpShell) return { allowed: true };
  const command = classification.command;
  const hasProxy = /(?:^|\s)(?:-x|--proxy)\s+(?:['"]?\$\{?GLADOS_PROXY_URL\}?|['"]?http:\/\/127\.0\.0\.1:18080)/i.test(command);
  const tag = new RegExp(`X-GLaDOS-Agent\\s*:\\s*${agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (!hasProxy) return { allowed: false, reason: `${classification.commandName} target HTTP must use --proxy/-x $GLADOS_PROXY_URL` };
  if (!tag.test(command)) return { allowed: false, reason: `${classification.commandName} must set X-GLaDOS-Agent: ${agentId}` };
  return { allowed: true };
}

function evaluateToolUse({ agentId, toolName, input = {}, turnTargets = [] }) {
  const halt = agentStatus(agentId);
  if (halt.haltActive) {
    return { allowed: false, interrupt: true, reason: `${agentId} is halted by ${halt.marker?.initiator || 'operator'}: ${halt.marker?.reason || 'halt active'}` };
  }

  const secretReason = forbiddenSecretAccess(toolName, input);
  if (secretReason) return { allowed: false, interrupt: true, reason: secretReason };

  if (PRIVILEGED_WATCHDOG_TOOLS.has(toolName) && agentId !== 'glados') {
    return { allowed: false, interrupt: true, reason: `only GLaDOS may call ${toolName}` };
  }

  if ((toolName === 'Task' || toolName === 'Agent')) {
    const targetAgent = input.subagent_type || input.subagentType || input.agent || input.agentId || input.agent_id;
    const plan = planCheckDispatch(targetAgent);
    if (!plan.allowed) return { allowed: false, reason: `subagent plan gate denied: ${plan.reason}`, plan };
  }

  const use = classifyToolUse(toolName, input);
  if (use.webFetch) {
    return { allowed: false, reason: 'WebFetch is not proxy-attributed; use the agent-specific browser MCP or a tagged proxied shell HTTP command' };
  }
  if (!use.targetCapable) return { allowed: true, reason: `${toolName} is a local or passive operation` };
  if (agentId === 'glados') {
    return { allowed: false, reason: 'GLaDOS is the coordinator and must dispatch a named specialist for target-capable work' };
  }

  const plan = planCheckDispatch(agentId);
  if (!plan.allowed) return { allowed: false, reason: `plan gate denied ${agentId}: ${plan.reason}`, plan };
  if (PHASE1_AGENTS.has(agentId) && use.mutating && !use.browser) {
    return { allowed: false, reason: `${agentId} is phase-1 and may not perform mutating or active-test operations` };
  }

  const attribution = hasRequiredHttpAttribution(agentId, use);
  if (!attribution.allowed) return attribution;

  const targets = use.targets.length ? use.targets : (use.browser ? turnTargets : []);
  for (const target of targets) {
    const scope = targetAllowed(agentId, target, turnTargets);
    if (!scope.allowed) return { allowed: false, reason: `scope gate denied: ${scope.reason}` };
    const health = targetHealthDecision(target);
    if (!health.allowed) return { allowed: false, reason: `health gate denied: ${health.reason}` };
  }
  if ((use.networkShell || use.browser) && targets.length === 0) {
    return { allowed: false, reason: `${toolName} is target-capable but no target could be extracted for scope enforcement` };
  }
  return { allowed: true, reason: `scope, health, plan, attribution, and halt gates passed`, plan };
}

module.exports = {
  classifyToolUse,
  evaluateToolUse,
  extractTargets,
  targetAllowed,
  targetHealthDecision,
  forbiddenSecretAccess,
};
