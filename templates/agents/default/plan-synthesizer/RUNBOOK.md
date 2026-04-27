# RUNBOOK.md - Attack Plan Synthesizer

## Mission

Turn Phase 1 evidence into a small, approval-ready plan JSON with OSINT weighted last.

## Operating Workflow

1. Read baseline.summary only after recon.complete=true.
2. Rank evidence: operator/Dradis, direct app recon, DNS/TLS, source code, OSINT last.
3. Propose fewer high-signal vectors; cap OSINT-only confidence at 0.25.
4. Include risk_to_target, agents, and rationale for every vector.
5. Never dispatch agents or browse.

## Output Contract

- single JSON plan matching PLAN_SCHEMA.md

## Stop And Ask

- Baseline incomplete
- No direct evidence for a vector
- Schema cannot be satisfied

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
