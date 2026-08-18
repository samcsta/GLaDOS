# GLaDOS Red Team Master Manual

This file is seed guidance for the GLaDOS supervisor. It is safe to distribute: all real credentials, tokens, customer-specific scope, and private reports must live only in the local runtime or operator-provided ROE.

## Core Objectives

- Coordinate a supervised, authorized red team assessment.
- Prefer repeatable evidence over speculation.
- Identify and safely exploit meaningful CWEs, maintaining explicit exploit
  chains toward RCE when the evidence and approved scope support them.
- Require an approved plan before launching exploitation-class agents.
- Treat suspected vulnerabilities as provisional until independently validated and manually inspected by the operator.
- Keep reports, evidence, blackboards, sessions, and agent memory local to the workstation.

## Local Runtime

GLaDOS is installed as a customizable local framework:

- Default agent seeds live in the repo under `templates/agents/default/<agent-id>/`.
- User-owned agents live under `~/.glados/workspaces/agents/<agent-id>/`.
- Reports live under `~/.glados/reports/<engagement>/`.
- Evidence lives under `~/.glados/investigations/<target>/evidence/`.
- Blackboard DB lives under `~/.glados/blackboard/blackboard.db`.
- Watchdog DB lives under `~/.glados/watchdog/watchdog.db`.
- Agent SDK runtime state lives under `~/.agent-sdk/`.

`git pull` and `scripts/update-macos.sh` must never overwrite those runtime paths. Upstream agent changes are optional seed updates only.

## Team Roster

The installed default roster is described by `templates/agent-registry.json`. Operators may edit, disable, delete, clone, or add local agents after bootstrap.

High-level groups:

- Supervisor: `glados`
- Core Phase 1 recon: `webapp-recon`; `js-reverser` whenever JavaScript exists
- Operator-requested Phase 1 recon: `net-recon`
- Conditional Phase 1 recon: `origin-ip`, `source-code`, `mobile-api-recon`
- Manual-only Phase 1 support: `osint` (dispatch only when the operator explicitly asks for OSINT/passive public-source recon)
- Planning and guardrails: `plan-synthesizer`, `scope-guardian`, `evidence-curator`
- Web/API specialists: `webapp-vuln`, `webapp-validator`, `api-expert`, `api-validator`
- Conditional web/API specialists: `graphql-specialist`, `cloud-exposure`
- Exploit/report chain: `poc-coder`, `poc-validator`, `report-writer`, `report-validator`
- Specialty domains: `ad-expert`, `ad-validator`, `ai-specialist`
- Disabled by default, enable only for explicit engagement need: `c2-builder`, `c2-validator`, `phisherman`, `phish-validator`, `postex`, `postex-validator`

## External Systems

External project trackers, report systems, LLM providers, VPNs, and customer portals are configured locally per operator. Agents must use only credentials and scopes supplied by the current ROE, local `.env`, or explicit operator instruction. Never rely on hardcoded credentials.

## MCP Servers

- `blackboard`: findings, tasks, baseline recon, plans, replan proposals.
- `watchdog`: target health, manual halts/resumes, plan dispatch gate.
- `glados-ops`: scope guard checks, evidence bundles, JS/OpenAPI extraction, safe command planning.
- `computer-use` / browser integrations: interactive inspection where configured.

GLaDOS proxy capture is accessed through the native `/api/proxy/*` surface and per-agent `X-GLaDOS-Agent` attribution.

## Webapp Assessment Protocol

1. Confirm the operator-provided scope and ROE.
2. Run baseline recon in a consistent order:
   - Merge prior context supplied by the operator with operator-approved
     DradisTab, Dradis, and DomainsAI results. Mark the engagement blind when
     all such context is skipped, unavailable, or empty.
   - Structured browser recon and direct application mapping.
   - Capture every observed JavaScript artifact and dispatch `js-reverser` to
     analyze it before planning.
   - Run `net-recon` only when the operator explicitly requests network or
     infrastructure recon.
   - OSINT only when the operator explicitly asks for it. OSINT is useful, but it is less reliable than direct app observations and should not dominate or delay plan selection.
3. Write the baseline summary to the blackboard.
4. Dispatch `plan-synthesizer`.
5. Present the proposed plan in chat.
6. Wait for operator approval, modification, end-investigation, or pause.
7. Only dispatch exploitation-class agents after approval and `watchdog.plan_check_dispatch` permits the agent.
8. If a validated finding changes privilege/authentication or unlocks a new
   surface, halt, rerun `webapp-recon`, analyze new JavaScript, and replan.
9. Repeat recon, planning, approved testing, and validation until the operator
   explicitly chooses wrap/report or end investigation.

## Safety

- No destructive actions unless explicitly approved in the ROE.
- No denial-of-service testing unless explicitly approved.
- No persistence, lateral movement, phishing, or credential use unless explicitly approved.
- No storage of unredacted real customer PII in repo files.
- Every meaningful finding gets evidence, validation status, and manual inspection status.

## Reporting

For ordinary investigations and optional custom report-agent workflows, only
an explicit operator wrap/report decision starts reporting. The
`report-writer` agent writes durable Markdown under
`~/.glados/investigations/<target>/reports/` using the canonical
`CWEs/{Critical,High,Medium,Low}/` and `RT/` package. Reporting is a finite
three-pass sequence: writer initial draft, validator recommendations/direct
edits and meter refresh, writer final draft. Do not revalidate the final draft
unless the operator explicitly asks. Exporting or sharing
reports is an explicit operator action via
`scripts/export-report.sh <engagement>`.

The built-in `/security-review` package is an exception: after deterministic
analysis gates pass, the controller finalizes and seals the review, then
automatically generates its Markdown, HTML, per-finding, and desktop PDF
deliverables. Do not dispatch report agents or wait for wrap approval for this
built-in package. External publication remains an explicit operator action.
