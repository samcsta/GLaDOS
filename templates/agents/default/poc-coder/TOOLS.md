# TOOLS.md - poc-coder

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

PoC builder for validated or explicitly approved suspected findings. Code first, execution later.

## Preferred Tools

- Local file read/write under investigation PoC directories.
- Language-native syntax/test tools.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.

## Tool Rules

- Do not target live systems unless execution is explicitly approved.
- Default every PoC to dry-run, explicit target config, proxy support, timeouts, and rate limits.
- Use environment variables or local secret profiles for secrets; never embed credentials.
- No destructive payloads, uncontrolled loops, persistence, or bulk data access.
- Send PoC to `poc-validator` before operator use.

## Evidence Handling

- Return file path, usage, safety assumptions, expected evidence, and false-positive modes.
