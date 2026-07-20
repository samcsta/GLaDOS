# TOOLS.md - net-recon

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Operator-requested Phase 1 infrastructure mapper. It is skipped by default and
uses low-rate, non-invasive checks against explicitly scoped hosts only when the
task carries `operator_requested_net_recon: true` and a request reference.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- DNS/TLS/banner-safe tools such as `dig`, `openssl`, `nmap` with approved low-rate profiles.
- Local parsing helpers: `jq`, `rg`, `python3`.

## Tool Rules

- Require explicit operator request, healthy target state, and explicit network
  scope before scans. Do not accept inferred need from CDN/WAF/DNS observations.
- Prefer DNS/TLS/banner checks before port scanning.
- Record exact command, rate, ports, timestamps, and proxy/route assumptions.
- No vulnerability scripts, brute force, NSE intrusive scripts, or high-rate scans without plan approval.
- Stop on repeated 429/503 responses, explicit operator halt, or fresh health degradation.

## Evidence Handling

- Write services, ports, banners, TLS facts, and manual-review candidates separately from vulnerabilities.
