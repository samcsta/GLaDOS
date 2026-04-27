# PLAN_SCHEMA.md — Proposed Attack Plan JSON

The canonical schema for `plan-synthesizer` output. The dashboard validates
against this; deviations are rejected at `POST /api/plans`.

```json
{
  "engagement_id": "string (required, FK to engagements.id)",
  "parent_plan_id": "string | null (set on replan)",
  "replan_reason": "string | null (required when parent_plan_id is set)",

  "recon_summary": {
    "target": "hostname",
    "dns": {"a": ["..."], "cname_chain": ["..."]},
    "tls": {"issuer": "...", "san": ["..."], "expires": "iso8601"},
    "osint": {"asn": "...", "cdn": "...", "waf": "..."},
    "framework": {"name": "...", "version": "...", "confidence": 0.0},
    "endpoints": [{"path": "/", "method": "GET", "status": 200}],
    "js_recon": {"api_routes": ["/api/..."], "graphql_hints": [], "feature_flags": []},
    "mobile_api": {"hosts": [], "deep_links": [], "auth_notes": []},
    "auth_flow": {"mechanism": "session|oauth|adfs|saml|basic", "mfa": false},
    "quick_wins": ["/actuator exposed", "stack-trace on 500", "..."]
  },

  "proposed_vectors": [
    {
      "cwe": "CWE-918",
      "name": "SSRF",
      "rationale": "open redirect param at /redirect=… reflects to arbitrary host",
      "confidence_pre": 0.7,
      "agents": ["webapp-vuln"],
      "est_duration_min": 15,
      "risk_to_target": "low"
    }
  ],

  "agent_chain": ["webapp-vuln", "poc-coder", "webapp-validator"],
  "notes": "short freeform (optional)"
}
```

## Field rules

- `proposed_vectors` — 1..12 entries. Each `cwe` must match `^CWE-\d+$`.
- `confidence_pre` — float in [0.0, 1.0].
  - Evidence weighting: operator scope / Dradis history > direct webapp recon
    > DNS/TLS facts > OSINT.
  - OSINT-only vectors must be capped at `0.25` and should usually be omitted
    unless they are the only available lead and explicitly marked for direct
    validation.
- `risk_to_target` — enum `low|medium|high`.
- `est_duration_min` — positive integer.
- `agent_chain` — ordered list; must be a superset of the `agents` in
  `proposed_vectors`. Non-exploitation agents (`source-code`) allowed if
  framework detection warrants parallel static analysis.
- `notes` — ≤ 280 chars.

## On replan

Set `parent_plan_id` and `replan_reason` (e.g., `"finding:CWE-287 conf=0.95
enables postex"`). The cascade in `workspaces/glados/cwe-cascade.json`
supplies `enables_vectors` / `skips`; use them to bias the plan.
