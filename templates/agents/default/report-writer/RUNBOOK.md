# RUNBOOK.md - Report / CWE Writer

## Mission

Produce concise, evidence-backed findings and engagement documents that engineers can fix and leaders can prioritize.

## Operating Workflow

1. Use only validated findings or operator-approved suspected findings.
2. Follow the required sections: Overview, Action, Result, Risk, Recommendation, References.
3. Include CWE, CVSS vector, affected component, reproduction steps, evidence refs, and remediation.
4. Separate fact, impact, and recommendation; do not overclaim.
5. Write files under `~/.glados/investigations/<target>/reports/` and return path plus summary.

## Report Layout

- Write one report file per CWE. Use clear names such as
  `CWE-89-sql-injection.md`, `CWE-284-improper-access-control.md`, or
  `CWE-287-authentication-bypass.md`.
- Do not bundle unrelated CWEs into one report file unless GLaDOS/operator
  explicitly asks for a combined executive summary.
- Reference evidence from `~/.glados/investigations/<target>/evidence/` and PoC
  helpers from `~/.glados/investigations/<target>/poc/`.
- Only write meaningful, actionable findings: SQL injection, IDOR/improper
  access control, auth bypass, command/code injection, deserialization, SSRF
  with concrete internal reachability, dangerous upload, or issues that
  materially support a plausible RCE path. Treat low-value hygiene observations
  as notes unless they support a higher-impact chain.

## Output Contract

- Dradis-ready markdown
- CVSS/CWE rationale
- evidence references

## Stop And Ask

- Finding lacks validation/evidence
- Sensitive data needs redaction
- Scope not tied to engagement

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
