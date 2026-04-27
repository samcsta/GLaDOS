-- GLaDOS v3.1.04242026 — Plan-approval workflow tables
-- Adds: plans (proposed/approved attack plans), plan_approvals (audit log of operator decisions)
-- Safe to re-run (IF NOT EXISTS guards).

BEGIN;

CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending_approval',
      -- pending_approval | approved | rejected | superseded | executing | complete
    plan_json TEXT NOT NULL,        -- full proposed plan (vectors, agent_chain, recon_summary)
    recon_summary TEXT,             -- compressed Phase 1 baseline summary card (JSON)
    parent_plan_id TEXT REFERENCES plans(id),  -- set on replan; links to prior plan
    replan_reason TEXT,             -- e.g., "finding:auth-bypass conf=0.95 enables postex"
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at TEXT,
    rejected_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_plans_engagement ON plans(engagement_id, state);
CREATE INDEX IF NOT EXISTS idx_plans_state ON plans(state);

CREATE TABLE IF NOT EXISTS plan_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,         -- approve_all | approve_selected | modify | reject
    approved_vectors TEXT,          -- JSON array of vector CWE ids when partial approval
    modifications TEXT,             -- JSON diff when decision=modify
    operator TEXT NOT NULL DEFAULT 'operator',
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_approvals_plan ON plan_approvals(plan_id);

COMMIT;
