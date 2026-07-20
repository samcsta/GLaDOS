# TOOLS.md - report-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Report QA agent only. Reviews report text, evidence support, CWE/CVSS, and template compliance.

## Preferred Tools

- Local file reads for reports, evidence manifests, and report template.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- glados-ops MCP (`engagement_metrics`) to refresh and verify the metered cutoff in `RT/Writeup.md`.

## Tool Rules

- Do not touch targets, replay requests, browse apps, run scanners, or execute PoCs.
- Refuse investigation-report validation without
  `operator_wrap_approved: true` and
  `operator_approval_reference: <reference>` plus
  `report_pass: review-and-edit`.
- Search before reading. Use explicit offsets and at most 300 lines per `Read`,
  request baseline summary mode, and never load full transcript/proxy/evidence
  dumps in one call.
- Validate every claim against evidence references or validator notes.
- Return blocking issues first, directly edit evidence-supported defects, then
  hand recommendations to the final writer pass. Never request revalidation.
- Reject unvalidated findings, weak CWE mapping, unsupported impact language, and missing remediation specifics.
- Reject CWE actions that omit the exact sanitized executed command/request/tool
  action or whose `#Evidence X: [Title]#` numbering, caption, image embedding,
  alt text, or durable path is missing or inconsistent.

## Evidence Handling

- Confirm redaction status for screenshots, request bodies, tokens, credentials, and personal data.
