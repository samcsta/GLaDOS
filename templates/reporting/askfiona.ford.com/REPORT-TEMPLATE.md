# GLaDOS Red Team — CWE Report Template
*Modeled on the AskFiona-style Dradis Pro report format.*

---

## File Naming Convention

```text
CWE-{NUMBER}-{short-slug}.md
```

Examples:

- `CWE-287-306-639-auth-bypass.md`
- `CWE-200-prometheus-metrics-exposure.md`
- `CWE-798-522-hardcoded-credentials.md`

Use the primary/root CWE first. Keep slugs short, hyphenated, lowercase, and
descriptive.

---

## Report File Structure

```markdown
# [Finding Title — Clear, specific, technical]
**CWE:** CWE-XXX [/ CWE-YYY if multiple] | **Severity:** [Critical/High/Medium/Low] | **CVSS:** X.X

**Status:** [STILL ACTIVE / REMEDIATED / PARTIAL] ([re-validation note])
**Affected Endpoint:** `[URL or endpoint path]`

## Overview

[2–3 sentences. Cover: why this application is vulnerable, how Red Team
exploited or validated it during the assessment, and what remediation requires.
Use dense technical prose. Do not include generic CWE definition boilerplate.]

---

## Steps to Reproduce

### Action 1: [Short, active-voice title]

**Action:** Red Team [verb]ed [what] to [purpose/goal].

```bash
[exact command if applicable]
```

*Evidence 1: [Short Label]*

![Screenshot - Action 1](_attachments/screenshot-action1.png)

[One or two sentences continuing the narrative: what Red Team observed, what
happened next, and any constants, IDs, tokens, headers, or values extracted.]

**Result:** [1–2 sentences. State the achieved result directly.]

---

### Action 2: [Short, active-voice title]

**Action:** [...]

*Evidence 2: [Label]*

![Screenshot - Action 2](_attachments/screenshot-action2.png)

**Result:** [...]

---

## Remediation

- **(CRITICAL — 24h)** [Specific technical action.]
- **(HIGH — 48h)** [...]
- **(MEDIUM — 1 week)** [...]
- **(LOW — 1 month)** [...]
```

---

## Style Rules

### Subject

- Always use **"Red Team"**.
- Do not write "the tester", "I", or vague passive phrasing.
- Preferred verbs: "Red Team issued", "Red Team navigated", "Red Team
  constructed", "Red Team loaded", "Red Team validated".

### Action Blocks

- **Action** is past-tense narrative prose. Explain what Red Team did, why, and
  what was observed along the way.
- Screenshots are embedded inside the Action block as `*Evidence N: Label*`
  followed by the image on the next line.
- Narrative may continue after the screenshot before the Result.
- **Result** is the short conclusion. Include exact values, counts, HTTP codes,
  or IDs when they reinforce impact.

### Overview Paragraph

- Dense technical context.
- No CWE definition boilerplate.
- State the vulnerability, exploitation/validation, and fix in one tight
  paragraph.
- Avoid hedging. State facts.

### Technical Detail Level

- Include exact command strings when used.
- Include exact response values: HTTP status codes, header values, function
  names, IDs, client IDs, route names, and payload fragments.
- Include exact payloads inline when short; reference separate PoC files for
  large scripts.
- Extract and display tables of disclosed data where applicable.

### Screenshot Blocks

```markdown
*Evidence N: Short Descriptive Label*

![Screenshot - Action N](_attachments/screenshot-slugname.png)
```

Keep a blank line before and after the image line.

### Severity Tags in Remediation

| Priority | Timeline | Use For |
| --- | --- | --- |
| CRITICAL | 24h | Immediately exploitable issues, CVSS >= 9.0, credential exposure |
| HIGH | 48h | CVSS 7–9, indirect enablement, incomplete fixes |
| MEDIUM | 1 week | Defense-in-depth, partial mitigations |
| LOW | 1 month | Hardening, best practices, low-impact cleanups |

---

## Dradis Pro Field Mapping

| Report Section | Dradis Field |
| --- | --- |
| Overview paragraph | `#[Summary]#` |
| Action steps + embedded evidence | `#[Action]#` |
| Result paragraph(s) | `#[Result]#` |
| Remediation bullets | `#[Remediation]#` |
| Assessment date | `#[Timestamp]#` |
| Network source | `#[Source]#` |

Screenshots in local Markdown reports use:

```markdown
![Alt](_attachments/filename.png)
```

---

## Example: Minimal Report Skeleton

```markdown
# SQL Injection in Search Parameter
**CWE:** CWE-89 | **Severity:** HIGH | **CVSS:** 8.8

**Status:** STILL ACTIVE (re-validated YYYY-MM-DD)
**Affected Endpoint:** `https://target.example.com/search?q=`

## Overview

The target application's search endpoint passes the `q` parameter directly into
an unsanitized SQL query without parameterization. During the assessment, Red
Team confirmed time-based blind SQL injection delays against the parameter in a
single session. Remediation requires replacing dynamic SQL string concatenation
with parameterized queries or prepared statements.

---

## Steps to Reproduce

### Action 1: Probe the Search Endpoint for SQL Error Behavior

**Action:** Red Team submitted a single-quote character as the search parameter
to detect raw SQL error exposure.

```bash
curl -s "https://target.example.com/search?q='"
```

*Evidence 1: SQL Error Response*

![Screenshot - Action 1](_attachments/screenshot-sqli-action1-error.png)

The server returned HTTP 500 with a raw database error message.

**Result:** Unparameterized SQL query construction was confirmed because user
input reached the query directly without sanitization.

---

## Remediation

- **(HIGH — 48h)** Replace dynamic SQL string concatenation in the search
  handler with parameterized queries using the database driver's prepared
  statement API.
- **(MEDIUM — 1 week)** Add regression tests for SQL metacharacters across all
  search/query endpoints.
```

---

Template maintained by GLaDOS Red Team. Last updated: 2026-04-28.
