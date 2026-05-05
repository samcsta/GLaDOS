# Webapp Assessment Playbook — GLaDOS v3.1

Authoritative 3-phase flow for every webapp engagement. GLaDOS and the operator
both read this file; it defines the hard boundary between recon (no approval
needed) and exploitation (approval required).

## Phase 1 — Baseline Recon (always, same every engagement)

Runs unconditionally on every new webapp target. Write each step's result to
the blackboard under `baseline.*`. No exploitation permitted in Phase 1.

1. **DradisTab lookup** — `dradistab.redteamstuff.com` for prior engagement
   artifacts on the target hostname. If found, surface to operator: resume /
   validate / start-fresh decision.
2. **DNS + TLS fingerprint** — A/CNAME/SAN/issuer/expiry → `baseline.dns.*`,
   `baseline.tls.*`.
3. **Structured browser recon** — dispatch `webapp-recon` with the JSON schema
   (framework, endpoints, forms, auth-flow, tech-stack, quick-wins). Output is
   machine-readable, not prose.
4. **Client artifact recon (conditional)** — dispatch `js-reverser` when
   `webapp-recon` identifies large JS bundles, source maps, GraphQL hints, or
   client-side route/API discovery needs. Dispatch `mobile-api-recon` only when
   mobile artifacts, mobile API hosts, app-store metadata, or deep links are in
   scope.
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
6. **Origin-IP / net-recon (gated)** — if DomainsAI, DNS/TLS, direct headers,
   or operator-requested OSINT show CDN/WAF, dispatch `origin-ip` first. Only
   fall through to `net-recon` if origin-IP confidence < 70%. Replaces the old
   binary LB Gate.
7. **Baseline summary card** — single JSON blob merging core steps 1–4 plus
   any operator-requested OSINT/origin data, written to blackboard with
   `recon.complete=true` timestamp. Missing or degraded OSINT is an explicit
   field in the summary, not a reason to delay Phase 2.

## Phase 2 — Plan Proposal (GATE: operator approval)

After core Phase 1 completes, dispatch `plan-synthesizer`. Core Phase 1 means
Dradis/local report context, DomainsAI, DNS/TLS basics, and direct
`webapp-recon`; OSINT is included only when the operator explicitly requested
it and is not required. The
plan-synthesizer reads the baseline summary card and emits a Proposed Attack
Plan JSON with `proposed_vectors`
(CWE + rationale + confidence_pre + agents + est_duration + risk_to_target)
and `agent_chain` (ordered dispatch plan). The plan-synthesizer must weight
evidence in this order: operator scope + Dradis history, direct webapp recon,
DNS/TLS facts, then OSINT as corroborating context only.

Plan is written to the blackboard and summarized by GLaDOS in chat. The chat
summary is the operator approval surface; the separate Plans dashboard tab is
not used.

GLaDOS **HALTS** and posts a single consolidated chat message: *"Plan ready
for review. Approve all, approve selected vectors, modify, or reject."*

Operator decisions (via GLaDOS chat):
- **Approve all** → GLaDOS records approval and dispatches every vector.
- **Approve selected** → GLaDOS records only the selected vectors as approved.
- **Modify** → operator states edits in chat; GLaDOS records the modified plan
  before dispatch.
- **Reject** → GLaDOS records the rejection reason and loops back to Phase 1
  for a re-run or prompts for operator guidance.

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

Validators write findings with a new `enables_vectors` field. When a finding
satisfies `confidence >= replan_threshold AND cwe ∈ cwe-cascade.json`, GLaDOS:

1. Lets the current agent finish its turn.
2. Halts the remaining chain.
3. Dispatches `plan-synthesizer` with `parent_plan_id` = current plan, reading
   `cwe-cascade.json` to bias toward `enables_vectors` and away from `skips`.
4. New plan is posted to chat: *"High-confidence finding unlocks new vectors.
   Proposed replan: […]. Continue original / approve replan / reject?"*
5. Blocks until operator decision.

## Invariants (enforced in SOUL.md)

- **I1**: No exploitation agent (`webapp-vuln`, `api-expert`,
  `graphql-specialist`, `cloud-exposure`, `poc-coder`, `postex`, etc.) may
  dispatch before the operator approves the current engagement plan in chat and
  GLaDOS records that approval in the blackboard.
- **I2**: On replan trigger, no further exploitation dispatches until the new
  plan is approved.
- **I3**: Core Phase 1 agents (`origin-ip`, `net-recon`, `webapp-recon`,
  `source-code`, `js-reverser`, `mobile-api-recon`, `plan-synthesizer`) are
  always permitted. `osint` is Phase 1 but manual-only; dispatch it only when
  the operator explicitly asks for OSINT/passive public-source recon.
- **I6**: Suspected vulnerabilities require operator manual inspection or
  explicit validation approval before confirmation, scope expansion, follow-on
  exploitation, or final reporting.

Violation of any invariant = hard refusal + LIVE EVENT `soul.violation`.
