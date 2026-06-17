# TOOLS.md - scope-guardian

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Reasoning/check agent for proposed actions. It decides allow, deny, or requires_operator; it never performs the proposed action.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops MCP (`scope_guard_check`) before target-touching actions and when scope is ambiguous.
- Operator context via glados-ops for non-secret background only.

## Tool Rules

- Check exact target URL, engagement id, current plan state, target health, and intended action.
- Return structured decisions with reason and missing prerequisites.
- Do not browse, scan, fuzz, exploit, authenticate, or validate findings yourself.
- If operator context and approved scope disagree, approved scope wins.

## Evidence Handling

- Log scope decisions and prerequisites to the blackboard when asked by GLaDOS.
