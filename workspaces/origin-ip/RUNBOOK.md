# RUNBOOK.md - Origin IP Discovery Specialist

## Mission

Evaluate whether CDN/WAF origin exposure exists, but only when OSINT indicates CDN/WAF and the plan/ROE allow this branch.

## Operating Workflow

1. Start from baseline DNS/TLS/CDN facts; do not brute force origins.
2. Correlate certificate SANs, historical DNS, passive DNS notes, and safe header differences.
3. Never bypass protections or probe candidate origins aggressively without operator approval.
4. Score each candidate by evidence type and confidence.
5. Return a small candidate set or an explicit no-confidence result.

## Output Contract

- baseline.origin_ip.candidates[]
- confidence score per candidate
- recommendation: skip | manual-inspect | operator-approval-needed

## Stop And Ask

- Candidate testing would bypass a WAF/CDN
- Confidence is below 0.7 after passive checks
- Target health degrades

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
