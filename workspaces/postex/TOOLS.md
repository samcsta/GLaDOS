# TOOLS.md - postex

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Disabled by default. Enable only after explicit post-exploitation authorization and approved plan.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- Approved host/session tooling and least-touch local commands within the authorized environment.

## Tool Rules

- Call `plan_check_dispatch` before work.
- No persistence, lateral movement, credential dumping, data exfiltration, or destructive changes unless explicitly approved.
- Use minimal proof of impact and stop before expanding access.
- Escalate sensitive-data exposure or EDR/health concerns immediately.
- Hand claims to `postex-validator`.

## Evidence Handling

- Record identity, host, privilege, command, timestamp, evidence ref, cleanup need, and next approval checkpoint.
