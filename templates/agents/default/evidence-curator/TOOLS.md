# TOOLS.md - evidence-curator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Evidence-only support agent. It normalizes existing artifacts and does not create new target traffic.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- Local filesystem reads under investigation evidence/report directories.
- Burp history exports only when already captured and explicitly referenced by the finding.

## Tool Rules

- Do not browse targets, replay requests, run PoCs, or validate vulnerabilities.
- Create one evidence bundle per suspected or validated finding.
- Redact secrets, tokens, credentials, and personal data before report handoff.
- Preserve request ids, screenshot paths, command-output refs, timestamps, and agent ids.

## Evidence Handling

- Return manifest path, redaction notes, and a concise human-readable evidence summary.
