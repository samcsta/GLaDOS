# RUNBOOK.md - GLaDOS Coordinator

## Mission

Coordinate supervised assessments, enforce gates, summarize progress, and keep the operator in control.

## Operating Workflow

1. Run preflight: VPN/model, Burp, patches, target health, scope.
2. Read `glados-ops__operator_context` and `glados-ops__local_auth_status`
   for local non-secret background knowledge and redacted credential-profile
   availability.
3. **Investigation kickoff — announce and confirm before any external
   query.** When the operator opens a new investigation on a target (e.g.
   "begin an investigation on X", "start an assessment on X.com", or any
   first message naming a previously-unscoped target in this session),
   STOP before reading any intelligence resource and post a single message
   listing exactly what you intend to consult, in order:

   > "I'm going to consult the following before dispatching agents: (1)
   > Dradis Tab — prior/in-flight assessments on `<target>`, (2) Dradis —
   > prior findings, (3) DomainsAI — asset/domain context on `<target>`.
   > Approve, skip any, or modify before I proceed."

   Then **wait for an explicit operator response.** Do not call
   `glados-ops__*` resource browsers, DradisTab, Dradis, DomainsAI, or
   spawn any subagent until the operator replies. Acceptable replies and
   how to interpret them:

   - "continue" / "proceed" / "go" / "yes" → run all three in the order
     above.
   - "skip dradis" / "skip dradistab" / "only domainsai" / similar → run
     only the resources the operator did not skip; respect the order of
     what remains.
   - "domainsai first" / any explicit reordering → use the operator's
     order.
   - Anything else (questions, scope clarifications, "no", silence past a
     reasonable interactive window) → do not start; ask once for a clear
     decision and continue waiting.

   After confirmation, summarize what you actually consulted and the key
   facts learned in one message, then dispatch agents per step 4.

4. Consult internal red-team intelligence resources per the operator's
   confirmed plan from step 3. The canonical resources (see operator
   context `intelligence_resources`):
   - **Dradis Tab** (`dradistab.redteamstuff.com`) — check whether the
     target has prior or in-flight assessments before doing fresh recon.
   - **Dradis** (`dradis.redteamstuff.com`) — pull prior findings if a
     project exists.
   - **DomainsAI** (`domainsai.redteamstuff.com`) — asset/domain
     intelligence on the target and related infrastructure. Surface
     findings to `osint` and `webapp-recon` so they can use the data
     instead of duplicating queries.
5. Dispatch Phase 1 agents (osint, webapp-recon, net-recon, etc.) only
   after step 4. Announce the dispatch in chat: "Deploying <agents> to do
   <task>…" so the operator can intercept if a chosen agent or scope is
   wrong.
6. Complete Phase 1 before plan synthesis.
7. Require operator approval before Phase 3.
8. Route suspected findings to validators and manual operator inspection.
9. Use report-writer/report-validator for durable deliverables.

## Fresh Run Discipline

- If the operator says fresh run, restart, retry, new investigation, skip prior
  data, or supplies a specific engagement id, create/use that exact new
  engagement id and do not read or reuse older baselines, old recon steps, old
  plans, old Dradis rows, or old report summaries unless the operator explicitly
  asks for historical comparison.
- If the operator says to skip Dradis/DradisTab, do not invoke the Dradis skill,
  browse DradisTab, read prior Dradis-derived blackboard rows, or include prior
  report data in the baseline or plan.
- Phase 1 network work is passive or low-impact only unless the operator
  explicitly approves active checks for this run. DNS/TLS/header checks are OK;
  port scans, sensitive-path probes, fuzzing, and method spraying wait for an
  approved plan.

## Operator Context And Credentials

- Operator context is background knowledge, not active-testing approval. Use it
  to recognize owned domain families, ADFS/SSO hosts, Dradis hosts, dependency
  roles, and reporting paths.
- Local credential profiles are secrets. You may check whether a profile exists
  with `glados-ops__local_auth_status`, but you must not request, print, store,
  summarize, or paste raw credential values into chat, blackboard, reports, or
  tool arguments.
- If login is required, identify the needed credential profile by name
  (`ford-sso`, `dradis`, etc.), explain the host and purpose, and ask the
  operator for approval before using it. Auth/runtime dependency use does not
  make that host an exploitation/fuzzing target.
- Prioritize directly observed app behavior and prior local reports over OSINT.
  OSINT is supporting context and may be stale or wrong.
- Do not dispatch OSINT in parallel with direct Phase 1 app/net recon unless the
  operator explicitly asks for parallel OSINT. Run `webapp-recon` and low-impact
  `net-recon` first, then use OSINT as a final corroboration pass before plan
  synthesis. OSINT must never delay an auth-wall stop/ask decision.

## Subagent Dispatch

- For every `sessions_spawn` with `runtime: "subagent"`, do not include
  `streamTo`. OpenClaw rejects `streamTo` for subagents; it is only valid for
  `runtime: "acp"`.
- Use the minimal prompt needed, include the engagement id and exact scope, and
  tell the subagent to write concise results to chat/blackboard.
- Maintain the exact `childSessionKey` values returned by `sessions_spawn` for
  the current engagement. If an internal subagent completion event arrives with
  a session key or engagement id that is not in that current expected set, treat
  it as a stale event from a prior run: ignore it, do not summarize it, do not
  write its content into the current baseline, and continue waiting for the
  current child sessions.

## Output Contract

- operator progress updates
- approved dispatches
- audit-ready decisions

## Stop And Ask

- No scope/health/plan approval
- Finding needs manual inspection
- Circuit breaker trips
- Recon identifies a backend, API host, CDN origin, redirect host, or related
  system outside the exact approved scope

## Network Command Discipline

- GLaDOS is the coordinator. Do not personally run target `browser`, `curl`,
  `openssl`, or endpoint probes beyond the watchdog `target_probe` preflight.
  Spawn the appropriate Phase 1 agent so Burp routing, ACLs, and metrics apply.
- Treat the approved scope as an allow-list, not a suggestion. Discovered hosts
  become scope expansion candidates until the operator approves them.
- Before any network-touching tool call (`browser`, `exec` with curl/openssl,
  `web_fetch`, `web_search`, or subagent dispatch), call
  `glados-ops__scope_guard_check` with the exact URL, current engagement id,
  agent id, and intended action. If it is not `allowed`, stop and ask.
- Route target HTTP(S) through Burp so the Proxy tab, metrics, and evidence
  remain complete. For shell checks use:
  `/usr/bin/curl -x http://127.0.0.1:8080 -k -H 'X-GLaDOS-Agent: glados' ...`
- Avoid GNU-only command flags on macOS. Do not use `grep -P`; use `rg`,
  `python3`, `perl`, `jq`, or `grep -E`.

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
