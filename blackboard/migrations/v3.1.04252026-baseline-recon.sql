-- v3.1.04252026 (Blocker D) — Baseline recon state.
--
-- The webapp assessment playbook references a "baseline summary card" written
-- to the blackboard at the end of Phase 1 (DNS/TLS, OSINT, origin-ip,
-- structured webapp-recon). v3.1.04242026 documented the shape but never
-- created a table for it, so plan-synthesizer had no canonical source of
-- truth. This migration adds the missing schema + the recon.complete signal
-- the playbook says triggers Phase 2.
--
-- baseline_recon: one row per engagement; later phases overwrite as recon
-- iterates. plan-synthesizer reads `summary_json` to draft the proposed plan.
--
-- recon_steps: append-only audit of every Phase 1 step, so the dashboard /
-- Plans tab can show "OSINT 12s, origin-ip 4s, webapp-recon 38s, complete".

CREATE TABLE IF NOT EXISTS baseline_recon (
  engagement_id TEXT PRIMARY KEY,
  -- Free-form JSON blob: { dns:{...}, tls:{...}, osint:{...}, origin_ip:{...},
  -- net_recon:{...}, webapp_recon:{ framework, endpoints, forms, auth, stack,
  -- quick_wins }, dradistab_prior:{...} }.
  summary_json TEXT NOT NULL DEFAULT '{}',
  -- 1 once Phase 1 is finished and the plan-synthesizer can be dispatched.
  -- The plan gate itself does NOT enforce this (it gates Phase 3); this flag
  -- is for plan-synthesizer to know it has enough context.
  complete INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);

CREATE TABLE IF NOT EXISTS recon_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL,
  -- 'dradistab' | 'dns' | 'tls' | 'osint' | 'origin-ip' | 'net-recon' | 'webapp-recon'
  step TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | ok | failed | skipped
  -- JSON of step-specific output. Conventions per step are documented in
  -- workspaces/glados/webapp-assessment-playbook.md.
  output_json TEXT,
  duration_ms INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);

CREATE INDEX IF NOT EXISTS idx_recon_steps_engagement ON recon_steps(engagement_id, step);
CREATE INDEX IF NOT EXISTS idx_recon_steps_status ON recon_steps(status);

-- Findings: add fields the dynamic-replan trigger needs (Blocker E).
-- enables_vectors is a JSON array of CWE-cascade vector names a high-confidence
-- finding unlocks (e.g., RCE -> ["postex", "ad-expert"]). confidence_score is
-- the validator's 0..1 confidence used for the >= 0.9 replan threshold.
-- Both are nullable; pre-existing findings are unaffected.
ALTER TABLE findings ADD COLUMN enables_vectors TEXT;
ALTER TABLE findings ADD COLUMN confidence_score REAL;

-- Replan proposals (audit + dedup). Each row = "this finding triggered a
-- replan suggestion at this time, was the operator notified, did they act."
-- The dashboard watcher upserts on (engagement_id, finding_id) so we don't
-- spam the operator if the same finding is re-validated multiple times.
CREATE TABLE IF NOT EXISTS replan_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id TEXT NOT NULL,
  finding_id INTEGER NOT NULL,
  cwe_id TEXT,
  confidence_score REAL,
  enables_vectors TEXT,         -- JSON array, persisted as-found
  current_plan_id TEXT,         -- plan that was active when proposal fired
  state TEXT NOT NULL DEFAULT 'open',  -- open | accepted | dismissed | superseded
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  UNIQUE (engagement_id, finding_id),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id),
  FOREIGN KEY (finding_id) REFERENCES findings(id)
);
CREATE INDEX IF NOT EXISTS idx_replan_state ON replan_proposals(state);
