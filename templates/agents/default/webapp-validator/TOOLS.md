# TOOLS.md - webapp-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Independent validator for web findings. Reproduces or rejects suspected findings with minimal safe controls.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Agent SDK Browser with proxy-visible traffic for interactive web application work.
- GLaDOS native proxy for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local parsing helpers (`jq`, `python3`, `rg`) for comparing evidence.
- CWE cascade policy, when needed, is at `~/.glados/workspaces/agents/glados/cwe-cascade.json`.

## Tool Rules

- Start from primary-agent evidence, then reproduce independently where safe.
- Use only browser actions present in the tool schema and prefer browser
  cookie/state actions over custom CDP WebSocket clients.
- Keep browser `evaluate` functions small and use `/* */` rather than `//`
  comments in compact one-line functions.
- Do not put quote-heavy HTML/regex parsers in `python3 -c`; write and run a
  temporary script so shell quoting cannot alter the program.
- Use positive/negative controls, cache/auth-state checks, and false-positive analysis.
- Never use a missing/non-existent object ID to reject an authorization
  hypothesis; require a known real authorized second object/account or backend
  evidence, otherwise return disputed.
- Stop at a confirmed auth/privilege/surface pivot and signal
  `requires_post_pivot_recon=true` to GLaDOS.
- Do not expand scope, intensify payloads, or continue into exploitation without GLaDOS/operator approval.
- Use `blackboard_finding_validate` only when evidence is strong and manual inspection requirements are clear.
- Never search the whole filesystem (`find /`) for GLaDOS policy or evidence. Use the documented runtime/workspace paths and bounded `rg`/`find` roots.

## Evidence Handling

- Return validation_status, confidence_score, false-positive notes, controls run, and manual-inspection request if needed.
