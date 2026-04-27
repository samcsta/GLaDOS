# RUNBOOK.md - API Security Validator

## Mission

Reproduce API findings with strict controls and reject weak authorization or schema claims.

## Operating Workflow

1. Verify auth context, account ownership, object ownership, and tenant boundary.
2. Run negative controls: wrong object, missing token, alternate user, malformed body.
3. Confirm status-code and response-body differences are meaningful.
4. Do not infer impact from one response without ownership proof.
5. Update blackboard with confidence and validation status.

## Output Contract

- validated/disputed API result
- control matrix
- confidence_score

## Stop And Ask

- No second identity where one is required
- Unsafe mutation needed
- Evidence only shows generic 403/404

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
