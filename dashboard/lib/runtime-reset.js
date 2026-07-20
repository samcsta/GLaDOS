const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const PLAN_STATE_TABLES = ['plan_approvals', 'replan_proposals', 'plans'];

const IDLE_AGENT_STATUS = `# AGENT-STATUS.md

## Current Engagement

None. GLaDOS is idle and waiting for a new operator-authorized engagement.

## Agent Roster

No agents are running.
`;

function resetMutableAgentStatus(workspaces) {
  let entries = [];
  try { entries = fs.readdirSync(workspaces, { withFileTypes: true }); }
  catch (error) { return { reset: 0, errors: [`read workspaces: ${error.message}`] }; }

  let reset = 0;
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusFile = path.join(workspaces, entry.name, 'AGENT-STATUS.md');
    if (!fs.existsSync(statusFile)) continue;
    try {
      fs.writeFileSync(statusFile, IDLE_AGENT_STATUS, { mode: 0o600 });
      fs.chmodSync(statusFile, 0o600);
      reset += 1;
    } catch (error) {
      errors.push(`${entry.name}/AGENT-STATUS.md: ${error.message}`);
    }
  }
  return { reset, errors };
}

function isLoosePlaywrightArtifact(name) {
  return /^(?:page-\d{4}-\d{2}-\d{2}T[^/]+\.(?:ya?ml|png|jpe?g)|console-\d{4}-\d{2}-\d{2}T[^/]+\.log)$/i
    .test(String(name || ''));
}

// Browser MCP places disposable captures at the investigations root or at an
// engagement root. Preserve nested evidence/ and reports/ files verbatim.
function cleanupLooseInvestigationArtifacts(investigationsRoot) {
  const candidates = [investigationsRoot];
  const errors = [];
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(investigationsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(investigationsRoot, entry.name));
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { removed, errors };
    return { removed, errors: [`read investigations: ${error.message}`] };
  }

  for (const dir of candidates) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { errors.push(`${dir}: ${error.message}`); continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !isLoosePlaywrightArtifact(entry.name)) continue;
      try { fs.rmSync(path.join(dir, entry.name), { force: true }); removed += 1; }
      catch (error) { errors.push(`${path.join(dir, entry.name)}: ${error.message}`); }
    }
  }
  return { removed, errors };
}

// Targeted plan-only cleanup for maintenance/tests. The dashboard's full
// runtime refresh intentionally uses server.wipeBlackboard() so engagement,
// finding, task, recon, transcript, and plan rows all start clean together.
function clearPlanState(dbPath) {
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const existing = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(row => row.name));
    const rowsDeleted = {};
    const cleared = PLAN_STATE_TABLES.filter(table => existing.has(table));
    const tx = db.transaction(() => {
      for (const table of cleared) {
        rowsDeleted[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        db.prepare(`DELETE FROM ${table}`).run();
      }
      if (existing.has('sqlite_sequence')) {
        db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('plan_approvals', 'replan_proposals')`).run();
      }
    });
    tx();
    return { ok: true, tablesCleared: cleared, rowsDeleted };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    try { db?.close(); } catch {}
  }
}

module.exports = {
  IDLE_AGENT_STATUS,
  PLAN_STATE_TABLES,
  clearPlanState,
  cleanupLooseInvestigationArtifacts,
  isLoosePlaywrightArtifact,
  resetMutableAgentStatus,
};
