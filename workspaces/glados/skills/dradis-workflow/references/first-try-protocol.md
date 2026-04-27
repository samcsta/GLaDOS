# First Try Protocol — CWE Recreation & Validation

Source: REDTEAM_MASTER.md §7

## Core Principle

When recreating a finding from a prior Dradis report, the **Action** and **Result** fields are a literal script. Do not look for alternate bypasses unless the primary method explicitly fails.

---

## Step-by-Step Validation Protocol

### 1. Read the Report Literally

- Extract the exact **Action** steps — number them if not already numbered
- Extract the expected **Result** — note specific visual markers, data states, identity context
- Do not interpret, generalize, or optimize. Follow exactly.

### 2. Identify the Contextual Anchor

Every successful finding has a contextual anchor — a specific UI element or data state that proves the bypass worked as reported:

- Examples: `"Welcome, [Dealer Name]"`, specific account data populated, specific error message absent
- The anchor must be present in your live browser state for validation to succeed
- If the anchor is absent, the finding is **not reproduced** — even if you achieved some form of access

### 3. Execute the Action Steps

- Use OpenClaw Browser MCP to follow steps exactly
- Take a screenshot after each significant step
- Do not skip steps, reorder steps, or substitute equivalent actions

### 4. Visual Delta Audit

Perform a side-by-side comparison:
- **Left:** Live browser snapshot (current state)
- **Right:** Original Dradis report screenshot(s)

Explicitly confirm:
- Same page/URL (or documented reason for difference)
- Same greeting / top-right identity context
- Same data population state
- Same error handling behavior

### 5. Home Page Priority

If the report result specifies "Home Page" or "Front Page":
- Validate **there first**
- Do not assume a bypass in a sub-module satisfies a front-page requirement
- Explicitly navigate to the root/home after any bypass before declaring success

### 6. Functional Confirmation Bias — Warning

**Unlocking a link is NOT a success.**

The following do NOT count as reproduction unless the report explicitly states them as the result:
- Being able to navigate to a URL
- Receiving a 200 response
- Seeing a login form bypass
- Accessing any page

Only the **specific data state and identity context defined in the report** constitutes success.

---

## Validator Agent Checklist

Before declaring a finding validated:

- [ ] Followed Action steps exactly (no deviation)
- [ ] Contextual anchor is present and matches report
- [ ] Visual delta audit completed — screenshots compared
- [ ] Home page validated if report specifies it
- [ ] Evidence captured: screenshots, request/response, Burp traffic
- [ ] Both primary agent and validator agree on outcome
- [ ] Discrepancies flagged for further investigation (not silently resolved)
