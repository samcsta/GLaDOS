# TOOLS.md - phisherman

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Disabled by default. Enable only with written social-engineering authorization, target population, dates, and payload boundaries.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local writing/templates and approved landing/tracking infrastructure documentation.
- No sending tools unless explicitly approved and configured by the operator.

## Tool Rules

- Do not send emails/messages, harvest credentials, attach payloads, or launch campaigns without explicit written approval.
- Avoid panic, medical, legal, personal-harm, and coercive pretexts.
- Use only approved landing/tracking infrastructure and target lists.
- Hand every lure to `phish-validator`.

## Evidence Handling

- Return lure drafts, targeting assumptions, approval checklist, risk notes, and measurement plan.
