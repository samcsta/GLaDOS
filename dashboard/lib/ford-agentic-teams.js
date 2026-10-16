const fs = require('node:fs');
const path = require('node:path');

const FORD_TEAMS = Object.freeze([
  Object.freeze({ id: 'herbie', packageId: 'herbie', name: 'Herbie', teamId: 'pkg-herbie--herbie-team', localTeamId: 'herbie-team', source: 'herbie.glados-agent.json',
    description: 'A coordinated team for evidence-backed network, packet and automotive analysis.', comingSoon: false }),
  Object.freeze({ id: 'jarvis', packageId: 'jarvis', name: 'Jarvis', description: 'A future Ford RT agentic team.', comingSoon: true }),
  Object.freeze({ id: 'chappie', packageId: 'chappie', name: 'Chappie', description: 'A future Ford RT agentic team.', comingSoon: true }),
]);

function failure(message, status = 400, code = 'ford_team_invalid') {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}

function refreshInstalledIntegrations({ store, sourceDir, warn = () => {} }) {
  if (!fs.existsSync(sourceDir)) return;
  const installed = new Set(store.list({ includeArchived: true }).map(row => row.id));
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.glados-agent.json')) continue;
    // Merely bundling a definition does not consent to installing a team.
    // Archived entries remain archived under the store's refresh rules.
    const packageId = entry.name.slice(0, -'.glados-agent.json'.length);
    if (!installed.has(packageId)) continue;
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Integration packages must be regular source files');
      const sourcePath = path.join(sourceDir, entry.name);
      const manifest = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      if (manifest.id !== packageId) throw new Error('Integration source identity does not match its filename');
      store.installIntegration(manifest, { sourcePath });
    } catch (error) { warn(entry.name, error); }
  }
}

function createFordAgenticTeams({ store, installer, sourceDir, activeAgentIds = () => [], changed = () => {}, env = process.env }) {
  const jobs = new Map();
  let dependency = { id: 'tshark', installed: false, available: false, path: null, version: null, manager: null };

  function definition(id) {
    const row = FORD_TEAMS.find(team => team.id === id);
    if (!row) failure('Ford RT agentic team not found', 404, 'ford_team_not_found');
    return row;
  }
  function packageFor(def) { return store.list({ includeArchived: true }).find(pkg => pkg.id === def.packageId) || null; }
  function trustedPackage(def, pkg) { return Boolean(pkg?.managedIntegration && pkg.managedSource === def.source); }
  function packageState(pkg) { return pkg ? JSON.stringify([pkg.revision, pkg.enabled, pkg.archived]) : null; }
  function requireIdle(def) {
    const packageIds = new Set(store.runtimeEntries({ includeDisabled: true }).filter(row => row.packageId === def.packageId).map(row => row.id));
    if (activeAgentIds().some(id => packageIds.has(id))) failure('Finish or stop this team’s active agents before changing its installation', 409, 'ford_team_busy');
  }
  function row(def) {
    const pkg = packageFor(def);
    const conflict = Boolean(pkg && !trustedPackage(def, pkg));
    const installed = Boolean(pkg && !conflict && !pkg.archived);
    const job = jobs.get(def.id) || null;
    const localTeam = pkg?.manifest.teams.find(team => team.id === def.localTeamId);
    const enabled = installed && pkg.enabled && localTeam?.enabled !== false;
    return {
      id: def.id, packageId: def.packageId, name: def.name, description: def.description,
      teamId: def.teamId || null, comingSoon: def.comingSoon, installed, enabled: Boolean(enabled),
      available: Boolean(installed && enabled && dependency.installed), revision: pkg?.revision || null,
      agentCount: conflict ? 0 : pkg?.agentCount || 0, optIn: !conflict && pkg?.optIn === true,
      canInstall: !def.comingSoon && !conflict, conflictingPackage: conflict,
      ...(conflict ? { error: `A custom package already uses ${def.packageId}. Rename that package before installing ${def.name}.` } : {}),
      status: def.comingSoon ? 'coming-soon' : conflict ? 'conflict' : job?.state === 'installing' ? 'installing'
        : job?.state === 'failed' ? 'failed' : installed ? 'installed' : 'available',
      dependency: def.comingSoon ? null : { ...dependency }, installation: job ? { ...job } : null,
    };
  }
  function snapshot() { return { teams: FORD_TEAMS.map(row) }; }
  async function refreshDependency() {
    dependency = await installer.status();
    if (dependency.installed && typeof installer.environment === 'function') Object.assign(env, await installer.environment());
    return dependency;
  }
  async function catalog() { await refreshDependency(); return snapshot(); }
  async function get(id) { const def = definition(id); await refreshDependency(); return { ...snapshot(), team: row(def), job: jobs.get(id) || null }; }

  async function runInstall(def, expectedRevision, initialState, job) {
    try {
      const status = await installer.install({ onProgress(progress) {
        if (job.state !== 'installing') return;
        job.phase = progress.phase || job.phase;
        job.message = String(progress.message || job.message).slice(0, 2000);
      } });
      dependency = status;
      if (!status.installed) failure('tshark could not be verified. The team has not been installed.', 503, 'tshark_unavailable');
      if (typeof installer.environment === 'function') Object.assign(env, await installer.environment());
      requireIdle(def);
      const current = packageFor(def);
      if (packageState(current) !== initialState) failure('This team changed while tshark was being installed. Reload before trying again.', 409, 'ford_team_conflict');
      job.phase = 'integrating'; job.message = `Integrating ${def.name} and its agents…`;
      const sourcePath = path.join(sourceDir, def.source);
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) failure('The bundled team source is unavailable', 500, 'ford_team_source_unavailable');
      const pkg = store.installOptInIntegration(fs.readFileSync(sourcePath, 'utf8'), { sourcePath, teamId: def.localTeamId, expectedRevision });
      job.state = 'installed'; job.phase = 'complete'; job.message = `${def.name} and tshark are ready.`;
      job.finishedAt = new Date().toISOString();
      changed('install', { id: def.id, packageId: pkg.id });
    } catch (error) {
      job.state = 'failed'; job.phase = 'failed'; job.error = String(error.message || 'Installation failed').slice(0, 2000);
      job.message = job.error; job.code = error.code || 'ford_team_install_failed';
      if (error.remediation) job.remediation = error.remediation;
      job.finishedAt = new Date().toISOString();
      changed('install-failed', { id: def.id, packageId: def.packageId });
    }
  }
  async function install(id, { expectedRevision } = {}) {
    const def = definition(id);
    if (def.comingSoon) failure(`${def.name} is coming soon and cannot be installed yet`, 400, 'ford_team_coming_soon');
    if (jobs.get(id)?.state === 'installing') return { ...snapshot(), team: row(def), job: { ...jobs.get(id) } };
    const current = packageFor(def);
    if (current && !trustedPackage(def, current)) failure('A different package already uses this integration identity. Rename it before installing this Ford RT team.', 409, 'ford_team_identity_conflict');
    if (current && (!expectedRevision || expectedRevision !== current.revision)) failure('This team changed. Reload it before installing.', 409, 'ford_team_conflict');
    requireIdle(def);
    const job = { state: 'installing', phase: 'checking', message: 'Checking tshark…', startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(id, job);
    // Retain the task even if the browser closes. No package or runtime agent is
    // changed until the dependency has actually been installed and verified.
    void runInstall(def, expectedRevision, packageState(current), job);
    return { ...snapshot(), team: row(def), job: { ...job } };
  }
  async function remove(id, { expectedRevision } = {}) {
    const def = definition(id);
    if (jobs.get(id)?.state === 'installing') failure('Wait for this team’s installation to finish before uninstalling', 409, 'ford_team_busy');
    requireIdle(def);
    const current = packageFor(def);
    if (current && !trustedPackage(def, current)) failure('This identity belongs to a custom package. Manage it through Custom Agents.', 409, 'ford_team_identity_conflict');
    if (!current || current.archived) failure('This team is not installed', 404, 'ford_team_not_installed');
    const result = store.remove(def.packageId, { expectedRevision });
    jobs.delete(id);
    changed('archive', { id: def.id, packageId: def.packageId });
    return { ...snapshot(), team: row(def), recoverable: result.recoverable, toolPreserved: true };
  }
  return { catalog, get, install, remove };
}

module.exports = { FORD_TEAMS, createFordAgenticTeams, refreshInstalledIntegrations };
