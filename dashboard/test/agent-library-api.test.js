const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentPackageStore } = require('../lib/agent-packages');
const { createConnectorStore, connectorCatalog } = require('../lib/connectors');
const { saveClippyToken, secretPath: clippySecretPath } = require('../lib/secrets/clippy-mcp');
const { createAgentTeamStore } = require('../lib/agent-teams');
const { createAgentLibraryRouter, createConnectorsRouter, createAgentTeamsRouter } = require('../routes/agent-library');

async function fixture(t, testDraft = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-agent-library-api-'));
  const env = { GLADOS_RUNTIME_DIR: root, GLADOS_CLIPPY_MCP: '0' };
  const packages = createAgentPackageStore({ runtimeDir: root, builtInIds: ['glados'] });
  const connectors = createConnectorStore({ env });
  const active = [];
  const connectorChanges = [];
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use('/api/agent-packages', createAgentLibraryRouter({ store: packages, testDraft, activeAgentIds: () => active, catalog: () => ({ builtInAgents: [{ id: 'glados' }], connectors: connectorCatalog(env).connectors, tools: ['Read'] }) }));
  app.use('/api/connectors', createConnectorsRouter({ store: connectors, catalog: () => connectorCatalog(env), changed: (action, row) => connectorChanges.push({ action, id: row?.id }) }));
  app.use('/api/agent-teams', createAgentTeamsRouter({ store: createAgentTeamStore({ env }), registry: () => [{ id: 'glados', subagent: false }, { id: 'source-code' }, ...packages.runtimeEntries({ includeDisabled: true })], activeAgentIds: () => active }));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, env, packages, connectors, active, connectorChanges,
    async request(route, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await response.text();
      return { status: response.status, headers: response.headers, json: raw ? JSON.parse(raw) : null, raw };
    },
  };
}

function manifest(version = '1.0.0', instructions = 'Produce a concise inspection note.') {
  return { schemaVersion: 1, id: 'inspection', name: 'Inspection', version, agents: [{ id: 'inspector', name: 'Inspector', description: 'Inspects operator-provided text.', instructions, model: 'test-model', effort: 'low', tools: ['Read'], deliverables: ['Inspection note'] }] };
}

test('agent library APIs preserve edits while staging imports and exporting selected revisions', async t => {
  const { request } = await fixture(t);
  const created = await request('/api/agent-packages', 'POST', { package: manifest() });
  assert.equal(created.status, 201, created.raw);
  const first = created.json.package;
  const edited = await request('/api/agent-packages/inspection', 'PATCH', { package: manifest('1.0.0', 'Operator-edited inspection instructions.'), expectedRevision: first.revision });
  assert.equal(edited.status, 200, edited.raw);
  const activeRevision = edited.json.package.revision;
  const preview = await request('/api/agent-packages/import/preview', 'POST', { package: manifest('2.0.0') });
  assert.equal(preview.json.preview.willStage, true);
  const imported = await request('/api/agent-packages/import', 'POST', { package: manifest('2.0.0') });
  assert.equal(imported.status, 201, imported.raw);
  assert.equal(imported.json.package.activeRevision, activeRevision);
  const staged = imported.json.package.staged[0];
  const detail = await request(`/api/agent-packages/inspection?version=2.0.0&revision=${staged.revision}`);
  assert.equal(detail.json.package.selectedVersion, '2.0.0');
  assert.equal(detail.json.package.activeRevision, activeRevision);
  assert.equal(detail.json.package.manifest.version, '2.0.0');
  const stale = await request('/api/agent-packages/inspection/activate', 'POST', { version: '2.0.0', revision: staged.revision, expectedRevision: first.revision });
  assert.equal(stale.status, 409);
  const activated = await request('/api/agent-packages/inspection/activate', 'POST', { version: '2.0.0', revision: staged.revision, expectedRevision: activeRevision });
  assert.equal(activated.status, 200, activated.raw);
  const exported = await request(`/api/agent-packages/inspection/export?version=1.0.0&revision=${activeRevision}`);
  assert.match(exported.headers.get('content-disposition'), /inspection-1.0.0.glados-agent.json/);
  assert.equal(exported.json.agents[0].instructions, 'Operator-edited inspection instructions.');
  const catalog = await request('/api/agent-packages');
  assert.equal(catalog.json.builtInAgents[0].id, 'glados');
  assert.equal(catalog.json.packages[0].version, '2.0.0');
});

test('package disable and archive cannot interrupt a live package agent', async t => {
  const { request, active } = await fixture(t);
  const created = await request('/api/agent-packages', 'POST', { package: manifest() });
  active.push('pkg-inspection--inspector');
  const disabled = await request('/api/agent-packages/inspection/enabled', 'PATCH', { enabled: false, expectedRevision: created.json.package.revision });
  assert.equal(disabled.status, 409);
  const archived = await request('/api/agent-packages/inspection', 'DELETE', { expectedRevision: created.json.package.revision });
  assert.equal(archived.status, 409);
});

test('team assignment API keeps independent rosters and blocks stale or active edits', async t => {
  const { request, active } = await fixture(t);
  const raw = manifest(); raw.teams = [{ id: 'crew', name: 'Inspection crew', coordinator: 'inspector', members: ['inspector'] }];
  await request('/api/agent-packages', 'POST', { package: raw });
  const catalog = await request('/api/agent-teams');
  const glados = catalog.json.teams.find(team => team.id === 'glados');
  const crew = catalog.json.teams.find(team => team.id === 'pkg-inspection--crew');
  assert.deepEqual(glados.memberIds, ['source-code']);
  assert.deepEqual(crew.memberIds, ['pkg-inspection--inspector']);
  const saved = await request('/api/agent-teams/glados', 'PATCH', { assignedAgentIds: ['pkg-inspection--inspector'], expectedRevision: glados.revision });
  assert.equal(saved.status, 200, saved.raw);
  assert.deepEqual(saved.json.team.memberIds, ['source-code', 'pkg-inspection--inspector']);
  const stale = await request('/api/agent-teams/glados', 'PATCH', { assignedAgentIds: [], expectedRevision: glados.revision });
  assert.equal(stale.status, 409);
  active.push('pkg-inspection--inspector');
  const blocked = await request('/api/agent-teams/pkg-inspection--crew', 'PATCH', { assignedAgentIds: ['source-code'], expectedRevision: crew.revision });
  assert.equal(blocked.status, 409);
});

test('entry delete APIs require idle revisions and archive the final agent recoverably', async t => {
  const { request, active } = await fixture(t);
  const raw = manifest(); raw.teams = [{ id: 'crew', members: ['inspector'] }];
  const created = await request('/api/agent-packages', 'POST', { package: raw });
  const first = created.json.package;
  active.push('pkg-inspection--crew');
  const blocked = await request('/api/agent-packages/inspection/agents/inspector', 'DELETE', { expectedRevision: first.revision });
  assert.equal(blocked.status, 409);
  active.length = 0;
  const removed = await request('/api/agent-packages/inspection/teams/crew', 'DELETE', { expectedRevision: first.revision });
  assert.equal(removed.status, 200, removed.raw);
  assert.equal(removed.json.package.manifest.teams.length, 0);
  const archived = await request('/api/agent-packages/inspection/agents/inspector', 'DELETE', { expectedRevision: removed.json.package.revision });
  assert.equal(archived.status, 200, archived.raw); assert.equal(archived.json.archived, true);
  const history = await request(`/api/agent-packages/inspection/export?revision=${first.revision}`);
  assert.equal(history.status, 200); assert.equal(history.json.teams.length, 1);
});

test('public upload rejects teams and managed instruction updates while per-team toggles are protected', async t => {
  const { request, packages, active } = await fixture(t);
  const raw = manifest(); raw.teams = [{ id: 'crew', members: ['inspector'] }, { id: 'other-crew', members: ['inspector'] }];
  const deniedPreview = await request('/api/agent-packages/import/preview', 'POST', { package: raw }); assert.equal(deniedPreview.status, 400);
  const deniedImport = await request('/api/agent-packages/import', 'POST', { package: raw }); assert.equal(deniedImport.status, 400);
  const installed = packages.installIntegration(raw, { sourcePath: '/source/inspection.glados-agent.json' });
  const catalog = await request('/api/agent-teams');
  assert.equal(catalog.json.teams.find(team => team.id === 'pkg-inspection--crew').available, false);
  const deniedEdit = await request('/api/agent-packages/inspection', 'PATCH', { package: raw, expectedRevision: installed.revision }); assert.equal(deniedEdit.status, 409);
  const deniedAgentUpload = await request('/api/agent-packages/import', 'POST', { package: manifest() }); assert.equal(deniedAgentUpload.status, 409);
  const enabled = await request('/api/agent-packages/inspection/teams/crew/enabled', 'POST', { enabled: true, expectedRevision: installed.revision });
  assert.equal(enabled.status, 200, enabled.raw); assert.equal(enabled.json.package.enabled, true);
  assert.equal(enabled.json.package.manifest.teams.find(team => team.id === 'other-crew').enabled, false);
  const stale = await request('/api/agent-packages/inspection/teams/crew/enabled', 'PATCH', { enabled: false, expectedRevision: installed.revision }); assert.equal(stale.status, 409);
  active.push('pkg-inspection--crew');
  const blocked = await request('/api/agent-packages/inspection/teams/crew/enabled', 'PATCH', { enabled: false, expectedRevision: enabled.json.package.revision }); assert.equal(blocked.status, 409);
});

test('trusted Clippy integration is editable through Agents while preserving revision and capability guards', async t => {
  const { request, packages, active } = await fixture(t);
  const sourcePath = path.resolve(__dirname, '../../templates/integrated-teams/clippy-intel.glados-agent.json');
  const installed = packages.installIntegration(fs.readFileSync(sourcePath, 'utf8'), { sourcePath });
  const list = await request('/api/agent-packages');
  assert.equal(list.json.packages.find(row => row.id === installed.id).editableIntegration, true);
  const draft = structuredClone(installed.manifest);
  Object.assign(draft.agents[0], { instructions: 'Prioritize critical domains with explicit report coverage evidence.', model: 'my-model', effort: 'low', tools: ['mcp__clippy__read'], deliverables: ['Prioritized leads'] });
  active.push('pkg-clippy-intel--clippy');
  const busy = await request('/api/agent-packages/clippy-intel', 'PATCH', { package: draft, expectedRevision: installed.revision });
  assert.equal(busy.status, 409);
  active.length = 0;
  const saved = await request('/api/agent-packages/clippy-intel', 'PATCH', { package: draft, expectedRevision: installed.revision });
  assert.equal(saved.status, 200, saved.raw);
  assert.equal(saved.json.package.manifest.agents[0].model, 'my-model');
  assert.equal(saved.json.package.manifest.agents[0].effort, 'low');
  assert.equal(saved.json.package.managedIntegration, true);
  assert.equal(saved.json.package.editableIntegration, true);
  assert.equal((await request('/api/agent-packages/clippy-intel', 'PATCH', { package: draft, expectedRevision: installed.revision })).status, 409);
  draft.agents[0].tools.push('Bash');
  const wider = await request('/api/agent-packages/clippy-intel', 'PATCH', { package: draft, expectedRevision: saved.json.package.revision });
  assert.equal(wider.status, 400, wider.raw);
  assert.match(wider.json.error, /capabilities are limited/);
  const upload = await request('/api/agent-packages/import', 'POST', { package: installed.manifest });
  assert.equal(upload.status, 409);
});

test('a draft test uses conversation history and never saves an agent package', async t => {
  let seen;
  const { request, packages } = await fixture(t, async options => { seen = options; return { reply: 'A sample inspection note.', isolated: true, model: 'test-model', effort: 'low', events: [] }; });
  const response = await request('/api/agent-packages/test', 'POST', { agent: manifest().agents[0], messages: [{ role: 'user', content: 'Inspect this text.' }, { role: 'assistant', content: 'What should I check?' }, { role: 'user', content: 'Clarity.' }] });
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.json.reply, 'A sample inspection note.');
  assert.equal(response.json.isolated, true);
  assert.equal(seen.prompt, 'Clarity.');
  assert.equal(seen.conversation.length, 2);
  assert.equal(seen.options.abortSignal.aborted, false);
  assert.equal(packages.list().length, 0);
  const invalid = await request('/api/agent-packages/test', 'POST', { agent: manifest().agents[0], messages: [{ role: 'system', content: 'Untrusted role' }] });
  assert.equal(invalid.status, 400);
});

test('connector API import and edits keep credentials hidden and reject identity collisions', async t => {
  const { request, connectors } = await fixture(t);
  const payload = { config: { mcpServers: { inventory: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private-token' }, tools: ['read'] } } } };
  const preview = await request('/api/connectors/import/preview', 'POST', payload);
  assert.equal(preview.status, 200, preview.raw);
  assert.equal(preview.raw.includes('private-token'), false);
  const imported = await request('/api/connectors/import', 'POST', payload);
  assert.equal(imported.status, 201, imported.raw);
  assert.equal(imported.json.connectors[0].enabled, false);
  assert.equal(imported.raw.includes('private-token'), false);
  const row = imported.json.connectors[0];
  const enabled = await request('/api/connectors/inventory', 'PATCH', { connector: { enabled: true }, expectedRevision: row.revision });
  assert.equal(enabled.status, 200, enabled.raw);
  assert.equal(connectors.runtimeConfig('inventory').headers.Authorization, 'Bearer private-token');
  const stale = await request('/api/connectors/inventory', 'PATCH', { connector: { enabled: false }, expectedRevision: row.revision });
  assert.equal(stale.status, 409);
  const collision = await request('/api/connectors/import', 'POST', payload);
  assert.equal(collision.status, 409);
});

test('connector disconnect API disables user connectors, deletes keys, and publishes the updated catalog', async t => {
  const { request, root, connectors, connectorChanges } = await fixture(t);
  const created = await request('/api/connectors', 'POST', { connector: { id: 'inventory', url: 'https://example.test/mcp?token=query-secret', headers: { Authorization: 'Bearer header-secret' }, tools: ['read'], enabled: true } });
  const row = created.json.connector;
  const missingRevision = await request('/api/connectors/inventory/disconnect', 'POST');
  assert.equal(missingRevision.status, 409);
  const stale = await request('/api/connectors/inventory/disconnect', 'POST', { expectedRevision: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(connectors.get(row.id).available, true);
  const response = await request('/api/connectors/inventory/disconnect', 'POST', { expectedRevision: row.revision });
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.json.connector.available, false);
  assert.equal(response.json.connector.enabled, false);
  assert.equal(response.json.connector.hasCredentials, false);
  assert.equal(response.json.connectors.find(item => item.id === row.id).status, 'not connected');
  assert.equal(/query-secret|header-secret/.test(response.raw), false);
  assert.equal(fs.existsSync(path.join(root, 'secrets/connectors/inventory.json')), false);
  assert.equal(connectors.runtimeConfig(row.id), null);
  assert.deepEqual(connectorChanges.at(-1), { action: 'disconnect', id: 'inventory' });
});

test('Clippy disconnect API removes runtime-disabled credentials and rejects built-in connector disconnects', async t => {
  const { request, env, connectorChanges } = await fixture(t);
  saveClippyToken('clippy-disconnect-secret', env);
  const before = await request('/api/connectors');
  const clippy = before.json.connectors.find(row => row.id === 'clippy');
  assert.equal(clippy.source, 'integration');
  assert.equal(clippy.builtIn, false);
  assert.equal(clippy.disconnectable, true);
  assert.equal(clippy.configured, true);
  assert.equal(clippy.enabled, false);
  assert.equal(before.raw.includes('clippy-disconnect-secret'), false);
  const disconnected = await request('/api/connectors/clippy/disconnect', 'POST');
  assert.equal(disconnected.status, 200, disconnected.raw);
  assert.equal(disconnected.json.connector.configured, false);
  assert.equal(disconnected.json.connectors.find(row => row.id === 'clippy').hasCredentials, false);
  assert.equal(fs.existsSync(clippySecretPath(env)), false);
  assert.equal(disconnected.raw.includes('clippy-disconnect-secret'), false);
  assert.deepEqual(connectorChanges.at(-1), { action: 'disconnect', id: 'clippy' });
  for (const id of ['blackboard', 'watchdog', 'glados-ops', 'browser']) {
    const response = await request(`/api/connectors/${id}/disconnect`, 'POST');
    assert.equal(response.status, 400, response.raw);
    assert.equal(response.json.code, 'builtin_connector');
  }
  assert.equal((await request('/api/connectors/missing/disconnect', 'POST')).status, 404);
  assert.equal(connectorChanges.filter(row => row.action === 'disconnect').length, 1);
});
