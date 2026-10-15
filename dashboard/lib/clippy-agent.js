const fs = require('node:fs');
const path = require('node:path');
const { loadClippyToken } = require('./secrets/clippy-mcp');

const CLIPPY_PACKAGE_ID = 'clippy-intel';
const CLIPPY_AGENT_ID = 'pkg-clippy-intel--clippy';
const CLIPPY_TEAM_ID = `agent:${CLIPPY_AGENT_ID}`;
const CLIPPY_AGENT_SOURCE_PATH = path.resolve(__dirname, '../../templates/integrated-teams/clippy-intel.glados-agent.json');

function getClippyPackage(store) {
  try { return store.get(CLIPPY_PACKAGE_ID); }
  catch (error) {
    if (error.status === 404 || error.statusCode === 404 || error.code === 'AGENT_PACKAGE_NOT_FOUND') return null;
    throw error;
  }
}

function unavailable(message, code = 'agent_unavailable') {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

function clippyAgentInfo(store) {
  let entry;
  try { entry = store.get(CLIPPY_PACKAGE_ID); } catch {}
  const agent = entry?.manifest?.agents?.find(agent => agent.id === 'clippy');
  return {
    agentId: CLIPPY_AGENT_ID,
    teamId: CLIPPY_TEAM_ID,
    agentName: agent?.name || 'Clippy Agent',
    editableIntegration: entry?.editableIntegration === true,
    agentExists: Boolean(entry && !entry.archived && agent),
    agentAvailable: Boolean(entry?.managedIntegration && entry.enabled && !entry.archived
      && agent && agent.enabled !== false),
  };
}

// Connecting a data source or opening chat does not grant consent to install
// or enable an agent. The caller must obtain explicit operator approval first.
function enableClippyAgent({ store, env = process.env, createAgent = false }) {
  if (!loadClippyToken(env)) {
    throw unavailable('Connect Clippy before opening Clippy Agent.', 'clippy_not_connected');
  }
  let entry = getClippyPackage(store);
  let agent = entry?.manifest?.agents?.find(agent => agent.id === 'clippy');
  if (entry && (!entry.managedIntegration || !agent)) {
    throw unavailable('Clippy Agent is unavailable. Restore its trusted integration in Agents.');
  }
  if (!entry || entry.archived || !entry.enabled || agent.enabled === false) {
    if (createAgent !== true) {
      throw unavailable('Approve creating or enabling Clippy Agent before starting a conversation.', 'agent_consent_required');
    }
    if (!entry) {
      entry = store.installIntegration(fs.readFileSync(CLIPPY_AGENT_SOURCE_PATH, 'utf8'), { sourcePath: CLIPPY_AGENT_SOURCE_PATH });
      agent = entry.manifest.agents.find(agent => agent.id === 'clippy');
    } else if (entry.archived) {
      if (!entry.active?.version || !entry.active?.revision || typeof store.activate !== 'function') {
        throw unavailable('Restore the archived Clippy Agent in Agents before starting a conversation.');
      }
      entry = store.activate(CLIPPY_PACKAGE_ID, { ...entry.active, expectedRevision: entry.revision });
    }
  }
  if (!entry.enabled) entry = store.setEnabled(CLIPPY_PACKAGE_ID, true, { expectedRevision: entry.revision });
  if (agent.enabled === false) store.setEntryEnabled(CLIPPY_AGENT_ID, true, { expectedRevision: entry.revision });
  return { ok: true, ...clippyAgentInfo(store) };
}

module.exports = { CLIPPY_PACKAGE_ID, CLIPPY_AGENT_ID, CLIPPY_TEAM_ID, CLIPPY_AGENT_SOURCE_PATH, clippyAgentInfo, enableClippyAgent };
