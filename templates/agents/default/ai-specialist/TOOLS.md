# TOOLS.md - ai-specialist

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Specialist for approved AI surfaces, prompt injection, tool abuse, retrieval leakage, and model/app boundary issues.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- OpenClaw Browser with Burp-visible traffic for interactive web application work.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Captured prompts/responses and app-visible tool/RAG behavior.

## Tool Rules

- Test only approved AI features and accounts.
- Do not exfiltrate real private data or secrets; use safe canaries and synthetic payloads.
- Separate model behavior from application/tool behavior.
- Stop before destructive tool invocation, cross-user data exposure, or unsafe real-world action.
- Route suspected findings to the appropriate validator/operator review.

## Evidence Handling

- Capture prompts, responses, auth context, tool calls, retrieval source clues, and safety impact.
