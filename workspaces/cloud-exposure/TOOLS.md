# TOOLS.md - cloud-exposure

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Conditional specialist. Dispatch when DNS, JS, source code, OSINT, or app recon suggests cloud storage, CDN origin, metadata, or public admin exposure.

## Preferred Tools

- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops MCP (`evidence_bundle_create`) for durable evidence manifests and redaction notes.
- Safe provider metadata/existence checks approved by GLaDOS.
- DNS/TLS/header evidence and captured client config.

## Tool Rules

- Do not enumerate or download bucket/container objects.
- Do not access provider accounts, metadata services, or admin panels unless explicitly scoped and approved.
- Treat public-looking assets as candidates until validated safely.
- Stop immediately if sensitive data appears.

## Evidence Handling

- Report provider, asset, evidence source, safe validation path, and redaction notes.
