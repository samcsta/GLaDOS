const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAgentPackageStore } = require('../lib/agent-packages');
const { createFordAgenticTeams, refreshInstalledIntegrations } = require('../lib/ford-agentic-teams');
const { createFordAgenticTeamsRouter } = require('../routes/agent-library');

const sourceDir = path.resolve(__dirname, '../../templates/integrated-teams');
const sourcePath = path.join(sourceDir, 'herbie.glados-agent.json');
const source = () => fs.readFileSync(sourcePath, 'utf8');
const installedTool = { id: 'tshark', installed: true, available: true, path: '/opt/test/bin/tshark', version: 'test', manager: 'test' };

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-ford-teams-'));
  const store = createAgentPackageStore({ runtimeDir: root });
  const active = [];
  const changes = [];
  const env = { PATH: '/usr/bin' };
  let installs = 0;
  const installer = {
    status: async () => ({ ...installedTool, installed: installs > 0, available: installs > 0 }),
    install: async ({ onProgress }) => { installs++; onProgress({ phase: 'verifying', message: 'Verifying tshark' }); return installedTool; },
    environment: () => ({ GLADOS_TSHARK_PATH: installedTool.path, PATH: '/opt/test/bin:/usr/bin' }),
    ...options.installer,
  };
  const service = createFordAgenticTeams({ store, installer, sourceDir, env,
    activeAgentIds: () => active, changed: (...args) => changes.push(args) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store, service, active, changes, env, installs: () => installs };
}

async function terminal(service) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await service.get('herbie');
    if (result.job.state !== 'installing') return result;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('installation did not finish');
}

test('fresh startup and catalog do not install or enable any bundled team', async t => {
  const f = fixture(t);
  refreshInstalledIntegrations({ store: f.store, sourceDir });
  const catalog = await f.service.catalog();
  assert.deepEqual(f.store.list(), []);
  assert.equal(f.installs(), 0);
  assert.deepEqual(catalog.teams.map(team => [team.id, team.status]), [
    ['herbie', 'available'], ['jarvis', 'coming-soon'], ['chappie', 'coming-soon'],
  ]);
  await assert.rejects(f.service.install('jarvis'), /coming soon/);
  await assert.rejects(f.service.install('not-a-team'), /not found/);
  assert.equal(f.installs(), 0);
});

test('explicit installation verifies tshark before atomically enabling Herbie and records opt-in', async t => {
  const f = fixture(t, { installer: { install: async () => {
    assert.deepEqual(f.store.list(), []);
    return installedTool;
  }, status: async () => installedTool } });
  const started = await f.service.install('herbie');
  assert.equal(started.job.state, 'installing');
  const result = await terminal(f.service);
  assert.equal(result.job.state, 'installed');
  assert.equal(result.team.installed, true);
  assert.equal(result.team.enabled, true);
  assert.equal(result.team.optIn, true);
  assert.equal(result.team.agentCount, 14);
  assert.equal(f.store.runtimeEntries().filter(row => row.packageId === 'herbie').length, 15);
  assert.equal(f.env.GLADOS_TSHARK_PATH, '/opt/test/bin/tshark');
  assert.deepEqual(f.changes, [['install', { id: 'herbie', packageId: 'herbie' }]]);
});

test('dependency failure leaves no team package and exposes remediation without claiming success', async t => {
  const f = fixture(t, { installer: { install: async () => {
    const error = new Error('Install Homebrew first'); error.code = 'manager_missing'; error.remediation = 'Install the supported package manager, then retry.'; throw error;
  } } });
  await f.service.install('herbie');
  const result = await terminal(f.service);
  assert.equal(result.job.state, 'failed');
  assert.equal(result.job.code, 'manager_missing');
  assert.match(result.job.remediation, /supported package manager/);
  assert.equal(result.team.installed, false);
  assert.deepEqual(f.store.list({ includeArchived: true }), []);
});

test('a single dependency job is reused and cannot be archived while installing', async t => {
  let finish;
  let calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { installer: { install: () => { calls++; return pending; } } });
  const started = await f.service.install('herbie');
  const duplicate = await f.service.install('herbie');
  assert.equal(calls, 1);
  assert.equal(duplicate.job.startedAt, started.job.startedAt);
  await assert.rejects(f.service.remove('herbie'), /installation to finish/);
  finish(installedTool);
  assert.equal((await terminal(f.service)).job.state, 'installed');
});

test('archiving and explicit reinstall retain operator prompts, models, tools and team definition', async t => {
  const f = fixture(t);
  const initial = f.store.installIntegration(source(), { sourcePath });
  const manifest = structuredClone(initial.manifest);
  Object.assign(manifest.agents[0], { instructions: 'Operator coordinator instructions.', model: 'operator-model', effort: 'low', tools: ['Read'] });
  manifest.teams[0].instructions = 'Operator team instructions.';
  const edited = f.store.save('herbie', manifest, { expectedRevision: initial.revision });
  f.store.remove('herbie', { expectedRevision: edited.revision });
  refreshInstalledIntegrations({ store: f.store, sourceDir });
  assert.equal(f.store.get('herbie').archived, true);
  await f.service.install('herbie', { expectedRevision: edited.revision });
  const result = await terminal(f.service);
  assert.equal(result.job.state, 'installed');
  const installed = f.store.get('herbie');
  assert.equal(installed.manifest.agents[0].instructions, 'Operator coordinator instructions.');
  assert.equal(installed.manifest.agents[0].model, 'operator-model');
  assert.deepEqual(installed.manifest.agents[0].tools, ['Read']);
  assert.equal(installed.manifest.teams[0].instructions, 'Operator team instructions.');
  const removed = await f.service.remove('herbie', { expectedRevision: installed.revision });
  assert.equal(removed.recoverable, true);
  assert.equal(removed.toolPreserved, true);
  assert.equal(removed.team.installed, false);
  assert.equal(f.store.get('herbie').optIn, true);
});

test('install and archive reject stale revisions and active teams', async t => {
  const f = fixture(t);
  const initial = f.store.installOptInIntegration(source(), { sourcePath, teamId: 'herbie-team' });
  await assert.rejects(f.service.install('herbie'), /Reload/);
  assert.equal(f.installs(), 0);
  f.active.push('pkg-herbie--packet-analysis');
  await assert.rejects(f.service.install('herbie', { expectedRevision: initial.revision }), /active agents/);
  await assert.rejects(f.service.remove('herbie', { expectedRevision: initial.revision }), /active agents/);
  assert.equal(f.store.get('herbie').archived, false);
});

test('changes during dependency installation cannot restore or overwrite a newly archived team', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { installer: { install: () => pending } });
  const initial = f.store.installIntegration(source(), { sourcePath });
  await f.service.install('herbie', { expectedRevision: initial.revision });
  f.store.remove('herbie', { expectedRevision: initial.revision });
  finish(installedTool);
  const result = await terminal(f.service);
  assert.equal(result.job.state, 'failed');
  assert.equal(result.job.code, 'ford_team_conflict');
  assert.equal(f.store.get('herbie').archived, true);
});

test('a custom package with a Ford catalog identity is neither installed, overwritten nor archived by the catalog', async t => {
  const f = fixture(t);
  const custom = f.store.create(JSON.parse(source()));
  const details = await f.service.get('herbie');
  assert.equal(details.team.installed, false);
  assert.equal(details.team.canInstall, false);
  assert.equal(details.team.conflictingPackage, true);
  assert.equal(details.team.status, 'conflict');
  await assert.rejects(f.service.install('herbie', { expectedRevision: custom.revision }), error => error.code === 'ford_team_identity_conflict');
  await assert.rejects(f.service.remove('herbie', { expectedRevision: custom.revision }), error => error.code === 'ford_team_identity_conflict');
  assert.equal(f.installs(), 0);
  assert.equal(f.store.get('herbie').revision, custom.revision);
  assert.equal(f.store.get('herbie').archived, false);
});

test('catalog API exposes progress and rejects cross-site or non-JSON tool installs', async t => {
  const f = fixture(t);
  const app = express(); app.use(express.json());
  app.use('/api/ford-rt-teams', createFordAgenticTeamsRouter({ service: f.service }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const request = (route, options = {}) => fetch(base + '/api/ford-rt-teams' + route, options);
  const catalog = await request('');
  assert.equal(catalog.headers.get('cache-control'), 'no-store');
  assert.equal((await catalog.json()).teams.length, 3);
  assert.equal((await request('/herbie/install', { method: 'POST', headers: { Origin: 'https://untrusted.test' } })).status, 403);
  assert.equal((await request('/herbie/install', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/herbie/install', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(f.installs(), 0);
  const accepted = await request('/herbie/install', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).team.id, 'herbie');
  await terminal(f.service);
  const detail = await request('/herbie');
  const installed = await detail.json();
  assert.equal(installed.job.state, 'installed');
  const archiveBody = JSON.stringify({ expectedRevision: installed.team.revision });
  assert.equal((await request('/herbie', { method: 'DELETE', headers: { Origin: 'https://untrusted.test', 'Content-Type': 'application/json' }, body: archiveBody })).status, 403);
  assert.equal(f.store.get('herbie').archived, false);
  // CLI requests without Origin are allowed; only trusted catalog identities
  // and the saved expected revision can be changed.
  const removed = await request('/herbie', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: archiveBody });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).team.installed, false);
});
