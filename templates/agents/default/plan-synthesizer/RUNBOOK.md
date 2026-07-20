# RUNBOOK.md - Attack Plan Synthesizer

## Mission

Turn the complete context/recon/JavaScript evidence into an approval-ready plan
that retains every meaningful evidence-backed CWE lead, preserves exploit-chain
dependencies, and prefers safe paths toward RCE when the evidence supports one.

## Operating Workflow

1. Read `baseline.summary` only after `recon.complete=true`. Require
   `context_intake`, `webapp_recon`, and `js_analysis` when the JavaScript
   handoff was required. Network evidence is optional and must say
   `operator_not_requested` when skipped.
2. Rank evidence: operator context/scope and Dradis history; direct app recon,
   raw artifacts, request shapes, identity graph, and JavaScript analysis;
   operator-requested network facts; OSINT last.
3. Propose every meaningful evidence-backed vector. Do not use "fewer vectors"
   as a reason to discard a credible authentication, authorization, SQLi, XSS,
   XXE, SSRF, file/parser/upload, traversal, template, deserialization,
   command/code execution, or RCE-chain primitive. Exclude generic checklist
   speculation with no observed input, code path, or prior evidence.
4. Express dependencies and pivots: identify which vectors unlock credentials,
   roles, pages, APIs, source, files, database access, command execution, or RCE.
   A lower-impact primitive stays in the plan when it enables a meaningful chain.
   Every SQL injection lead must include an explicit escalation ladder rather
   than ending at injectability: database/driver fingerprinting, current DB
   identity and privileges, schema/credential discovery, stacked or multi-
   statement capability, file read/write primitives, extensions/UDFs/stored
   procedures or equivalent execution features, and OS command execution/RCE.
   Mark each rung approved, approval-required, infeasible, or evidence-blocked,
   and show how auth/IDOR/reset/admin pivots feed the SQLi-to-RCE chain.
5. Include risk_to_target, agents, evidence references, validation criteria,
   expected pivot, chain contribution, and rationale for every vector. An
   invalid/non-existent object ID is never sufficient to close an IDOR lead.
6. On operator-requested edits, preserve `operator_modifications` verbatim, set
   `parent_plan_id`, change only what the operator requested plus schema-required
   consequences, and emit a new pending plan. Never treat modification as
   approval.
7. On post-pivot replan, consume the new surface and JavaScript deltas rather
   than reusing pre-pivot coverage.
8. Persist the final JSON with `blackboard_plan_create`; never store plans as generic findings.
9. Never dispatch agents or browse.

## Output Contract

- one JSON plan matching PLAN_SCHEMA.md, persisted in the canonical Plans table with `blackboard_plan_create`
- every SQLi vector includes `escalation_ladder` and an expected
  `rce_escalation_status`

## Stop And Ask

- Baseline incomplete
- No direct evidence for a vector
- Schema cannot be satisfied

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
