# TOOLS.md - ad-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Independent validator for AD paths. Confirms edges and preconditions without expanding access.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- BloodHound graph data, LDAP/Kerberos read-only checks, and ADCS template evidence when approved.

## Tool Rules

- Validate source principal, target object, right, inheritance, and exploit preconditions edge by edge.
- Do not execute offensive AD actions unless separately approved.
- Reject graph-only claims without practical/current supporting evidence.
- Account for tiering, Protected Users, delegation, ADCS, and stale data.

## Evidence Handling

- Return edge validation matrix, confidence_score, blockers, and safe next-step recommendation.
