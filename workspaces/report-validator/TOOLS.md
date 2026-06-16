# TOOLS.md - report-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Report QA agent only. Reviews report text, evidence support, CWE/CVSS, and template compliance.

## Preferred Tools

- Local file reads for reports, evidence manifests, and report template.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.

## Tool Rules

- Do not touch targets, replay requests, browse apps, run scanners, or execute PoCs.
- Validate every claim against evidence references or validator notes.
- Return blocking issues first, then suggested edits.
- Reject unvalidated findings, weak CWE mapping, unsupported impact language, and missing remediation specifics.

## Evidence Handling

- Confirm redaction status for screenshots, request bodies, tokens, credentials, and personal data.
