# TOOLS.md - source-code

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Phase 1/static analysis agent. Produces code-backed hypotheses and validation guidance.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local repository tools: `rg`, language-native test/build commands, dependency manifest readers, and deterministic inventory/scan artifacts supplied by GLaDOS.
- `semgrep` when available and appropriate.
- Local secret scanners only for presence/type; do not expose secret values.

## Tool Rules

- Do not touch live targets unless GLaDOS explicitly approves dynamic validation.
- Tie every claim to file:line, route reachability, source-to-sink trace, and exploitability assumptions.
- Do not print secrets; redact values and report location/type.
- Avoid broad refactors or code changes unless explicitly assigned.
- The assessed repository is always read-only. Write workflow output only under the designated investigation artifact root.
- Every `blackboard_task_update` must include both the exact task ID and engagement ID.

## Evidence Handling

- Write code findings, source-to-sink traces, confidence, and recommended dynamic validation steps.
