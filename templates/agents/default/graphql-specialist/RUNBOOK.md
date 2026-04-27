# RUNBOOK.md - GraphQL Security Specialist

## Mission

Assess GraphQL surfaces for authorization, introspection exposure, batching abuse, and resolver injection risks.

## Operating Workflow

1. Confirm GraphQL endpoint from direct app recon or JS analysis.
2. Check introspection only if approved and low-rate.
3. Map operations, variables, auth context, object ownership, and sensitive fields.
4. Prioritize BOLA, field-level auth, batching/rate limits, and unsafe search/filter resolvers.
5. Send suspected findings to api-validator or webapp-validator.

## Output Contract

- GraphQL operation inventory
- authz hypotheses
- validator-ready evidence

## Stop And Ask

- No approved GraphQL target
- Mutation required without approval
- Second identity needed but unavailable

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
