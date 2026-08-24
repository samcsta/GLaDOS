# RUNBOOK.md - Independent Source Review Validation

## Required Inputs

- exact repository path and immutable revision (Git HEAD or deterministic snapshot hash)
- engagement ID and blackboard task ID
- deterministic file, route, suppression, HTTP-client, crypto, security-sensitive semantic candidate, and secret-scan inventories
- primary findings and specialist-track outputs
- canonical deduplicated candidates, worker receipts, and dedupe mappings
- prior-finding disposition table when historical context exists
- one writable validation output path outside the assessed repository

## Workflow

1. Confirm the repository still matches the supplied Git HEAD or snapshot hash. Stop on snapshot drift.
2. Build an independent high-level inventory before relying on primary conclusions.
3. Search specifically for omitted classes: authorization/BOLA/IDOR, missing mutation scope checks, mass assignment, OData/Microsoft Graph/LDAP filter construction, GraphQL introspection/depth/complexity/batching controls, authentication initialization, token replay, OAuth scope-value enforcement, wrong permission constants, ORM mutation ordering, committed credentials, raw error reflection, timeouts/retries, swallowed failures, production overlay drift, weak crypto, and security-linter suppressions.
4. Trace authorization-sensitive routes end to end: registration -> middleware -> handler -> service -> repository filter/ORM operation. Check empty filters and operation ordering.
5. Compare the deterministic route inventory to the authorization matrix and the file manifest to the coverage ledger. Missing rows are blockers, not implicit CLEAN results.
6. Challenge every discovery and specialist finding and reproduce every High/Critical finding directly from source. Every finding ID requires exactly one terminal challenge outcome. Verify reachability, minimum attacker access, additional environmental/deployment preconditions, CWE, and CVSS. A source-confirmed security-control failure with a plausible attacker profile and security impact is reportable even if current deployment or exploitation is unobserved. Authenticated users, authorized or compromised contributors, workforce/insider actors, and dependency publishers are valid attacker profiles when supported by the source boundary. Distinguish that weakness from deployment reachability and dynamic reproduction; do not treat an assumed JWT, network position, registry access, or external-service behavior as observed evidence. A score of 9.0+ requires a named reachable unauthenticated network path or downgrade review.
7. Challenge every tested-negative claim. Package-level or directory-level negative claims are invalid; require exact file and line ranges plus the applied rule and observed evidence.
8. Verify every prior finding has an evidence-backed disposition and every suppression is accepted with justification or mapped to a finding.
9. Independently disposition every `inventory/security-sensitive.jsonl` `inventory_key` and reject `reviewed-as-class` coverage for its file. A negative disposition must state the exact rule, observed evidence, line range, and result; signature verification is not replay prevention, GraphQL schema validation is not an abuse limit, and typed binding is not a persistence allowlist.
10. Reconcile every raw candidate against the dedupe mapping. Reject missing, multiply mapped, or silently discarded candidates and any merge that loses counterevidence or proof gaps.
11. Write `validation/candidate-closure.jsonl` directly under the supplied `artifact_root` with exactly one terminal disposition for every canonical candidate and every discovery/specialist finding. When a finding is not already linked from a REPORTABLE canonical-candidate closure, use its `finding_id` as `candidate_id`; it must also receive an attack-path row and may not disappear from canonical findings or observations. Every active REPORTABLE or OBSERVATION row needs one stable `issue_key`, and no two active rows may represent the same root cause and attack path. REPORTABLE requires `finding_ids` containing exactly one ID, `source_weakness_status: SOURCE_CONFIRMED`, `minimum_attacker_access`, a `preconditions` array, and `deployment_evidence_status: SOURCE_CONFIGURED|DEPLOYMENT_UNVERIFIED|RUNTIME_CONFIRMED`. OBSERVATION requires `observation_ids` containing exactly one ID, `source_weakness_status: NOT_ESTABLISHED|HARDENING_ONLY|OPERATIONAL_ONLY`, `missing_reportability_element: SECURITY_CONTROL_FAILURE|PLAUSIBLE_ATTACKER|SECURITY_IMPACT`, `observation_category`, and a concrete `reportability_rationale`. Preserve `validation_method`, `evidence`, `counterevidence`, and `proof_gaps`. Merge cross-worker and cross-track duplicates under one issue key; mark duplicate aliases SUPPRESSED with `duplicate_of_issue_key`. Write `validation/attack-paths.jsonl` directly under that same `artifact_root` with fields `candidate_id`, `disposition`, `rationale`, and `reachability`; REPORTABLE, OBSERVATION, IGNORE, and NOT_APPLICABLE must match the closure disposition. Candidate and source-finding keys must have exact set equality across discovery, closure, and attack-path analysis. Do not write a workspace `generated/` substitute and do not replace complete canonical files with empty blocker markers. Do not substitute `canonical_candidate_id`, `terminal_disposition`, `terminal_decision`, or `reachability_basis`.
12. Write `validation/semantic-coverage.json` directly under `artifact_root` using the coordinator's exact checks/candidate_dispositions/referrals schema. Resolve every cross-track referral to a finding, tested negative, or not applicable; `BLOCKED` and `REFERRED` are nonterminal.
13. Write `validation/challenge-matrix.json` directly under `artifact_root` with `CONFIRMED`, `CONFIRMED_WITH_CORRECTION`, `REJECTED`, `DOWNGRADED`, `NEW`, and `NOT_COVERED` outcomes. Put every NEW candidate in `validation/new-candidates.jsonl` using the canonical discovery-candidate schema, and put that exact `candidate_id` on its single NEW challenge outcome; never rename it or place a NEW-only ID directly into closure or attack paths without that provenance artifact.
14. Verify required model receipts came from SDK/runtime observations and satisfy run.json modelPolicy. A static roster label is not observation of the deployed model.
15. Verify every secret and PII candidate is redacted and terminally classified. Offline syntax does not prove a valid credential, and a field name or syntactically valid email does not prove confirmed PII. Require controller-owned verification before accepting `VALID_SECRET` or `CONFIRMED_PII`.
    - Require exact inventory-key equality between `inventory/sensitive-data-head.json` and `tracks/secrets-history/sensitive-data-dispositions.jsonl`.
    - Reject value fragments and unsupported fields including `value`, `raw`, `sample`, `prefix`, `suffix`, `request_body`, and `response_body`.
16. Update the exact blackboard task using both `task_id` and `engagement_id`.

## Boundaries

- The assessed repository is read-only. Write only to the designated investigation artifact path and blackboard.
- Every Read call includes `pages: "1"` unless a specific PDF page range is required. Bash is intentionally unavailable during source-review isolation; use Read, Glob, and Grep instead of searching for a shell tool.
- Do not contact production or display secret values.
- Do not treat the primary coverage ledger as evidence that an area is clean.
- Do not write or validate the client report package; report-validator owns that later workflow.
