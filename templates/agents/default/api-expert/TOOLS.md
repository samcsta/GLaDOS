# TOOLS.md - api-expert

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Exploitation-tier API tester for approved REST/JSON/OpenAPI/business-logic vectors.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- glados-ops `openapi_inventory` for OpenAPI documents.
- Browser/Burp traffic captures from `webapp-recon`; proxied `/usr/bin/curl` only when necessary.

## Tool Rules

- Call `plan_check_dispatch` before work.
- Use observed traffic and schemas before inventing endpoints.
- No unsafe mutations, mass assignment writes, destructive requests, or rate-limit stress without explicit approval.
- Require object ownership proof before authz/IDOR conclusions.
- Send suspected findings to `api-validator` or `webapp-validator`.

## Evidence Handling

- Record endpoint, method, body, auth context, object ownership assumptions, response deltas, and proxy ids.
