const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configPath = require.resolve('../lib/config');
const detailsPath = require.resolve('../lib/agent-details');

function loadFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-model-batch-'));
  const runtime = path.join(root, 'runtime');
  const workspaces = path.join(runtime, 'workspaces', 'agents');
  const overrides = path.join(runtime, 'model-overrides.json');
  fs.mkdirSync(workspaces, { recursive: true });
  fs.writeFileSync(overrides, `${JSON.stringify({ unrelated: 'keep-me' }, null, 2)}\n`);

  const originalConfig = require.cache[configPath];
  const originalDetails = require.cache[detailsPath];
  delete require.cache[detailsPath];
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      MODEL_OVERRIDES_JSON: overrides,
      GLADOS_AGENT_WORKSPACES: workspaces,
    },
  };
  const details = require('../lib/agent-details');
  return {
    details,
    overrides,
    runtime,
    workspaces,
    cleanup() {
      delete require.cache[detailsPath];
      if (originalConfig) require.cache[configPath] = originalConfig;
      else delete require.cache[configPath];
      if (originalDetails) require.cache[detailsPath] = originalDetails;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('batch model updates persist valid assignments together and report invalid entries', () => {
  const fixture = loadFixture();
  try {
    const settings = fixture.details.listSettingsAgents();
    const candidates = settings.filter(agent => agent.registered).slice(0, 2);
    assert.equal(candidates.length, 2);
    const result = fixture.details.updateAgentModels([
      { agentId: candidates[0].id, expectedModel: candidates[0].model, model: 'batch-model-one' },
      { agentId: candidates[1].id, expectedModel: candidates[1].model, model: 'batch-model-two' },
      { agentId: 'not-an-agent', expectedModel: 'old', model: 'batch-model-one' },
    ], ['batch-model-one', 'batch-model-two']);

    assert.equal(result.partial, true);
    assert.equal(result.changed, 2);
    assert.equal(result.results.filter(entry => entry.ok).length, 2);
    assert.equal(result.results.find(entry => entry.agentId === 'not-an-agent').code, 'agent_not_found');
    const stored = JSON.parse(fs.readFileSync(fixture.overrides, 'utf8'));
    assert.equal(stored.unrelated, 'keep-me');
    assert.equal(stored[candidates[0].id], 'batch-model-one');
    assert.equal(stored[candidates[1].id], 'batch-model-two');
  } finally {
    fixture.cleanup();
  }
});

test('package models and enable state are managed without mutating immutable package files', () => {
  const fixture = loadFixture();
  const priorRuntime = process.env.GLADOS_RUNTIME_DIR;
  const priorWorkspaces = process.env.GLADOS_AGENT_WORKSPACES;
  process.env.GLADOS_RUNTIME_DIR = fixture.runtime;
  process.env.GLADOS_AGENT_WORKSPACES = fixture.workspaces;
  try {
    const { createAgentPackageStore } = require('../lib/agent-packages');
    const store = createAgentPackageStore({ runtimeDir: fixture.runtime });
    store.create({ schemaVersion: 1, id: 'test-package', name: 'Test package', version: '1.0.0', agents: [{ id: 'specialist', name: 'Test specialist', instructions: 'Return a structured result.', model: 'original-model', tools: [], connectors: [] }] });
    const id = 'pkg-test-package--specialist';
    const original = store.runtimeEntries()[0];
    const prompt = fs.readFileSync(path.join(original.workspace, 'AGENTS.md'), 'utf8');
    const metadata = fs.readFileSync(path.join(original.workspace, 'agent.json'), 'utf8');
    assert.equal(fixture.details.listSettingsAgents().find(row => row.id === id).source, 'custom');
    const change = fixture.details.updateAgentModels([{ agentId: id, expectedModel: 'original-model', model: 'batch-model-one' }], ['batch-model-one']);
    assert.equal(change.changed, 1);
    assert.equal(fixture.details.agentDetails(id).model, 'batch-model-one');
    assert.equal(fs.readFileSync(path.join(original.workspace, 'AGENTS.md'), 'utf8'), prompt);
    assert.equal(fs.readFileSync(path.join(original.workspace, 'agent.json'), 'utf8'), metadata);
    const edited = store.export('test-package').manifest;
    edited.agents[0].model = 'updated-manifest-model';
    store.save('test-package', edited, { expectedRevision: original.packageRevision });
    assert.equal(fixture.details.agentDetails(id).model, 'updated-manifest-model', 'a previous runtime override cannot defeat a new package revision model');
    fixture.details.updateAgentEnabled(id, false);
    assert.equal(fixture.details.listSettingsAgents().find(row => row.id === id).enabled, false);
    assert.equal(fs.readFileSync(path.join(original.workspace, 'AGENTS.md'), 'utf8'), prompt);
    fixture.details.updateAgentEnabled(id, true);
    assert.equal(fixture.details.listSettingsAgents().find(row => row.id === id).enabled, true);
  } finally {
    if (priorRuntime === undefined) delete process.env.GLADOS_RUNTIME_DIR; else process.env.GLADOS_RUNTIME_DIR = priorRuntime;
    if (priorWorkspaces === undefined) delete process.env.GLADOS_AGENT_WORKSPACES; else process.env.GLADOS_AGENT_WORKSPACES = priorWorkspaces;
    fixture.cleanup();
  }
});

test('batch model updates reject stale expected assignments without overwriting them', () => {
  const fixture = loadFixture();
  try {
    const agent = fixture.details.listSettingsAgents().find(entry => entry.registered);
    const result = fixture.details.updateAgentModels([
      { agentId: agent.id, expectedModel: 'stale-model', model: 'batch-model-one' },
    ], ['batch-model-one']);
    assert.equal(result.ok, false);
    assert.equal(result.changed, 0);
    assert.equal(result.results[0].code, 'model_conflict');
    const stored = JSON.parse(fs.readFileSync(fixture.overrides, 'utf8'));
    assert.deepEqual(stored, { unrelated: 'keep-me' });
  } finally {
    fixture.cleanup();
  }
});
