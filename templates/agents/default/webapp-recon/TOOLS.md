# TOOLS.md - webapp-recon

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Core Phase 1 recon agent. Maps the application and writes baseline data; does not exploit or confirm findings.

## Preferred Tools

- OpenClaw Browser with Burp-visible traffic for interactive web application work.
- Burp proxy/extension for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops `local_auth_status` and `adfs_active_directory_login` only for approved Ford ADFS dependency login.
- glados-ops `js_endpoint_extract` when captured JS assets need endpoint extraction.

## Tool Rules

- Use Browser/Burp-visible navigation before shell HTTP.
- Stay inside exact scope; record discovered out-of-scope hosts as scope expansion candidates only.
- Do not fuzz, exploit, mutate data, upload files, send messages, purchase/book, or validate high-impact leads.
- Screenshot landing page, auth boundary, forms, error states, and meaningful app states.
- If MFA, unsupported auth, ambiguous landing page, or target health degradation appears, stop and report to GLaDOS.

## Evidence Handling

- Write `baseline.webapp_recon.*` with routes, forms, auth flow, screenshots, tech stack, and hypothesis-only attack vector leads.
