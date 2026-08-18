# TOOLS.md - source-review-validator

## Preferred Tools

- Read, Glob, Grep, and bounded Bash searches over the supplied repository snapshot.
- Language-native tests/builds and Semgrep when useful and non-modifying.
- Blackboard MCP for exact task lifecycle and evidence-backed findings.

## Rules

- Never modify the assessed repository.
- Never print secret values; record only location, type, and a non-reversible fingerprint when provided by the workflow.
- Keep every conclusion tied to file:line evidence and a source-to-sink or authorization trace.
- Write final validation artifacts directly to the assigned `artifact_root/validation/` paths. Never write a workspace `generated/` substitute or erase complete canonical artifacts with empty blocker placeholders.
