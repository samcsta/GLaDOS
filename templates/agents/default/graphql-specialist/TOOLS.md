# TOOLS.md - graphql-specialist

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Conditional specialist. Dispatch only when recon identifies a GraphQL endpoint or operation evidence.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Captured GraphQL traffic, schemas, and operation names.
- glados-ops `js_endpoint_extract` for operation discovery from JS bundles.

## Tool Rules

- Call `plan_check_dispatch` for exploitation-tier GraphQL testing.
- Check introspection only when approved and low-rate.
- Do not run mutations, batching abuse, or resolver stress tests without explicit approval.
- Map operations, variables, auth context, object ownership, and sensitive fields before testing.
- Hand suspected findings to `api-validator`.

## Evidence Handling

- Provide operation inventory, authz hypotheses, controls, proxy ids, and validator-ready evidence.
