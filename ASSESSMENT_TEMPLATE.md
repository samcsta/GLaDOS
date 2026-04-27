# Authorized Web Application Assessment Template

Use this template for a single approved web application assessment. It is intentionally generic: never commit real credentials, customer names, private scopes, session tokens, screenshots containing secrets, Burp exports, or raw evidence into the GLaDOS repo.

## Engagement Header

| Field | Value |
| --- | --- |
| Engagement ID | `<target>-YYYYMMDD` |
| Target | `https://example.com/` |
| Authorized Scope | `<exact hosts, paths, IPs, or exclusions>` |
| Operator | `<name or handle>` |
| Approval Source | `<ticket, email, ROE, or operator approval>` |
| Test Window | `<dates/times/timezone>` |
| Auth Material | Provided locally through the operator or local ROE. Do not store here. |

## Guardrails

- Confirm the target is in scope before every active test.
- Route active web traffic through Burp when GLaDOS is operating.
- Avoid destructive actions, denial of service, persistence, bulk data extraction, or real-user impact unless the ROE explicitly approves the activity.
- Treat every suspected vulnerability as provisional until it has been manually inspected or separately validated.
- Store evidence under the local runtime, not the repo:
  - Reports: `~/.glados/reports/<engagement>/`
  - Evidence: `~/.glados/investigations/<target>/evidence/`

## Phase 1 - Baseline Recon

1. Confirm scope and ROE.
2. Check prior reports or tracking systems available to the operator.
3. Capture DNS, TLS, CDN/WAF, hosting, and redirect behavior.
4. Perform structured browser recon:
   - Pages and workflows
   - Auth flow
   - Forms and state-changing actions
   - API endpoints and JavaScript routes
   - Frameworks and client-side libraries
   - Security headers and cookie attributes
5. Use OSINT as a supporting signal, not the primary decision source. Direct observations, prior reports, and scoped app behavior should outrank public OSINT when synthesizing the plan.

## Phase 2 - Plan Proposal

GLaDOS should summarize the baseline and propose a plan before launching exploitation-class agents. The operator approves, modifies, or rejects the plan in chat and can review the same plan in the dashboard Plans tab.

Plan fields:

- Engagement ID
- Target and scope summary
- Proposed vectors with CWE IDs
- Confidence before testing
- Risk to target
- Agent chain
- Evidence required
- Manual inspection checkpoints

## Phase 3 - Approved Testing

Only run tests that fit the approved plan and scope. For each candidate issue:

1. Capture the exact request, response, endpoint, parameter, and observed behavior.
2. Ask a validator agent to independently assess the evidence.
3. Ask the operator to manually inspect important findings before treating them as confirmed.
4. If a high-confidence finding unlocks a new vector, halt and propose a replan.

## Common Web Checks

Use the relevant checks for the application and scope:

- Injection: SQL, NoSQL, command, LDAP, template, XPath
- Auth/session: authorization bypass, IDOR, session fixation, token tampering, missing logout invalidation
- Input/output handling: reflected/stored XSS, SSRF, file upload, path traversal
- API: broken object authorization, excessive data exposure, mass assignment, schema misuse
- Business logic: workflow bypass, role transitions, payment/state manipulation
- Configuration: security headers, cookie flags, verbose errors, debug paths, exposed docs
- Source/client review: JavaScript endpoints, secrets by name only, route maps, GraphQL operations

## Evidence Format

For each finding:

- Title
- Severity and CWE
- Affected endpoint/component
- Preconditions
- Reproduction steps
- Request/response evidence with secrets redacted
- Impact
- Remediation
- Validation status and validating agent
- Manual inspection status

## Report Output

Write final reports to:

`~/.glados/reports/<engagement>/`

Keep raw evidence and screenshots in:

`~/.glados/investigations/<target>/evidence/`

Export a report only when explicitly requested:

```bash
scripts/export-report.sh <engagement>
```
