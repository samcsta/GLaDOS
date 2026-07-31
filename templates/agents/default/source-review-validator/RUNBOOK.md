# RUNBOOK.md - Independent Source Review Validation

## Required Inputs

- exact repository path and immutable revision (Git HEAD or deterministic snapshot hash)
- engagement ID and blackboard task ID
- deterministic file, route, suppression, HTTP-client, crypto, and secret-scan inventories
- primary findings and specialist-track outputs
- prior-finding disposition table when historical context exists
- one writable validation output path outside the assessed repository

## Workflow

1. Confirm the repository still matches the supplied Git HEAD or snapshot hash. Stop on snapshot drift.
2. Build an independent high-level inventory before relying on primary conclusions.
3. Search specifically for omitted classes: authorization/BOLA/IDOR, missing mutation scope checks, mass assignment, query construction, authentication initialization, token replay, committed credentials, raw error reflection, timeouts/retries, swallowed failures, production overlay drift, weak crypto, and security-linter suppressions.
4. Trace authorization-sensitive routes end to end: registration -> middleware -> handler -> service -> repository filter/ORM operation. Check empty filters and operation ordering.
5. Compare the deterministic route inventory to the authorization matrix and the file manifest to the coverage ledger. Missing rows are blockers, not implicit CLEAN results.
6. Reproduce every High/Critical finding directly from source. Verify reachability, preconditions, CWE, and CVSS. A score of 9.0+ requires a named reachable unauthenticated network path or downgrade review.
7. Challenge every tested-negative claim. Package-level or directory-level negative claims are invalid; require exact file and line ranges plus the applied rule and observed evidence.
8. Verify every prior finding has an evidence-backed disposition and every suppression is accepted with justification or mapped to a finding.
9. Write `validation/challenge-matrix.json` with `CONFIRMED`, `CONFIRMED_WITH_CORRECTION`, `REJECTED`, `DOWNGRADED`, `NEW`, and `NOT_COVERED` outcomes.
10. Update the exact blackboard task using both `task_id` and `engagement_id`.

## Boundaries

- The assessed repository is read-only. Write only to the designated investigation artifact path and blackboard.
- Do not contact production or display secret values.
- Do not treat the primary coverage ledger as evidence that an area is clean.
- Do not write or validate the client report package; report-validator owns that later workflow.
