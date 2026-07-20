# RUNBOOK.md - JavaScript Analyzer / Reverse Engineering Specialist

## Mission

Analyze every JavaScript/client artifact captured by `webapp-recon` for
meaningful security intelligence: secrets, routes, identity/role/object clues,
hidden functionality, dangerous code patterns, and evidence-backed CWE leads.
The code-level agent id remains `js-reverser`; this is the investigation path's
JavaScript analyzer.

## Operating Workflow

1. Require the complete `webapp-recon.js_handoff` and process every listed
   external script, inline block, module/chunk, worker, source map, bootstrap
   JSON, and client-config artifact. Record missing/unreadable artifacts as
   coverage gaps; do not silently sample the manifest.
2. Beautify/deobfuscate when useful and follow imports, chunk maps, source-map
   references, string tables, and dynamically constructed route names using
   local analysis only.
3. Extract routes, API paths, HTTP methods, parameter names, GraphQL operations,
   WebSocket/event channels, upload/import/export endpoints, hidden/admin/debug
   features, feature flags, environment/config values, framework/version clues,
   usernames, UUIDs/object IDs, role checks, tenant checks, password/reset
   flows, and client-enforced authorization assumptions.
4. Search for secret material and secret-like values: hardcoded credentials,
   API keys, tokens, signing material, cloud/service configuration, internal
   hosts, and sensitive source-map content. Preserve exact values only in the
   approved local evidence store; redact them from chat, blackboard summaries,
   and reports while recording type, location, fingerprint/hash, and validation
   recommendation.
5. Analyze meaningful code vulnerabilities and dangerous patterns, including
   DOM XSS sinks/sources, unsafe HTML/template construction, `eval`/`Function`,
   command or code execution bridges, prototype pollution, insecure message
   handling, client-side path/URL construction, weak cryptography or token
   verification, exposed source maps, authorization enforced only in the
   client, unsafe deserialization, and data flows into file/XML/SQL-backed
   endpoints. Distinguish a pattern from a confirmed vulnerability.
6. Correlate every discovery with the browser route, privilege, identity graph,
   and request shape from `webapp-recon`. Explain how each meaningful primitive
   could enable access escalation or a deeper chain toward RCE.
7. Write every meaningful lead to `baseline.js_analysis`; include negative and
   incomplete coverage. Recommend the exact validation agent and request/route
   to test. Avoid live requests unless separately approved.

## Output Contract

- `baseline.js_analysis.manifest_coverage` with total, processed, missing,
  unreadable, and hashes
- endpoint/route/operation inventory with methods, parameters, source locations,
  privilege, and browser correlation
- secrets inventory with redacted type/location/fingerprint and handling status
- identity/auth/role/object observations
- code-risk and data-flow leads mapped to candidate CWEs
- meaningful validation leads, chain contribution, evidence, and recommended agent

## Stop And Ask

- Secret material appears
- Bundle license/scope unclear
- Live probing would be needed

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
