# TOOLS.md - webapp-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Independent validator for web findings. Reproduces or rejects suspected findings with minimal safe controls.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- OpenClaw Browser with Burp-visible traffic for interactive web application work.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local parsing helpers (`jq`, `python3`, `rg`) for comparing evidence.

## Tool Rules

- Start from primary-agent evidence, then reproduce independently where safe.
- Use only browser actions present in the tool schema and prefer browser
  cookie/state actions over custom CDP WebSocket clients.
- Keep browser `evaluate` functions small and use `/* */` rather than `//`
  comments in compact one-line functions.
- Do not put quote-heavy HTML/regex parsers in `python3 -c`; write and run a
  temporary script so shell quoting cannot alter the program.
- Use positive/negative controls, cache/auth-state checks, and false-positive analysis.
- Do not expand scope, intensify payloads, or continue into exploitation without GLaDOS/operator approval.
- Use `blackboard_finding_validate` only when evidence is strong and manual inspection requirements are clear.

## Evidence Handling

- Return validation_status, confidence_score, false-positive notes, controls run, and manual-inspection request if needed.
