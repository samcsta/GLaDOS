const fs = require('node:fs');
const path = require('node:path');
const { OPENCLAW_JSON } = require('./config');
const { loadAgentRegistry } = require('./openclaw');

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
    workspace: ws,
    agentsDoc: safeRead(path.join(ws, 'AGENTS.md')),
    toolsDoc: safeRead(path.join(ws, 'TOOLS.md')),
    runbook: safeRead(path.join(ws, 'RUNBOOK.md')),
    identity: safeRead(path.join(ws, 'IDENTITY.md')),
    skills: listSkills(ws),
    mcp: listMcpServers(),
  };
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

module.exports = { agentDetails, updateAgentModel, listKnownModels };
