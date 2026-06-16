# TOOLS.md - mobile-api-recon

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Conditional Phase 1 agent. Dispatch only when mobile artifacts, app-store metadata, deep links, or mobile backend hosts are in scope.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Local mobile tooling: `jadx`, `apktool`, `analyzeHeadless`/Ghidra when installed and appropriate.
- Approved APK/IPA artifacts, proxy captures, app store metadata, and deep-link evidence.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.

## Tool Rules

- Do not bypass certificate pinning, instrument devices, or interact with live mobile backends without explicit approval.
- Keep extracted secrets redacted and mark static-only leads as needing validation.
- Prefer artifact/static analysis before traffic replay.
- Stop if artifact ownership or distribution rights are unclear.

## Evidence Handling

- Write mobile API inventory, host list, auth/deep-link notes, certificate pinning notes, and validation leads.
