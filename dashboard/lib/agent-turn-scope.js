function queryAgentScope(rootAgentId, { dispatchable, registry }) {
  const agents = new Set([rootAgentId]);
  const parents = new Map();
  for (const id of dispatchable(rootAgentId)) {
    agents.add(id);
    parents.set(id, rootAgentId);
  }
  const byId = new Map(registry.map(row => [row.id, row]));
  for (const id of [...agents]) {
    if (!byId.get(id)?.teamCoordinator) continue;
    for (const member of dispatchable(id)) {
      agents.add(member);
      parents.set(member, id);
    }
  }
  return { agents, parents };
}

function owningChatTurn(sessionId, agentId, { chatTurns, subagentTurns, runtimeKey }) {
  const seen = new Set();
  let current = agentId;
  let expectedTurnId = null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const direct = chatTurns.get(runtimeKey(sessionId, current));
    if (direct && (!expectedTurnId || direct.turnId === expectedTurnId)) return { agentId: current, turn: direct };
    const child = [...subagentTurns.values()].find(row => row.investigationSessionId === sessionId && row.agentId === current
      && (!expectedTurnId || row.parentTurnId === expectedTurnId));
    if (!child) return null;
    expectedTurnId = child.parentTurnId || expectedTurnId;
    current = child.parentAgentId;
  }
  return null;
}

module.exports = { queryAgentScope, owningChatTurn };
