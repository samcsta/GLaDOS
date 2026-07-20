# Webapp Assessment Playbook — GLaDOS v4

Authoritative iterative flow for every webapp engagement. GLaDOS and the operator
both read this file; it defines the hard boundary between recon (no approval
needed) and exploitation (approval required).

## Phase 1 — Baseline Recon (always, same every engagement)

Runs unconditionally on every new webapp target. Write each step's result to
the blackboard under `baseline.*`. No exploitation permitted in Phase 1.

1. **Context intake** — merge operator-supplied prior knowledge with each
   operator-approved source among DradisTab, Dradis, and DomainsAI. Write source
   status and facts to `baseline.context_intake`. Use `context_mode=informed`
   when substantive context exists; otherwise use `context_mode=blind` with
   skipped/empty/unavailable reasons. Blind recon proceeds but is never hidden.
2. **Structured browser recon** — after successful SSO, `webapp-recon` first
   screenshots the landing page and captures its complete JavaScript manifest
   before clicking through the app. It returns that checkpoint to GLaDOS;
   GLaDOS runs `js-reverser`, then redispatches recon with the analyzer leads to
   map raw HTML/DOM identifiers, endpoints, forms, request shapes, auth flow,
   roles, object IDs, inputs, technology, and meaningful CWE hypotheses.
3. **Client artifact analysis (required when artifacts exist)** —
   `webapp-recon` saves every observed inline/external script, worker, source
   map, and client configuration item into a manifest. GLaDOS dispatches
   `js-reverser` for any nonempty manifest, regardless of bundle size, and
   requires `baseline.js_analysis` before planning.
4. **Network recon (operator-optional)** — dispatch `net-recon` only when the
   operator explicitly requests network/infrastructure recon. Otherwise record
   `baseline.net_recon.status=skipped` and
   `reason=operator_not_requested`. DNS/TLS/CDN/WAF observations do not
   implicitly authorize it.
5. **OSINT (manual-only, skipped by default)** —
   do not dispatch `osint` during the normal baseline flow. Dispatch it only
   when the operator explicitly asks for OSINT, passive public-source recon,
   CT-log review, Google dorking, archive review, GitHub leak search, or
   similar public-source work. ASN, CDN, WAF, MX/TXT, GitHub/GitLab mentions,
   archive.org.
   Each fact gets a confidence score and source. OSINT supports and
   corroborates the plan; it does not outrank direct app recon, Dradis history,
   DNS/TLS facts, or operator-provided scope. If public sources fail, time out,
   or return only stale/noisy results, record `baseline.osint.status=degraded`
   and `blocking=false`; do not hold the plan. If OSINT was not requested,
   record `baseline.osint.status=skipped`, `blocking=false`, and
   `reason=operator_not_requested`.
6. **Baseline summary card** — single JSON blob merging context intake,
   `webapp-recon`, required `js_analysis`, and any operator-requested network or
   OSINT data. Set `recon.complete=true` only when those mandatory pieces are
   present. Missing/degraded OSINT is explicit and nonblocking.

## Phase 2 — Plan Proposal (GATE: operator approval)

After core Phase 1 completes, dispatch `plan-synthesizer`. Core Phase 1 means
context intake, direct `webapp-recon`, and JavaScript analysis whenever a
client-artifact manifest is nonempty. Network evidence is included only when
the operator requested `net-recon`; OSINT is included only when explicitly
requested and is not required. The
plan-synthesizer reads the baseline summary card and emits a Proposed Attack
Plan JSON with `proposed_vectors`
(CWE + rationale + confidence_pre + agents + est_duration + risk_to_target)
and `agent_chain` (ordered dispatch plan). The plan-synthesizer must weight
evidence in this order: operator context/scope + Dradis history, direct webapp
recon and JavaScript analysis, operator-requested network facts, then OSINT as
corroborating context only. It must retain every meaningful evidence-backed
lead and show how access-control or information-disclosure steps may enable a
deeper chain toward RCE.

Plan is written to the blackboard and summarized by GLaDOS in chat and the
Plans dashboard.

GLaDOS **HALTS** and posts a single consolidated decision message: *"Plan
ready. Approve all/selected, request edits, end the investigation, or keep it
paused."*

Operator decisions (via GLaDOS chat):
- **Approve all** → GLaDOS records approval and dispatches every vector.
- **Approve selected** → GLaDOS records only the selected vectors as approved.
- **Request edits** → preserve the operator's exact requested changes and
  dispatch `plan-synthesizer` with `parent_plan_id` plus
  `operator_modifications`. The replacement plan is pending approval; edits are
  never implicit approval.
- **End investigation** → record the terminal decision, cancel remaining work,
  and do not generate reports unless the operator separately requests them.
- **Keep paused** → no dispatch.

Approval writes a per-engagement fetch ACL derived from the plan (ties into
HMAC/ACL layer in the proxy patch).

## Phase 3 — Approved Execution + Dynamic Replanning

Exploitation agents dispatch **only** after Phase 2 approval. This includes
specialized active testers such as `graphql-specialist` and `cloud-exposure`
when their work would touch live APIs or cloud assets beyond passive analysis.

Suspected findings are never silently promoted to confirmed findings. When an
agent detects a likely vulnerability, GLaDOS reports the evidence, confidence,
endpoint, blast radius, and proposed next validation step to the operator.
The operator manually inspects and explicitly approves validation, follow-on
testing, or report drafting before the finding is treated as confirmed.

Validators write `enables_vectors`, `pivot_detected`, and
`requires_post_pivot_recon`. When approved testing or validation changes
authentication/privilege or reaches a new page/API/tenant/role, GLaDOS:

1. Lets the current agent finish its turn.
2. Halts the remaining chain.
3. Dispatches `webapp-recon` in post-pivot mode using the new authenticated
   context, then dispatches `js-reverser` for the new client artifacts.
4. Dispatches `plan-synthesizer` with `parent_plan_id` = current plan, the
   surface delta, and the triggering finding.
5. Posts the replacement plan and blocks until operator decision.

If no pivot occurs, GLaDOS still ends the cycle at an operator decision point:
continue/replan, edit, wrap/report, end, or pause. Reporting never starts merely
because the current vector list is exhausted.

## Phase 4 — Operator-Controlled Wrap And Reporting

Only an explicit operator wrap/report instruction enters this phase. GLaDOS
dispatches `report-writer` with `operator_wrap_approved: true`, the approval
reference, and `report_pass: initial` to create the canonical severity-partitioned `CWEs/` tree plus
`RT/Timeline.md`, `RT/Errors.md`, `RT/ExecSummary.md`, and `RT/Writeup.md`.
`Writeup.md` includes engagement-scoped elapsed time and metered SDK
cost/tokens. GLaDOS then dispatches `report-validator` with the same markers and
`report_pass: review-and-edit`; the validator records recommendations and edits
the package directly. Finally, GLaDOS dispatches `report-writer` once with
`report_pass: final` to reconcile those changes and publish the final draft.
Stop there. Do not revalidate or cycle unless the operator explicitly requests it.

## Invariants (enforced in SOUL.md)

- **I1**: No exploitation agent (`webapp-vuln`, `api-expert`,
  `graphql-specialist`, `cloud-exposure`, `poc-coder`, `postex`, etc.) may
  dispatch before the operator approves the current engagement plan in chat and
  GLaDOS records that approval in the blackboard.
- **I2**: On replan trigger, no further exploitation dispatches until the new
  plan is approved.
- **I3**: Core Phase 1 agents (`origin-ip`, `net-recon`, `webapp-recon`,
  `source-code`, `js-reverser`, `mobile-api-recon`, `plan-synthesizer`) are
  permitted, but `net-recon` is operator-requested only and `js-reverser` is
  mandatory for nonempty webapp client-artifact manifests. `osint` is Phase 1
  but manual-only.
- **I6**: Suspected vulnerabilities require operator manual inspection or
  explicit validation approval before confirmation, scope expansion, follow-on
  exploitation, or final reporting.
- **I17**: Report agents require an explicit operator wrap/report decision.

Violation of any invariant = hard refusal + LIVE EVENT `soul.violation`.
