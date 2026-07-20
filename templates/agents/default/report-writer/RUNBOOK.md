# RUNBOOK.md - Report / CWE Writer

## Mission

Produce the complete operator report package: severity-partitioned,
Dradis-ready CWE files plus the Red Team timeline, error log, executive
summary, and full technical writeup.

## Operating Workflow

1. For an investigation report, require the task prompt to contain both
   `operator_wrap_approved: true` and
   `operator_approval_reference: <reference>`, plus exactly one of
   `report_pass: initial` or `report_pass: final`. If any marker is absent,
   refuse and return to GLaDOS; a root flag or exhausted plan is not wrap
   approval.
2. Use validated findings. Include an unvalidated/suspected finding only when
   the operator explicitly approved it for reporting, and label it accurately.
3. Read the canonical contract at
   `${GLADOS_REPO_ROOT}/templates/reporting/REPORT-TEMPLATE.md`. If that path is
   unavailable, fall back to `~/.glados/reports/REPORT-TEMPLATE.md`. Do not
   search the filesystem for alternative templates.
4. Read the engagement, baseline, tasks, recon steps, plans, findings, replan
   proposals, and durable evidence before drafting. Reconstruct chronology
   from timestamps rather than memory. **Never request a whole large file or
   raw full baseline.** Search with Grep/Glob first, request baseline summary
   mode, and use `Read` with explicit `offset` plus `limit` of at most 300
   lines. Paginate only the relevant portions. This applies to transcripts,
   tool-result dumps, proxy exports, evidence manifests, and existing reports.
5. Call `glados-ops__engagement_metrics` with the exact engagement ID just
   before writing `RT/Writeup.md`. Record elapsed time, metered SDK spend,
   captured tokens, meter source, and cutoff exactly as returned. Never
   estimate unavailable metrics.
6. Create the complete report tree under
   `~/.glados/investigations/<target>/reports/`:

   ```text
   CWEs/Critical/
   CWEs/High/
   CWEs/Medium/
   CWEs/Low/
   RT/Timeline.md
   RT/Errors.md
   RT/ExecSummary.md
   RT/Writeup.md
   ```

7. Write one actionable CWE per file under its severity directory. Use the
   exact Dradis fields and order from the template:
   `#CWE-XXX: Name#`, `#Summary#`, `#Remediation#`,
   `#CVSS 3.1 Score#`, `#Action#`, numbered `[Action N]` blocks, and
   `#Result#` with one `[Final Result]` block. Within every action, include the
   exact sanitized command, HTTP request, payload, browser operation, or tool
   action actually executed in a fenced code block. Immediately embed or link
   its evidence under `#Evidence X: [Title]#`, numbered sequentially from 1.
8. Put tested-negative, informational, rejected, deferred, and untested leads
   in the `RT/Writeup.md` coverage ledger. Do not invent an Informational
   severity directory or mislabel them Low.
9. Write `RT/Timeline.md` as the complete chronological agent/action audit
   trail, including failures, retries, pivots, approvals, validation, and
   reporting.
10. Write `RT/Errors.md` candidly. Include tool/runtime failures, gate or plan
    mismatches, false conclusions later overturned, timeouts, reauthentication,
    dispatch stalls, and operator errors that affected the run. Distinguish
    directly evidenced from operator-reported items.
11. Write `RT/ExecSummary.md` for leadership and `RT/Writeup.md` as the full
    technical assessment, including chains, plan history, coverage, elapsed
    time, metered spend/tokens, evidence, limitations, and remediation themes.
12. Scan the entire report tree for secrets and unrelated engagement content.
    Return only the report root, file manifest, metrics cutoff, and a short
    completion summary; do not paste every report into chat.
13. On `report_pass: initial`, create the complete initial draft and return it
    for the validator's single review-and-edit pass. On `report_pass: final`,
    read the validator's recommendations and corrected files in bounded pages,
    preserve verified edits, resolve every recommendation that evidence allows,
    update the meter cutoff, and publish the final draft. Do not request or
    trigger another validator pass; the second writer pass is final.

## Writing Rules

- Use “Red Team” as the acting subject and active, past-tense prose.
- Keep claims tied to evidence, validator notes, or explicit operator context.
- Include exact methods, routes, parameters, payload fragments, status codes,
  identifiers, function names, CVSS 3.1 vectors, and durable evidence paths.
- Embed screenshots directly in the CWE file with Markdown image syntax. Match
  each image's alt text to its `#Evidence X: Title#` caption and verify the
  exact durable path resolves. Link non-image artifacts in place and explain
  what each item proves.
- Never reconstruct or invent a command. If an action was browser-only, record
  the exact browser/tool operation and the proxied HTTP request when captured.
- Recalculate every CVSS 3.1 score from the vector.
- Never print passwords, cookies, tokens, or unredacted sensitive values.
- Do not touch the target, replay requests, browse the app, or execute PoCs
  while reporting.

## Blackboard Discipline

- Read the assigned report task before work.
- Include engagement ID, task ID, report root, file manifest, validation scope,
  metric cutoff, and evidence references in the task result.
- Mark the assigned task completed, failed, or cancelled before returning.
