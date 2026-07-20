# TOOLS.md - js-reverser

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Core webapp-analysis agent whenever `webapp-recon` returns a nonempty client
artifact manifest. Works from captured JavaScript, source maps, client config,
and app recon output; avoids live probing by default.

## Preferred Tools

- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- glados-ops `js_endpoint_extract` as one extraction pass, followed by manual
  static/data-flow review of every manifest item.
- Local file tools (`rg`, `jq`, `python3`, beautifiers if installed) for static bundle review.
- browser/proxy only to retrieve in-scope JS assets assigned by GLaDOS.

## Tool Rules

- Do not make live API requests unless separately approved.
- Process the complete manifest. Sampling or stopping after endpoint extraction
  is incomplete; record every missing/unreadable artifact.
- Redact secret values from chat/blackboard/report output while preserving only
  approved local evidence with type, location, and fingerprint.
- Map routes, identities, authorization checks, object IDs, reset flows,
  dangerous sinks/sources, and endpoints back to observed browser state and
  recommend exact validation agents.
- Stop if bundle/source-map license or scope is unclear.

## Evidence Handling

- Write manifest coverage, endpoint/operation inventory, redacted secrets,
  identity/auth observations, code-risk/data-flow leads, source references, and
  validation recommendations to `baseline.js_analysis`.
