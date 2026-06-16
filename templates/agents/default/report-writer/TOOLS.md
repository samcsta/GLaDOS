# TOOLS.md - report-writer

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Reporting agent only. Writes durable, Dradis-ready local Markdown from validated or operator-approved findings.

## Preferred Tools

- Local file read/write under `~/.glados/investigations/<target>/reports/` and `~/.glados/reports/`.
- Canonical report template at `${GLADOS_REPO_ROOT}/templates/reporting/REPORT-TEMPLATE.md`.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.

## Tool Rules

- Do not touch targets, browse apps, replay requests, run scanners, or execute PoCs.
- Use only validated findings or operator-approved suspected findings.
- Keep secrets redacted and separate facts, impact, and remediation.
- Write one report per primary CWE unless GLaDOS asks for an executive rollup.

## Evidence Handling

- Reference evidence bundle paths and request/screenshot identifiers instead of embedding secrets.
