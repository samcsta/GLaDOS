#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {
  DEFAULT_BARE_MODEL,
  bareModelAlias,
} = require('./model-aliases');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates', 'agents', 'default');
const REGISTRY_PATH = path.join(REPO_ROOT, 'templates', 'agent-registry.json');
const DOTENV_PATH = path.join(REPO_ROOT, '.env');
const DEFAULT_OPERATOR_CONTEXT = path.join(REPO_ROOT, 'templates', 'operator-context', 'ford-redteam.json');
const REPORTING_TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates', 'reporting');
const DEFAULT_PRIMARY_MODEL = DEFAULT_BARE_MODEL;
const OLLAMA_PROVIDER = 'ollama-local';

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`WARN: ${msg}\n`); }
function fail(msg, code = 1) { process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); }

function truthyEnv(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function ollamaDisabled() {
  return truthyEnv(process.env.GLADOS_DISABLE_OLLAMA);
}

function primaryModel() {
  return bareModelAlias(process.env.GLADOS_PRIMARY_MODEL || DEFAULT_PRIMARY_MODEL);
}

function resolveAgentModel(model) {
  if (ollamaDisabled() && typeof model === 'string' && model.startsWith(`${OLLAMA_PROVIDER}/`)) {
    return primaryModel();
  }
  return model && String(model).startsWith(`${OLLAMA_PROVIDER}/`) ? model : bareModelAlias(model || primaryModel());
}

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
  return {
    repoRoot: REPO_ROOT,
    runtimeDir,
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
    modelOverridesPath: path.join(runtimeDir, 'model-overrides.json'),
    secretsDir: path.join(runtimeDir, 'secrets'),
    localAuthPath: path.join(runtimeDir, 'secrets', 'local-auth.json'),
    sessionsDir: path.join(runtimeDir, 'sessions'),
    trafficDir: path.join(runtimeDir, 'traffic'),
    haltsDir: path.join(runtimeDir, 'halts'),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureOwnerOnlyDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function chmodOwnerOnly(file) {
  try { fs.chmodSync(file, 0o600); }
  catch { /* best effort; caller health checks surface unreadable paths */ }
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
    model: resolveAgentModel(entry.model),
    enabled: entry.enabled !== false,
    subagent: entry.subagent !== false,
    ...(entry.dispatch ? { dispatch: entry.dispatch } : {}),
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
    paths.sessionsDir,
    paths.trafficDir,
    paths.haltsDir,
  ]) ensureDir(dir);
  for (const dir of [paths.runtimeDir, paths.sessionsDir, paths.trafficDir, paths.haltsDir]) ensureOwnerOnlyDir(dir);
  ensureOwnerOnlyDir(paths.secretsDir);
  if (!fs.existsSync(paths.customAgentsJson)) writeJson(paths.customAgentsJson, { version: 1, agents: [] });
  if (!fs.existsSync(paths.modelOverridesPath)) writeJson(paths.modelOverridesPath, {});
  if (!fs.existsSync(paths.operatorContextPath) && fs.existsSync(DEFAULT_OPERATOR_CONTEXT)) {
    fs.copyFileSync(DEFAULT_OPERATOR_CONTEXT, paths.operatorContextPath);
    fs.chmodSync(paths.operatorContextPath, 0o600);
  }
  installReportTemplates(paths);
}

function installReportTemplates(paths) {
  const src = path.join(REPORTING_TEMPLATE_ROOT, 'REPORT-TEMPLATE.md');
  const dst = path.join(paths.reportsDir, 'REPORT-TEMPLATE.md');
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

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, cmd);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function brewPrefix() {
  const r = cp.spawnSync('brew', ['--prefix'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  if (fs.existsSync('/opt/homebrew')) return '/opt/homebrew';
  return '/usr/local';
}

function sqlite() {
  const executable = which('sqlite3');
  if (!executable) {
    throw new Error('sqlite3 CLI is required but was not found in PATH');
  }
  return executable;
}

function runSql(dbPath, sql, { ignoreError = false } = {}) {
  ensureDir(path.dirname(dbPath));
  const result = cp.spawnSync(sqlite(), [dbPath], { input: sql, encoding: 'utf8' });
  if (result.status !== 0 && !ignoreError) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit status ${result.status}`;
    throw new Error(`sqlite failed for ${dbPath}: ${detail}`);
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
CREATE TABLE IF NOT EXISTS investigation_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS investigation_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES investigation_projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_investigation_sessions_one_active
  ON investigation_sessions((1)) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES investigation_sessions(id),
  target_name TEXT NOT NULL,
  scope TEXT,
  status TEXT DEFAULT 'active',
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS controller_goals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  engagement_id TEXT REFERENCES engagements(id),
  created_by TEXT NOT NULL DEFAULT 'operator',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_controller_goals_status ON controller_goals(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_controller_goals_engagement ON controller_goals(engagement_id);
CREATE TABLE IF NOT EXISTS controller_jobs (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES controller_goals(id) ON DELETE SET NULL,
  engagement_id TEXT REFERENCES engagements(id),
  agent_id TEXT NOT NULL,
  instance_id TEXT,
  job_type TEXT NOT NULL,
  target TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  sdk_session_id TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_controller_jobs_status ON controller_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_controller_jobs_agent_status ON controller_jobs(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_controller_jobs_goal ON controller_jobs(goal_id);
CREATE TABLE IF NOT EXISTS controller_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT REFERENCES controller_goals(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES controller_jobs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  message TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_controller_events_goal ON controller_events(goal_id, id);
CREATE INDEX IF NOT EXISTS idx_controller_events_job ON controller_events(job_id, id);
CREATE TABLE IF NOT EXISTS dashboard_transcript_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES investigation_sessions(id),
  agent_id TEXT NOT NULL,
  client_event_id TEXT,
  kind TEXT NOT NULL,
  text TEXT,
  event_json TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS security_review_worker_runs (
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  worker_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED','CANCELED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  requested_model TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  retry_of TEXT,
  PRIMARY KEY (engagement_id, worker_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_security_review_worker_sequence
  ON security_review_worker_runs(engagement_id, sequence);
CREATE TABLE IF NOT EXISTS security_review_worker_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED','CANCELED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  UNIQUE (engagement_id, worker_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_security_review_attempts_active
  ON security_review_worker_attempts(engagement_id, status, sequence);
CREATE TABLE IF NOT EXISTS security_review_model_observations (
  observation_id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  controller_job_id TEXT,
  agent_id TEXT NOT NULL,
  review_role TEXT,
  worker_id TEXT,
  worker_tool_call_id TEXT,
  requested_model TEXT,
  actual_model TEXT NOT NULL,
  billed_model_name TEXT,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  gateway_model_id TEXT NOT NULL,
  cost_usd REAL,
  logical_model_alias TEXT,
  provider_model TEXT,
  attestation_level TEXT NOT NULL DEFAULT 'deployment',
  gateway_call_id TEXT,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_review_llm_requests (
  request_id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  controller_job_id TEXT,
  agent_id TEXT NOT NULL,
  review_role TEXT,
  worker_id TEXT,
  worker_tool_call_id TEXT,
  requested_model TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SETTLED','UNRESOLVED','CONFLICT')) DEFAULT 'PENDING',
  lookup_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  observed_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_review_llm_pending
  ON security_review_llm_requests(engagement_id, status, observed_at);
CREATE TABLE IF NOT EXISTS litellm_relay_receipts (
  request_id TEXT PRIMARY KEY,
  gateway_call_id TEXT UNIQUE,
  logical_model_alias TEXT,
  gateway_model_id TEXT,
  gateway_model_group TEXT,
  provider_model TEXT,
  provisional_cost_usd REAL,
  final_cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'CAPTURED',
  last_error TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  reconciled_at TEXT
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
CREATE TABLE IF NOT EXISTS operator_action_approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES investigation_sessions(id),
  agent_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '*',
  risk_to_target TEXT NOT NULL DEFAULT '*',
  operator TEXT NOT NULL DEFAULT 'operator',
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_action_approvals_match
  ON operator_action_approvals(agent_id, target_url, method, expires_at);
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
  const sessionCount = runSql(paths.blackboardDb, `SELECT COUNT(*) FROM investigation_sessions;`).stdout.trim();
  if (sessionCount === '0') {
    runSql(paths.blackboardDb, `
      INSERT INTO investigation_sessions (id, name, state, metadata_json)
      VALUES ('legacy', 'Unassigned session', 'active', '{"unassigned":true,"legacy":true}');
    `);
  }
  const sessionCols = sqliteTableColumns(paths.blackboardDb, 'investigation_sessions');
  if (!sessionCols.has('project_id')) {
    runSql(paths.blackboardDb, `ALTER TABLE investigation_sessions ADD COLUMN project_id TEXT REFERENCES investigation_projects(id) ON DELETE SET NULL;`);
  }
  runSql(paths.blackboardDb, `CREATE INDEX IF NOT EXISTS idx_investigation_sessions_project ON investigation_sessions(project_id, updated_at DESC);`);
  const engagementCols = sqliteTableColumns(paths.blackboardDb, 'engagements');
  if (!engagementCols.has('session_id')) {
    runSql(paths.blackboardDb, `ALTER TABLE engagements ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES investigation_sessions(id);`);
  }
  const transcriptCols = sqliteTableColumns(paths.blackboardDb, 'dashboard_transcript_events');
  if (!transcriptCols.has('session_id')) {
    runSql(paths.blackboardDb, `ALTER TABLE dashboard_transcript_events ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES investigation_sessions(id);`);
  }
  if (!transcriptCols.has('engagement_id')) {
    runSql(paths.blackboardDb, 'ALTER TABLE dashboard_transcript_events ADD COLUMN engagement_id TEXT REFERENCES engagements(id);');
  }
  if (!transcriptCols.has('controller_job_id')) {
    runSql(paths.blackboardDb, 'ALTER TABLE dashboard_transcript_events ADD COLUMN controller_job_id TEXT REFERENCES controller_jobs(id);');
  }
  const approvalCols = sqliteTableColumns(paths.blackboardDb, 'operator_action_approvals');
  if (!approvalCols.has('session_id')) {
    runSql(paths.blackboardDb, `ALTER TABLE operator_action_approvals ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES investigation_sessions(id);`);
  }
  runSql(paths.blackboardDb, `
    DROP INDEX IF EXISTS idx_dashboard_transcript_client_id;
    DROP INDEX IF EXISTS idx_dashboard_transcript_agent_id;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_transcript_session_client_id
      ON dashboard_transcript_events(session_id, client_event_id) WHERE client_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dashboard_transcript_session_agent_id
      ON dashboard_transcript_events(session_id, agent_id, id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_transcript_engagement_id
      ON dashboard_transcript_events(engagement_id, id);
    CREATE INDEX IF NOT EXISTS idx_engagements_session_started
      ON engagements(session_id, started_at DESC);
  `);
  const cols = sqliteTableColumns(paths.blackboardDb, 'findings');
  if (!cols.has('enables_vectors')) runSql(paths.blackboardDb, 'ALTER TABLE findings ADD COLUMN enables_vectors TEXT;', { ignoreError: true });
  if (!cols.has('confidence_score')) runSql(paths.blackboardDb, 'ALTER TABLE findings ADD COLUMN confidence_score REAL;', { ignoreError: true });
  const jobCols = sqliteTableColumns(paths.blackboardDb, 'controller_jobs');
  if (!jobCols.has('sdk_session_id')) runSql(paths.blackboardDb, 'ALTER TABLE controller_jobs ADD COLUMN sdk_session_id TEXT;', { ignoreError: true });
  const observationCols = sqliteTableColumns(paths.blackboardDb, 'security_review_model_observations');
  if (!observationCols.has('billed_model_name')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_model_observations ADD COLUMN billed_model_name TEXT;', { ignoreError: true });
  if (!observationCols.has('logical_model_alias')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_model_observations ADD COLUMN logical_model_alias TEXT;', { ignoreError: true });
  if (!observationCols.has('provider_model')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_model_observations ADD COLUMN provider_model TEXT;', { ignoreError: true });
  if (!observationCols.has('attestation_level')) runSql(paths.blackboardDb, "ALTER TABLE security_review_model_observations ADD COLUMN attestation_level TEXT NOT NULL DEFAULT 'deployment';", { ignoreError: true });
  if (!observationCols.has('gateway_call_id')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_model_observations ADD COLUMN gateway_call_id TEXT;', { ignoreError: true });
  if (!observationCols.has('worker_tool_call_id')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_model_observations ADD COLUMN worker_tool_call_id TEXT;', { ignoreError: true });
  const requestCols = sqliteTableColumns(paths.blackboardDb, 'security_review_llm_requests');
  if (!requestCols.has('worker_tool_call_id')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_llm_requests ADD COLUMN worker_tool_call_id TEXT;', { ignoreError: true });
  runSql(paths.blackboardDb, 'CREATE INDEX IF NOT EXISTS idx_security_review_model_worker_dispatch ON security_review_model_observations(engagement_id, worker_tool_call_id);', { ignoreError: true });
  runSql(paths.blackboardDb, 'CREATE INDEX IF NOT EXISTS idx_security_review_request_worker_dispatch ON security_review_llm_requests(engagement_id, worker_tool_call_id);', { ignoreError: true });
  const workerCols = sqliteTableColumns(paths.blackboardDb, 'security_review_worker_runs');
  if (!workerCols.has('requested_model')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_worker_runs ADD COLUMN requested_model TEXT;', { ignoreError: true });
  if (!workerCols.has('attempt')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_worker_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;', { ignoreError: true });
  if (!workerCols.has('retry_of')) runSql(paths.blackboardDb, 'ALTER TABLE security_review_worker_runs ADD COLUMN retry_of TEXT;', { ignoreError: true });
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
  session_id TEXT NOT NULL DEFAULT 'legacy',
  engagement_id TEXT,
  reason TEXT,
  initiator TEXT,
  action TEXT NOT NULL,
  at INTEGER NOT NULL
);
`);
  const haltCols = sqliteTableColumns(paths.watchdogDb, 'halt_log');
  if (!haltCols.has('session_id')) runSql(paths.watchdogDb, "ALTER TABLE halt_log ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy';", { ignoreError: true });
}

function assertSupportedNodeForInstall() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major > 22) {
    fail([
      `Node ${process.versions.node} is too new for the current GLaDOS native dependencies on macOS.`,
      'Install Node 22 LTS instead:',
      '  brew unlink node || true',
      '  brew install node@22',
      '  brew link --overwrite --force node@22',
    ].join('\n'));
  }
}

function verifyNativeDependency(dir, moduleName, probe, env) {
  const result = cp.spawnSync(process.execPath, ['-e', probe], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  if (result.status === 0) return;
  const detail = result.stderr || result.stdout || result.error?.message || `exit status ${result.status}`;
  fail(`native dependency ${moduleName} failed to load in ${path.relative(REPO_ROOT, dir)}:\n${detail}`);
}

function installDeps() {
  assertSupportedNodeForInstall();
  const dirs = [
    'dashboard',
    'desktop',
    'blackboard/blackboard-mcp',
    'watchdog',
    'watchdog/watchdog-mcp',
    'tools/glados-ops-mcp',
  ];
  const npmEnv = { ...process.env };
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/python3')) {
    // Homebrew's latest Python can lag native-module build expectations on
    // fresh macOS installs. Xcode's system Python is the most stable node-gyp
    // choice for GLaDOS' native deps (better-sqlite3, node-pty).
    npmEnv.PYTHON = npmEnv.PYTHON || '/usr/bin/python3';
    npmEnv.npm_config_python = npmEnv.npm_config_python || '/usr/bin/python3';
  }
  for (const rel of dirs) {
    const dir = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
    log(`npm install --prefix ${rel}`);
    const r = cp.spawnSync('npm', ['install', '--prefix', dir], { stdio: 'inherit', env: npmEnv });
    if (r.status !== 0) fail(`npm install failed in ${rel}`);
    const dependencies = readJson(path.join(dir, 'package.json'), {}).dependencies || {};
    if (dependencies['better-sqlite3']) {
      verifyNativeDependency(
        dir,
        'better-sqlite3',
        "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();",
        npmEnv,
      );
    }
    if (dependencies['node-pty']) {
      verifyNativeDependency(dir, 'node-pty', "require('node-pty');", npmEnv);
    }
  }
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
  const { checkMitmCaPermissions } = require('../../dashboard/lib/proxy/mitm-ca');
  const { fallbackSecretStatus, loadLlmAuthToken } = require('../../dashboard/lib/secrets/llm-secrets');
  const { toolStatus } = require('./redteam-tools');
  checks.runtime_outside_repo = !inside(REPO_ROOT, paths.runtimeDir);
  checks.agents_outside_repo = !inside(REPO_ROOT, paths.agentsDir);
  checks.reports_outside_repo = !inside(REPO_ROOT, paths.reportsDir);
  checks.investigations_outside_repo = !inside(REPO_ROOT, paths.investigationsDir);
  checks.blackboard_outside_repo = !inside(REPO_ROOT, paths.blackboardDb);
  checks.watchdog_outside_repo = !inside(REPO_ROOT, paths.watchdogDb);
  for (const [k, ok] of Object.entries(checks)) if (!ok) issues.push(`${k} is false`);
  for (const p of [paths.runtimeDir, paths.agentsDir, paths.reportsDir, paths.investigationsDir, paths.blackboardDb, paths.watchdogDb]) {
    if (!fs.existsSync(p)) warnings.push(`missing ${p}`);
  }
  for (const dir of [paths.runtimeDir, paths.secretsDir, paths.sessionsDir, paths.trafficDir, paths.haltsDir]) {
    if (!fs.existsSync(dir)) continue;
    if ((fs.statSync(dir).mode & 0o077) !== 0) issues.push(`${dir} must be chmod 700`);
  }
  const registry = [...registryById().values()];
  const enabledAgents = registry.filter(agent => agent.enabled !== false && !fs.existsSync(path.join(paths.agentsDir, agent.id, '.disabled')));
  const mcpEntrypoints = [
    path.join(REPO_ROOT, 'blackboard', 'blackboard-mcp', 'index.js'),
    path.join(REPO_ROOT, 'watchdog', 'watchdog-mcp', 'index.js'),
    path.join(REPO_ROOT, 'tools', 'glados-ops-mcp', 'index.js'),
  ];
  checks.mcp_entrypoints = mcpEntrypoints.every(file => fs.existsSync(file));
  if (!checks.mcp_entrypoints) issues.push('one or more v4 MCP entrypoints are missing');
  let sdkVersion = null;
  try { sdkVersion = require('../../dashboard/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version; } catch {}
  checks.agent_sdk = !!sdkVersion;
  if (!sdkVersion) issues.push('@anthropic-ai/claude-agent-sdk is not installed under dashboard');
  const secretResult = secretScan({ quiet: true });
  if (!secretResult.ok) {
    issues.push(`secret scan found ${secretResult.issues.length} issue(s)`);
    for (const issue of secretResult.issues) {
      warnings.push(`secret scan match: ${issue.file} (${issue.reason})`);
    }
  }
  const mitmCa = checkMitmCaPermissions(process.env);
  checks.mitm_ca_permissions = mitmCa.ok;
  if (!mitmCa.ok) issues.push(...mitmCa.issues);
  const llmSecret = fallbackSecretStatus(process.env);
  checks.llm_secret_fallback_permissions = !llmSecret.exists || llmSecret.ownerOnly === true;
  if (llmSecret.exists && !llmSecret.ownerOnly) issues.push(`${llmSecret.path} must be chmod 600`);
  try { checks.llm_auth_available = !!loadLlmAuthToken(process.env); }
  catch (error) { checks.llm_auth_available = false; issues.push(error.message); }
  if (!checks.llm_auth_available) issues.push('LiteLLM key is unavailable; run scripts/setup-llm-secret.sh');
  const redteamTools = toolStatus({ tier: 'core' });
  checks.required_tools = redteamTools.missingRequired.length === 0;
  if (redteamTools.missingRequired.length) issues.push(`missing required tools: ${redteamTools.missingRequired.join(', ')}`);
  if (redteamTools.missing.length) warnings.push(`optional/core tools unavailable: ${redteamTools.missing.join(', ')}`);
  const result = {
    ok: issues.length === 0,
    paths,
    checks,
    agent_sdk_version: sdkVersion,
    redteam_tools: redteamTools,
    mitm_ca: mitmCa,
    llm_secret_fallback: llmSecret,
    issues,
    warnings,
    agent_count: enabledAgents.length,
  };
  if (json) log(JSON.stringify(result, null, 2));
  else {
    log(`GLaDOS doctor: ${result.ok ? 'OK' : 'FAILED'}`);
    log(`runtime: ${paths.runtimeDir}`);
    log(`agents: ${paths.agentsDir}`);
    log(`reports: ${paths.reportsDir}`);
    log(`investigations: ${paths.investigationsDir}`);
    log(`blackboard: ${paths.blackboardDb}`);
    log(`watchdog: ${paths.watchdogDb}`);
    log(`agent count: ${result.agent_count}`);
    log(`agent_sdk: ${sdkVersion || 'missing'}`);
    log(`required_tools: ${checks.required_tools ? 'true' : 'false'}`);
    log(`mitm_ca_permissions: ${mitmCa.ok ? 'true' : 'false'}`);
    log(`llm_secret_fallback_permissions: ${checks.llm_secret_fallback_permissions ? 'true' : 'false'}`);
    if (warnings.length) warnings.forEach(w => warn(w));
    if (issues.length) issues.forEach(i => warn(i));
  }
  return result;
}

const SOURCE_SKIP_DIRS = new Set([
  '.git', '.glados', 'node_modules', 'Reports', 'reports', 'investigations',
  'memory', 'target-hunting', 'build', 'dist', 'dist-verify', '.gradle', '.venv',
  '.playwright-mcp', 'tmp',
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
    /\.har$/i,
    /\.jsonl$/i,
  ];
  const patterns = [
    { name: 'blocked-user-id', rx: new RegExp(['sco', 'sta44'].join(''), 'i') },
    { name: 'blocked-known-secret', rx: new RegExp(['Yellow14', 'doG'].join(''), 'i') },
    { name: 'api-key-looking-value', rx: /\bsk-[A-Za-z0-9_-]{12,}\b/ },
    { name: 'secret-assignment', rx: /\b(api[_-]?key|secret|token|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9_./+=:@!-]{12,}["']/i },
    { name: 'bearer-token', rx: /\bBearer\s+[A-Za-z0-9_./+=-]{16,}/i },
  ];
  for (const rel of files) {
    const normalized = rel.replace(/\\/g, '/');
    if (!staged && (normalized === '.env' || normalized.startsWith('.env.'))) continue;
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
  updateAgentStatus(paths);
  log(`bootstrap complete`);
  log(`installed agents: ${agentResult.installed.length}`);
  log(`existing agents left untouched: ${agentResult.skipped.length}`);
  if (!fs.existsSync(DOTENV_PATH) && process.env.GLADOS_DESKTOP !== '1') {
    warn('no .env found; copy .env.example to .env and configure non-secret runtime paths');
  }
  return { paths, agentResult };
}

async function llmCheck() {
  loadDotenv();
  const { verifyLiteLlm } = require('../../dashboard/lib/litellm-setup');
  const result = await verifyLiteLlm({ env: process.env });
  if (result.models.ok) {
    log(`LiteLLM model catalog: OK (${result.models.count} model(s); ${result.model} ${result.models.modelAvailable ? 'available' : 'missing'})`);
  } else {
    warn(`LiteLLM model catalog: ${result.models.message}`);
  }
  if (!result.messages.ok) throw new Error(result.messages.message);
  log(`LiteLLM Anthropic Messages: OK (HTTP ${result.messages.status}, model ${result.model}, ${result.messages.latencyMs}ms)`);
  if (!result.models.ok) warn('Chat is authorized, but Settings model discovery will remain unavailable until /v1/models access is granted.');
  if (!result.models.modelAvailable) throw new Error(`LiteLLM model ${result.model} is not available to this key.`);
  return result;
}

function update() {
  const paths = localPaths();
  ensureRuntimeDirs(paths);
  ensureBlackboardDb(paths);
  ensureWatchdogDb(paths);
  const status = updateAgentStatus(paths);
  log('update complete');
  log(`new upstream agents: ${status.new_upstream_agents.length}`);
  log(`changed upstream templates: ${status.upstream_template_changed.length}`);
  log(`local agents changed by user: ${status.local_agent_differs_from_installed_seed.length}`);
  log(`local agents removed by user: ${status.local_agent_removed.length}`);
  log(`custom agents: ${status.custom_agents.length}`);
  log(`status file: ${paths.upstreamStatusPath}`);
}

async function main() {
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
      case 'secret-scan': {
        const result = secretScan();
        process.exit(result.ok ? 0 : 1);
      }
      case 'llm-check': return await llmCheck();
      case 'export-report': return exportReport(process.argv[3]);
      default:
        fail(`usage: ${path.relative(REPO_ROOT, __filename)} <bootstrap|update|doctor|install-deps|secret-scan|llm-check|export-report>`);
    }
  } catch (e) {
    fail(e.stack || e.message);
  }
}

if (require.main === module) main();

module.exports = {
  localPaths,
  bootstrap,
  bootstrapAgents,
  updateAgentStatus,
  ensureBlackboardDb,
  ensureWatchdogDb,
  doctor,
  llmCheck,
  secretScan,
  bareModelAlias,
};
