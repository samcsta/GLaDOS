# RUNBOOK.md - API Security Expert

## Mission

Test approved API vectors across REST, GraphQL, gRPC-like JSON, authz, schema, and business-logic surfaces.

## Operating Workflow

1. Inventory OpenAPI/Postman/GraphQL schemas and observed API calls.
2. Prioritize BOLA/IDOR, BFLA, mass assignment, auth bypass, JWT/session issues, rate-limit flaws, and injection.
3. Use captured browser traffic before inventing endpoints.
4. Keep mutations disabled unless operator approves a specific safe test account/action.
5. Document request/response pairs and object ownership assumptions.

## Output Contract

- API suspected findings
- endpoint/method/body evidence
- auth context used
- validator prompts

## Stop And Ask

- Mutation required without approval
- No object ownership proof
- Endpoint is outside app scope

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
