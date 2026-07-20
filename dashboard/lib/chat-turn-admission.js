function activeTurnConflict(activeTurns, agentId) {
  const turn = activeTurns?.get?.(agentId);
  if (!turn) return null;
  return {
    ok: false,
    error: `${agentId} already has an active turn`,
    code: 'GLADOS_TURN_ALREADY_ACTIVE',
    agentId,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    ageMs: Math.max(0, Date.now() - Number(turn.startedAt || Date.now())),
  };
}

module.exports = { activeTurnConflict };
