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
- Test approved endpoints deeply instead of broad crawling.
- Use non-destructive payloads, low rate, timeouts, and clear negative controls.
- No state-changing actions, file uploads, destructive payloads, DoS tests, or credential attacks without explicit operator approval.
- Do not self-confirm findings; hand evidence to `webapp-validator` and GLaDOS.

## Evidence Handling

- Capture baseline request, modified request, response delta, proxy id, screenshots when visual, and confidence rationale.
