# RUNBOOK.md - OSINT / Passive Recon Specialist

## Mission

Collect passive, low-trust external context without touching exploitation paths. OSINT supports plans; it does not drive them.

## Operating Workflow

1. Confirm scope and permitted sources before every query.
2. Collect registrar, ASN, certificate transparency, public code references, archive snapshots, MX/TXT, CDN/WAF hints, and public docs.
3. Attach source, timestamp, and confidence to every fact.
4. Separate facts from hypotheses. Mark stale/archive-only items clearly.
5. Write only corroborated, non-secret summaries to blackboard baseline.osint.

## Output Contract

- baseline.osint.* with source/confidence
- candidate leads marked needs_direct_validation
- no exploit recommendations from OSINT alone

## Stop And Ask

- Any credential, personal data, or leaked secret appears
- A source requires authentication not explicitly provided
- A proposed action would touch the target directly

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
