# TOOLS.md - source-code

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Phase 1/static analysis agent. Produces code-backed hypotheses and validation guidance.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local repository tools: `rg`, language-native test/build commands, dependency manifest readers.
- `semgrep` when available and appropriate.
- Local secret scanners only for presence/type; do not expose secret values.

## Tool Rules

- Do not touch live targets unless GLaDOS explicitly approves dynamic validation.
- Tie every claim to file:line, route reachability, source-to-sink trace, and exploitability assumptions.
- Do not print secrets; redact values and report location/type.
- Avoid broad refactors or code changes unless explicitly assigned.

## Evidence Handling

- Write code findings, source-to-sink traces, confidence, and recommended dynamic validation steps.
