const fs = require('node:fs');
const path = require('node:path');
const { MODEL_OVERRIDES_JSON, GLADOS_AGENT_WORKSPACES } = require('./config');
const { loadRegistry: loadAgentRegistry, loadPolicy, buildMcpServers } = require('./harness/agent-sdk');
const { fetchLiteLlmModels } = require('./litellm-models');
const { bareModelAlias } = require('../../scripts/lib/model-aliases');

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
  return Object.keys(buildMcpServers(process.env));
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
  return loadAgentRegistry().find(a => a.id === agentId && a.enabled !== false) || null;
}

function isSubagent(agentId, meta, upstream) {
  if (agentId === 'glados') return false;
  return meta.subagent !== undefined ? meta.subagent !== false : upstream.subagent !== false;
}

function listSettingsAgents() {
  const active = new Map(loadAgentRegistry().filter(a => a.enabled !== false).map(a => [a.id, a]));
  const upstream = templateRegistryById();
  const ids = new Set([...active.keys(), ...upstream.keys()]);
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
      model: bareModelAlias(entry?.model || local.meta.model || local.upstream.model || null, { fallback: null }),
      workspace: local.workspace,
      disabledFile: local.disabledFile,
    };
  });
}

function agentDetails(agentId) {
  const entry = activeEntryById(agentId);
  const local = workspaceMeta(agentId);
  if (!entry && !local.upstream.id) return null;
  const ws = entry?.workspace || local.workspace;
  if (!fs.existsSync(ws)) return null;
  return {
    id: entry?.id || agentId,
    name: local.meta.name || local.upstream.name || entry?.name || agentId,
    model: bareModelAlias(entry?.model || local.meta.model || local.upstream.model, { fallback: null }),
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

// Persist the model choice to the durable v4 override store. Agent SDK turns
// read this store when the next prompt is assembled.
function persistModelOverride(agentId, newModel) {
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_JSON, 'utf8')) || {}; } catch {}
  if (newModel) overrides[agentId] = bareModelAlias(newModel, { fallback: null });
  else delete overrides[agentId];
  writeJsonAtomic(MODEL_OVERRIDES_JSON, overrides);
}

function updateAgentModel(agentId, newModel) {
  const durableModel = bareModelAlias(newModel, { fallback: null });
  if (!durableModel) throw new Error('model required');
  const local = workspaceMeta(agentId);
  if (!local.upstream.id) throw new Error(`agent not found: ${agentId}`);
  const old = bareModelAlias(local.meta.model || local.upstream.model || activeEntryById(agentId)?.model, { fallback: null });
  persistModelOverride(agentId, durableModel);
  const next = {
    id: local.meta.id || local.upstream.id || agentId,
    name: local.meta.name || local.upstream.name || agentId,
    ...local.meta,
    model: durableModel,
  };
  writeJsonAtomic(path.join(local.workspace, 'agent.json'), next);
  return { agentId, oldModel: old, newModel: durableModel, runtime: 'agent-sdk', requiresRestart: false };
}

function updateAgentModels(changes, availableModels) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('at least one model change is required');
  if (changes.length > 100) throw new Error('too many model changes');

  const catalog = new Set(availableModels || []);
  const registry = new Map(loadAgentRegistry().filter(row => row?.id).map(row => [row.id, row]));
  const upstream = templateRegistryById();
  const seen = new Set();
  const results = [];
  const accepted = [];

  for (const change of changes) {
    const agentId = String(change?.agentId || '').trim();
    const requested = String(change?.model || '').trim();
    const expected = bareModelAlias(change?.expectedModel, { fallback: null });
    const current = bareModelAlias(registry.get(agentId)?.model, { fallback: null });
    let error = null;
    let code = null;

    if (!agentId || seen.has(agentId)) {
      code = 'duplicate_or_missing_agent';
      error = agentId ? `duplicate agent: ${agentId}` : 'agentId required';
    } else if (!upstream.has(agentId)) {
      code = 'agent_not_found';
      error = `agent not found: ${agentId}`;
    } else if (!requested || requested.includes('/')) {
      code = 'invalid_model';
      error = `invalid model alias: ${requested || '(empty)'}`;
    } else if (!catalog.has(requested)) {
      code = 'model_unavailable';
      error = `model is not currently available on LiteLLM: ${requested}`;
    } else if (expected && current !== expected) {
      code = 'model_conflict';
      error = `${agentId} changed from ${expected} to ${current || '(unset)'} before this save`;
    }

    seen.add(agentId);
    if (error) {
      results.push({ agentId, ok: false, code, error });
      continue;
    }
    if (current === requested) {
      results.push({ agentId, ok: true, unchanged: true, oldModel: current, newModel: requested, runtime: 'agent-sdk', requiresRestart: false });
      continue;
    }
    const result = { agentId, ok: true, oldModel: current, newModel: requested, runtime: 'agent-sdk', requiresRestart: false };
    results.push(result);
    accepted.push(result);
  }

  if (accepted.length) {
    let overrides = {};
    try {
      if (fs.existsSync(MODEL_OVERRIDES_JSON)) overrides = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_JSON, 'utf8'));
    } catch (error) {
      throw new Error(`could not read model overrides: ${error.message}`);
    }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new Error('model override store must contain a JSON object');
    }
    for (const result of accepted) overrides[result.agentId] = result.newModel;
    writeJsonAtomic(MODEL_OVERRIDES_JSON, overrides);

    for (const result of accepted) {
      try {
        const local = workspaceMeta(result.agentId);
        const next = {
          id: local.meta.id || local.upstream.id || result.agentId,
          name: local.meta.name || local.upstream.name || result.agentId,
          ...local.meta,
          model: result.newModel,
        };
        writeJsonAtomic(path.join(local.workspace, 'agent.json'), next);
      } catch (error) {
        result.warning = `runtime override saved; workspace metadata was not updated: ${error.message}`;
      }
    }
  }

  return {
    ok: results.every(result => result.ok),
    partial: results.some(result => result.ok) && results.some(result => !result.ok),
    changed: accepted.length,
    results,
  };
}

function updateAgentEnabled(agentId, enabled) {
  if (agentId === 'glados' && enabled === false) throw new Error('glados cannot be disabled from Settings');
  const { workspace, meta, upstream } = workspaceMeta(agentId);
  if (!upstream.id) throw new Error(`agent not found: ${agentId}`);
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
  if (agentId === 'glados') next.subagent = false;
  writeJsonAtomic(path.join(workspace, 'agent.json'), next);
  return {
    agentId,
    enabled: !!enabled,
    workspace,
    registered: !!activeEntryById(agentId),
    runtime: 'agent-sdk',
    requiresRestart: false,
  };
}

async function listKnownModels(options = {}) {
  const policy = options.policy || loadPolicy();
  return fetchLiteLlmModels({
    env: options.env || process.env,
    baseUrl: policy.harness?.anthropicBaseUrl,
    ...options,
  });
}

module.exports = { agentDetails, updateAgentModel, updateAgentModels, updateAgentEnabled, listKnownModels, listSettingsAgents };
