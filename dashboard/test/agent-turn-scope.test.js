const test = require('node:test');
const assert = require('node:assert/strict');
const { queryAgentScope, owningChatTurn } = require('../lib/agent-turn-scope');

test('query transcript scope includes an authorized team member without granting another team access', () => {
  const registry = [{ id: 'crew-a', teamCoordinator: true }, { id: 'crew-b', teamCoordinator: true }, { id: 'member-a' }, { id: 'member-b' }];
  const dispatchable = id => ({ glados: ['crew-a', 'crew-b'], 'crew-a': ['member-a'], 'crew-b': ['member-b'] })[id] || [];
  const root = queryAgentScope('glados', { registry, dispatchable });
  assert.ok(root.agents.has('member-a'));
  assert.equal(root.parents.get('member-a'), 'crew-a');
  assert.equal(root.agents.has('unregistered'), false);
  const team = queryAgentScope('crew-a', { registry, dispatchable });
  assert.ok(team.agents.has('member-a'));
  assert.equal(team.agents.has('crew-b'), false);
  assert.equal(team.agents.has('member-b'), false);
});

test('halting a nested team member resolves its owning query without crossing sessions or newer turns', () => {
  const runtimeKey = (session, agent) => `${session}\0${agent}`;
  const query = { turnId: 'query-1', message: 'Run this team' };
  const chatTurns = new Map([[runtimeKey('session-a', 'glados'), query], [runtimeKey('session-b', 'glados'), { turnId: 'query-2' }]]);
  const subagentTurns = new Map([
    ['crew', { investigationSessionId: 'session-a', agentId: 'crew', parentAgentId: 'glados', parentTurnId: 'query-1' }],
    ['member', { investigationSessionId: 'session-a', agentId: 'member', parentAgentId: 'crew', parentTurnId: 'query-1' }],
  ]);
  const context = { chatTurns, subagentTurns, runtimeKey };
  assert.deepEqual(owningChatTurn('session-a', 'member', context), { agentId: 'glados', turn: query });
  assert.equal(owningChatTurn('session-b', 'member', context), null);
  chatTurns.set(runtimeKey('session-a', 'glados'), { turnId: 'newer-query' });
  assert.equal(owningChatTurn('session-a', 'member', context), null);
  subagentTurns.get('crew').parentAgentId = 'member';
  assert.equal(owningChatTurn('session-a', 'member', context), null);
});
