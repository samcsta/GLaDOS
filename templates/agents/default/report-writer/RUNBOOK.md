# RUNBOOK.md - Report / CWE Writer

## Mission

Produce concise, evidence-backed findings and engagement documents that engineers can fix and leaders can prioritize.

## Operating Workflow

1. Use only validated findings or operator-approved suspected findings.
2. Follow the required sections: Overview, Action, Result, Risk, Recommendation, References.
3. Include CWE, CVSS vector, affected component, reproduction steps, evidence refs, and remediation.
4. Separate fact, impact, and recommendation; do not overclaim.
5. Write files under the investigation directory and return path plus summary.

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
