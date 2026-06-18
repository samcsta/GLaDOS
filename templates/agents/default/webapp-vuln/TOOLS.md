# TOOLS.md - webapp-vuln

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Exploitation-tier web tester. Runs only approved plan vectors and produces suspected findings for validation.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- OpenClaw Browser with Burp-visible traffic for interactive web application work.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Safe local helpers such as `jq`, `python3`, and carefully proxied `/usr/bin/curl` when Browser is insufficient.

## Tool Rules

- Call `plan_check_dispatch` before work and stop if denied.
- Use only browser actions present in the tool schema. `fill` takes a `fields`
  array; use `type` for one referenced field and `press` for keys.
- Use the browser's cookie/state actions for cookies, including HttpOnly
  cookies. Do not build ad-hoc Python/Node CDP WebSocket clients.
- Keep browser `evaluate` functions small and use `/* */` rather than `//`
  comments in compact one-line functions.
- Do not put quote-heavy parsers in `python3 -c`. Write a temporary script,
  run it, then remove or retain it as evidence as appropriate.
- Test approved endpoints deeply instead of broad crawling.
- Use non-destructive payloads, low rate, timeouts, and clear negative controls.
- No state-changing actions, file uploads, destructive payloads, DoS tests, or credential attacks without explicit operator approval.
- Do not self-confirm findings; hand evidence to `webapp-validator` and GLaDOS.

## Evidence Handling

- Capture baseline request, modified request, response delta, proxy id, screenshots when visual, and confidence rationale.
