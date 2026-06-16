# TOOLS.md - net-recon

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Core/conditional Phase 1 infrastructure mapper. Uses low-rate, non-invasive checks against explicitly scoped hosts.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- DNS/TLS/banner-safe tools such as `dig`, `openssl`, `nmap` with approved low-rate profiles.
- Local parsing helpers: `jq`, `rg`, `python3`.

## Tool Rules

- Require healthy target state and explicit network scope before scans.
- Prefer DNS/TLS/banner checks before port scanning.
- Record exact command, rate, ports, timestamps, and proxy/route assumptions.
- No vulnerability scripts, brute force, NSE intrusive scripts, or high-rate scans without plan approval.
- Stop on 429/503, circuit breaker, or health degradation.

## Evidence Handling

- Write services, ports, banners, TLS facts, and manual-review candidates separately from vulnerabilities.
