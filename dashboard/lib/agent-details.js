const fs = require('node:fs');
const path = require('node:path');
const { OPENCLAW_JSON, MODEL_OVERRIDES_JSON, THINKING_OVERRIDES_JSON } = require('./config');
const { loadAgentRegistry } = require('./openclaw');

// Reasoning levels exposed in the dashboard, fastest -> hardest. These are the
// OpenClaw thinking levels honored by the gateway; "off" disables reasoning.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
const DEFAULT_THINKING = 'minimal';

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

function agentDetails(agentId) {
  const registry = loadAgentRegistry();
  const entry = registry.find(a => a.id === agentId);
  if (!entry) return null;
  const ws = entry.workspace;
  return {
    id: entry.id,
    name: entry.name,
    model: entry.model,
    thinking: getAgentThinking(entry.id, entry.model),
    thinkingLevels: THINKING_LEVELS,
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

// Read the effective reasoning level for an agent: explicit per-agent override
// wins, else whatever the live config resolves for the agent's model, else the
// default. Used to seed the dashboard dropdown.
function getAgentThinking(agentId, modelRef) {
  try {
    const overrides = JSON.parse(fs.readFileSync(THINKING_OVERRIDES_JSON, 'utf8')) || {};
    if (overrides[agentId]) return overrides[agentId];
  } catch {}
  if (modelRef) {
    try {
      const cfg = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'));
      const lvl = cfg?.agents?.defaults?.models?.[modelRef]?.params?.thinking;
      if (lvl) return lvl;
    } catch {}
  }
  return DEFAULT_THINKING;
}

// Persist a per-agent reasoning level to the durable override store (so it
// survives `glados update`), then patch the live openclaw.json for immediate
// effect. OpenClaw keys thinking per MODEL, so we only patch the model params
// when this agent is the SOLE user of its model (and it isn't the shared
// primary) — otherwise we'd change every agent on that model. The durable
// override is always written; config regen applies it safely via the same
// "all agents on the model agree" rule.
function updateAgentThinking(agentId, level) {
  if (!THINKING_LEVELS.includes(level)) {
    throw new Error(`invalid reasoning level: ${level} (use ${THINKING_LEVELS.join('|')})`);
  }
  // Durable store.
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(THINKING_OVERRIDES_JSON, 'utf8')) || {}; } catch {}
  const old = overrides[agentId] || null;
  overrides[agentId] = level;
  fs.mkdirSync(path.dirname(THINKING_OVERRIDES_JSON), { recursive: true });
  const tmp = THINKING_OVERRIDES_JSON + '.tmp';
  fs.writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`);
  fs.renameSync(tmp, THINKING_OVERRIDES_JSON);

  // Patch the live config for instant effect, only when safe (sole user, not primary).
  let patched = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'));
    const list = cfg?.agents?.list || [];
    const entry = list.find(a => a.id === agentId);
    const modelRef = entry?.model;
    const primary = cfg?.agents?.defaults?.model?.primary;
    const sharers = list.filter(a => a.model === modelRef).map(a => a.id);
    if (modelRef && modelRef !== primary && sharers.length === 1) {
      cfg.agents.defaults.models = cfg.agents.defaults.models || {};
      const cur = cfg.agents.defaults.models[modelRef] || {};
      cfg.agents.defaults.models[modelRef] = { ...cur, params: { ...(cur.params || {}), thinking: level } };
      const backup = OPENCLAW_JSON + `.bak.${Date.now()}`;
      fs.copyFileSync(OPENCLAW_JSON, backup);
      fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2));
      patched = true;
    }
  } catch {}
  return { agentId, oldLevel: old, newLevel: level, livePatched: patched };
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

module.exports = {
  agentDetails,
  updateAgentModel,
  listKnownModels,
  getAgentThinking,
  updateAgentThinking,
  THINKING_LEVELS,
};
