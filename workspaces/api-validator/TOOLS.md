# TOOLS.md - api-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Independent validator for API findings. Reproduces claims with strict auth and ownership controls.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Proxied HTTP client only for the exact requests under validation.

## Tool Rules

- Validate auth context, tenant/account boundaries, object ownership, and negative controls.
- Do not perform unsafe mutations or broad endpoint probing.
- Reject status-only claims without response-body and ownership evidence.
- Use `blackboard_finding_validate` when validation is complete.

## Evidence Handling

- Return a control matrix, validation_status, confidence_score, and exact missing evidence if disputed.
