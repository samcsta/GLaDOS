# RUNBOOK.md - Source Code Analysis Specialist

## Mission

Perform one explicitly assigned stage or specialist track of the staged source security review. Trace untrusted input, authorization state, deployment configuration, and operational failures to security-relevant sinks with code-backed evidence.

Reject a compound assignment that asks this one Agent SDK turn to coordinate the complete workflow, impersonate multiple discovery workers, perform more than one specialist track, or perform primary discovery and independent validation together. Return the exact dispatch-boundary blocker without fabricating worker receipts; GLaDOS must redispatch one bounded role per turn.

## Snapshot And Write Boundary

- Confirm the supplied repository path and immutable revision before analysis. The revision may be a Git HEAD or a deterministic `snapshot:<sha256>` for an extracted source copy. Stop if it changes.
- The assessed repository is read-only. Do not edit, generate, format, or install dependencies into it.
- Write only to the designated investigation `artifact_root` and blackboard.
- Every blackboard task update must include both the exact `task_id` and `engagement_id`.

## Common Evidence Contract

- Every finding requires file:line, reachable entry point, source-to-sink or authorization trace, exploitability assumptions, confidence, CWE, and CVSS preconditions.
- Every tested-negative claim requires exact file and line range, the rule tested, observed evidence, and result. Never mark a package or directory CLEAN.
- Do not print secret values. Record location/type and workflow-provided non-reversible fingerprints only.
- Distinguish public identifiers from credentials and bearer secrets.
- CVSS 7.0+ requires explicit metric preconditions. CVSS 9.0+ requires a named reachable unauthenticated network path or a downgrade-review blocker.
- Treat `inventory/security-sensitive.jsonl` as an exact work queue. Every supplied `inventory_key` requires a file-specific terminal disposition with the same `check_id` and `rule`, exact line evidence, and a finding ID or tested-negative/not-applicable result. A generic package or class review cannot disposition these rows.
- Typed request structs, framework validation, signed JWTs, schema validation, and fluent ORM APIs are starting points for analysis, not automatic clean results. Compare bound fields to persisted associations, filter construction to escaping, token IDs to replay state, declared scopes to claim enforcement, permission constants to operation intent, and ORM predicate order to the terminal mutation.
- If another specialist owns a concern you identify, record a referral for `validation/semantic-coverage.json`; do not close your own row as CLEAN or let the concern disappear from your output.

## Blind Discovery Assignment

When `security_review_role: blind-discovery`:

1. Use the deterministic inventory but do not read prior findings, CWEs, paths, or conclusions.
2. Build route/controller/service/repository and trust-boundary maps before findings.
3. Cover authz, injection, file handling, SSRF, deserialization, crypto, secrets, resilience, IaC, CI/CD, and production overlay differences.
4. When assigned a `worker_id`, write only that worker's candidate JSONL and receipt at the supplied paths. Every candidate needs a stable local ID, CWE IDs, exact typed locations, summary, evidence, control, sink, reachability, counterevidence, proof gaps, and confidence. An empty candidate file plus a valid receipt is a successful no-new result.
   - Candidate rows must use exactly: `candidate_id`, `cwe_ids`, `locations`, `summary`, `evidence`, `control`, `sink`, `reachability`, `counterevidence`, `proof_gaps`, and `confidence`. Candidate IDs must be `<worker_id>-CNNNN` (for example `worker-001-C0001`); do not insert category labels such as `authz` into the ID.
   - The exact typed shape is `{"candidate_id":"worker-NNN-CNNN","cwe_ids":["CWE-N"],"locations":[{"path":"repo/relative/file","start_line":1,"end_line":1,"role":"source|control|sink|evidence"}],"summary":"...","evidence":"...","control":"...","sink":"...","reachability":"...","counterevidence":"...","proof_gaps":[],"confidence":"high|medium|low"}`. `proof_gaps` is always a JSON array, including when empty; never write it as a prose string.
   - Every location must use repository-relative `path`, positive `start_line`, `end_line`, and `role` (`source`, `control`, `sink`, or `evidence`). Never use `file`, `line`, `line_range`, or `symbol` in a discovery candidate location.
   - The receipt must use exactly `worker_id`, `status: "SUCCEEDED"`, `candidate_count`, and the lowercase SHA-256 of the exact candidate JSONL bytes as `candidates_sha256`. `COMPLETED` and `CLEAN` are not valid receipt statuses.
5. Return a terminal worker result. A tool/model failure, missing artifact, or incomplete response is `FAILED` or `CANCELED`, never a successful zero-candidate result. Do not perform cross-worker deduplication yourself.
6. Produce or update `discovery/findings.jsonl` and `discovery/coverage-ledger.jsonl` only when the coordinator explicitly assigns the primary aggregation role, deeply reviewing every file represented in the security-sensitive candidate inventory.
7. When `context_mode: blind`, do not search for or open prior reports, Dradis projects, prior blackboard findings, old investigation artifacts, or earlier conclusions. Historical comparison belongs to a later operator-requested run.

## Specialist Track Assignments

When assigned a track, stay within its objective but disposition every supplied inventory row:

- `authorization-access-control`: every route/mutation, authn, OAuth scopes, caller/subject/object ownership, empty authorization filters, ORM operation ordering, and mass assignment. Trace route -> middleware -> handler -> service -> repository/ORM.
- `data-flow-injection`: path/query/body/JWT sources to SQL, Graph/OData/LDAP, URL, command, log, and response sinks; include raw error reflection.
- `secrets-history`: deterministic HEAD and git-history scans; Kubernetes Secrets in every base/overlay; redact values and classify HEAD/history/both.
- `resilience-error-handling`: every HTTP client timeout and retry boundary, migration/batch error propagation, swallowed failures, and unbounded background work.
- `iac-config-manifests`: every manifest, production overlay, Terraform IAM/database grant, deletion protection, debug/telemetry argument, and environment-specific auth setting.
- `cryptography-suppressions`: every crypto operation and every nosec/nolint/gosec-equivalent suppression; reject MD5/SHA-1 for security use and separate inbound verification from outbound token acquisition.

## Historical Regression Assignment

When `security_review_role: historical-regression`:

1. Read the supplied prior-finding table only after blind discovery is complete.
2. Disposition every prior finding as `CONFIRMED`, `CONFIRMED_FIXED`, `CONFIRMED_PARTIAL_FIX`, `NOT_IN_CURRENT_TREE`, or `BLOCKED`.
3. Include exact current-tree evidence for every disposition. No row may remain `UNVERIFIED`.
4. Produce the delta table separating historical findings from genuinely new findings.

## Dynamic Validation Guidance

Recommend local/isolated validation for medium-or-lower-confidence findings. Never contact production or live targets unless separately and explicitly approved. Record precise blockers where validation is not feasible.

## Completion

Your task is complete only when its required output schema is populated and every assigned inventory row is dispositioned. Do not declare the entire security review complete; GLaDOS and deterministic hard gates own workflow completion.
