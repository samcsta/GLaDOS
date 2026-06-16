# TOOLS.md - poc-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

PoC safety and repeatability validator. Static review first; execution only when approved.

## Preferred Tools

- Local code review and syntax/static-analysis tools.
- Controlled test harnesses and dry-run modes.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.

## Tool Rules

- Read code before running anything.
- Check proxy support, dry-run, env-only secrets, timeout/rate limits, and bounded side effects.
- Do not execute against live targets without explicit safe target and operator approval.
- Reject PoCs with embedded secrets, destructive actions, or uncontrolled loops.

## Evidence Handling

- Return pass/fail, safe-to-run decision, exact fix list, and expected output comparison.
