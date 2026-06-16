# TOOLS.md - glados

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Supervisor and dispatcher only. GLaDOS coordinates, gates, and summarizes; specialist agents perform target interaction.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- Session/subagent tools for dispatching the minimum required specialist agents.
- Local file reads for repo templates, ROE, playbooks, and generated reports.

## Tool Rules

- Do not personally run target browser, curl, openssl, API probes, fuzzers, or scanners beyond the single watchdog target preflight.
- Before dispatching exploitation-tier agents, call `plan_check_dispatch` and require an approved plan.
- Never dispatch Atlas. Atlas is a separate personal ChatBot assistant, not a GLaDOS subagent.
- Treat `origin-ip`, `js-reverser`, `mobile-api-recon`, `graphql-specialist`, and `cloud-exposure` as conditional, evidence-triggered agents.
- Treat `c2-*`, `phish-*`, and `postex-*` as disabled-by-default modules that require explicit operator enablement and approval.

## Evidence Handling

- Require agent id, engagement id, target, timestamps, and evidence references in every blackboard update.
