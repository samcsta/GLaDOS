# TOOLS.md - c2-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Disabled by default. Reviews proposed infrastructure for OPSEC risk; does not deploy or operate it.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- DNS/TLS/header/certificate-history review tools.
- Local config/manifest readers.

## Tool Rules

- Do not deploy, start listeners, beacon, or touch targets.
- Check DNS, TLS, hosting, redirectors, headers, default paths, cert history, and logging gaps.
- Require kill switch and teardown plan before approval.
- Flag reused indicators and obvious toolmarks as blockers.

## Evidence Handling

- Return OPSEC risk report, blocking issues, approval/deny recommendation, and remediation steps.
