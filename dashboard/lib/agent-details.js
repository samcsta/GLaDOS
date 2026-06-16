const fs = require('node:fs');
const path = require('node:path');
const { OPENCLAW_JSON, MODEL_OVERRIDES_JSON, GLADOS_AGENT_WORKSPACES } = require('./config');
const { loadAgentRegistry } = require('./openclaw');
const gladosLocal = require('../../scripts/lib/glados-local');

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function listSkills(workspace) {
  const dir = path.join(workspace, 'skills');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({
        name: d.name,
        skillFile: path.join(dir, d.name, 'SKILL.md'),
        description: extractDescription(path.join(dir, d.name, 'SKILL.md')),
      }));
  } catch { return []; }
}

function extractDescription(skillFile) {
  const raw = safeRead(skillFile);
  if (!raw) return null;
  const m = raw.match(/^description:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function listMcpServers() {
  try {
    const raw = fs.readFileSync(OPENCLAW_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    const mcp = parsed?.mcp?.servers || parsed?.mcpServers || {};
    return Object.keys(mcp);
  } catch { return []; }
}

function readJson(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function templateRegistryById() {
  const registryPath = path.resolve(__dirname, '..', '..', 'templates', 'agent-registry.json');
  const rows = readJson(registryPath, []);
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : rows.agents || []) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}

function workspaceMeta(agentId) {
  const workspace = path.join(GLADOS_AGENT_WORKSPACES, agentId);
  const meta = readJson(path.join(workspace, 'agent.json'), {});
  const upstream = templateRegistryById().get(agentId) || {};
  const disabledFile = fs.existsSync(path.join(workspace, '.disabled'));
  const enabled = (meta.enabled !== undefined ? meta.enabled !== false : upstream.enabled !== false) && !disabledFile;
  return { workspace, meta, upstream, disabledFile, enabled };
}

function activeEntryById(agentId) {
  return loadAgentRegistry().find(a => a.id === agentId) || null;
}

function isSubagent(agentId, meta, upstream) {
  if (agentId === 'glados' || agentId === 'atlas') return false;
  return meta.subagent !== undefined ? meta.subagent !== false : upstream.subagent !== false;
}

function listSettingsAgents() {
  const active = new Map(loadAgentRegistry().map(a => [a.id, a]));
  const upstream = templateRegistryById();
  const ids = new Set([...active.keys(), ...upstream.keys()]);
  try {
    for (const d of fs.readdirSync(GLADOS_AGENT_WORKSPACES, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) ids.add(d.name);
    }
  } catch {}
  return [...ids].sort().map(id => {
    const local = workspaceMeta(id);
    const entry = active.get(id);
    return {
      id,
      name: local.meta.name || local.upstream.name || entry?.name || id,
      enabled: local.enabled,
      registered: !!entry,
      subagent: isSubagent(id, local.meta, local.upstream),
      dispatch: local.meta.dispatch || local.upstream.dispatch || null,
      model: entry?.model || local.meta.model || local.upstream.model || null,
      workspace: local.workspace,
      disabledFile: local.disabledFile,
    };
  });
}

function agentDetails(agentId) {
  const entry = activeEntryById(agentId);
  const local = workspaceMeta(agentId);
  const ws = entry?.workspace || local.workspace;
  if (!fs.existsSync(ws)) return null;
  return {
    id: entry?.id || agentId,
    name: local.meta.name || local.upstream.name || entry?.name || agentId,
    model: entry?.model || local.meta.model || local.upstream.model,
    enabled: local.enabled,
    registered: !!entry,
    subagent: isSubagent(agentId, local.meta, local.upstream),
    dispatch: local.meta.dispatch || local.upstream.dispatch || null,
    disabledFile: local.disabledFile,
    workspace: ws,
    agentsDoc: safeRead(path.join(ws, 'AGENTS.md')),
    toolsDoc: safeRead(path.join(ws, 'TOOLS.md')),
    runbook: safeRead(path.join(ws, 'RUNBOOK.md')),
    identity: safeRead(path.join(ws, 'IDENTITY.md')),
    skills: listSkills(ws),
    mcp: listMcpServers(),
  };
}

// Persist the model choice to the durable override store so it survives the next
// `glados update` (which fully regenerates openclaw.json), then patch the live
// openclaw.json for immediate effect. Writing both means: the dashboard change
// takes effect now, AND the override file is what config regen reads back — so
// the assignment is no longer wiped on every update.
function persistModelOverride(agentId, newModel) {
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_JSON, 'utf8')) || {}; } catch {}
  if (newModel) overrides[agentId] = newModel;
  else delete overrides[agentId];
  fs.mkdirSync(path.dirname(MODEL_OVERRIDES_JSON), { recursive: true });
  const tmp = MODEL_OVERRIDES_JSON + '.tmp';
  fs.writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`);
  fs.renameSync(tmp, MODEL_OVERRIDES_JSON);
}

function updateAgentModel(agentId, newModel) {
  const raw = fs.readFileSync(OPENCLAW_JSON, 'utf8');
  const parsed = JSON.parse(raw);
  const list = parsed?.agents?.list;
  if (!Array.isArray(list)) throw new Error('openclaw.json has no agents.list');
  const entry = list.find(a => a.id === agentId);
  if (!entry) throw new Error(`agent not found: ${agentId}`);
  const old = entry.model;
  entry.model = newModel;
  const backup = OPENCLAW_JSON + `.bak.${Date.now()}`;
  fs.copyFileSync(OPENCLAW_JSON, backup);
  fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(parsed, null, 2));
  // Durable store so the choice persists across `glados update` regenerations.
  persistModelOverride(agentId, newModel);
  return { agentId, oldModel: old, newModel, backup };
}

function updateAgentEnabled(agentId, enabled) {
  if (agentId === 'glados' && enabled === false) throw new Error('glados cannot be disabled from Settings');
  const { workspace, meta, upstream } = workspaceMeta(agentId);
  if (!fs.existsSync(workspace)) throw new Error(`agent workspace not found: ${agentId}`);
  const disabledPath = path.join(workspace, '.disabled');
  if (enabled && fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath);
  const next = {
    id: meta.id || upstream.id || agentId,
    name: meta.name || upstream.name || agentId,
    model: meta.model || upstream.model,
    ...meta,
    enabled: !!enabled,
  };
  if (agentId === 'atlas' || agentId === 'glados') next.subagent = false;
  writeJsonAtomic(path.join(workspace, 'agent.json'), next);
  const paths = gladosLocal.localPaths();
  const config = gladosLocal.generateOpenClawConfig(paths);
  return {
    agentId,
    enabled: !!enabled,
    workspace,
    openclawJson: config.openclawJson,
    registered: !!activeEntryById(agentId),
    requiresRestart: true,
  };
}

async function fetchOllamaModels() {
  // Query local Ollama daemon for installed models. Short timeout so a missing
  // Ollama install does not stall the /api/models route.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.models)
      ? body.models.map(m => `ollama-local/${m.name}`).filter(Boolean)
      : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function listKnownModels() {
  const registry = loadAgentRegistry();
  const models = new Set(registry.map(a => a.model).filter(Boolean));
  for (const m of [
    'custom-llmapi-redteamstuff-com/gemini-2.5-flash',
    'custom-llmapi-redteamstuff-com/gemini-3.1-flash-lite-preview',
    'custom-llmapi-redteamstuff-com/gemini-2.5-flash-lite',
    'custom-llmapi-redteamstuff-com/gemini-3.1-pro-preview',
    'custom-llmapi-redteamstuff-com/gpt-5.3-codex',
    'custom-llmapi-redteamstuff-com/gpt-5.5-pro',
    'custom-llmapi-redteamstuff-com/gpt-5.5',
    'custom-llmapi-redteamstuff-com/claude-opus-4-6',
    'custom-llmapi-redteamstuff-com/gemini-3.5-flash',
    'custom-llmapi-redteamstuff-com/claude-opus-4-7',
    'custom-llmapi-redteamstuff-com/claude-opus-4-8',
    'custom-llmapi-redteamstuff-com/gemini-3-flash-preview',
    'custom-llmapi-redteamstuff-com/claude-sonnet-4-6',
    'custom-llmapi-redteamstuff-com/qwen3.6-27b-fp8',
    'custom-llmapi-redteamstuff-com/qwen3.6-35b-a3b-fp8',
    'custom-llmapi-redteamstuff-com/minimax-m2.7',
    'custom-llmapi-redteamstuff-com/gemma-4-31b-it-fp8',
  ]) models.add(m);
  for (const m of await fetchOllamaModels()) models.add(m);
  return [...models].sort();
}

module.exports = { agentDetails, updateAgentModel, updateAgentEnabled, listKnownModels, listSettingsAgents };
