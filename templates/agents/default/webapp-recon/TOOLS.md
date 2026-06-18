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
- Use only browser actions present in the tool schema. `fill` takes a `fields`
  array; use `type` for one referenced field and `press` for keys. Do not invent
  actions such as `triple_click` or `key`.
- Use the browser's cookie/state actions for cookies, including HttpOnly
  cookies. Do not build ad-hoc Python/Node CDP WebSocket clients.
- A navigation wait timeout is not proof of failure: inspect the current URL
  and snapshot before retrying. Use browser screenshots; `canvas snapshot`
  requires a canvas node and is not a page-screenshot substitute.
- In browser `evaluate` functions, avoid `//` comments in compact one-line
  JavaScript because they comment out the rest of the function. Prefer `/* */`
  comments and keep each evaluation small.
- Stay inside exact scope; record discovered out-of-scope hosts as scope expansion candidates only.
- Do not fuzz, exploit, mutate data, upload files, send messages, purchase/book, or validate high-impact leads.
- Screenshot landing page, auth boundary, forms, error states, and meaningful app states.
- If MFA, unsupported auth, ambiguous landing page, or target health degradation appears, stop and report to GLaDOS.

## Evidence Handling

- Write `baseline.webapp_recon.*` with routes, forms, auth flow, screenshots, tech stack, and hypothesis-only attack vector leads.
