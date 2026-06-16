# TOOLS.md - phish-validator

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Disabled by default. Reviews social-engineering material for safety, authorization, deliverability, and measurement quality.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local review of lure drafts, approval artifacts, landing-page copy, and tracking plan.

## Tool Rules

- Do not send messages, test deliverability externally, harvest credentials, or operate infrastructure.
- Verify written approval, audience, dates, payload boundaries, opt-out/escalation handling, and PII handling.
- Reject unsafe pretexts and unapproved credential/attachment capture.
- Return blocking changes before style edits.

## Evidence Handling

- Return approval/deny decision, safety edits, deliverability notes, and missing approval artifacts.
