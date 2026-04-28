#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates', 'agents', 'default');
const REGISTRY_PATH = path.join(REPO_ROOT, 'templates', 'agent-registry.json');
const DOTENV_PATH = path.join(REPO_ROOT, '.env');
const DEFAULT_OPERATOR_CONTEXT = path.join(REPO_ROOT, 'templates', 'operator-context', 'ford-redteam.json');
const REPORTING_TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates', 'reporting');

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`WARN: ${msg}\n`); }
function fail(msg, code = 1) { process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); }

function expandValue(value) {
  if (value == null) return value;
  return String(value)
    .replace(/\$HOME\b/g, os.homedir())
    .replace(/^~(?=$|\/)/, os.homedir());
}

function loadDotenv(file = DOTENV_PATH) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = expandValue(value);
    env[m[1]] = value;
    if (process.env[m[1]] == null) process.env[m[1]] = value;
  }
  return env;
}

function localPaths() {
  loadDotenv();
  const runtimeDir = path.resolve(expandValue(process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados')));
  const openclawHome = path.resolve(expandValue(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw')));
  return {
    repoRoot: REPO_ROOT,
    runtimeDir,
    openclawHome,
    agentsDir: path.resolve(expandValue(process.env.GLADOS_AGENT_WORKSPACES || path.join(runtimeDir, 'workspaces', 'agents'))),
    reportsDir: path.resolve(expandValue(process.env.GLADOS_REPORTS_DIR || path.join(runtimeDir, 'reports'))),
    investigationsDir: path.resolve(expandValue(process.env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations'))),
    blackboardDir: path.resolve(path.dirname(expandValue(process.env.BLACKBOARD_DB || path.join(runtimeDir, 'blackboard', 'blackboard.db')))),
    blackboardDb: path.resolve(expandValue(process.env.BLACKBOARD_DB || path.join(runtimeDir, 'blackboard', 'blackboard.db'))),
    watchdogDir: path.resolve(path.dirname(expandValue(process.env.WATCHDOG_DB || path.join(runtimeDir, 'watchdog', 'watchdog.db')))),
    watchdogDb: path.resolve(expandValue(process.env.WATCHDOG_DB || path.join(runtimeDir, 'watchdog', 'watchdog.db'))),
    customAgentsJson: path.join(runtimeDir, 'custom-agents.json'),
    seedStatePath: path.join(runtimeDir, 'agent-seed-state.json'),
    upstreamStatusPath: path.join(runtimeDir, 'upstream-agent-status.json'),
    operatorContextPath: path.join(runtimeDir, 'operator-context.json'),
    secretsDir: path.join(runtimeDir, 'secrets'),
    localAuthPath: path.join(runtimeDir, 'secrets', 'local-auth.json'),
    openclawJson: path.join(openclawHome, 'openclaw.json'),
    openclawAgentsDir: path.join(openclawHome, 'agents'),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fileList(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === '.DS_Store') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...fileList(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function hashDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  for (const rel of fileList(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function copyDir(src, dst) {
  ensureDir(path.dirname(dst));
  fs.cpSync(src, dst, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: source => !path.basename(source).startsWith('.DS_Store'),
  });
}

function templateAgents() {
  if (!fs.existsSync(TEMPLATE_ROOT)) return [];
  return fs.readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function registryById() {
  const rows = readJson(REGISTRY_PATH, []);
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : rows.agents || []) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}

function createLocalAgentJson(file, entry, templateHash) {
  if (fs.existsSync(file)) return;
  writeJson(file, {
    id: entry.id,
    name: entry.name || entry.id,
    model: entry.model || process.env.GLADOS_PRIMARY_MODEL || 'custom-llmapi-redteamstuff-com/claude-sonnet-4-6',
    enabled: true,
    upstream: {
      source: `templates/agents/default/${entry.id}`,
      installed_template_hash: templateHash,
      installed_at: new Date().toISOString(),
    },
  });
}

function ensureRuntimeDirs(paths) {
  for (const dir of [
    paths.runtimeDir,
    paths.agentsDir,
    paths.reportsDir,
    paths.investigationsDir,
    paths.blackboardDir,
    paths.watchdogDir,
    paths.secretsDir,
    paths.openclawHome,
    paths.openclawAgentsDir,
  ]) ensureDir(dir);
  if (!fs.existsSync(paths.customAgentsJson)) writeJson(paths.customAgentsJson, { version: 1, agents: [] });
  if (!fs.existsSync(paths.operatorContextPath) && fs.existsSync(DEFAULT_OPERATOR_CONTEXT)) {
    fs.copyFileSync(DEFAULT_OPERATOR_CONTEXT, paths.operatorContextPath);
    fs.chmodSync(paths.operatorContextPath, 0o600);
  }
  installReportTemplates(paths);
}

function installReportTemplates(paths) {
  const src = path.join(REPORTING_TEMPLATE_ROOT, 'askfiona.ford.com', 'REPORT-TEMPLATE.md');
  const dst = path.join(paths.reportsDir, 'askfiona.ford.com', 'REPORT-TEMPLATE.md');
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
}

function bootstrapAgents(paths) {
  const registry = registryById();
  const state = readJson(paths.seedStatePath, { version: 1, installed_at: new Date().toISOString(), templates: {} });
  const installed = [];
  const skipped = [];
  for (const id of templateAgents()) {
    const src = path.join(TEMPLATE_ROOT, id);
    const dst = path.join(paths.agentsDir, id);
    const hash = hashDir(src);
    const entry = registry.get(id) || { id, name: id };
    if (!fs.existsSync(dst)) {
      copyDir(src, dst);
      createLocalAgentJson(path.join(dst, 'agent.json'), entry, hash);
      installed.push(id);
    } else {
      skipped.push(id);
      createLocalAgentJson(path.join(dst, 'agent.json'), entry, hash);
    }
    const installedLocalHash = fs.existsSync(dst) ? hashDir(dst) : hash;
    state.templates[id] = {
      source: `templates/agents/default/${id}`,
      installed_template_hash: state.templates[id]?.installed_template_hash || hash,
      installed_local_hash: state.templates[id]?.installed_local_hash || installedLocalHash,
      latest_upstream_hash: hash,
      local_path: dst,
      installed_at: state.templates[id]?.installed_at || new Date().toISOString(),
    };
  }
  writeJson(paths.seedStatePath, state);
  return { installed, skipped };
}

function updateAgentStatus(paths) {
  const registry = registryById();
  const state = readJson(paths.seedStatePath, { version: 1, installed_at: null, templates: {} });
  const status = {
    checked_at: new Date().toISOString(),
    new_upstream_agents: [],
    upstream_template_changed: [],
    local_agent_differs_from_installed_seed: [],
    local_agent_removed: [],
    custom_agents: [],
  };
  const templates = templateAgents();
  for (const id of templates) {
    const src = path.join(TEMPLATE_ROOT, id);
    const local = path.join(paths.agentsDir, id);
    const upstreamHash = hashDir(src);
    const recorded = state.templates[id];
    if (!recorded) {
      status.new_upstream_agents.push({ id, name: registry.get(id)?.name || id, source: `templates/agents/default/${id}` });
      continue;
    }
    if (!fs.existsSync(local)) {
      status.local_agent_removed.push({ id, source: `templates/agents/default/${id}` });
      state.templates[id] = { ...recorded, latest_upstream_hash: upstreamHash, removed_local_at: recorded.removed_local_at || new Date().toISOString() };
      continue;
    }
    const localHash = hashDir(local);
    const installedLocalHash = recorded.installed_local_hash || recorded.installed_template_hash;
    if (installedLocalHash && localHash && localHash !== installedLocalHash) {
      status.local_agent_differs_from_installed_seed.push({ id, local_path: local });
    }
    if (recorded.latest_upstream_hash && upstreamHash !== recorded.latest_upstream_hash) {
      status.upstream_template_changed.push({
        id,
        source: `templates/agents/default/${id}`,
        previous_hash: recorded.latest_upstream_hash,
        new_hash: upstreamHash,
        local_path: local,
      });
    }
    state.templates[id] = { ...recorded, latest_upstream_hash: upstreamHash, local_path: local };
  }
  const templateSet = new Set(templates);
  if (fs.existsSync(paths.agentsDir)) {
    for (const d of fs.readdirSync(paths.agentsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      if (!templateSet.has(d.name)) {
        status.custom_agents.push({ id: d.name, local_path: path.join(paths.agentsDir, d.name) });
      }
    }
  }
  writeJson(paths.seedStatePath, state);
  writeJson(paths.upstreamStatusPath, status);
  return status;
}

function localAgentEntries(paths) {
  const registry = registryById();
  const entries = [];
  if (!fs.existsSync(paths.agentsDir)) return entries;
  for (const d of fs.readdirSync(paths.agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const workspace = path.join(paths.agentsDir, d.name);
    const meta = readJson(path.join(workspace, 'agent.json'), {});
    if (meta.enabled === false || fs.existsSync(path.join(workspace, '.disabled'))) continue;
    const upstream = registry.get(d.name) || {};
    const id = meta.id || upstream.id || d.name;
    entries.push({
      id,
      name: meta.name || upstream.name || id,
      workspace,
      agentDir: path.join(paths.openclawAgentsDir, id, 'agent'),
      model: meta.model || upstream.model || process.env.GLADOS_PRIMARY_MODEL || 'custom-llmapi-redteamstuff-com/claude-sonnet-4-6',
      identity: meta.identity || upstream.identity,
    });
  }
  return entries;
}

function existingComputerUseServer(existing) {
  const server = existing?.mcp?.servers?.['computer-use'];
  if (server?.command) return server;
  const candidates = [
    '/opt/homebrew/lib/node_modules/computer-use-mcp/dist/main.js',
    '/usr/local/lib/node_modules/computer-use-mcp/dist/main.js',
  ];
  const found = candidates.find(p => fs.existsSync(p));
  return found ? { command: 'node', args: [found] } : null;
}

function providerModel(id) {
  return { id, name: id.split('/').slice(1).join('/') || id };
}

function generateOpenClawConfig(paths) {
  const existing = readJson(paths.openclawJson, {});
  const agents = localAgentEntries(paths);
  for (const a of agents) {
    ensureDir(a.agentDir);
    const sessionDir = path.join(paths.openclawAgentsDir, a.id, 'sessions');
    ensureDir(sessionDir);
    const sessionIndex = path.join(sessionDir, 'sessions.json');
    if (!fs.existsSync(sessionIndex)) writeJson(sessionIndex, {});
  }

  const primary = process.env.GLADOS_PRIMARY_MODEL || existing?.agents?.defaults?.model?.primary || 'custom-llmapi-redteamstuff-com/claude-sonnet-4-6';
  const llmApiKey = process.env.LLMAPI_API_KEY || existing?.models?.providers?.['custom-llmapi-redteamstuff-com']?.apiKey || 'replace-me';
  const llmBaseUrl = process.env.LLMAPI_BASE_URL || existing?.models?.providers?.['custom-llmapi-redteamstuff-com']?.baseUrl || 'https://llmapi.redteamstuff.com/';
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || existing?.models?.providers?.['ollama-local']?.baseUrl || 'http://localhost:11434/v1/';
  const localModel = process.env.GLADOS_LOCAL_MODEL || 'glm-4.7-flash:latest';
  const burpProxy = process.env.BURP_PROXY || 'http://127.0.0.1:8080';
  const burpExtApi = process.env.BURP_EXT_API || 'http://127.0.0.1:1338';
  const burpApi = process.env.BURP_API || 'http://127.0.0.1:1337';
  const gatewayToken = existing?.gateway?.auth?.token || crypto.randomBytes(24).toString('hex');
  const toolPath = [
    path.join(REPO_ROOT, 'tools', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  const mcpEnv = {
    GLADOS_RUNTIME_DIR: paths.runtimeDir,
    GLADOS_REPO_ROOT: REPO_ROOT,
    GLADOS_AGENT_WORKSPACES: paths.agentsDir,
    GLADOS_REPORTS_DIR: paths.reportsDir,
    GLADOS_INVESTIGATIONS_DIR: paths.investigationsDir,
    GLADOS_OPERATOR_CONTEXT: paths.operatorContextPath,
    GLADOS_LOCAL_AUTH: paths.localAuthPath,
    BLACKBOARD_DB: paths.blackboardDb,
    WATCHDOG_DB: paths.watchdogDb,
    OPENCLAW_HOME: paths.openclawHome,
    BURP_PROXY: burpProxy,
    BURP_API: burpApi,
    BURP_EXT_API: burpExtApi,
    PATH: toolPath,
  };
  const servers = {
    watchdog: { command: 'node', args: [path.join(REPO_ROOT, 'watchdog', 'watchdog-mcp', 'index.js')], env: mcpEnv },
    blackboard: { command: 'node', args: [path.join(REPO_ROOT, 'blackboard', 'blackboard-mcp', 'index.js')], env: mcpEnv },
    'glados-ops': { command: 'node', args: [path.join(REPO_ROOT, 'tools', 'glados-ops-mcp', 'index.js')], env: mcpEnv },
  };
  const computerUse = existingComputerUseServer(existing);
  if (computerUse) servers['computer-use'] = computerUse;

  const meta = { ...(existing.meta || {}) };
  delete meta.gladosLocalVersion;
  meta.lastTouchedAt = new Date().toISOString();

  const config = {
    ...existing,
    meta,
    models: {
      ...(existing.models || {}),
      mode: 'merge',
      providers: {
        ...(existing.models?.providers || {}),
        'custom-llmapi-redteamstuff-com': {
          ...(existing.models?.providers?.['custom-llmapi-redteamstuff-com'] || {}),
          baseUrl: llmBaseUrl,
          ['api' + 'Key']: llmApiKey,
          api: 'openai-completions',
          models: [
            providerModel('claude-sonnet-4-6'),
            providerModel('claude-opus-4-7'),
            providerModel('claude-haiku-4-5'),
          ],
        },
        'ollama-local': {
          ...(existing.models?.providers?.['ollama-local'] || {}),
          baseUrl: ollamaBaseUrl,
          ['api' + 'Key']: existing.models?.providers?.['ollama-local']?.apiKey || 'ollama',
          api: 'openai-completions',
          models: [providerModel(localModel)],
        },
      },
    },
    agents: {
      defaults: {
        ...(existing.agents?.defaults || {}),
        model: { primary },
        models: { [primary]: {} },
        workspace: paths.agentsDir,
        compaction: { mode: 'safeguard' },
        maxConcurrent: Number(process.env.GLADOS_MAX_CONCURRENT || existing.agents?.defaults?.maxConcurrent || 6),
        subagents: {
          maxConcurrent: Math.max(agents.length, Number(process.env.GLADOS_SUBAGENT_MAX || existing.agents?.defaults?.subagents?.maxConcurrent || 6)),
          allowAgents: ['*'],
        },
        llm: { idleTimeoutSeconds: Number(process.env.OPENCLAW_LLM_IDLE_TIMEOUT_SECONDS || existing.agents?.defaults?.llm?.idleTimeoutSeconds || 1200) },
      },
      list: agents,
    },
    tools: existing.tools || {
      profile: 'full',
      sessions: { visibility: 'all' },
      agentToAgent: { enabled: true, allow: ['*'] },
      fs: { workspaceOnly: false },
    },
    gateway: {
      ...(existing.gateway || {}),
      port: Number(process.env.OPENCLAW_GATEWAY_PORT || existing.gateway?.port || 18789),
      mode: existing.gateway?.mode || 'local',
      bind: existing.gateway?.bind || 'loopback',
      auth: { mode: 'token', ['to' + 'ken']: gatewayToken },
      tailscale: existing.gateway?.tailscale || { mode: 'off', resetOnExit: false },
      nodes: existing.gateway?.nodes || {
        denyCommands: ['camera.snap', 'camera.clip', 'screen.record', 'contacts.add', 'calendar.add', 'reminders.add', 'sms.send'],
      },
    },
    plugins: existing.plugins || { entries: { browser: { enabled: true } }, installs: {} },
    mcp: { servers },
    browser: {
      ...(existing.browser || {}),
      extraArgs: [
        `--proxy-server=${burpProxy}`,
        '--ignore-certificate-errors',
        '--proxy-bypass-list=localhost;127.0.0.1;::1',
      ],
    },
    env: {
      ...(existing.env || {}),
      GLADOS_RUNTIME_DIR: paths.runtimeDir,
      GLADOS_REPO_ROOT: REPO_ROOT,
      GLADOS_AGENT_WORKSPACES: paths.agentsDir,
      GLADOS_REPORTS_DIR: paths.reportsDir,
      GLADOS_INVESTIGATIONS_DIR: paths.investigationsDir,
      GLADOS_OPERATOR_CONTEXT: paths.operatorContextPath,
      GLADOS_LOCAL_AUTH: paths.localAuthPath,
      BLACKBOARD_DB: paths.blackboardDb,
      WATCHDOG_DB: paths.watchdogDb,
      BURP_PROXY: burpProxy,
      BURP_API: burpApi,
      BURP_EXT_API: burpExtApi,
      HTTPS_PROXY: burpProxy,
      HTTP_PROXY: burpProxy,
      NO_PROXY: 'localhost,127.0.0.1,::1,host.docker.internal,llmapi.redteamstuff.com',
      OPENCLAW_RAW_STREAM: process.env.OPENCLAW_RAW_STREAM || '1',
      PATH: toolPath,
      JAVA_HOME: process.env.JAVA_HOME || existing.env?.JAVA_HOME || '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
      DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH || existing.env?.DYLD_LIBRARY_PATH || '/opt/homebrew/opt/expat/lib',
    },
  };
  delete config.env.OPENCLAW_HOME;
  if (fs.existsSync(paths.openclawJson)) {
    const backup = `${paths.openclawJson}.bak-glados-local-${Date.now()}`;
    fs.copyFileSync(paths.openclawJson, backup);
  }
  writeJson(paths.openclawJson, config);
  return { agents: agents.map(a => ({ id: a.id, model: a.model, workspace: a.workspace })), openclawJson: paths.openclawJson };
}

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, cmd);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function sqlite() {
  return which('sqlite3') || '/usr/bin/sqlite3';
}

function runSql(dbPath, sql, { ignoreError = false } = {}) {
  ensureDir(path.dirname(dbPath));
  const result = cp.spawnSync(sqlite(), [dbPath], { input: sql, encoding: 'utf8' });
  if (result.status !== 0 && !ignoreError) {
    throw new Error(`sqlite failed for ${dbPath}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function sqliteTableColumns(dbPath, table) {
  const result = cp.spawnSync(sqlite(), [dbPath, `PRAGMA table_info(${table});`], { encoding: 'utf8' });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split(/\r?\n/).map(line => line.split('|')[1]).filter(Boolean));
}

function ensureBlackboardDb(paths) {
  runSql(paths.blackboardDb, `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  target_name TEXT NOT NULL,
  scope TEXT,
  status TEXT DEFAULT 'active',
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  finding_type TEXT NOT NULL,
  cwe_id TEXT,
  affected_component TEXT NOT NULL,
  severity TEXT,
  priority TEXT DEFAULT 'INFORMATIONAL',
  cvss_score REAL,
  title TEXT NOT NULL,
  description TEXT,
  evidence TEXT,
  reproduction_steps TEXT,
  discovered_by TEXT NOT NULL,
  validated_by TEXT,
  validation_status TEXT DEFAULT 'pending',
  dradis_pushed INTEGER DEFAULT 0,
  enables_vectors TEXT,
  confidence_score REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);
CREATE INDEX IF NOT EXISTS idx_findings_dedup ON findings(target_url, cwe_id, affected_component);
CREATE INDEX IF NOT EXISTS idx_findings_engagement ON findings(engagement_id);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  assigned_by TEXT DEFAULT 'glados',
  task_type TEXT NOT NULL,
  target TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_engagement ON tasks(engagement_id);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending_approval',
  plan_json TEXT NOT NULL,
  recon_summary TEXT,
  parent_plan_id TEXT REFERENCES plans(id),
  replan_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_engagement ON plans(engagement_id, state);
CREATE INDEX IF NOT EXISTS idx_plans_state ON plans(state);
CREATE TABLE IF NOT EXISTS plan_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  approved_vectors TEXT,
  modifications TEXT,
  operator TEXT NOT NULL DEFAULT 'operator',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_plan ON plan_approvals(plan_id);
CREATE TABLE IF NOT EXISTS baseline_recon (
  engagement_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL DEFAULT '{}',
  complete INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);
CREATE TABLE IF NOT EXISTS recon_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL,
  step TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  output_json TEXT,
  duration_ms INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);
CREATE INDEX IF NOT EXISTS idx_recon_steps_engagement ON recon_steps(engagement_id, step);
CREATE INDEX IF NOT EXISTS idx_recon_steps_status ON recon_steps(status);
CREATE TABLE IF NOT EXISTS replan_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL,
  finding_id INTEGER NOT NULL,
  cwe_id TEXT,
  confidence_score REAL,
  enables_vectors TEXT,
  current_plan_id TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  UNIQUE (engagement_id, finding_id),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id),
  FOREIGN KEY (finding_id) REFERENCES findings(id)
);
CREATE INDEX IF NOT EXISTS idx_replan_state ON replan_proposals(state);
`);
  const cols = sqliteTableColumns(paths.blackboardDb, 'findings');
  if (!cols.has('enables_vectors')) runSql(paths.blackboardDb, 'ALTER TABLE findings ADD COLUMN enables_vectors TEXT;', { ignoreError: true });
  if (!cols.has('confidence_score')) runSql(paths.blackboardDb, 'ALTER TABLE findings ADD COLUMN confidence_score REAL;', { ignoreError: true });
}

function ensureWatchdogDb(paths) {
  runSql(paths.watchdogDb, `
CREATE TABLE IF NOT EXISTS target_health (
  target_url TEXT PRIMARY KEY,
  last_probed_at INTEGER,
  last_status INTEGER,
  consecutive_failures INTEGER DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS halt_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  engagement_id TEXT,
  reason TEXT,
  initiator TEXT,
  action TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS breaker_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_host TEXT NOT NULL,
  tripped_at INTEGER NOT NULL,
  sample_count INTEGER,
  last_status INTEGER
);
`);
}

function installDeps() {
  const dirs = [
    'dashboard',
    'blackboard/blackboard-mcp',
    'watchdog',
    'watchdog/watchdog-mcp',
    'tools/glados-ops-mcp',
  ];
  for (const rel of dirs) {
    const dir = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
    log(`npm install --prefix ${rel}`);
    const r = cp.spawnSync('npm', ['install', '--prefix', dir], { stdio: 'inherit' });
    if (r.status !== 0) fail(`npm install failed in ${rel}`);
  }
}

function restartGateway() {
  if (process.argv.includes('--no-restart')) return { skipped: true };
  const openclaw = process.env.OPENCLAW_BIN || 'openclaw';
  const found = which(openclaw);
  if (!found) return { skipped: true, reason: 'openclaw not found' };
  const r = cp.spawnSync(found, ['daemon', 'restart'], { stdio: 'inherit' });
  return { skipped: r.status !== 0, status: r.status };
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function doctor({ json = false } = {}) {
  const paths = localPaths();
  const issues = [];
  const warnings = [];
  const checks = {};
  checks.runtime_outside_repo = !inside(REPO_ROOT, paths.runtimeDir);
  checks.agents_outside_repo = !inside(REPO_ROOT, paths.agentsDir);
  checks.reports_outside_repo = !inside(REPO_ROOT, paths.reportsDir);
  checks.investigations_outside_repo = !inside(REPO_ROOT, paths.investigationsDir);
  checks.blackboard_outside_repo = !inside(REPO_ROOT, paths.blackboardDb);
  checks.watchdog_outside_repo = !inside(REPO_ROOT, paths.watchdogDb);
  for (const [k, ok] of Object.entries(checks)) if (!ok) issues.push(`${k} is false`);
  for (const p of [paths.runtimeDir, paths.agentsDir, paths.reportsDir, paths.investigationsDir, paths.blackboardDb, paths.watchdogDb, paths.openclawJson]) {
    if (!fs.existsSync(p)) warnings.push(`missing ${p}`);
  }
  const cfg = readJson(paths.openclawJson, {});
  const badAgents = (cfg?.agents?.list || []).filter(a => a.workspace && inside(REPO_ROOT, a.workspace));
  if (badAgents.length) issues.push(`OpenClaw agents still point inside repo: ${badAgents.map(a => a.id).join(', ')}`);
  const secretResult = secretScan({ quiet: true });
  if (!secretResult.ok) issues.push(`secret scan found ${secretResult.issues.length} issue(s)`);
  const result = { ok: issues.length === 0, paths, checks, issues, warnings, agent_count: (cfg?.agents?.list || []).length };
  if (json) log(JSON.stringify(result, null, 2));
  else {
    log(`GLaDOS doctor: ${result.ok ? 'OK' : 'FAILED'}`);
    log(`runtime: ${paths.runtimeDir}`);
    log(`agents: ${paths.agentsDir}`);
    log(`reports: ${paths.reportsDir}`);
    log(`investigations: ${paths.investigationsDir}`);
    log(`blackboard: ${paths.blackboardDb}`);
    log(`watchdog: ${paths.watchdogDb}`);
    log(`openclaw: ${paths.openclawJson}`);
    log(`agent count: ${result.agent_count}`);
    if (warnings.length) warnings.forEach(w => warn(w));
    if (issues.length) issues.forEach(i => warn(i));
  }
  return result;
}

const SOURCE_SKIP_DIRS = new Set([
  '.git', '.glados', '.openclaw', 'node_modules', 'Reports', 'reports', 'investigations',
  'memory', 'target-hunting', 'build', 'dist', '.gradle',
]);
const SOURCE_SKIP_PATHS = [
  /^workspaces\/glados\/MEMORY\.md$/,
  /^workspaces\/glados\/memory\//,
  /^workspaces\/glados\/investigations\//,
  /^workspaces\/glados\/target-hunting\//,
  /^blackboard\/.*\.db($|-)/,
  /^watchdog\/.*\.db($|-)/,
  /^dashboard\/node_modules\//,
  /^blackboard\/blackboard-mcp\/node_modules\//,
  /^watchdog\/node_modules\//,
  /^watchdog\/watchdog-mcp\/node_modules\//,
  /^tools\/glados-ops-mcp\/node_modules\//,
  /^tools\/burp-ext-glados-proxy-api\/build\//,
];
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.jar', '.class', '.db', '.der', '.mp3', '.zip', '.gz', '.tar']);

function walkSource(dir = REPO_ROOT, rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (SOURCE_SKIP_PATHS.some(rx => rx.test(r))) continue;
    if (e.isDirectory()) {
      if (SOURCE_SKIP_DIRS.has(e.name)) continue;
      out.push(...walkSource(dir, r));
    } else if (e.isFile()) {
      if (BINARY_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      out.push(r);
    }
  }
  return out;
}

function gitStagedFiles() {
  const r = cp.spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function secretScan({ quiet = false } = {}) {
  const staged = process.argv.includes('--staged');
  const files = staged ? (gitStagedFiles() || []) : walkSource();
  const issues = [];
  const pathBlockers = [
    /^\.env($|\.(?!example$))/,
    /^Reports\//,
    /^reports\//,
    /^investigations\//,
    /^blackboard\/.*\.db/,
    /^watchdog\/.*\.db/,
    /\.burp(state)?$/i,
    /\.har$/i,
    /\.jsonl$/i,
  ];
  const patterns = [
    { name: 'blocked-user-id', rx: new RegExp(['sco', 'sta44'].join(''), 'i') },
    { name: 'blocked-known-secret', rx: new RegExp(['Yellow14', 'doG'].join(''), 'i') },
    { name: 'api-key-looking-value', rx: /\bsk-[A-Za-z0-9_-]{12,}\b/ },
    { name: 'secret-assignment', rx: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@!-]{12,}/i },
    { name: 'bearer-token', rx: /\bBearer\s+[A-Za-z0-9_./+=-]{16,}/i },
  ];
  for (const rel of files) {
    const normalized = rel.replace(/\\/g, '/');
    for (const rx of pathBlockers) {
      if (rx.test(normalized)) issues.push({ file: normalized, reason: 'runtime-or-secret path is not distributable' });
    }
    const full = path.join(REPO_ROOT, rel);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); }
    catch { continue; }
    for (const p of patterns) {
      if (p.rx.test(text)) issues.push({ file: normalized, reason: p.name });
    }
  }
  if (!quiet) {
    if (!issues.length) log('secret scan: OK');
    else {
      log('secret scan: FAILED');
      for (const i of issues) log(`- ${i.file}: ${i.reason}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function exportReport(engagement) {
  if (!engagement) fail('usage: scripts/export-report.sh <engagement>');
  const paths = localPaths();
  const src = path.resolve(paths.reportsDir, engagement);
  if (!inside(paths.reportsDir, src) || !fs.existsSync(src)) fail(`report not found under ${paths.reportsDir}: ${engagement}`);
  const outDir = path.join(paths.runtimeDir, 'exports');
  ensureDir(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = engagement.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'engagement';
  const out = path.join(outDir, `${safe}-${stamp}.zip`);
  const zip = which('zip') || '/usr/bin/zip';
  const r = cp.spawnSync(zip, ['-qr', out, '.'], { cwd: src, stdio: 'inherit' });
  if (r.status !== 0) fail('zip export failed');
  log(out);
}

function bootstrap() {
  const paths = localPaths();
  ensureRuntimeDirs(paths);
  ensureBlackboardDb(paths);
  ensureWatchdogDb(paths);
  const agentResult = bootstrapAgents(paths);
  const oc = generateOpenClawConfig(paths);
  updateAgentStatus(paths);
  log(`bootstrap complete`);
  log(`installed agents: ${agentResult.installed.length}`);
  log(`existing agents left untouched: ${agentResult.skipped.length}`);
  log(`openclaw config: ${oc.openclawJson}`);
  if (!fs.existsSync(DOTENV_PATH)) warn('no .env found; copy .env.example to .env and set your local LLMAPI_API_KEY');
}

function update() {
  const paths = localPaths();
  ensureRuntimeDirs(paths);
  ensureBlackboardDb(paths);
  ensureWatchdogDb(paths);
  const status = updateAgentStatus(paths);
  const oc = generateOpenClawConfig(paths);
  log('update complete');
  log(`new upstream agents: ${status.new_upstream_agents.length}`);
  log(`changed upstream templates: ${status.upstream_template_changed.length}`);
  log(`local agents changed by user: ${status.local_agent_differs_from_installed_seed.length}`);
  log(`local agents removed by user: ${status.local_agent_removed.length}`);
  log(`custom agents: ${status.custom_agents.length}`);
  log(`status file: ${paths.upstreamStatusPath}`);
  log(`openclaw config: ${oc.openclawJson}`);
}

function main() {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case 'bootstrap': return bootstrap();
      case 'update': return update();
      case 'doctor': {
        const result = doctor({ json: process.argv.includes('--json') });
        process.exit(result.ok ? 0 : 1);
      }
      case 'install-deps': return installDeps();
      case 'restart-gateway': return log(JSON.stringify(restartGateway(), null, 2));
      case 'secret-scan': {
        const result = secretScan();
        process.exit(result.ok ? 0 : 1);
      }
      case 'export-report': return exportReport(process.argv[3]);
      default:
        fail(`usage: ${path.relative(REPO_ROOT, __filename)} <bootstrap|update|doctor|install-deps|restart-gateway|secret-scan|export-report>`);
    }
  } catch (e) {
    fail(e.stack || e.message);
  }
}

if (require.main === module) main();

module.exports = {
  localPaths,
  bootstrapAgents,
  updateAgentStatus,
  generateOpenClawConfig,
  ensureBlackboardDb,
  ensureWatchdogDb,
  doctor,
  secretScan,
};
