# TOOLS.md - webapp-recon

This file defines the tools this agent should prefer, avoid, and document. It is role-specific guidance, not a place for generic personal-device notes.

## Dispatch Posture

Core Phase 1 recon agent. Maps the application and writes baseline data; does not exploit or confirm findings.

## Preferred Tools

- Agent SDK Browser with proxy-visible traffic for interactive web application work.
- GLaDOS native proxy for request and response evidence; keep target HTTP(S) observable unless the operator approves an exception.
- Blackboard MCP (`blackboard_*`) for tasks, baseline data, findings, validation state, and audit notes.
- Watchdog MCP (`target_health`, `plan_check_dispatch`) for health and phase gates.
- glados-ops `local_auth_status` and `adfs_active_directory_login` only for approved Ford ADFS dependency login.
- glados-ops `js_endpoint_extract` for a quick first pass over captured assets;
  this never replaces the required `js-reverser` handoff.

## Tool Rules

- Use Browser/proxy-visible navigation before shell HTTP.
- For an operator-requested proxy smoke test, do exactly one GET through
  `$GLADOS_PROXY_URL` with `X-GLaDOS-Agent: webapp-recon`, report the status
  and redirect, then stop. Do not convert the diagnostic into recon.
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
- Prefer snapshot/find/fill/click/upload tools over `browser_run_code_unsafe`.
  `browser_evaluate` takes a function string and has no `page` variable.
  `browser_run_code_unsafe` has a Node callback; create browser globals such as
  `URLSearchParams` inside `page.evaluate`, not in that outer callback.
- Create upload payloads under `~/.glados/investigations` or
  `~/.glados/workspaces`, never `/tmp`. After clicking a file input and opening
  the chooser, call `browser_file_upload` immediately; do not click again.
- Stay inside exact scope; record discovered out-of-scope hosts as scope expansion candidates only.
- Do not fuzz, exploit, mutate data, upload files, send messages, purchase/book, or validate high-impact leads.
- Inspect raw HTML/DOM attributes in addition to accessibility snapshots and
  extract UUIDs, hidden inputs, classes, `data-*` fields, comments, and object
  identifiers from every distinct template.
- Capture every observed inline/external JavaScript artifact, worker, source
  map, bootstrapped JSON/config, and dynamically loaded chunk. Save in-scope
  bodies with hashes and return a complete `js_handoff` to GLaDOS; never omit a
  script because it looks small.
- Capture complete proxy-visible request shapes for state-changing workflows,
  including hidden authorization/ownership fields, without submitting them.
- Screenshot landing page, auth boundary, forms, error states, and meaningful app states.
- After any privilege or authentication pivot, remap the newly visible surface
  and inventory every form/search/filter/import/export input before declaring
  recon complete.
- If MFA, unsupported auth, ambiguous landing page, or target health degradation appears, stop and report to GLaDOS.

## Evidence Handling

- Write `baseline.webapp_recon.*` with routes, forms, auth flow, raw artifacts,
  identity graph, request shapes, JavaScript manifest/handoff, screenshots,
  technology, coverage ledger, and hypothesis-only meaningful CWE leads.
