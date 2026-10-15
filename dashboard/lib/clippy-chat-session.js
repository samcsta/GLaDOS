const { CLIPPY_TEAM_ID } = require('./clippy-agent');

// This background conversation belongs to Tools > Clippy. It can accept chat
// without becoming the globally active assessment. Explicitly archiving it
// closes that workspace; opening Clippy afterwards starts another conversation.
function isClippyWorkspaceSession(session) {
  return session?.teamId === CLIPPY_TEAM_ID
    && session.metadata?.surface === 'clippy'
    && session.metadata?.workspaceClosed !== true;
}

function ensureClippyChatSession(sessions) {
  const existing = sessions.list().find(isClippyWorkspaceSession);
  if (existing) return existing;
  return sessions.create({
    name: 'Clippy intelligence', teamId: CLIPPY_TEAM_ID,
    metadata: { surface: 'clippy' }, activate: false,
  });
}

module.exports = { isClippyWorkspaceSession, ensureClippyChatSession };
