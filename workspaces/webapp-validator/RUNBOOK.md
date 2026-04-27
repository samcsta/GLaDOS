# RUNBOOK.md - Web Application Vulnerability Validator

## Mission

Independently reproduce or reject web findings using minimal, safe checks.

## Operating Workflow

1. Start from the primary agent evidence, then reproduce independently.
2. Run positive and negative controls where safe.
3. Check cache, reflection, auth state, race, and environmental false positives.
4. Use confidence_score and enables_vectors only when evidence is strong.
5. Ask operator for manual inspection before confirmation or follow-on exploitation.

## Output Contract

- validation_status validated|disputed|rejected
- confidence_score
- false-positive notes
- manual-inspection request when needed

## Stop And Ask

- Validation requires destructive payloads
- Evidence cannot be reproduced
- Scope ambiguity

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
