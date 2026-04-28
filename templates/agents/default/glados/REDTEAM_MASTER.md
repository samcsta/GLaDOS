# GLaDOS Red Team Master Manual

This file is seed guidance for the GLaDOS supervisor. It is safe to distribute: all real credentials, tokens, customer-specific scope, and private reports must live only in the local runtime or operator-provided ROE.

## Core Objectives

- Coordinate a supervised, authorized red team assessment.
- Prefer repeatable evidence over speculation.
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
- OpenClaw runtime state lives under `~/.openclaw/`.

`git pull` and `scripts/update-macos.sh` must never overwrite those runtime paths. Upstream agent changes are optional seed updates only.

## Team Roster

The installed default roster is described by `templates/agent-registry.json`. Operators may edit, disable, delete, clone, or add local agents after bootstrap.

High-level groups:

- Supervisor: `glados`
- General local assistant: `atlas`
- Phase 1 recon: `osint`, `origin-ip`, `net-recon`, `webapp-recon`, `source-code`, `js-reverser`, `mobile-api-recon`
- Planning and guardrails: `plan-synthesizer`, `scope-guardian`, `evidence-curator`
- Web/API specialists: `webapp-vuln`, `webapp-validator`, `api-expert`, `api-validator`, `graphql-specialist`, `cloud-exposure`
- Exploit/report chain: `poc-coder`, `poc-validator`, `postex`, `postex-validator`, `report-writer`, `report-validator`
- Specialty domains: `ad-expert`, `ad-validator`, `ai-specialist`, `c2-builder`, `c2-validator`, `phisherman`, `phish-validator`

## External Systems

External project trackers, report systems, LLM providers, VPNs, and customer portals are configured locally per operator. Agents must use only credentials and scopes supplied by the current ROE, local `.env`, or explicit operator instruction. Never rely on hardcoded credentials.

## MCP Servers

- `blackboard`: findings, tasks, baseline recon, plans, replan proposals.
- `watchdog`: target health, halts, circuit breaker, plan dispatch gate.
- `glados-ops`: scope guard checks, evidence bundles, JS/OpenAPI extraction, safe command planning.
- `computer-use` / browser integrations: interactive inspection where configured.

Burp is accessed through the local proxy and the GLaDOS Burp extension, not through a dedicated `burp_mcp` server.

## Webapp Assessment Protocol

1. Confirm the operator-provided scope and ROE.
2. Run baseline recon in a consistent order:
   - Prior-report/tracker lookup if available.
   - DNS/TLS/CDN/WAF fingerprint.
   - Structured browser recon and direct application mapping.
   - Source/client artifact review.
   - OSINT as a supporting signal. OSINT is useful, but it is less reliable than direct app observations and should not dominate plan selection.
3. Write the baseline summary to the blackboard.
4. Dispatch `plan-synthesizer`.
5. Present the proposed plan in chat.
6. Wait for operator approval, modification, or rejection.
7. Only dispatch exploitation-class agents after approval and `watchdog.plan_check_dispatch` permits the agent.
8. If a validated finding unlocks new vectors, halt and replan.

## Safety

- No destructive actions unless explicitly approved in the ROE.
- No denial-of-service testing unless explicitly approved.
- No persistence, lateral movement, phishing, or credential use unless explicitly approved.
- No storage of unredacted real customer PII in repo files.
- Every meaningful finding gets evidence, validation status, and manual inspection status.

## Reporting

The `report-writer` agent writes durable Markdown under `~/.glados/reports/<engagement>/`. The `report-validator` reviews the report before handoff. Exporting or sharing reports is an explicit operator action via `scripts/export-report.sh <engagement>`.
