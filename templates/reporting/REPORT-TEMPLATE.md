# GLaDOS Red Team Report Contract

This is the canonical output contract for every operator-approved GLaDOS
investigation report. Report agents must create the complete directory tree,
write every required file, and keep each CWE file directly importable into
Dradis without heading conversion.

## Required Directory Layout

```text
reports/
├── CWEs/
│   ├── Critical/
│   │   └── CWE-XXX-short-name.md
│   ├── High/
│   │   └── CWE-XXX-short-name.md
│   ├── Medium/
│   │   └── CWE-XXX-short-name.md
│   └── Low/
│       └── CWE-XXX-short-name.md
└── RT/
    ├── Timeline.md
    ├── Errors.md
    ├── ExecSummary.md
    └── Writeup.md
```

Canonical report paths:

- `CWEs/Critical/`
- `CWEs/High/`
- `CWEs/Medium/`
- `CWEs/Low/`
- `RT/Timeline.md`
- `RT/Errors.md`
- `RT/ExecSummary.md`
- `RT/Writeup.md`

- Create all four severity directories even when one is empty.
- Write one file per distinct actionable CWE finding under its assessed
  severity. Never combine unrelated CWEs into one file.
- Do not create an `Informational/` severity directory. Tested-negative,
  informational, rejected, and explicitly deferred leads belong in
  `RT/Writeup.md` under the coverage ledger.
- Use `CWE-{NUMBER}-{short-lowercase-slug}.md` filenames.
- Store this tree under
  `~/.glados/investigations/<target>/reports/`.

## Exact Dradis CWE Format

Every file under `CWEs/<Severity>/` must use the following field names and
order exactly. Do not add Markdown `##` headings, metadata banners, YAML front
matter, or alternate field names.

```markdown
#CWE-XXX: [NAME]#

#Summary#

[A dense technical summary of the vulnerability, affected endpoint/component,
validation status, exploit chain position, demonstrated impact, and evidence
references. Use “Red Team” as the acting subject. Do not include generic CWE
definition boilerplate.]

#Remediation#

[Specific, technically feasible remediation ordered by urgency. Include the
primary code/configuration fix and relevant regression tests.]

#CVSS 3.1 Score#

[Numeric score] — `[complete CVSS:3.1 vector]`

[One concise sentence explaining the metric choices and any chained-impact
assumption.]

#Action#

[Action 1]

[Describe chronologically what Red Team did and why. Reproduce the exact
sanitized command, raw HTTP request, payload, or browser/tool action that was
actually executed. Put commands and requests in fenced code blocks. Never
replace an exact value with prose except where a secret must be shown as
`[REDACTED]`.]

```text
[Exact command, request, payload, or tool action]
```

#Evidence 1: [Title]#

![Evidence 1: [Title]](../../../evidence/[exact-screenshot-filename].png)

[Explain exactly what this screenshot or artifact proves. For non-image
evidence, use a Markdown link to the durable artifact and quote only the
minimal relevant excerpt.]

[Action 2]

[Continue with each material reproduction/validation step and its exact
command/request/tool action. Add Action 3, Action 4, and so on as required.]

```text
[Exact command, request, payload, or tool action]
```

#Evidence 2: [Title]#

[Embed the screenshot with Markdown image syntax or link the exact durable
evidence artifact, followed by a concise explanation of what it proves.]

#Result#

[Final Result]

[State the final independently supported outcome, exact impact, validation
status/confidence, and relevant evidence references. Do not introduce new
claims here.]
```

### CWE Writing Rules

- Preserve the exact `#Field#` syntax because these are Dradis fields.
- The title must be `#CWE-XXX: Name#`; use the primary CWE for the file.
- `#Action#` contains `[Action 1]`, `[Action 2]`, and subsequent numbered
  actions in chronological order.
- Every action must show the exact sanitized command, raw HTTP request, payload,
  browser operation, or tool action that Red Team actually executed. Preserve
  methods, routes, headers relevant to the vulnerability, parameters, encoding,
  and response status. Never invent a shell command for a browser-only action.
- Put exact commands, requests, payloads, and material response excerpts in
  fenced code blocks. Redact only secrets and sensitive unrelated data, using
  explicit `[REDACTED]` markers without changing exploit-relevant values.
- Place each supporting screenshot or artifact immediately after the action it
  proves. Caption every item using the exact syntax
  `#Evidence X: [Title]#`, replacing `X` with a sequential integer and
  `[Title]` with a specific descriptive title.
- Evidence numbering starts at 1 in each CWE file and increases without gaps.
  The number and title in a screenshot's Markdown alt text must match its
  `#Evidence X: Title#` caption.
- Embed screenshots in place using Markdown image syntax and their exact
  durable evidence path. Link non-image artifacts at their exact durable path;
  do not substitute a bare evidence ID or an unresolvable filename.
- `#Result#` contains one `[Final Result]` block, not a result after every
  action.
- Include exact HTTP methods, routes, parameters, payload fragments, status
  codes, identifiers, function names, and evidence paths when supported.
- Reference screenshots and artifacts by durable engagement-relative path.
- Never place plaintext passwords, session cookies, tokens, or unredacted
  secrets in a report.
- CVSS must be CVSS 3.1. Recalculate the numeric score from the printed vector;
  do not copy a stale blackboard score without checking it.

## RT/Timeline.md

`Timeline.md` is the chronological audit trail of what the agents actually did.
It must include the complete assessment window, not only successful findings.

Required columns:

```markdown
# Investigation Timeline

| UTC Timestamp | Elapsed | Agent | Task/Plan | Action | Result | Evidence |
| --- | ---: | --- | --- | --- | --- | --- |
```

Requirements:

- Start with engagement creation and end with report validation/closure.
- Include recon, JavaScript analysis, plan creation/approval/editing,
  exploitation, validation, pivots, reauthentication, reporting, and closure.
- Include failed, cancelled, blocked, or retried work in its true position.
- Derive timestamps and durations from blackboard task/recon/plan records and
  transcript evidence. Never invent missing timestamps.

## RT/Errors.md

`Errors.md` is the candid process and runtime defect record.

```markdown
# Investigation Errors

| UTC Timestamp | Agent/Component | Stage | Error | Impact/Time Lost | Fix or Workaround | Status |
| --- | --- | --- | --- | --- | --- | --- |
```

Include tool failures, malformed calls, false conclusions later overturned,
approval/gate mismatches, dispatch stalls, timeouts, session expiry, evidence
hygiene gaps, and operator-side errors that affected the run. Separate directly
evidenced facts from operator-reported observations. If there were no errors,
write an explicit “No investigation errors were recorded” statement.

## RT/ExecSummary.md

`ExecSummary.md` is the concise leadership-facing report. It must cover:

- target and authorized assessment scope;
- assessment objective and whether it was achieved;
- overall risk rating;
- highest-impact findings and validated attack chains;
- business impact in plain language;
- the most urgent remediation priorities;
- important limitations or deferred coverage.

Do not include plaintext credentials, long payloads, or an exhaustive action
log in the executive summary.

## RT/Writeup.md

`Writeup.md` is the complete technical narrative. At minimum include:

1. Scope, objective, assumptions, and starting access.
2. Assessment methodology and agent workflow.
3. Initial and post-pivot attack-surface inventories.
4. Plan history and operator decisions.
5. Full exploit-chain narrative with cross-links to CWE files and evidence.
6. Findings index sorted Critical, High, Medium, then Low.
7. Coverage ledger for validated, rejected, tested-negative, deferred, and
   untested leads with reasons.
8. Accepted collateral and safety constraints.
9. Assessment metrics: elapsed time, token usage, and metered cost.
10. Evidence index and final conclusion.

### Required Assessment Metrics

Immediately before writing metrics, call
`glados-ops__engagement_metrics` with the exact engagement ID. Print:

- assessment start in UTC;
- completion time, or the `meteredThrough` cutoff if still active;
- elapsed wall-clock time in seconds and human-readable form;
- Claude Agent SDK metered spend in USD;
- input, output, cache-read, cache-creation, and total tokens when available;
- model/agent cost breakdown when available;
- the metering source, attribution method, and cutoff caveat.

Never estimate missing cost or tokens. If unavailable, state “Unavailable from
the runtime meter” and explain why. The currently executing reporting turn is
not included until it returns, so the cutoff must always be explicit.

## Report Validation Contract

The report validator must:

1. Confirm the exact directory tree and four RT filenames exist.
2. Validate every CWE file against the exact Dradis fields and field order,
   exact executed commands/requests, and sequential
   `#Evidence X: [Title]#` captions. Confirm screenshots are embedded in place,
   artifact links resolve, and captions match their image alt text.
3. Confirm severity-directory placement matches the assessed severity.
4. Recalculate every CVSS 3.1 score from its vector.
5. Trace every claim to blackboard/evidence and scan for secrets and
   cross-engagement contamination.
6. Call `glados-ops__engagement_metrics` again and update
   `RT/Writeup.md` with the newest available meter cutoff before returning a
   pass verdict.
7. Use the finite wrap sequence once: writer initial draft, validator
   recommendations plus direct edits, writer final draft. The validator returns
   its edited manifest and recommendations to the final writer; it does not
   revalidate the final draft or create a writer/validator loop unless the
   operator explicitly requests another review.

Template maintained by GLaDOS Red Team. Last updated: 2026-07-15.
