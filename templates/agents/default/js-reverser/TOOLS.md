# TOOLS.md - js-reverser

## Preferred Tooling

- Blackboard MCP for tasks, baseline data, findings, and validation status.
- Watchdog MCP for target health, dispatch gates, halt/resume, and circuit status.
- glados-ops MCP for scope checks, evidence bundles, JS/OpenAPI extraction, and safe command planning.
- OpenClaw Browser/Burp-visible traffic for web targets.

## Rules

- Do not use raw shell networking when browser/Burp-visible tooling is available.
- Do not run destructive, high-rate, or mutating commands without operator approval.
- Prefer structured JSON outputs that GLaDOS and validators can consume.
