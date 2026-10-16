const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function section(start, end) {
  const offset = app.indexOf(start);
  assert.notEqual(offset, -1, `Missing ${start}`);
  const boundary = app.indexOf(end, offset + start.length);
  assert.notEqual(boundary, -1, `Missing ${end}`);
  return app.slice(offset, boundary);
}

test('GLaDOS and installed teams share visible bulk controls above the same roster and editor', () => {
  const ctx = vm.createContext({ escapeHtml });
  vm.runInContext(section('function builtInAgentsMarkup(', 'async function loadBuiltInAgentSettings('), ctx);
  const native = ctx.builtInAgentsMarkup();
  const installed = ctx.builtInAgentsMarkup({ teamName: 'Herbie', packageTeam: true });
  for (const markup of [native, installed]) {
    const bulk = markup.indexOf('data-all-agent-model');
    const save = markup.indexOf('id="settings-save-models"');
    const roster = markup.indexOf('built-in-team-grid');
    assert.ok(bulk >= 0 && save > bulk && roster > save, 'Team model selection and Save Changes must precede the roster');
    assert.equal((markup.match(/data-all-agent-model/g) || []).length, 1);
    assert.match(markup, /built-in-agent-roster/);
    assert.match(markup, /data-built-in-editor/);
  }
  assert.match(native, /GLaDOS team/);
  assert.match(installed, /Herbie team/);
  assert.match(installed, /data-built-in-editor[^>]*data-package-editor|data-package-editor[^>]*data-built-in-editor/);
  assert.doesNotMatch(native, /data-package-editor/);
});

test('the installed-team view uses the shared settings shell instead of a separate roster', () => {
  const page = section('function drawAgentsLibrary(', 'function fordTeamAgentRosterMarkup(');
  const installedBranch = page.slice(page.indexOf("if (library.view.startsWith('team:'))"));
  assert.match(installedBranch, /builtInAgentsMarkup\(\{[^}]*packageTeam:\s*true/s);
  assert.match(installedBranch, /loadBuiltInAgentSettings\([^;]+teamId/s);
  assert.match(installedBranch, /onEditAgent/);
  assert.doesNotMatch(installedBranch, /ford-installed-team-grid|data-ford-roster-agent/);
});

function element() {
  const classes = new Set();
  return {
    dataset: {}, value: '', textContent: '', disabled: false, hidden: false, isConnected: true, listeners: {},
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    insertAdjacentHTML() {},
  };
}

async function herbieSettingsFixture() {
  const manifest = {
    id: 'herbie',
    agents: [
      { id: 'coordinator', name: 'Herbie Coordinator', model: 'manifest-default' },
      { id: 'packet', name: 'Packet Inspector', model: null, enabled: false },
      { id: 'other-team-member', model: 'manifest-default' },
    ],
    teams: [{ id: 'crew', coordinator: 'coordinator', members: ['coordinator', 'packet'] }],
  };
  const team = manifest.teams[0];
  const teamId = 'pkg-herbie--crew';
  const rows = [
    { id: teamId, name: 'Herbie', model: 'old-model', enabled: true, packageId: 'herbie', teamCoordinator: true },
    { id: 'pkg-herbie--coordinator', name: 'Herbie Coordinator', model: 'old-model', enabled: true, packageId: 'herbie' },
    { id: 'pkg-herbie--packet', name: 'Packet Inspector', model: 'runtime-override', enabled: false, packageId: 'herbie' },
    { id: 'webapp-recon', name: 'Webapp Recon', model: 'old-model', enabled: true },
    { id: 'pkg-herbie--other-team-member', name: 'Other team member', model: 'old-model', enabled: true, packageId: 'herbie' },
    { id: 'glados', model: 'old-model', enabled: true },
    { id: 'pkg-unrelated--agent', model: 'old-model', enabled: true, packageId: 'unrelated' },
  ];
  const cards = [];
  const fields = Object.fromEntries(['settings-model-catalog', 'settings-agent-search', 'settings-save-models', 'settings-discard-models', 'settings-pending-models'].map(id => [`#${id}`, element()]));
  fields['[data-all-agent-model]'] = element();
  fields['[data-built-in-editor]'] = element();
  fields['[data-package-editor]'] = fields['[data-built-in-editor]'];
  const list = {
    innerHTML: '', textContent: '',
    appendChild(card) { cards.push(card); },
    querySelector(selector) {
      const id = selector.match(/data-agent-id="([^"]+)"/)?.[1];
      return id ? cards.find(card => card.dataset.agentId === id) || null : null;
    },
    querySelectorAll: () => cards,
    insertAdjacentHTML() {},
  };
  fields['#settings-list'] = list;
  const requests = [], mutations = [], edits = [], notifications = [];
  const library = { catalog: { builtInAgents: [{ id: 'glados' }, { id: 'webapp-recon' }] }, view: 'team:herbie', draft: manifest, selectedId: 'herbie', selectedAgentId: 'coordinator', selectedTeamId: 'crew', dirty: false };
  const context = vm.createContext({
    state: { agentLibrary: library, teamCatalog: { agents: rows, teams: [{ id: teamId, assignedAgentIds: ['webapp-recon'] }] } },
    CSS: { escape: value => value }, escapeHtml,
    fetchJson: async url => {
      requests.push(url);
      return url === '/api/models' ? { available: true, models: ['old-model', 'runtime-override', 'shared-model'] } : { agents: rows };
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      mutations.push({ url, method: options.method, ...body });
      return { ok: true, json: async () => ({ results: body.changes.map(change => ({ ok: true, agentId: change.agentId, newModel: change.model })) }) };
    },
    confirmBuiltInEditorDiscard: async () => true,
    loadAgents: async () => {}, loadAgentTeams: async () => {},
    showToast() {}, pushNotification: (...args) => notifications.push(args),
    document: {
      createElement() {
        const card = element();
        const model = element(), edit = element(), saved = element();
        card.querySelector = selector => selector === '[data-model-select]' ? model : selector === '[data-agent-details-toggle]' ? edit : selector === '[data-saved-model]' ? saved : null;
        return card;
      },
    },
  });
  vm.runInContext(section('function gladosTeamSettingsAgents(', 'function builtInAgentsMarkup('), context);
  vm.runInContext(section('function packageTeamModelAgentIds(', 'async function renderPackageTeamModels('), context);
  vm.runInContext(section('async function loadBuiltInAgentSettings(', 'function renderSettingsVersion('), context);
  const wrap = { isConnected: true, querySelector: selector => fields[selector], querySelectorAll: () => [], closest: () => wrap };
  const before = JSON.stringify(manifest);
  await context.loadBuiltInAgentSettings(wrap, {
    teamId, manifest, team,
    onEditAgent: async agent => { edits.push(agent.id); fields['[data-built-in-editor]'].textContent = `Editing ${agent.id}`; },
  });
  assert.equal(list.textContent, '', `Settings loader failed: ${list.textContent}`);
  return { context, manifest, before, cards, fields, mutations, requests, edits, notifications };
}

test('Herbie roster displays effective settings models and hides only the virtual team coordinator', async () => {
  const fixture = await herbieSettingsFixture();
  assert.deepEqual(fixture.cards.map(card => card.dataset.agentId), ['pkg-herbie--coordinator', 'pkg-herbie--packet', 'webapp-recon']);
  const packet = fixture.cards.find(card => card.dataset.agentId === 'pkg-herbie--packet');
  assert.equal(packet.dataset.enabled, 'false');
  assert.equal(packet.dataset.model, 'runtime-override');
  assert.equal(packet.dataset.committedModel, 'runtime-override');
  assert.match(packet.innerHTML, /data-saved-model>runtime-override</);
  assert.doesNotMatch(packet.innerHTML, /manifest-default/);
  assert.equal(fixture.mutations.length, 0);
  assert.equal(JSON.stringify(fixture.manifest), fixture.before);
});

test('the native editor button covers the roster card with an independent model control and visible keyboard focus', async () => {
  const fixture = await herbieSettingsFixture();
  const coordinator = fixture.cards[0], packet = fixture.cards[1];
  assert.match(coordinator.innerHTML, /<button type="button"[^>]*data-agent-details-toggle[^>]*aria-label="Edit Herbie Coordinator agent"[^>]*aria-expanded="true"/);
  assert.match(packet.innerHTML, /<button type="button"[^>]*data-agent-details-toggle[^>]*aria-expanded="false"/);
  assert.doesNotMatch(coordinator.innerHTML, /<button[^>]*>[\s\S]*<select/);
  for (const card of fixture.cards) {
    assert.equal(card.listeners.click, undefined, 'The button must remain the sole activation handler, avoiding duplicate bubbled clicks');
    assert.equal(card.listeners.keydown, undefined, 'Use native button keyboard activation rather than a second keyboard handler');
  }
  assert.match(css, /\.built-in-agent-roster \.settings-agent-row\s*\{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;/);
  assert.match(css, /\.built-in-agent-roster \.settings-agent-details-toggle::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*1;/);
  assert.match(css, /\.built-in-agent-roster \.settings-agent-model select\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/);
  assert.match(css, /\.settings-agent-details-toggle:focus-visible::after\s*\{[^}]*outline:\s*2px/);
});

test('opening a roster card selects its editor once while model changes remain independent and unsaved', async () => {
  const fixture = await herbieSettingsFixture();
  const [coordinator, packet] = fixture.cards;
  const model = packet.querySelector('[data-model-select]');
  model.value = 'shared-model';
  await model.listeners.change();
  assert.deepEqual(fixture.edits, []);
  assert.equal(fixture.mutations.length, 0);
  await packet.querySelector('[data-agent-details-toggle]').listeners.click();
  assert.deepEqual(fixture.edits, ['pkg-herbie--packet']);
  assert.equal(packet.classList.contains('open'), true);
  assert.equal(coordinator.classList.contains('open'), false);
  assert.equal(packet.querySelector('[data-agent-details-toggle]').ariaExpanded, 'true');
  assert.equal(coordinator.querySelector('[data-agent-details-toggle]').ariaExpanded, 'false');
  assert.equal(model.value, 'shared-model');
  assert.equal(fixture.mutations.length, 0);
  assert.equal(JSON.stringify(fixture.manifest), fixture.before);
});

test('declining unsaved-edit discard leaves the selected roster card and editor unchanged', async () => {
  const fixture = await herbieSettingsFixture();
  const [coordinator, packet] = fixture.cards;
  fixture.context.confirmBuiltInEditorDiscard = async () => false;
  await packet.querySelector('[data-agent-details-toggle]').listeners.click();
  assert.deepEqual(fixture.edits, []);
  assert.equal(coordinator.classList.contains('open'), true);
  assert.equal(packet.classList.contains('open'), false);
  assert.equal(fixture.mutations.length, 0);
});

test('Herbie bulk model changes remain staged across role selection and save the full scoped roster', async () => {
  const fixture = await herbieSettingsFixture();
  const all = fixture.fields['[data-all-agent-model]'];
  const save = fixture.fields['#settings-save-models'];
  const pending = fixture.fields['#settings-pending-models'];
  assert.equal(fixture.mutations.length, 0);
  all.value = 'shared-model';
  await all.listeners.change();
  assert.equal(fixture.mutations.length, 0, 'Choosing a model must not persist it');
  assert.equal(save.disabled, false);
  assert.match(pending.textContent, /4 pending model changes/);
  const cardsBefore = [...fixture.cards];
  for (const card of fixture.cards.slice(0, 2)) {
    await card.querySelector('[data-agent-details-toggle]').listeners.click();
    assert.equal(card.querySelector('[data-model-select]').value, 'shared-model');
  }
  assert.deepEqual(fixture.edits, ['pkg-herbie--coordinator', 'pkg-herbie--packet']);
  assert.deepEqual(fixture.cards, cardsBefore, 'Changing the selected agent must retain the staged roster');
  assert.match(pending.textContent, /4 pending model changes/);
  assert.equal(fixture.mutations.length, 0);
  await save.listeners.click();
  assert.equal(fixture.mutations.length, 1);
  const post = fixture.mutations[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.url, '/api/settings/agents/models');
  assert.deepEqual(post.changes.map(change => change.agentId).sort(), ['pkg-herbie--crew', 'pkg-herbie--coordinator', 'pkg-herbie--packet', 'webapp-recon'].sort());
  assert.ok(post.changes.every(change => change.model === 'shared-model'));
  assert.equal(post.changes.find(change => change.agentId === 'pkg-herbie--packet').expectedModel, 'runtime-override');
  assert.ok(post.changes.filter(change => change.agentId !== 'pkg-herbie--packet').every(change => change.expectedModel === 'old-model'));
  for (const card of fixture.cards) {
    assert.equal(card.dataset.committedModel, 'shared-model');
    assert.equal(card.querySelector('[data-saved-model]').textContent, 'shared-model');
  }
  assert.equal(save.disabled, true);
  assert.equal(pending.textContent, 'No pending model changes');
  assert.equal(JSON.stringify(fixture.manifest), fixture.before, 'Model overrides must not rewrite package instructions or metadata');
});

test('discarding Herbie model changes restores saved choices and clears hidden coordinator changes without a request', async () => {
  const fixture = await herbieSettingsFixture();
  const all = fixture.fields['[data-all-agent-model]'];
  const save = fixture.fields['#settings-save-models'];
  const discard = fixture.fields['#settings-discard-models'];
  const pending = fixture.fields['#settings-pending-models'];
  const committed = fixture.cards.map(card => ({ id: card.dataset.agentId, model: card.dataset.committedModel }));
  assert.equal(save.disabled, true);
  assert.equal(discard.disabled, true);
  all.value = 'shared-model';
  await all.listeners.change();
  assert.match(pending.textContent, /4 pending model changes/);
  assert.equal(discard.disabled, false);
  assert.equal(fixture.context.state.agentLibrary.teamModelEdits.dirty, true);
  for (const card of fixture.cards) {
    assert.equal(card.dataset.model, 'shared-model');
    assert.equal(card.querySelector('[data-model-select]').value, 'shared-model');
  }
  await discard.listeners.click();
  assert.equal(fixture.mutations.length, 0);
  assert.equal(all.value, '');
  for (const row of committed) {
    const card = fixture.cards.find(card => card.dataset.agentId === row.id);
    assert.equal(card.dataset.committedModel, row.model);
    assert.equal(card.dataset.model, row.model);
    assert.equal(card.querySelector('[data-model-select]').value, row.model);
    assert.equal(card.classList.contains('model-dirty'), false);
    assert.equal(card.querySelector('[data-model-select]').classList.contains('model-dirty'), false);
  }
  assert.equal(pending.textContent, 'No pending model changes');
  assert.equal(save.disabled, true);
  assert.equal(discard.disabled, true);
  assert.equal(fixture.context.state.agentLibrary.teamModelEdits.dirty, false);
  await save.listeners.click();
  assert.equal(fixture.mutations.length, 0, 'Discard must also clear the invisible team coordinator draft');
  assert.equal(JSON.stringify(fixture.manifest), fixture.before);
});

test('cancelling the package discard keeps the pending model guard intact', async () => {
  const models = { dirty: true, saving: false };
  const answers = [true, false];
  const ctx = vm.createContext({ state: { agentLibrary: { dirty: true, teamModelEdits: models } }, confirmBuiltInEditorDiscard: async () => true, confirmAction: async () => answers.shift(), showToast() {} });
  vm.runInContext(section('async function confirmAgentPackageDiscard(', 'function renderPackageTestMessages('), ctx);
  assert.equal(await ctx.confirmAgentPackageDiscard(), false);
  assert.equal(ctx.state.agentLibrary.teamModelEdits, models);
  assert.equal(models.dirty, true);
});
