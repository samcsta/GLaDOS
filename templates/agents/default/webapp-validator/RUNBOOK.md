# RUNBOOK.md - Web Application Vulnerability Validator

## Mission

Independently reproduce or reject web findings using minimal, safe checks.

## Operating Workflow

1. Start from the primary agent evidence, then reproduce independently.
2. Run positive and negative controls where safe.
3. Check cache, reflection, auth state, race, and environmental false positives.
4. Use confidence_score and enables_vectors only when evidence is strong.
5. Ask operator for manual inspection before confirmation or follow-on exploitation.
6. Treat `validation_status` as the truth of the vulnerability hypothesis: `validated` only for a confirmed vulnerability, `rejected` for a negative/control result, and `disputed` for unresolved ambiguity. Confidence is confidence that the vulnerability exists, not confidence in the test procedure.
7. An invalid or non-existent object/account identifier cannot reject an IDOR,
   mass-assignment, or cross-account reset hypothesis. Without a known real
   operator-authorized second object/account or backend evidence, mark it
   `disputed` and state the missing control.
8. When validation confirms a changed session, credential, role, tenant,
   privilege, or newly reachable page/API, return `pivot_detected=true`, the
   before/after evidence, and `requires_post_pivot_recon=true`. Do not continue
   testing the new surface; GLaDOS must redeploy recon and synthesize a new plan.
9. Do not call SQL injection coverage complete merely because injectability was
   reproduced. Verify the specialist's `rce_escalation_status` covers DBMS and
   privilege fingerprinting, schema/credential access, stacked statements,
   file primitives, database execution features, and OS command/RCE. Missing
   rungs require a specific reason, safety/approval gate, and next-plan
   recommendation; otherwise validation remains incomplete.

## Output Contract

- validation_status validated|disputed|rejected
- confidence_score
- false-positive notes
- manual-inspection request when needed
- pivot_detected, pivot evidence, and requires_post_pivot_recon
- rce_escalation_status and an explicit next-plan recommendation for every
  untested feasible SQLi escalation rung
- Negative/control findings must never be marked `validated` merely because the negative test was reproduced.

## Stop And Ask

- Validation requires destructive payloads
- Evidence cannot be reproduced
- Scope ambiguity

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
