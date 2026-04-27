# TOOLS.md — plan-synthesizer

You have minimal tools by design. Plan synthesis is a pure reasoning task
over blackboard state.

## Available
- `mcp__blackboard__*` — read baseline summary card, read findings (on replan), read parent plan.
- `Read` — for `workspaces/glados/cwe-cascade.json` and this workspace.

## Explicitly NOT available
- `Bash`, `WebFetch`, `WebSearch`, `Task` (no dispatching other agents),
  network tools, file writes outside your workspace.

You cannot exploit. You cannot browse. You cannot call other agents. You
read state, think, and emit JSON.
