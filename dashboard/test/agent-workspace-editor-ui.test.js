const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const plain = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function context() {
  const ctx = vm.createContext({ state: { agentLibrary: { catalog: { packages: [{ id: 'herbie', managedIntegration: true, managedSource: 'herbie.glados-agent.json' }, { id: 'custom', name: 'Custom' }] }, fordCatalog: { teams: [{ id: 'herbie', name: 'Herbie' }] } }, teamCatalog: { agents: [] } }, escapeHtml, agentDisplayName: agent => agent.name || agent.id });
  vm.runInContext(section('function agentPackageSummary(', 'function portablePackageManifest('), ctx);
  vm.runInContext(section('function fordAgenticTeamForPackage(', 'function customAgentPackages('), ctx);
  vm.runInContext(section('function agentOriginLabel(', 'function renderTeamAssignments('), ctx);
  vm.runInContext(section('function teamAssignableAgents(', 'function agentOriginLabel('), ctx);
  vm.runInContext(section('function instructionDisabledTools(', 'async function hydrateAgentCard('), ctx);
  vm.runInContext(section('function packageTeamModelAgentIds(', 'function teamAssignableAgents('), ctx);
  return ctx;
}

test('assignment source labels name RT teams and do not mislabel custom packages with the same ID', () => {
  const ctx = context();
  const agents = [{ id: 'pkg-herbie--packet', name: 'Packet Inspector', packageId: 'herbie' }, { id: 'pkg-custom--agent', name: 'Clippy', packageId: 'custom' }];
  ctx.state.teamCatalog.agents = agents;
  const html = ctx.teamAssignmentsMarkup({ id: 'glados', assignedAgentIds: [], memberIds: [] });
  assert.match(html, /Herbie · RT Agentic Team/);
  assert.match(html, /<small>Custom agent<\/small>/);
  assert.match(html, /data-assignment-name="packet inspector pkg-herbie--packet herbie · rt agentic team"/);
  ctx.state.agentLibrary.catalog.packages[0].managedIntegration = false;
  assert.equal(ctx.agentOriginLabel(agents[0]), 'Custom agent');
  const page = section('function drawAgentsLibrary(', 'function fordTeamAgentRosterMarkup(');
  assert.ok(page.indexOf('${builtInAgentsMarkup()}') < page.indexOf('data-built-in-team-assignments'));
});

test('document drafts preserve missing files and original line endings until an actual edit', () => {
  const ctx = context();
  const snapshot = { documents: [{ name: 'AGENTS.md', content: '\r\nOriginal\r\n', exists: true }, { name: 'USER.md', exists: false, content: null }] };
  const fields = [{ dataset: { instructionDocument: 'AGENTS.md' }, value: '\nOriginal\n' }, { dataset: { instructionDocument: 'USER.md' }, value: '' }];
  assert.deepEqual(plain(ctx.changedInstructionDocuments(snapshot, fields)), {});
  fields[0].value = 'Edited\n';
  assert.deepEqual(plain(ctx.changedInstructionDocuments(snapshot, fields)), { 'AGENTS.md': 'Edited\n' });
});

test('built-in instruction edits cannot be discarded during a save and can be cancelled before switching agents', async () => {
  const ctx = context(); let asked = 0;
  ctx.showToast = () => {}; ctx.confirmAction = async () => { asked++; return false; };
  ctx.state.agentLibrary.builtInEditor = { dirty: true, saving: true };
  assert.equal(await ctx.confirmBuiltInEditorDiscard(), false); assert.equal(asked, 0);
  ctx.state.agentLibrary.builtInEditor.saving = false;
  assert.equal(await ctx.confirmBuiltInEditorDiscard(), false); assert.equal(asked, 1);
  assert.equal(ctx.state.agentLibrary.builtInEditor.dirty, true);
  ctx.confirmAction = async () => true;
  assert.equal(await ctx.confirmBuiltInEditorDiscard(), true); assert.equal(ctx.state.agentLibrary.builtInEditor, null);
});

function element() { return { isConnected: true, innerHTML: '', textContent: '', value: '', disabled: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } }; }
for (const partial of [false, true]) test(`team bulk models stage, scope saves, and handle partial failures (${partial})`, async () => {
  const ctx = context();
  const manifest = { id: 'herbie', agents: [{ id: 'coordinator' }, { id: 'packet', enabled: false }, { id: 'other-team-member' } ] };
  const team = { id: 'crew', coordinator: 'coordinator', members: ['coordinator', 'packet'] };
  const runtimeTeam = { id: 'pkg-herbie--crew', assignedAgentIds: ['webapp-recon'] };
  ctx.state.teamCatalog.teams = [runtimeTeam];
  const ids = plain(ctx.packageTeamModelAgentIds(manifest, team, runtimeTeam));
  assert.deepEqual(ids, ['pkg-herbie--crew', 'pkg-herbie--coordinator', 'pkg-herbie--packet', 'webapp-recon']);
  const rows = [...ids, 'pkg-other--agent'].map(id => ({ id, model: 'old' }));
  const calls = [];
  ctx.fetchJson = async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body); calls.push({ method: options.method, url, ...body });
      return { ok: !partial || calls.length > 1, partial: partial && calls.length === 1, results: body.changes.map(row => partial && calls.length === 1 && row.agentId === 'pkg-herbie--packet' ? { ok: false, agentId: row.agentId, error: 'Concurrent model change' } : { ok: true, agentId: row.agentId, newModel: row.model }) };
    }
    return url === '/api/models' ? { available: true, models: ['old', 'new'] } : { agents: rows };
  };
  ctx.loadAgentTeams = async () => {}; ctx.loadAgents = async () => {}; ctx.showToast = () => {};
  const fields = Object.fromEntries(['[data-package-team-model]', '[data-save-team-model]', '[data-team-model-status]'].map(key => [key, element()]));
  const target = { ...element(), querySelector: selector => fields[selector] };
  await ctx.renderPackageTeamModels(target, manifest, team, { revision: 'same', activeRevision: 'same' });
  assert.equal(calls.length, 0);
  const select = fields['[data-package-team-model]'], save = fields['[data-save-team-model]'];
  select.value = 'new'; select.listeners.change();
  assert.equal(calls.length, 0); assert.equal(save.disabled, false);
  await save.listeners.click();
  assert.deepEqual(calls[0].changes.map(row => row.agentId), ids);
  assert.ok(calls[0].changes.every(row => row.model === 'new' && row.expectedModel === 'old'));
  if (partial) {
    assert.equal(save.disabled, false);
    assert.match(fields['[data-team-model-status]'].textContent, /Concurrent model change/);
    await save.listeners.click();
    assert.deepEqual(calls[1].changes.map(row => row.agentId), ['pkg-herbie--packet']);
  }
  assert.equal(save.disabled, true); assert.deepEqual(manifest.agents, [{ id: 'coordinator' }, { id: 'packet', enabled: false }, { id: 'other-team-member' }]);
});


test('tool selections preserve unavailable restrictions and only stage explicit checkbox changes', () => {
  const ctx = context();
  const snapshot = { availableTools: ['Read', 'Bash'], disabledTools: ['unavailable-tool'] };
  const fields = [{ value: 'Read', checked: true }, { value: 'Bash', checked: true }];
  assert.deepEqual(plain(ctx.instructionDisabledTools(snapshot, fields)), ['unavailable-tool']);
  fields[1].checked = false;
  assert.deepEqual(plain(ctx.instructionDisabledTools(snapshot, fields)), ['Bash', 'unavailable-tool']);
});
