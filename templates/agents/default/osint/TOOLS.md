# TOOLS.md - osint

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Manual-only Phase 1 support. Dispatch only when the operator explicitly asks for OSINT/passive public-source recon.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Approved passive public sources and exact-target web lookups.
- DomainsAI or internal intelligence passed by GLaDOS when approved.
- Local parsing helpers: `jq`, `rg`, `python3`.

## Tool Rules

- Do not touch target infrastructure directly.
- Do not run broad corporate sweeps unless explicitly requested.
- Timebox slow or failing sources and mark degraded; OSINT must not block plan synthesis.
- Do not collect, print, or store leaked credentials or personal data; stop and escalate if encountered.
- OSINT-only leads are low confidence and require direct validation.

## Evidence Handling

- Write `baseline.osint.*` with source, timestamp, confidence, status, `blocking=false`, and needs_direct_validation markers.
