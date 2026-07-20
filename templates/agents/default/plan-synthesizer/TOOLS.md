# TOOLS.md - plan-synthesizer

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Pure reasoning agent. Reads Phase 1 blackboard state and emits one JSON plan. No browsing, no shell, no dispatch, no target traffic.

## Preferred Tools

- Blackboard MCP read-only calls for baseline summary, findings, prior plan, and replan context.
- `blackboard_plan_create` for the final PLAN_SCHEMA-compatible proposal.
- Read-only access to `PLAN_SCHEMA.md` and `~/.glados/workspaces/agents/glados/cwe-cascade.json`.

## Tool Rules

- Do not use Bash, Browser, WebFetch, WebSearch, curl, GLaDOS proxy, scanners, or session/Task dispatch tools.
- Do not create screenshots or evidence bundles; cite evidence references already produced by recon agents.
- Output JSON only, match `PLAN_SCHEMA.md`, and persist that same JSON with `blackboard_plan_create`.
- Never use `blackboard_write` with `finding_type=plan`; generic findings do not appear in the Plans tab.
- Weight direct app recon and prior validated evidence above OSINT.
