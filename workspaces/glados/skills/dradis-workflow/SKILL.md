---
name: dradis-workflow
description: Workflow for interacting with Dradis Professional and DradisTab during an authorized red team assessment. Use when: (1) checking for prior reports on a target at engagement start, (2) reading existing findings and Action/Results from Dradis, (3) pushing new findings to Dradis after peer review, (4) formatting findings with CWE/CVSS/evidence. NOT for: general web browsing, non-Dradis task tracking. Triggers on phrases like "check dradis", "push finding", "look up prior report", "dradis finding", "engagement start", "check for prior work".
---

# Dradis Workflow

## Tools Required

Use **OpenClaw Browser (MCP)** for all Dradis interactions. Simple `curl` is insufficient — both targets are session-based.

- **DradisTab** (metadata/tracking): `https://dradistab.redteamstuff.com` — no credentials needed
- **Dradis Pro** (full findings): `https://dradis.redteamstuff.com` — auth required
- **Auth:** Use only operator-provided, engagement-approved credentials from the local ROE. Do not store credentials in this skill.

**Only inspect Dradis Pro projects explicitly authorized for the current operator and engagement.**

---

## Engagement Start Protocol

### Step 1 — Check DradisTab

1. Navigate to `https://dradistab.redteamstuff.com`
2. Wait for content to load fully (JS-heavy)
3. Search for the target domain/application name
4. **IF prior project found:**
   - Note project name, date, status
   - Write to blackboard: `prior_report_found=true`, `prior_project_name=<name>`
   - Proceed to Step 2
5. **IF not found:**
   - Write to blackboard: `prior_report_found=false`
   - Notify analyst, proceed with new engagement immediately

### Step 2 — Read Prior Findings in Dradis Pro (if prior report found)

1. Navigate to `https://dradis.redteamstuff.com`
2. Authenticate with the operator-approved local credentials
3. Open the matching project from DradisTab
4. For each finding, extract and record to blackboard:
   - Finding title
   - CWE reference
   - CVSS score
   - **Action** field (exact reproduction steps — treat as literal script)
   - **Result** field (expected output/evidence)
   - Affected component / URL
5. Notify analyst with full finding list
6. **WAIT for analyst instruction before dispatching any agent:**
   - `"Full engagement"` → run full agent chain
   - `"Repeat [CWE-XXX]"` → dispatch relevant agent with exact Action/Results as context
   - `"Validate all"` → reproduce every prior finding
   - `"New surface only"` → skip already-documented findings

---

## Reading Findings — Critical Rules

See `references/first-try-protocol.md` for the full reproduction protocol. Key rules:

- Treat **Action** and **Result** fields as a literal script — do not deviate
- Identify the **Contextual Anchor** (e.g., "Welcome [Dealer Name]") and verify it matches
- Perform a **Visual Delta Audit** — side-by-side comparison of live browser state vs. report screenshots
- **Home Page Priority** — if result specifies "Home Page", validate there first
- Unlocking a link ≠ Success. The specific data state and identity context must match

---

## Pushing New Findings to Dradis Pro

Only push findings that have passed peer review (primary agent + validator agent both agree, with supporting evidence).

### Finding Format

Every finding must include:

| Field | Required |
|-------|----------|
| Title | Yes — concise, action-oriented |
| Affected Component | Yes — full URL or endpoint |
| CWE | Yes — mapped CWE-XXX |
| CVSS Score | Yes — calculated score + vector string |
| Severity | Yes — Critical/High/Medium/Low/Info |
| Description | Yes — what the vulnerability is |
| Action | Yes — exact reproduction steps (numbered) |
| Result | Yes — what happens, with evidence |
| Business Impact | Yes — concrete impact statement |
| Evidence | Yes — screenshots, request/response, PoC output |

### Priority Classification

- **PRIORITY** (main report body): Shell access, data exfiltration at scale, full auth bypass, internal access, material business impact
- **INFORMATIONAL** (appendix): Real finding but no clear escalation path

### Push Process

1. Navigate to `https://dradis.redteamstuff.com`
2. Open the correct project (verify it belongs to the current authorized engagement)
3. Create new finding with all required fields populated
4. Attach evidence (screenshots, request captures from Burp)
5. Confirm finding saved — notify analyst with Dradis confirmation

---

## References

- `references/first-try-protocol.md` — Full CWE recreation and validation rules
- `references/cvss-quick-ref.md` — CVSS scoring quick reference for common finding types
