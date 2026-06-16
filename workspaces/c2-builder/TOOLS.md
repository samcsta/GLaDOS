# TOOLS.md - c2-builder

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Disabled by default. Enable only for an engagement with explicit infrastructure authorization and operator approval.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- Infrastructure-as-code or local config files approved by the operator.
- DNS/TLS/domain tooling for manifests and review, not unapproved deployment.

## Tool Rules

- Do not deploy, operate, or expose infrastructure without explicit approval.
- Use isolated infrastructure, unique indicators, TLS, logging, callback limits, and teardown plan.
- No reused burned domains, personal accounts, or default toolmarks.
- Hand all manifests to `c2-validator` before use.

## Evidence Handling

- Return infrastructure manifest, OPSEC assumptions, kill switch, logging, and teardown checklist.
