# TOOLS.md - postex-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Disabled by default. Validates post-ex claims and cleanup without expanding access.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- Read-only review of commands, screenshots, logs, and operator-approved metadata.

## Tool Rules

- Do not move laterally, collect bulk data, escalate privileges, or run new offensive actions.
- Validate identity, privilege, host, access path, blast radius, and cleanup requirements from existing evidence.
- Reject claims without timestamps, commands, and evidence refs.
- Escalate accidental sensitive exposure to GLaDOS.

## Evidence Handling

- Return validation status, impact confidence, cleanup notes, and residual risk.
