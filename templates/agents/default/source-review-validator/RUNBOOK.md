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
6. Reproduce every High/Critical finding directly from source. Verify reachability, preconditions, CWE, and CVSS. A score of 9.0+ requires a named reachable unauthenticated network path or downgrade review.
7. Challenge every tested-negative claim. Package-level or directory-level negative claims are invalid; require exact file and line ranges plus the applied rule and observed evidence.
8. Verify every prior finding has an evidence-backed disposition and every suppression is accepted with justification or mapped to a finding.
9. Independently disposition every `inventory/security-sensitive.jsonl` `inventory_key` and reject `reviewed-as-class` coverage for its file. A negative disposition must state the exact rule, observed evidence, line range, and result; signature verification is not replay prevention, GraphQL schema validation is not an abuse limit, and typed binding is not a persistence allowlist.
10. Reconcile every raw candidate against the dedupe mapping. Reject missing, multiply mapped, or silently discarded candidates and any merge that loses counterevidence or proof gaps.
11. Write `validation/candidate-closure.jsonl` with exactly one terminal disposition for every canonical candidate using fields `candidate_id`, `disposition`, `validation_method`, `evidence`, `counterevidence`, and `proof_gaps`. Allowed dispositions are REPORTABLE, OBSERVATION, SUPPRESSED, NOT_APPLICABLE, and DEFERRED. REPORTABLE requires `finding_ids`; OBSERVATION requires `observation_ids`, `observation_category`, and a concrete `reportability_rationale` naming the unproven attacker capability, deployment reachability, inherited control, or security impact. Merge duplicates that do not establish distinct attack paths. Write `validation/attack-paths.jsonl` with fields `candidate_id`, `disposition`, `rationale`, and `reachability`; allowed dispositions are REPORTABLE, OBSERVATION, IGNORE, NOT_APPLICABLE, and DEFERRED. Candidate keys must have exact set equality across discovery, closure, and attack-path analysis. Do not substitute `canonical_candidate_id`, `terminal_disposition`, `terminal_decision`, or `reachability_basis`.
12. Write `validation/semantic-coverage.json` using the coordinator's exact checks/candidate_dispositions/referrals schema. Resolve every cross-track referral to a finding, tested negative, or not applicable; `BLOCKED` and `REFERRED` are nonterminal.
13. Write `validation/challenge-matrix.json` with `CONFIRMED`, `CONFIRMED_WITH_CORRECTION`, `REJECTED`, `DOWNGRADED`, `NEW`, and `NOT_COVERED` outcomes. Put every NEW candidate in `validation/new-candidates.jsonl` using the canonical discovery-candidate schema; never place a NEW-only ID directly into closure or attack paths without that provenance artifact.
14. Verify required model receipts came from SDK/runtime observations and satisfy run.json modelPolicy. A static roster label is not observation of the deployed model.
15. Verify every secret and PII candidate is redacted and terminally classified. Offline syntax does not prove a valid credential, and a field name or syntactically valid email does not prove confirmed PII. Require controller-owned verification before accepting `VALID_SECRET` or `CONFIRMED_PII`.
    - Require exact inventory-key equality between `inventory/sensitive-data-head.json` and `tracks/secrets-history/sensitive-data-dispositions.jsonl`.
    - Reject value fragments and unsupported fields including `value`, `raw`, `sample`, `prefix`, `suffix`, `request_body`, and `response_body`.
16. Update the exact blackboard task using both `task_id` and `engagement_id`.

## Boundaries

- The assessed repository is read-only. Write only to the designated investigation artifact path and blackboard.
- Do not contact production or display secret values.
- Do not treat the primary coverage ledger as evidence that an area is clean.
- Do not write or validate the client report package; report-validator owns that later workflow.
