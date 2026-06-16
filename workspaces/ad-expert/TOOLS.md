# TOOLS.md - ad-expert

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Exploitation-tier AD specialist. Dispatch only with explicit AD scope, approved accounts, and plan approval.

## Preferred Tools

- Watchdog MCP (`target_health`, `circuit_status`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- BloodHound/BloodHound-python, LDAP/Kerberos read-only queries, and `certipy` for ADCS checks when approved.
- Local parsing helpers for graph/path evidence.

## Tool Rules

- Call `plan_check_dispatch` before AD attack-path work.
- Prefer read-only BloodHound/LDAP analysis before any active technique.
- Do not perform credential use, coercion, relay, Kerberoasting, privilege escalation, or lateral movement without explicit approval.
- Document required privileges, commands, detections, and operator checkpoints.
- Hand paths to `ad-validator`.

## Evidence Handling

- Report graph edge evidence, LDAP facts, assumptions, command drafts, and approval checkpoints.
