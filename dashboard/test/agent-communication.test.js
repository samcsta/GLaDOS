const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentPackageStore } = require('../lib/agent-packages');
const { loadRegistry, buildAgentSdkOptions, buildAgentDefinitions, buildAgentDraftSdkOptions, mapSdkMessageToEvents, streamAgentTurn } = require('../lib/harness/agent-sdk');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-communication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, GLADOS_RUNTIME_DIR: root, GLADOS_AGENT_WORKSPACES: path.join(root, 'agents'), GLADOS_CLIPPY_MCP: '0', GLADOS_BROWSER_MCP: '0', GLADOS_SECURITY_REVIEW: '0', GLADOS_FULL_ACCESS: '0', ANTHROPIC_AUTH_TOKEN: 'test-token' } };
}

function assertCommunication(prompt) {
  assert.match(prompt, /Progress communication \(authoritative for every agent and team\)/);
  assert.match(prompt, /before meaningful sustained work/);
  assert.match(prompt, /45–60 seconds/);
  assert.match(prompt, /do not expose private chain-of-thought/);
  assert.match(prompt, /Do not do extra work, make extra calls, delay completion/);
}

test('every built-in direct agent and delegated definition gets the same useful progress contract', t => {
  const { env } = fixture(t);
  for (const row of loadRegistry({ env })) {
    const options = buildAgentSdkOptions(row.id, { env });
    assertCommunication(options.systemPrompt);
    assert.equal(options.includePartialMessages, true, row.id);
    assert.equal(options.forwardSubagentText, true, row.id);
  }
  for (const definition of Object.values(buildAgentDefinitions(undefined, { env }))) assertCommunication(definition.prompt);
  const review = buildAgentSdkOptions('glados', { env: { ...env, GLADOS_SECURITY_REVIEW: '1' }, subagentAllowlist: ['source-code', 'source-review-validator'] });
  assertCommunication(review.systemPrompt);
  for (const definition of Object.values(review.agents)) assertCommunication(definition.prompt);
});

test('operator-editable packages, standalone sessions, teams, and draft tests retain progress behavior', t => {
  const { root, env } = fixture(t);
  const store = createAgentPackageStore({ runtimeDir: root });
  const agent = id => ({ id, name: id, instructions: 'Keep my customized response format.', model: 'gpt-6-sol', tools: [], connectors: [], deliverables: ['A useful answer'] });
  store.create({ schemaVersion: 1, id: 'analysts', name: 'Analysts', version: '1.0.0', agents: [agent('lead'), agent('worker')], teams: [{ id: 'crew', name: 'Crew', members: ['lead', 'worker'], coordinator: 'lead' }], resources: [] });
  for (const id of ['pkg-analysts--lead', 'pkg-analysts--crew']) {
    const options = buildAgentSdkOptions(id, { env: { ...env, GLADOS_TEAM_ID: id.endsWith('--crew') ? id : `agent:${id}` } });
    assertCommunication(options.systemPrompt);
    assert.match(options.systemPrompt, /Keep my customized response format/);
    for (const definition of Object.values(options.agents || {})) assertCommunication(definition.prompt);
  }
  assertCommunication(buildAgentDraftSdkOptions(agent('draft'), { env }).systemPrompt);
});

test('interleaved parent and worker text streams keep separate block kinds and run identities', () => {
  const context = {};
  const map = message => mapSdkMessageToEvents('glados', { session_id: 'shared-session', ...message }, context);
  map({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'child-call', name: 'Agent', input: { subagent_type: 'webapp-recon' } }] } });
  const [rootStart] = map({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'I found the relevant evidence.' } } });
  const [childStart] = map({ type: 'stream_event', parent_tool_use_id: 'child-call', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
  const [rootEnd] = map({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  const [childEnd] = map({ type: 'stream_event', parent_tool_use_id: 'child-call', event: { type: 'content_block_stop', index: 0 } });
  assert.equal(rootStart.delta, 'I found the relevant evidence.');
  assert.equal(rootEnd.evtType, 'text_end');
  assert.equal(childEnd.evtType, 'thinking_end');
  assert.equal(childStart.agentId, 'webapp-recon');
  assert.notEqual(rootStart.runId, childStart.runId);
  assert.equal(rootStart.runId, rootEnd.runId);
  assert.equal(childStart.runId, childEnd.runId);
  assert.equal(context.streamBlockKindByIndex.size, 0);
});

test('nested worker progress and completion keep the actual coordinator when task frames omit tool ids', () => {
  const context = {};
  const map = message => mapSdkMessageToEvents('glados', { session_id: 'nested-session', ...message }, context);
  const dispatch = (id, target, parent) => map({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: target } }] } });
  dispatch('lead-call', 'pkg-analysts--crew');
  dispatch('worker-call', 'pkg-analysts--worker', 'lead-call');
  const [progress] = map({ type: 'stream_event', parent_tool_use_id: 'worker-call', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The first source rules out one candidate.' } } });
  assert.equal(progress.agentId, 'pkg-analysts--worker');
  assert.equal(progress.parentAgentId, 'pkg-analysts--crew');
  map({ type: 'system', subtype: 'task_started', task_id: 'worker-task', tool_use_id: 'worker-call' });
  const [complete] = map({ type: 'system', subtype: 'task_notification', task_id: 'worker-task', status: 'completed', summary: 'Evidence checked.' });
  assert.equal(complete.agentId, 'pkg-analysts--worker');
  assert.equal(complete.parentAgentId, 'pkg-analysts--crew');
  assert.equal(complete.toolCallId, 'worker-call');
  assert.equal(complete.live, false);
});

test('assistant progress reaches the user callback before tools finish and the terminal result remains intact', async () => {
  const delivered = [];
  let releaseTool;
  const toolComplete = new Promise(resolve => { releaseTool = resolve; });
  const messages = async function* () {
    yield { type: 'stream_event', session_id: 'live-progress', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
    yield { type: 'stream_event', session_id: 'live-progress', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will inspect the evidence and check report coverage.' } } };
    yield { type: 'stream_event', session_id: 'live-progress', event: { type: 'content_block_stop', index: 0 } };
    yield { type: 'assistant', session_id: 'live-progress', uuid: 'progress-complete', message: { content: [{ type: 'text', text: 'I will inspect the evidence and check report coverage.' }] } };
    await toolComplete;
    yield { type: 'assistant', session_id: 'live-progress', uuid: 'answer-complete', message: { content: [{ type: 'text', text: 'The source supports one candidate; report coverage remains unverified.' }] } };
    yield { type: 'result', session_id: 'live-progress', subtype: 'success', result: 'done' };
  };
  const pending = streamAgentTurn({ agentId: 'glados', prompt: 'Review the evidence.', store: false, queryImpl: () => messages(), onEvent: event => delivered.push(event), options: { sdkOptions: { includePartialMessages: true, forwardSubagentText: true }, haltPollMs: 0 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.some(event => event.kind === 'text-stream' && event.evtType === 'text_delta'), true);
  assert.equal(delivered.some(event => event.kind === 'assistant-text'), true);
  assert.equal(delivered.some(event => event.kind === 'result'), false);
  releaseTool();
  await pending;
  assert.deepEqual(delivered.filter(event => event.kind === 'assistant-text').map(event => event.id), ['progress-complete', 'answer-complete']);
  assert.equal(delivered.at(-1).kind, 'result');
});
