const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentTeamStore, resolveAgentTeam } = require('../lib/agent-teams');

function rows() {
  return [
    { id: 'glados', name: 'GLaDOS', enabled: true, subagent: false },
    { id: 'source-code', name: 'Source code', enabled: true },
    { id: 'api-expert', name: 'API expert', enabled: true },
    { id: 'disabled-built-in', enabled: false },
    { id: 'pkg-custom--specialist', name: 'Specialist', enabled: true, packageCapabilities: true, packageId: 'custom', packageRevision: 'custom-revision', source: 'custom' },
    { id: 'pkg-first--member', name: 'First member', enabled: true, teamInternal: true, packageCapabilities: true, packageId: 'first' },
    { id: 'pkg-first--crew', name: 'First crew', enabled: true, teamCoordinator: true, teamMembers: ['pkg-first--member'], packageCapabilities: true, packageId: 'first', packageRevision: 'first-revision', source: 'imported' },
    { id: 'pkg-second--member', name: 'Second member', enabled: true, teamInternal: true, packageCapabilities: true, packageId: 'second' },
    { id: 'pkg-second--crew', name: 'Second crew', enabled: true, teamCoordinator: true, teamMembers: ['pkg-second--member'], packageCapabilities: true, packageId: 'second', packageRevision: 'second-revision', source: 'custom' },
  ];
}
function fixture(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-agent-teams-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const env = { GLADOS_RUNTIME_DIR: runtimeDir }; return { runtimeDir, env, store: createAgentTeamStore({ env }) };
}

test('teams start with independent actual rosters and no unrelated custom specialists', t => {
  const { env, store } = fixture(t); const registryRows = rows();
  const main = resolveAgentTeam(registryRows, { env });
  assert.equal(main.id, 'glados'); assert.equal(main.coordinatorId, 'glados');
  assert.deepEqual(main.memberIds, ['source-code', 'api-expert']);
  const first = store.get('pkg-first--crew', registryRows);
  assert.deepEqual(first.rosterIds, ['pkg-first--crew', 'pkg-first--member']);
  const second = store.get('pkg-second--crew', registryRows);
  assert.deepEqual(second.memberIds, ['pkg-second--member']);
  assert.equal(first.source, 'imported'); assert.equal(first.available, true);
  assert.deepEqual(store.catalog(registryRows).teams.map(team => team.name), ['GLaDOS', 'First crew', 'Second crew']);
  assert.equal(fs.existsSync(store.root), false);
});

test('durable assignment explicitly adds standalone or reused internal specialists to selected team only', t => {
  const { env, store } = fixture(t); const registryRows = rows();
  const first = store.get('pkg-first--crew', registryRows);
  const assigned = store.save(first.id, ['source-code', 'pkg-custom--specialist', 'pkg-second--member'], { expectedRevision: first.revision, registryRows });
  assert.deepEqual(assigned.memberIds, ['pkg-first--member', 'source-code', 'pkg-custom--specialist', 'pkg-second--member']);
  assert.equal(assigned.memberIds.includes('pkg-second--crew'), false);
  assert.deepEqual(store.get('glados', registryRows).memberIds, ['source-code', 'api-expert']);
  assert.deepEqual(store.get('pkg-second--crew', registryRows).memberIds, ['pkg-second--member']);
  const main = store.get('glados', registryRows);
  store.save('glados', ['pkg-first--member'], { expectedRevision: main.revision, registryRows });
  assert.deepEqual(createAgentTeamStore({ env }).get('glados', registryRows).memberIds, ['source-code', 'api-expert', 'pkg-first--member']);
  assert.equal(store.catalog(registryRows).agents.find(agent => agent.id === 'pkg-first--member').assignable, true);
  assert.notEqual(assigned.revision, first.revision);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.indexFile).mode & 0o777, 0o600);
});

test('assignment edits enforce revisions and preserve prior overlay history', t => {
  const { store } = fixture(t); const registryRows = rows();
  const original = store.get('glados', registryRows);
  assert.throws(() => store.save('glados', [], { registryRows }), error => error.status === 409);
  const saved = store.save('glados', ['pkg-custom--specialist'], { expectedRevision: original.revision, registryRows });
  assert.throws(() => store.save('glados', [], { expectedRevision: original.revision, registryRows }), error => error.status === 409);
  const disabledRows = registryRows.map(row => row.id === 'pkg-custom--specialist' ? { ...row, enabled: false } : row);
  const disabled = store.get('glados', disabledRows);
  assert.notEqual(disabled.revision, saved.revision);
  assert.equal(disabled.memberIds.includes('pkg-custom--specialist'), false);
  assert.deepEqual(disabled.assignedAgentIds, ['pkg-custom--specialist']);
  const next = store.save('glados', [], { expectedRevision: disabled.revision, registryRows: disabledRows });
  assert.deepEqual(next.assignedAgentIds, []);
  const history = JSON.parse(fs.readFileSync(store.indexFile)).teams[0].history;
  assert.equal(history.length, 1); assert.deepEqual(history[0].assignedAgentIds, ['pkg-custom--specialist']);
});

test('assignments reject invalid identities, unknown agents, coordinators and duplicate IDs', t => {
  const { store } = fixture(t); const registryRows = rows(); const current = store.get('glados', registryRows);
  for (const assignedAgentIds of [['glados'], ['pkg-first--crew'], ['missing'], ['../escape'], ['source-code', 'source-code']]) {
    assert.throws(() => store.save('glados', assignedAgentIds, { expectedRevision: current.revision, registryRows }));
  }
  assert.throws(() => store.get('../escape', registryRows), /Invalid/);
  assert.throws(() => store.get('pkg-missing--crew', registryRows), error => error.status === 404);
  const disabled = registryRows.map(row => row.id === 'pkg-first--crew' ? { ...row, enabled: false } : row);
  assert.equal(store.get('pkg-first--crew', disabled).available, false);
  assert.equal(store.list(disabled).find(team => team.id === 'pkg-first--crew').available, false);
});

test('direct custom agent conversations have a singleton roster without assignment or dispatch', t => {
  const { env, store } = fixture(t); const registryRows = rows();
  const direct = resolveAgentTeam(registryRows, { env, teamId: 'agent:pkg-second--member' });
  assert.equal(direct.kind, 'agent'); assert.equal(direct.coordinatorId, 'pkg-second--member');
  assert.deepEqual(direct.rosterIds, ['pkg-second--member']); assert.deepEqual(direct.memberIds, []);
  assert.deepEqual(direct.assignedAgentIds, []); assert.equal(direct.available, true);
  assert.equal(fs.existsSync(store.root), false);
  assert.equal(store.catalog(registryRows).directAgents.some(agent => agent.id === direct.id), true);
  assert.equal(store.catalog(registryRows).teams.some(team => team.id === direct.id), false);
  assert.throws(() => store.save(direct.id, ['source-code'], { registryRows, expectedRevision: direct.revision }), /does not have team assignments/);
  assert.throws(() => resolveAgentTeam(registryRows, { env, teamId: 'agent:glados' }));
  assert.throws(() => resolveAgentTeam(registryRows, { env, teamId: 'agent:pkg-second--crew' }), /Custom agent not found/);
});

test('team collections reject symlink storage before changing operator files', t => {
  const { runtimeDir, store } = fixture(t); const registryRows = rows(); const current = store.get('glados', registryRows);
  const outside = path.join(runtimeDir, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, store.root);
  assert.throws(() => store.save('glados', [], { expectedRevision: current.revision, registryRows }), /symlinks/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
