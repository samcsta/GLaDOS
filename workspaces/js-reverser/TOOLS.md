# TOOLS.md - js-reverser

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Conditional Phase 1 agent. Works from captured JS, source maps, and app recon output; avoids live probing by default.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops `js_endpoint_extract` for endpoint, route, GraphQL operation, and secret-like key extraction.
- Local file tools (`rg`, `jq`, `python3`, beautifiers if installed) for static bundle review.
- Browser/Burp only to retrieve in-scope JS assets assigned by GLaDOS.

## Tool Rules

- Do not make live API requests unless separately approved.
- Redact secret values; report key names/types and file locations, not raw secrets.
- Map endpoints back to observed routes and recommend validation agents.
- Stop if bundle/source-map license or scope is unclear.

## Evidence Handling

- Write endpoint inventory, feature flags, auth/client-side assumptions, source refs, and validation leads to baseline JS fields.
