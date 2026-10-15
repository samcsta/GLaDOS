const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeManifest, parsePackage } = require('../lib/agent-packages');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const plain = value => JSON.parse(JSON.stringify(value));

function editorHelpers() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, URL });
  vm.runInContext(section('function newPackageDraft(', 'async function packageApi('), context);
  vm.runInContext(section('async function agentPackageImportPayload(', 'function openAgentPackageImport('), context);
  vm.runInContext(section('function connectorFormPayload(', 'function openConnectorEditor('), context);
  return context;
}

function fillAgent(draft) {
  draft.name = 'Custom specialist';
  draft.description = 'Checks requested work.';
  draft.agents[0].name = 'Custom specialist';
  draft.agents[0].instructions = 'Read the task.\n\n  Preserve its constraints and report the result.\n';
  draft.agents[0].model = 'local-model';
  return draft;
}

const file = (name, content, extra = {}) => ({ name, size: Buffer.byteLength(content), text: async () => content, ...extra });

test('specialist and team drafts produce distinct stable identities accepted by the package store', () => {
  const helpers = editorHelpers();
  const specialist = fillAgent(helpers.newPackageDraft());
  assert.deepEqual(plain(helpers.agentPackageIssues(specialist)), []);
  const normalized = normalizeManifest(plain(specialist));
  assert.equal(normalized.agents[0].instructions, specialist.agents[0].instructions);
  assert.match(normalized.id, /^custom-[a-f0-9-]+$/);
  const other = fillAgent(helpers.newPackageDraft());
  assert.notEqual(other.id, specialist.id);
  const team = fillAgent(helpers.newPackageDraft('team'));
  team.teams[0].name = 'Custom team';
  assert.notEqual(team.teams[0].id, team.agents[0].id);
  assert.deepEqual(plain(helpers.agentPackageIssues(team)), []);
  assert.equal(normalizeManifest(plain(team)).teams[0].coordinator, team.agents[0].id);
});

test('creator reports invalid identity, version, duplicate members, and excluded coordinator before saving', () => {
  const helpers = editorHelpers();
  const draft = fillAgent(helpers.newPackageDraft('team'));
  draft.id = 'Invalid Package';
  draft.version = '01.0.0';
  draft.teams[0].name = 'Team';
  draft.teams[0].members = [];
  draft.agents.push({ ...draft.agents[0] });
  const issues = helpers.agentPackageIssues(draft);
  assert.ok(issues.some(issue => /lowercase package ID/.test(issue)));
  assert.ok(issues.some(issue => /version/.test(issue)));
  assert.ok(issues.some(issue => /own ID/.test(issue)));
  assert.ok(issues.some(issue => /coordinator/.test(issue)));
  assert.ok(issues.some(issue => /members/.test(issue)));
});

test('editing a selected revision clones the manifest and retains supporting skills and resources', () => {
  const helpers = editorHelpers();
  const manifest = fillAgent(helpers.newPackageDraft());
  manifest.agents[0].skills = [{ id: 'review-workflow', name: 'Review workflow', path: 'skills/review-workflow/SKILL.md' }];
  manifest.resources = [{ path: 'skills/review-workflow/SKILL.md', text: '# Review workflow\nCheck the requested artifact.' }];
  const edited = helpers.portablePackageManifest({ manifest });
  edited.name = 'Edited locally';
  edited.agents[0].instructions = 'Changed instructions';
  assert.equal(manifest.name, 'Custom specialist');
  assert.match(manifest.agents[0].instructions, /Preserve its constraints/);
  const saved = normalizeManifest(plain(edited));
  assert.equal(saved.resources[0].text, manifest.resources[0].text);
  assert.equal(saved.agents[0].skills[0].id, 'review-workflow');
});

test('JSON, Markdown, and folder uploads map to supported import payloads', async () => {
  const helpers = editorHelpers();
  const manifest = fillAgent(helpers.newPackageDraft());
  const jsonPayload = await helpers.agentPackageImportPayload([file('specialist.json', JSON.stringify({ manifest }))]);
  assert.equal(normalizeManifest(parsePackage(plain(jsonPayload))).id, manifest.id);
  const markdownPayload = await helpers.agentPackageImportPayload([file('Agent.md', '# Custom specialist\nFollow the task.')]);
  assert.equal(markdownPayload.format, 'markdown');
  assert.equal(normalizeManifest(parsePackage(markdownPayload.text, plain(markdownPayload))).agents[0].instructions, '# Custom specialist\nFollow the task.');
  const folderPayload = await helpers.agentPackageImportPayload([
    file('manifest.json', JSON.stringify(manifest), { webkitRelativePath: 'team/manifest.json' }),
    file('instructions.md', '# Supporting context', { webkitRelativePath: 'team/reference/instructions.md' }),
  ]);
  const imported = normalizeManifest(parsePackage(plain(folderPayload)));
  assert.equal(imported.resources[0].path, 'reference/instructions.md');
  assert.equal(imported.resources[0].text, '# Supporting context');
});

test('uploader rejects unreadable JSON and oversized collections before a network mutation', async () => {
  const helpers = editorHelpers();
  await assert.rejects(helpers.agentPackageImportPayload([file('broken.json', '{')]), /could not be read/);
  await assert.rejects(helpers.agentPackageImportPayload([{ ...file('large.json', '{}'), size: 5 * 1024 * 1024 + 1 }]), /smaller than 5 MB/);
  await assert.rejects(helpers.agentPackageImportPayload(Array.from({ length: 252 }, (_, index) => file(`${index}.md`, '# text'))), /251 files/);
});

test('connector editor preserves omitted credential maps and validates process arguments', () => {
  const helpers = editorHelpers();
  const connector = plain(helpers.connectorFormPayload({ id: 'my-connector', name: 'My connector', type: 'http', url: 'https://example.test/mcp', tools: 'read\nread\nlookup', env: '', headers: '', enabled: false }));
  assert.equal(Object.hasOwn(connector, 'env'), false);
  assert.equal(Object.hasOwn(connector, 'headers'), false);
  assert.deepEqual(connector.tools, ['read', 'lookup']);
  const local = plain(helpers.connectorFormPayload({ id: 'local-connector', name: 'Local', type: 'stdio', command: '/usr/bin/example', args: '["--port", "3000"]', env: '{"API_TOKEN":"secret"}', tools: 'inspect' }));
  assert.deepEqual(local.args, ['--port', '3000']);
  assert.equal(local.env.API_TOKEN, 'secret');
  assert.throws(() => helpers.connectorFormPayload({ id: 'local', name: 'Local', type: 'stdio', command: 'example', args: '[1]' }), /array of strings/);
  assert.throws(() => helpers.connectorFormPayload({ id: 'bad', name: 'Bad', url: 'file:///tmp/mcp' }), /HTTP or HTTPS/);
});

test('Workspace icons and tool tabs coexist while Settings no longer renders agent or connector controls', () => {
  for (const id of ['open-glados', 'open-plans', 'open-reports', 'open-settings', 'open-agent-library', 'open-connectors', 'open-terminal', 'open-proxy']) {
    assert.match(html, new RegExp(`id="${id}"><svg class="workspace-icon"`));
  }
  const tools = html.slice(html.indexOf('<details id="workspace-tools"'), html.indexOf('</details>', html.indexOf('<details id="workspace-tools"')));
  assert.match(tools, /id="open-agent-library"/);
  assert.match(tools, /id="open-connectors"/);
  const settings = section('async function renderSettingsPane()', 'function clippyConnectorMarkup()');
  assert.doesNotMatch(settings, /clippy-connection-card|settings-agent-search|settings-list/);
  assert.match(settings, /setup-summary|operator-profile-card|full-access-card/);
});

test('late test responses cannot enter a different agent draft or a changed conversation', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const elements = {
    '[data-package-test-prompt]': { value: 'Sample task' },
    '[data-run-package-test]': { disabled: false, textContent: '' },
    '[data-package-test-status]': { textContent: '' },
  };
  const context = vm.createContext({
    state: { agentLibrary: { selectedAgentId: 'first', testGeneration: 0, testBusy: false, testMessages: [] } },
    packageApi: async () => pending,
    renderPackageTestMessages() {},
  });
  vm.runInContext(section('async function runAgentPackageTest(', 'async function agentPackageImportPayload('), context);
  const running = context.runAgentPackageTest({ querySelector: selector => elements[selector] }, { id: 'first', model: 'local-model', instructions: 'Follow the task.' });
  context.state.agentLibrary.selectedAgentId = 'second';
  context.state.agentLibrary.testGeneration++;
  context.state.agentLibrary.testMessages = [];
  release({ reply: 'A late response' });
  await running;
  assert.deepEqual(plain(context.state.agentLibrary.testMessages), []);
});


test('connector selection does not silently check server-wide or individual tool grants', () => {
  const context = vm.createContext({ escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') });
  vm.runInContext(section('function packageToolsMarkup(', 'function wirePackageToolSearch('), context);
  const catalog = { connectors: [{ id: 'sample', name: 'Sample MCP', serverName: 'user-sample' }], tools: ['Read', 'mcp__user-sample', 'mcp__user-sample__read', 'mcp__user-sample__write'] };
  const markup = context.packageToolsMarkup({ connectors: ['sample'], tools: ['Read', 'mcp__user-sample__read'] }, catalog);
  assert.match(markup, /value="mcp__user-sample__read" checked/);
  assert.doesNotMatch(markup, /value="mcp__user-sample" checked/);
  assert.doesNotMatch(markup, /value="mcp__user-sample__write" checked/);
  const unavailable = context.packageToolsMarkup({ connectors: [], tools: [] }, catalog);
  assert.match(unavailable, /value="mcp__user-sample__read" disabled/);
  assert.match(unavailable, /Select this connector above/);
});

test('package agents and teams use human names while built-in agent labels keep their IDs', () => {
  const context = vm.createContext({ state: { agents: [
    { id: 'recon', name: 'Reconnaissance', source: 'builtin' },
    { id: 'pkg-custom-team--analyst', name: 'Workspace analyst', packageId: 'custom-team' },
    { id: 'pkg-custom-team--coordinator', name: 'Workspace team', packageId: 'custom-team', teamCoordinator: true },
  ] } });
  vm.runInContext(section('function agentDisplayName(', 'function agentStatusLabel('), context);
  assert.equal(context.agentDisplayName('recon'), 'recon');
  assert.equal(context.agentDisplayName('glados'), 'GLaDOS');
  assert.equal(context.agentDisplayName('pkg-custom-team--analyst'), 'Workspace analyst');
  assert.equal(context.agentDisplayName('pkg-custom-team--coordinator'), 'Workspace team');
  assert.equal(context.agentDisplayName('pkg-missing--agent'), 'pkg-missing--agent');
});

test('direct invocation targets the saved scoped identity and refuses staged, disabled, or unavailable packages', () => {
  const context = vm.createContext({ state: { agentLibrary: {}, agents: [] } });
  vm.runInContext(section('function packageInvocationState(', 'function packageInvocationMarkup('), context);
  const agent = { id: 'analyst', enabled: true, requiredConnectors: ['evidence'] };
  const details = { id: 'custom-team', selectedRevision: 'active', activeRevision: 'active', enabled: true, manifest: { agents: [agent] } };
  const options = { catalog: { connectors: [{ id: 'evidence', enabled: true, available: true }] }, agents: [{ id: 'pkg-custom-team--analyst' }] };
  const ready = context.packageInvocationState(details, agent, options);
  assert.equal(ready.id, 'pkg-custom-team--analyst');
  assert.equal(ready.available, true);
  assert.match(context.packageInvocationState({ ...details, enabled: false }, agent, options).reason, /Enable/);
  assert.match(context.packageInvocationState({ ...details, selectedRevision: 'staged' }, agent, options).reason, /Activate/);
  assert.match(context.packageInvocationState(details, agent, { ...options, dirty: true }).reason, /Save/);
  assert.match(context.packageInvocationState(details, agent, { ...options, agents: [] }).reason, /Enable this agent/);
  assert.match(context.packageInvocationState(details, agent, { ...options, catalog: { connectors: [] } }).reason, /evidence/);
});

test('Run team checks required connectors across all selected team members', () => {
  const context = vm.createContext({ state: { agentLibrary: {}, agents: [] } });
  vm.runInContext(section('function packageInvocationState(', 'function packageInvocationMarkup('), context);
  const manifest = { agents: [{ id: 'coordinator', requiredConnectors: [] }, { id: 'reader', requiredConnectors: ['documents'] }], teams: [{ id: 'review-team', coordinator: 'coordinator', members: ['coordinator', 'reader'] }] };
  const details = { id: 'my-collection', revision: 'active', activeRevision: 'active', manifest };
  const options = { team: true, agents: [{ id: 'pkg-my-collection--review-team' }], catalog: { connectors: [] } };
  assert.match(context.packageInvocationState(details, manifest.teams[0], options).reason, /documents/);
  options.catalog.connectors = [{ id: 'documents', enabled: true, available: true }];
  assert.equal(context.packageInvocationState(details, manifest.teams[0], options).available, true);
});

test('agent tab names render as escaped text and keep the scoped ID in the hover detail', () => {
  const rendered = [];
  const state = { currentTab: 'pkg-local--agent', agents: [{ id: 'pkg-local--agent', packageId: 'local', name: '<Local specialist>' }], openTabs: [{ id: 'pkg-local--agent', kind: 'agent', label: 'pkg-local--agent' }] };
  const context = vm.createContext({
    state,
    tabsEl: { innerHTML: '', appendChild: element => rendered.push(element) },
    document: { createElement: () => ({ addEventListener() {} }) },
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });
  vm.runInContext(section('function agentDisplayName(', 'function agentStatusLabel('), context);
  vm.runInContext(section('function renderTabs()', 'function openReports('), context);
  context.renderTabs();
  assert.match(rendered[0].innerHTML, /&lt;Local specialist&gt;/);
  assert.doesNotMatch(rendered[0].innerHTML, /<Local specialist>/);
  assert.equal(rendered[0].title, 'pkg-local--agent');
});


test('nested Tools links retain transparent flat selection and no first-child bubble styling', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.doesNotMatch(css, /#workspace-links\s+a:first-child/);
  const navRule = css.match(/html\[data-theme\] #workspace-links a,([\s\S]*?)\{([^}]+)\}/);
  assert.ok(navRule, 'Workspace link styles cover nested Tools links');
  assert.match(navRule[1], /#workspace-links a:hover/);
  assert.match(navRule[1], /#workspace-links a\.nav-active/);
  assert.match(navRule[2], /background:\s*transparent/);
  assert.match(navRule[2], /border-color:\s*transparent/);
  assert.match(navRule[2], /border-radius:\s*0/);
  assert.match(navRule[2], /box-shadow:\s*none/);
  assert.match(css, /html\[data-theme\] #workspace-links a\.nav-active,[\s\S]*?\{\s*color:\s*var\(--accent-hi\)/);
});

test('agent uploader rejects team JSON and team folders while preserving agent-only manifests', async () => {
  const helpers = editorHelpers();
  const team = fillAgent(helpers.newPackageDraft('team'));
  team.teams[0].name = 'Team';
  await assert.rejects(helpers.agentPackageImportPayload([file('team.json', JSON.stringify(team))]), /Team uploads are not supported/);
  await assert.rejects(helpers.agentPackageImportPayload([file('manifest.json', JSON.stringify(team), { webkitRelativePath: 'team/manifest.json' })]), /Team uploads are not supported/);
  const agent = fillAgent(helpers.newPackageDraft());
  assert.equal((await helpers.agentPackageImportPayload([file('agent.json', JSON.stringify(agent))])).package.id, agent.id);
});

test('direct chat readiness uses the enabled global agent catalog without requiring team assignment', () => {
  const context = vm.createContext({ state: { agentLibrary: {}, agents: [], teamCatalog: { agents: [{ id: 'pkg-local--specialist', enabled: true, available: true }] } } });
  vm.runInContext(section('function packageInvocationState(', 'function packageInvocationMarkup('), context);
  const details = { id: 'local', revision: 'revision', activeRevision: 'revision', enabled: true, manifest: { agents: [] } };
  const ready = context.packageInvocationState(details, { id: 'specialist', enabled: true, connectors: [] }, { agents: [], catalog: { connectors: [] } });
  assert.equal(ready.available, true);
  assert.equal(ready.id, 'pkg-local--specialist');
  context.state.teamCatalog.agents[0].available = false;
  assert.equal(context.packageInvocationState(details, { id: 'specialist', connectors: [] }, { agents: [], catalog: { connectors: [] } }).available, false);
});

test('managed source remains visible and read-only after enabled-state revisions use a custom source', () => {
  const helpers = editorHelpers();
  const summary = helpers.agentPackageSummary({ id: 'installed', name: 'Installed collection', version: '1.0.0', source: 'custom', managedIntegration: true, enabled: false });
  assert.equal(summary.managedIntegration, true);
  assert.equal(summary.enabled, false);
  const editor = section('function renderAgentPackageEditor(', 'function makeManagedPackageReadOnly(');
  assert.match(editor, /summary\?\.managedIntegration && !summary\.editableIntegration\) makeManagedPackageReadOnly/);
  assert.match(editor, /Its instructions and resources are managed by Codex/);
  assert.match(app, /data-import-package>Upload agent/);
  assert.doesNotMatch(app, /data-import-package>Import package/);
});

test('Clippy retains its managed source metadata while allowing operator edits', () => {
  const summary = editorHelpers().agentPackageSummary({ id: 'clippy-intel', managedIntegration: true, editableIntegration: true });
  assert.equal(summary.managedIntegration, true);
  assert.equal(summary.editableIntegration, true);
});
