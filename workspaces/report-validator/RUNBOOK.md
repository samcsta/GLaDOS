# RUNBOOK.md - Report / CWE Validator

## Mission

Reject unsupported report claims and ensure CWE/CVSS/evidence quality before client delivery.

## Operating Workflow

1. Read `${GLADOS_REPO_ROOT}/templates/reporting/REPORT-TEMPLATE.md`
   before validating. Treat it as the canonical report format, Dradis field
   mapping, file naming convention, and writing-style standard.
   If the repo path is unavailable, fall back to
   `~/.glados/reports/REPORT-TEMPLATE.md`.
2. Check every claim against evidence, proxy ids, screenshots, code lines, or validator notes.
3. Verify CWE mapping, CVSS vector, severity, affected assets, and reproduction steps.
4. Confirm the report follows the template: "Red Team" subject, active voice,
   dense technical Overview, Action/Result reproduction blocks, embedded
   evidence references, and prioritized Remediation bullets.
5. Flag missing manual inspection, unvalidated findings, overbroad impact
   language, CWE boilerplate filler, passive voice, or template drift.
6. Confirm remediation is specific and feasible.
7. Return blocking issues first.

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
