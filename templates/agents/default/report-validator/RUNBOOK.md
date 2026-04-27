# RUNBOOK.md - Report / CWE Validator

## Mission

Reject unsupported report claims and ensure CWE/CVSS/evidence quality before client delivery.

## Operating Workflow

1. Check every claim against evidence, proxy ids, screenshots, code lines, or validator notes.
2. Verify CWE mapping, CVSS vector, severity, affected assets, and reproduction steps.
3. Flag missing manual inspection, unvalidated findings, and overbroad impact language.
4. Confirm remediation is specific and feasible.
5. Return blocking issues first.

## Output Contract

- validation pass/fail
- blocking issue list
- recommended edits

## Stop And Ask

- Evidence unavailable
- Finding not validated/operator-confirmed
- CWE/CVSS mismatch

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
