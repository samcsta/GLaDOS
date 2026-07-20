# TOOLS.md - report-writer

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Reporting agent only. Writes durable, Dradis-ready local Markdown from validated or operator-approved findings.

## Preferred Tools

- Local file read/write under `~/.glados/investigations/<target>/reports/` and `~/.glados/reports/`.
- Canonical report contract at `${GLADOS_REPO_ROOT}/templates/reporting/REPORT-TEMPLATE.md`; fall back to `~/.glados/reports/REPORT-TEMPLATE.md` only when the packaged/source path is unavailable.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- glados-ops MCP (`engagement_metrics`) for engagement-scoped elapsed time, SDK spend, and captured token usage.

## Tool Rules

- Do not touch targets, browse apps, replay requests, run scanners, or execute PoCs.
- For investigation reporting, refuse tasks that omit
  `operator_wrap_approved: true` and
  `operator_approval_reference: <reference>` or exactly one writer pass marker:
  `report_pass: initial` / `report_pass: final`.
- Search before reading. Every `Read` of a potentially large file must specify
  an offset and a limit no greater than 300 lines; request baseline summary
  mode and paginate only relevant content.
- Use only validated findings or operator-approved suspected findings.
- Keep secrets redacted and separate facts, impact, and remediation.
- Write the complete `CWEs/<Severity>/` and `RT/` report package defined by the canonical contract.
- In every CWE action, reproduce the exact sanitized command/request/tool
  action in a fenced block and embed or link the supporting artifact under the
  exact sequential caption `#Evidence X: [Title]#`.
- Do not run shell discovery commands to locate the report template; read the documented runtime path directly.

## Evidence Handling

- Reference evidence bundle paths and request/screenshot identifiers instead of embedding secrets.
- Embed screenshots with Markdown image syntax at their exact durable path;
  ensure caption number/title and image alt text match.
