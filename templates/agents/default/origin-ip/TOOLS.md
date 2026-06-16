# TOOLS.md - origin-ip

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Conditional Phase 1 agent. Dispatch only when CDN/WAF evidence exists and origin discovery is within scope.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Passive DNS/TLS/history sources approved by GLaDOS.
- Low-impact DNS/TLS checks through approved tooling; no WAF bypass testing.

## Tool Rules

- Do not test candidate origins in ways that bypass access controls or WAF/CDN protections without explicit approval.
- Do not run broad internet scans.
- Require confidence >= 0.7 before recommending manual inspection.
- Stop on scope ambiguity or health degradation.

## Evidence Handling

- Report candidates with source, confidence, why it may be origin, and recommended skip/manual-inspect/operator-approval-needed action.
