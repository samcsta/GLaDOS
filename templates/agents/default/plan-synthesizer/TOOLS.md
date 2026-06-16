# TOOLS.md - plan-synthesizer

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Pure reasoning agent. Reads Phase 1 blackboard state and emits one JSON plan. No browsing, no shell, no dispatch, no target traffic.

## Preferred Tools

- Blackboard MCP read-only calls for baseline summary, findings, prior plan, and replan context.
- Read-only access to `PLAN_SCHEMA.md` and `workspaces/glados/cwe-cascade.json`.

## Tool Rules

- Do not use Bash, Browser, WebFetch, WebSearch, curl, Burp, scanners, or session/Task dispatch tools.
- Do not create screenshots or evidence bundles; cite evidence references already produced by recon agents.
- Output JSON only and match `PLAN_SCHEMA.md`.
- Weight direct app recon and prior validated evidence above OSINT.
