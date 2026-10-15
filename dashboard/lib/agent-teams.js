const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TEAM_ID = /^(?:glados|(?:agent:)?pkg-[a-z][a-z0-9]*(?:-[a-z0-9]+)*--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const AGENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/;

function fail(message, status = 400, code = 'invalid_agent_team') {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}
function rootFor(env = process.env) { return path.join(path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados')), 'agent-teams'); }
function safePath(root, file) {
  let current = root;
  for (const part of ['', ...path.relative(root, file).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('Agent team storage cannot contain symlinks', 400, 'unsafe_storage'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function readAssignments(env = process.env) {
  const root = rootFor(env); const file = path.join(root, 'collection.json');
  safePath(root, file);
  let contents;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (process.platform !== 'win32' && stat.mode & 0o077)) fail('Agent team storage must be an owner-only file', 400, 'unsafe_storage');
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let index;
  try { index = JSON.parse(contents); } catch { fail('Agent team collection is unreadable', 500, 'agent_team_storage_error'); }
  if (index?.schemaVersion !== 1 || !Array.isArray(index.teams)) fail('Agent team collection is invalid', 500, 'agent_team_storage_error');
  for (const row of index.teams) {
    if (!TEAM_ID.test(row?.id || '') || !Array.isArray(row.assignedAgentIds) || row.assignedAgentIds.some(id => typeof id !== 'string' || !AGENT_ID.test(id))) fail('Agent team assignments are invalid', 500, 'agent_team_storage_error');
  }
  return index.teams;
}
function assignableAgent(row) { return row?.id !== 'glados' && !row?.teamCoordinator && row?.subagent !== false; }

// Derivation has no mutations or harness dependencies. Callers may supply an
// assignment snapshot; the normal runtime reads its durable user collection.
function resolveAgentTeam(registryRows, { env = process.env, teamId = env.GLADOS_TEAM_ID || 'glados', assignments } = {}) {
  if (typeof teamId !== 'string' || !TEAM_ID.test(teamId)) fail('Invalid agent team identity');
  const rows = Array.isArray(registryRows) ? registryRows : [];
  if (teamId.startsWith('agent:')) {
    const runtimeId = teamId.slice('agent:'.length);
    const agent = rows.find(row => row.id === runtimeId && row.packageCapabilities && !row.teamCoordinator && row.subagent !== false);
    if (!agent) fail('Custom agent not found', 404, 'agent_not_found');
    const revision = crypto.createHash('sha256').update(JSON.stringify({ id: teamId, packageRevision: agent.packageRevision || null, enabled: agent.enabled !== false })).digest('hex');
    return { id: teamId, kind: 'agent', name: agent.name || runtimeId, coordinatorId: runtimeId, source: agent.source || 'custom',
      packageId: agent.packageId || null, memberIds: [], rosterIds: [runtimeId], assignedAgentIds: [], revision,
      managedIntegration: !!agent.managedIntegration, managedSource: agent.managedSource || null, available: agent.enabled !== false, valid: true };
  }
  const coordinator = teamId === 'glados' ? rows.find(row => row.id === 'glados') : rows.find(row => row.id === teamId && row.teamCoordinator);
  if (!coordinator) fail('Agent team not found', 404, 'agent_team_not_found');
  const saved = (assignments || readAssignments(env)).find(row => row.id === teamId);
  const assignedAgentIds = [...(saved?.assignedAgentIds || [])];
  const byId = new Map(rows.map(row => [row.id, row]));
  const base = teamId === 'glados'
    ? rows.filter(row => !row.packageCapabilities && row.id !== 'glados' && row.enabled !== false && row.subagent !== false).map(row => row.id)
    : (coordinator.teamMembers || []).filter(id => byId.get(id)?.enabled !== false && byId.has(id));
  const assigned = assignedAgentIds.filter(id => {
    const row = byId.get(id); return row && assignableAgent(row) && row.enabled !== false && row.id !== coordinator.id;
  });
  const memberIds = [...new Set([...base, ...assigned])];
  const revision = crypto.createHash('sha256').update(JSON.stringify({ id: teamId, packageRevision: coordinator.packageRevision || null, enabled: coordinator.enabled !== false, base, assignmentRevision: saved?.revision || null, assignedAgentIds,
    assignedState: assignedAgentIds.map(id => ({ id, exists: byId.has(id), enabled: byId.get(id)?.enabled !== false, packageRevision: byId.get(id)?.packageRevision || null })) })).digest('hex');
  return {
    id: teamId, kind: 'team', name: teamId === 'glados' ? 'GLaDOS' : coordinator.name || teamId,
    coordinatorId: coordinator.id, source: coordinator.packageCapabilities ? coordinator.source || 'custom' : 'builtin',
    packageId: coordinator.packageId || null, memberIds, rosterIds: [coordinator.id, ...memberIds], assignedAgentIds,
    managedIntegration: !!coordinator.managedIntegration, managedSource: coordinator.managedSource || null,
    revision, available: coordinator.enabled !== false, valid: true,
  };
}

function createAgentTeamStore({ env = process.env, runtimeDir } = {}) {
  if (runtimeDir) env = { ...env, GLADOS_RUNTIME_DIR: runtimeDir };
  const root = rootFor(env); const indexFile = path.join(root, 'collection.json');
  function list(registryRows) {
    const assignments = readAssignments(env);
    return ['glados', ...registryRows.filter(row => row.teamCoordinator).map(row => row.id)]
      .map(teamId => resolveAgentTeam(registryRows, { env, teamId, assignments }));
  }
  function catalog(registryRows) {
    return { teams: list(registryRows), directAgents: registryRows.filter(row => row.packageCapabilities && !row.teamCoordinator && row.subagent !== false)
      .map(row => resolveAgentTeam(registryRows, { env, teamId: `agent:${row.id}` })), agents: registryRows.map(row => ({
      id: row.id, name: row.name || row.id, description: row.description || '', model: row.model || null,
      source: row.packageCapabilities ? row.source || 'custom' : 'builtin', packageId: row.packageId || null,
      teamInternal: !!row.teamInternal, teamCoordinator: !!row.teamCoordinator, enabled: row.enabled !== false,
      available: row.enabled !== false, assignable: assignableAgent(row),
      managedIntegration: !!row.managedIntegration, managedSource: row.managedSource || null,
    })) };
  }
  function save(teamId, assignedAgentIds, { expectedRevision, registryRows } = {}) {
    if (!Array.isArray(registryRows)) fail('An agent registry is required');
    const assignments = readAssignments(env);
    const team = resolveAgentTeam(registryRows, { env, teamId, assignments });
    if (team.kind === 'agent') fail('A direct agent conversation does not have team assignments');
    if (!expectedRevision || expectedRevision !== team.revision) fail('This team changed. Reload it before saving assignments.', 409, 'agent_team_conflict');
    if (!Array.isArray(assignedAgentIds) || assignedAgentIds.length > 200 || assignedAgentIds.some(id => typeof id !== 'string' || !AGENT_ID.test(id))) fail('Choose valid agent identities for this team');
    if (new Set(assignedAgentIds).size !== assignedAgentIds.length) fail('Team assignments cannot contain duplicate agents');
    const byId = new Map(registryRows.map(row => [row.id, row]));
    for (const id of assignedAgentIds) {
      const row = byId.get(id);
      if (!row || !assignableAgent(row) || id === team.coordinatorId) fail(`Agent ${id} cannot be assigned to this team`);
    }
    const existing = assignments.find(row => row.id === teamId);
    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const history = [...(existing?.history || [])];
    if (existing) history.push({ revision: existing.revision, assignedAgentIds: existing.assignedAgentIds, updatedAt: existing.updatedAt });
    const next = { id: teamId, assignedAgentIds: [...assignedAgentIds], revision, updatedAt: now, history };
    const updated = assignments.filter(row => row.id !== teamId).concat(next);
    safePath(root, indexFile);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    safePath(root, indexFile);
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    const temporary = path.join(root, `.teams-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, teams: updated }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, indexFile);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
    return resolveAgentTeam(registryRows, { env, teamId, assignments: updated });
  }
  return { root, indexFile, list, catalog, save, get: (teamId, registryRows) => resolveAgentTeam(registryRows, { env, teamId }) };
}

module.exports = { resolveAgentTeam, createAgentTeamStore, readAssignments, assignableAgent };
