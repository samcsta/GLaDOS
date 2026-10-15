const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAgentPackageStore, listPackageRuntimeEntries, normalizeManifest,
  readPackageFolder, MAX_PACKAGE_BYTES,
} = require('../lib/agent-packages');

function fixture(t, options = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-agent-packages-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return { runtimeDir, store: createAgentPackageStore({ runtimeDir, ...options }) };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1, id: 'custom-test', version: '1.0.0', name: 'Custom test specialist',
    description: 'Tests source changes and reports the evidence.',
    agents: [{
      id: 'reviewer', name: 'Test specialist', description: 'Review source and tests.',
      instructions: 'Read the selected source and report your evidence.\n',
      model: 'claude-sonnet-5', effort: 'high', connectors: ['blackboard'],
      tools: ['Read', 'Grep', 'mcp__blackboard'], deliverables: ['A source review'],
      skills: [{ id: 'review', name: 'Source review', description: 'Read source.', instructions: '# Review\nRead the selected source.\n' }],
    }],
    resources: [{ path: 'references/checklist.md', text: '# Checklist\nCheck assertions.\n' }],
    ...overrides,
  };
}

test('preview validates a portable package without creating runtime storage', t => {
  const { runtimeDir, store } = fixture(t, { builtInIds: ['glados'] });
  const preview = store.preview({ package: manifest() });
  assert.equal(preview.id, 'custom-test');
  assert.equal(preview.agents[0].runtimeId, 'pkg-custom-test--reviewer');
  assert.deepEqual(preview.requiredConnectors, ['blackboard']);
  assert.deepEqual(preview.tools, ['Read', 'Grep', 'mcp__blackboard']);
  assert.deepEqual(preview.resources, [{ path: 'references/checklist.md', bytes: 30 }]);
  assert.equal(preview.willStage, false);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'agent-packages')), false);
  assert.throws(() => store.preview(manifest({ id: 'glados' })), /reserved by a built-in/);
});

test('custom collection survives new store instances and exports all source resources', t => {
  const { runtimeDir, store } = fixture(t);
  const saved = store.create(manifest());
  assert.equal(saved.activeRevision, saved.revision);
  assert.equal(saved.activeVersion, '1.0.0');
  assert.equal(saved.agentCount, 1);
  assert.equal(saved.teamCount, 0);
  assert.equal(saved.source, 'custom');
  assert.equal(saved.versions[0].active, true);
  const reopened = createAgentPackageStore({ runtimeDir });
  assert.deepEqual(reopened.get(saved.id).manifest, saved.manifest);
  const exported = reopened.export(saved.id);
  assert.equal(exported.filename, 'custom-test-1.0.0.glados-agent.json');
  assert.deepEqual(JSON.parse(exported.text), saved.manifest);
  assert.equal(exported.manifest.agents[0].skills[0].instructions, '# Review\nRead the selected source.\n');
  assert.equal(exported.manifest.resources[0].text, '# Checklist\nCheck assertions.\n');
  assert.throws(() => store.create(manifest()), /already exists/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.indexFile).mode & 0o777, 0o600);
  }
});

test('imports preserve edited revisions, stage replacements, and reject stale activation', t => {
  const { store } = fixture(t);
  const first = store.import(JSON.stringify(manifest()));
  const originalFile = path.join(store.root, 'packages', first.id, 'versions', first.version, first.revision, 'package.json');
  const originalBytes = fs.readFileSync(originalFile);
  const edited = store.save(first.id, { ...first.manifest, name: 'My local revision' }, { expectedRevision: first.revision });
  assert.notEqual(edited.revision, first.revision);
  assert.equal(store.get(first.id).name, 'My local revision');
  assert.throws(() => store.save(first.id, first.manifest, { expectedRevision: first.revision }), error => error.status === 409);
  const imported = manifest({ version: '2.0.0', name: 'Upstream update' });
  const preview = store.preview(imported);
  assert.equal(preview.willStage, true);
  assert.equal(preview.existing.revision, edited.revision);
  const staged = store.import(imported);
  assert.equal(staged.name, 'My local revision');
  assert.equal(staged.revision, edited.revision);
  assert.equal(staged.staged.length, 1);
  assert.equal(staged.staged[0].version, '2.0.0');
  const inspected = store.get(first.id, { revision: preview.revision });
  assert.equal(inspected.manifest.name, 'Upstream update');
  assert.equal(inspected.selectedVersion, '2.0.0');
  assert.equal(inspected.selectedRevision, preview.revision);
  assert.equal(inspected.activeRevision, edited.revision);
  assert.equal(inspected.revision, edited.revision);
  assert.equal(store.get(first.id, { version: '2.0.0' }).selectedRevision, preview.revision);
  assert.throws(() => store.get(first.id, { revision: 'a'.repeat(64) }), error => error.status === 404);
  assert.throws(() => store.get(first.id, { revision: '../outside' }), /invalid package revision/);
  assert.throws(() => store.get(first.id, { version: '../outside' }), /invalid package version/);
  assert.equal(staged.versions.find(item => item.revision === first.revision).staged, false);
  assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
  assert.throws(() => store.activate(first.id, { version: '2.0.0', revision: preview.revision }), /expectedRevision/);
  assert.throws(() => store.activate(first.id, { version: '2.0.0', revision: preview.revision, expectedRevision: first.revision }), /changed/);
  const active = store.activate(first.id, { version: '2.0.0', revision: preview.revision, expectedRevision: edited.revision });
  assert.equal(active.name, 'Upstream update');
  assert.equal(active.staged.length, 0);
  assert.equal(store.export(first.id, { revision: edited.revision }).manifest.name, 'My local revision');
  assert.equal(store.export(first.id, { revision: first.revision }).manifest.name, 'Custom test specialist');
  assert.equal(store.export(first.id, { version: '1.0.0' }).manifest.name, 'My local revision');
  assert.equal(store.export(first.id, { version: '2.0.0' }).manifest.name, 'Upstream update');
  assert.throws(() => store.export(first.id, { version: '3.0.0' }), error => error.status === 404);
  assert.throws(() => store.export(first.id, { version: '../outside' }), /invalid package version/);
  assert.throws(() => store.export(first.id, { revision: '../outside' }), /invalid package revision/);
  assert.throws(() => store.export(first.id, { version: ['1.0.0'] }), /invalid package version/);
  assert.equal(store.preview(imported).alreadyImported, true);
});

test('same version imports are separate immutable revisions and never replace active edits', t => {
  const { store } = fixture(t);
  const first = store.create(manifest());
  const changed = manifest({ description: 'A different revision of the same version.' });
  const preview = store.preview(changed);
  const staged = store.import(changed);
  assert.equal(staged.version, first.version);
  assert.equal(staged.revision, first.revision);
  assert.notEqual(preview.revision, first.revision);
  assert.equal(staged.versions.length, 2);
  const again = store.import(changed);
  assert.equal(again.versions.length, 2);
  assert.equal(store.export(first.id, { revision: preview.revision }).manifest.description, changed.description);
  assert.throws(() => store.save(first.id, manifest({ id: 'new-id' }), { expectedRevision: first.revision }), /stable identity/);
});

test('runtime packages scope agents, project skills, and keep team coordinator capabilities explicit', t => {
  const { runtimeDir, store } = fixture(t);
  const raw = manifest();
  raw.agents.push({ id: 'tester', name: 'Tester', instructions: 'Test the assertions.', connectors: ['browser'], tools: ['mcp__browser'], skills: [], deliverables: ['Test results'] });
  raw.teams = [{ id: 'review-team', name: 'Review team', members: ['reviewer', 'tester'], coordinator: 'reviewer', instructions: 'Combine both reviews.' }];
  const saved = store.create(raw);
  const entries = listPackageRuntimeEntries({ env: { GLADOS_RUNTIME_DIR: runtimeDir } });
  const member = entries.find(item => item.localId === 'reviewer');
  const team = entries.find(item => item.teamCoordinator);
  assert.equal(entries.length, 3);
  assert.equal(member.teamInternal, true);
  assert.equal(member.teamCoordinatorId, team.id);
  assert.equal(team.id, 'pkg-custom-test--review-team');
  assert.deepEqual(team.teamMembers, ['pkg-custom-test--reviewer', 'pkg-custom-test--tester']);
  assert.deepEqual(team.connectors, ['blackboard']);
  assert.deepEqual(team.requiredConnectors, ['blackboard', 'browser']);
  assert.deepEqual(team.tools, ['Read', 'Grep', 'mcp__blackboard']);
  assert.equal(member.packageRevision, saved.revision);
  assert.equal(fs.readFileSync(path.join(member.workspace, 'AGENTS.md'), 'utf8'), raw.agents[0].instructions);
  assert.equal(fs.readFileSync(member.skills[0].path, 'utf8'), raw.agents[0].skills[0].instructions);
  assert.equal(fs.readFileSync(path.join(team.workspace, 'references/checklist.md'), 'utf8'), raw.resources[0].text);
  assert.match(fs.readFileSync(path.join(team.workspace, 'AGENTS.md'), 'utf8'), /pkg-custom-test--tester/);
  const other = store.create(manifest({ id: 'other-package' }));
  assert.notEqual(store.runtimeEntries().find(item => item.packageId === other.id).id, member.id);
  assert.notEqual(store.runtimeEntries().find(item => item.packageId === other.id).workspace, member.workspace);
});

test('enable and archive actions preserve packages and individual edits are recoverable', t => {
  const { store } = fixture(t);
  const saved = store.create(manifest());
  assert.throws(() => store.setEnabled(saved.id, false), /expectedRevision/);
  store.setEnabled(saved.id, false, { expectedRevision: saved.revision });
  assert.equal(store.runtimeEntries().length, 0);
  assert.equal(store.runtimeEntries({ includeDisabled: true })[0].enabled, false);
  store.setEnabled(saved.id, true, { expectedRevision: saved.revision });
  const changed = store.setEntryEnabled('pkg-custom-test--reviewer', false, { expectedRevision: saved.revision });
  assert.notEqual(changed.revision, saved.revision);
  assert.equal(changed.manifest.agents[0].enabled, false);
  assert.equal(store.export(saved.id, { revision: saved.revision }).manifest.agents[0].enabled, true);
  assert.deepEqual(store.remove(saved.id, { expectedRevision: changed.revision }), { id: saved.id, archived: true, recoverable: true });
  assert.deepEqual(store.list(), []);
  assert.equal(store.list({ includeArchived: true }).length, 1);
  assert.equal(store.export(saved.id).manifest.name, saved.name);
  store.activate(saved.id, { version: saved.version, revision: saved.revision, expectedRevision: changed.revision });
  store.setEnabled(saved.id, true, { expectedRevision: saved.revision });
  assert.equal(store.runtimeEntries().length, 1);
});

test('a disabled teammate is excluded from team delegation and required connectors', t => {
  const { store } = fixture(t);
  const raw = manifest();
  raw.agents.push({ id: 'browser-member', instructions: 'Inspect browser evidence.', connectors: ['browser'], tools: ['mcp__browser'], enabled: false });
  raw.teams = [{ id: 'review-team', name: 'Review team', coordinator: 'reviewer', members: ['reviewer', 'browser-member'] }];
  const first = store.create(raw);
  const team = store.runtimeEntries().find(entry => entry.teamCoordinator);
  assert.equal(team.enabled, true);
  assert.deepEqual(team.teamMembers, ['pkg-custom-test--reviewer']);
  assert.deepEqual(team.requiredConnectors, ['blackboard']);
  assert.doesNotMatch(fs.readFileSync(path.join(team.workspace, 'AGENTS.md'), 'utf8'), /pkg-custom-test--browser-member/);
  assert.equal(store.runtimeEntries({ includeDisabled: true }).find(entry => entry.localId === 'browser-member').enabled, false);
  store.setEntryEnabled('pkg-custom-test--browser-member', true, { expectedRevision: first.revision });
  const enabled = store.runtimeEntries().find(entry => entry.teamCoordinator);
  assert.deepEqual(enabled.teamMembers, ['pkg-custom-test--reviewer', 'pkg-custom-test--browser-member']);
  assert.deepEqual(enabled.requiredConnectors, ['blackboard', 'browser']);
  assert.match(fs.readFileSync(path.join(enabled.workspace, 'AGENTS.md'), 'utf8'), /pkg-custom-test--browser-member/);
});

test('deleting package entries revises team memberships and preserves exportable history', t => {
  const { store } = fixture(t); const raw = manifest();
  raw.agents.push({ id: 'tester', instructions: 'Test the evidence.', tools: ['Read'] });
  raw.teams = [
    { id: 'crew', members: ['reviewer', 'tester'], coordinator: 'reviewer' },
    { id: 'single-crew', members: ['reviewer'], coordinator: 'reviewer' },
  ];
  const first = store.create(raw);
  assert.throws(() => store.removeEntry(first.id, 'agent', 'reviewer'), error => error.status === 409);
  const deleted = store.removeEntry(first.id, 'agent', 'reviewer', { expectedRevision: first.revision });
  assert.equal(deleted.archived, false);
  assert.deepEqual(deleted.deleted, { kind: 'agent', id: 'reviewer' });
  assert.deepEqual(deleted.package.manifest.teams.map(team => ({ id: team.id, coordinator: team.coordinator, members: team.members })), [{ id: 'crew', coordinator: 'tester', members: ['tester'] }]);
  assert.equal(store.export(first.id, { revision: first.revision }).manifest.agents.length, 2);
  assert.throws(() => store.removeEntry(first.id, 'team', 'crew', { expectedRevision: first.revision }), error => error.status === 409);
  const removedTeam = store.removeEntry(first.id, 'team', 'crew', { expectedRevision: deleted.package.revision });
  assert.equal(removedTeam.package.manifest.teams.length, 0);
  assert.equal(removedTeam.package.manifest.agents.length, 1);
  assert.equal(store.runtimeEntries()[0].teamInternal, false);
  const archived = store.removeEntry(first.id, 'agent', 'tester', { expectedRevision: removedTeam.package.revision });
  assert.equal(archived.archived, true); assert.equal(archived.recoverable, true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.export(first.id).manifest.agents[0].id, 'tester');
  assert.equal(store.export(first.id, { revision: first.revision }).manifest.teams.length, 2);
});

test('public imports reject teams in JSON and folder wrappers while creator teams remain editable', t => {
  const { store } = fixture(t); const raw = manifest(); raw.teams = [{ id: 'crew', members: ['reviewer'] }];
  for (const input of [raw, JSON.stringify(raw), { package: raw }, { files: [{ path: 'glados-agent.json', text: JSON.stringify(raw) }] }]) {
    assert.throws(() => store.preview(input), /individual agents only/);
    assert.throws(() => store.import(input), /individual agents only/);
  }
  assert.equal(store.create(raw).manifest.teams.length, 1);
});

test('trusted source integrations start disabled and preserve operator state while staging updates', t => {
  const { store } = fixture(t); const raw = manifest(); raw.teams = [
    { id: 'crew', members: ['reviewer'], enabled: true }, { id: 'other-crew', members: ['reviewer'], enabled: true },
  ];
  const first = store.installIntegration(raw, { sourcePath: '/source/templates/integrated-teams/my-integration.glados-agent.json' });
  assert.equal(first.enabled, false); assert.equal(first.source, 'integrated'); assert.equal(first.managedIntegration, true);
  assert.equal(first.managedSource, 'my-integration.glados-agent.json');
  assert.equal(first.manifest.teams.every(team => team.enabled === false), true);
  assert.equal(store.runtimeEntries().length, 0);
  const enabled = store.setTeamEnabled(first.id, 'crew', true, { expectedRevision: first.revision });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.manifest.teams.find(team => team.id === 'crew').enabled, true);
  assert.equal(enabled.manifest.teams.find(team => team.id === 'other-crew').enabled, false);
  assert.equal(store.runtimeEntries().some(entry => entry.localId === 'other-crew'), false);
  const same = store.installIntegration(raw, { sourcePath: '/source/templates/integrated-teams/my-integration.glados-agent.json' });
  assert.equal(same.revision, enabled.revision); assert.equal(same.versions.length, enabled.versions.length);
  const edited = store.save(first.id, { ...enabled.manifest, name: 'Local integration settings' }, { expectedRevision: enabled.revision });
  const updated = store.installIntegration({ ...raw, version: '2.0.0', name: 'Source update' }, { sourcePath: '/source/templates/integrated-teams/my-integration.glados-agent.json' });
  assert.equal(updated.revision, edited.revision); assert.equal(updated.enabled, true); assert.equal(updated.name, edited.name);
  assert.equal(updated.staged.length, 1); assert.equal(updated.staged[0].version, '2.0.0');
  const staged = store.get(first.id, { revision: updated.staged[0].revision });
  assert.equal(staged.manifest.teams.find(team => team.id === 'crew').enabled, true);
  assert.equal(staged.manifest.teams.find(team => team.id === 'other-crew').enabled, false);
  const activated = store.activate(first.id, { version: '2.0.0', revision: staged.selectedRevision, expectedRevision: edited.revision });
  assert.equal(activated.enabled, true); assert.equal(activated.managedIntegration, true);
  assert.equal(store.export(first.id, { revision: edited.revision }).manifest.name, edited.name);
  const uploadedAgent = manifest();
  assert.throws(() => store.preview(uploadedAgent), /managed integration/);
  assert.throws(() => store.import(uploadedAgent), /managed integration/);
  store.remove(first.id, { expectedRevision: activated.revision });
  assert.equal(store.installIntegration(raw).archived, true);
});

test('trusted integration installation cannot reclassify an existing user package identity', t => {
  const { store } = fixture(t); const first = store.create(manifest());
  const bytes = fs.readFileSync(store.indexFile, 'utf8');
  assert.throws(() => store.installIntegration(manifest()), /user package already uses/);
  assert.equal(fs.readFileSync(store.indexFile, 'utf8'), bytes);
  assert.equal(store.get(first.id).managedIntegration, false);
});

test('public manifests cannot mark themselves as editable managed integrations', t => {
  const { store } = fixture(t);
  const fake = manifest({ id: 'clippy-intel', managedIntegration: true, editableIntegration: true,
    managedSource: 'clippy-intel.glados-agent.json', integrationCapabilities: { tools: ['Bash'] } });
  const uploaded = store.import(fake);
  assert.equal(uploaded.managedIntegration, false);
  assert.equal(uploaded.editableIntegration, false);
  assert.equal(uploaded.integrationCapabilities, undefined);
  assert.equal(uploaded.manifest.editableIntegration, undefined);
  assert.equal(store.runtimeEntries()[0].editableIntegration, false);
});

test('folder import previews text resources and rejects symlinks and conflicting files', t => {
  const { runtimeDir, store } = fixture(t);
  const raw = manifest();
  raw.resources = [];
  raw.agents[0].skills = ['review'];
  const files = [
    { path: 'my-package/glados-agent.json', content: JSON.stringify(raw) },
    { path: 'my-package/skills/review/SKILL.md', content: '# Review\nRead source.' },
    { path: 'my-package/references/check.md', content: 'Check the output.' },
  ];
  const preview = store.preview({ files });
  assert.deepEqual(preview.resources.map(item => item.path), ['references/check.md', 'skills/review/SKILL.md']);
  const imported = store.import({ files });
  assert.equal(imported.manifest.agents[0].skills[0].path, 'skills/review/SKILL.md');
  assert.throws(() => store.preview({ files: [...files, { path: 'outside.txt', content: 'outside' }] }), /under the manifest/);
  assert.throws(() => store.preview({ files: [...files, { path: 'my-package/link.txt', type: 'symlink', content: 'link' }] }), /symlink/);
  const folder = path.join(runtimeDir, 'import-folder');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'glados-agent.json'), JSON.stringify(manifest()));
  assert.equal(store.preview(readPackageFolder(folder)).id, 'custom-test');
  fs.symlinkSync(path.join(folder, 'glados-agent.json'), path.join(folder, 'unsafe-link.json'));
  assert.throws(() => readPackageFolder(folder), /symlink/);
  assert.throws(() => store.preview({ files: [{ path: 'glados-agent.json', text: JSON.stringify(manifest()) }, { path: 'references/checklist.md', text: 'Conflicting local file.' }] }), /conflicts/);
});

test('Markdown import retains instructions and starts with explicitly empty capabilities', t => {
  const { store } = fixture(t);
  const instructions = '# A custom specialist\n\nRead the project and produce a concise answer.\n';
  const preview = store.preview(instructions, { format: 'markdown', filename: 'specialist.md' });
  assert.match(preview.id, /^imported-a-custom-specialist-[a-f0-9]{8}$/);
  assert.equal(preview.name, 'A custom specialist');
  assert.equal(preview.manifest.agents[0].instructions, instructions);
  assert.deepEqual(preview.tools, []);
  assert.deepEqual(preview.connectors, []);
  assert.equal(store.preview(instructions, { format: 'markdown' }).id, preview.id);
  assert.equal(store.preview({ format: 'markdown', filename: 'specialist.md', text: instructions }).id, preview.id);
});

test('validation rejects prototype keys, traversal, reserved resources, malformed teams, and oversized payloads', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = JSON.stringify(manifest()).replace('"schemaVersion":1', `"schemaVersion":1,"${key}":{}`);
    const dir = path.join(os.tmpdir(), `never-written-glados-${Date.now()}-${key}`);
    const store = createAgentPackageStore({ runtimeDir: dir });
    assert.throws(() => store.preview(raw), /forbidden property/);
    assert.equal(fs.existsSync(dir), false);
  }
  for (const file of ['../outside.md', '/outside.md', 'C:/outside.md', 'folder\\outside.md', '.hidden/file.md', 'folder/./file.md', 'folder//file.md', 'AGENTS.md', 'agent.json', 'folder/file:stream', 'NUL.txt', 'file.']) {
    assert.throws(() => normalizeManifest(manifest({ resources: [{ path: file, text: 'unsafe' }] })), /relative file path|reserved/);
  }
  assert.throws(() => normalizeManifest(manifest({ resources: [{ path: 'a', text: 'a' }, { path: 'a/file', text: 'file' }] })), /files and directories/);
  assert.throws(() => normalizeManifest(manifest({ resources: [{ path: 'a.txt', text: 'a' }, { path: 'A.txt', text: 'A' }] })), /duplicate resource/);
  assert.throws(() => normalizeManifest(manifest({ version: '../1' })), /semantic versioning/);
  assert.throws(() => normalizeManifest(manifest({ id: 'Bad ID' })), /lowercase identifier/);
  assert.throws(() => normalizeManifest(manifest({ teams: [{ id: 'team', members: ['missing'] }] })), /refer to agents/);
  assert.throws(() => normalizeManifest(manifest({ teams: [{ id: 'reviewer', members: ['reviewer'] }] })), /collides/);
  assert.throws(() => normalizeManifest(manifest({ resources: [{ path: 'file.md', text: '\0' }] })), /NUL/);
  assert.throws(() => createAgentPackageStore({ runtimeDir: '/unused' }).preview('x'.repeat(MAX_PACKAGE_BYTES + 1)), /5 MiB/);
  const bad = manifest(); bad.agents[0].effort = 'unbounded';
  assert.throws(() => normalizeManifest(bad), /effort must/);
});

test('resource projection rejects symlinked destinations and detects manifest corruption', t => {
  const { runtimeDir, store } = fixture(t);
  const saved = store.create(manifest());
  const entries = store.runtimeEntries();
  const instructions = path.join(entries[0].workspace, 'AGENTS.md');
  fs.writeFileSync(instructions, 'Unrevisioned modified instructions.');
  assert.throws(() => store.runtimeEntries(), /immutable package revision/);
  fs.writeFileSync(instructions, saved.manifest.agents[0].instructions);
  const file = path.join(entries[0].workspace, 'references/checklist.md');
  fs.unlinkSync(file);
  const outside = path.join(runtimeDir, 'outside.md');
  fs.writeFileSync(outside, 'operator data');
  fs.symlinkSync(outside, file);
  assert.throws(() => store.runtimeEntries(), /symlink files/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'operator data');
  const revisionFile = path.join(store.root, 'packages', saved.id, 'versions', saved.version, saved.revision, 'package.json');
  const damaged = { ...saved.manifest, name: 'Tampered' };
  fs.writeFileSync(revisionFile, JSON.stringify(damaged));
  assert.throws(() => store.get(saved.id), /integrity check failed/);
});
