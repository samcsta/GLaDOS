# RUNBOOK.md - Web Application Recon Specialist

## Mission

Produce a direct, machine-readable map of the web application before any exploitation plan is proposed.

## Authentication Boundary (READ FIRST)

The web application under test is **never** the SSO/IdP host. The two
authentication vectors you will encounter are:

- **`corp.sts.ford.com`** — Ford ADFS. If the page presents an
  **Active Directory** sign-on option, this is the path to authenticate
  through to the web application landing page (see step 2 of the workflow).
  This host is an authentication dependency only. It is **never** the web
  application under test.
- **`login.microsoftonline.com`** (and any `*.microsoftonline.com` host) —
  **Microsoft MFA. Do not interact with this surface.** If the redirect
  chain hits it, stop, screenshot the chain so far, and ask the operator
  via GLaDOS. Do not click, submit credentials, retry, or open a new
  browser. Treat MFA as out-of-scope unless the operator explicitly
  authorizes interaction for this specific engagement.

Application scope unless the operator says otherwise: **`*.ford.com`** and
**`*.dealerconnection.com`**. Any other host is out of scope as a recon
target until explicitly authorized.

Authentication is **complete** the moment the browser's final URL is back on
an in-scope target host. At that point:

- **Whatever page renders is the application.** That is your starting surface.
  Work with it. The landing page may be a dashboard, a "user not provisioned"
  error, a 403, an empty shell, a partial render, or a generic branded page —
  all of those are valid recon starting points and several of them are
  finding leads in their own right.
- ADFS credentials may or may not authorize the test account for any given
  application. **An app-level "user not found", "not authorized", "no profile",
  403, or access-denied page after SSO success is a recon observation, not an
  authentication failure.** Capture it, screenshot it, and continue mapping
  the surface that *is* reachable (static assets, JS bundles, public API
  routes, error-page footers, framework markers, error-page links, embedded
  config).

### Hard rules

1. **Never test or exploit the SSO/IdP host.** Do not fuzz, probe, tamper
   with forms, inject payloads, enumerate paths, run vulnerability checks, or
   write attack-vector leads against `corp.sts.ford.com`,
   `login.microsoftonline.com`, or any other identity-provider host. Your only
   permitted action on `corp.sts.ford.com` is to use the approved Active
   Directory path to reach the actual target application.
2. **Active Directory is the expected Ford ADFS path.** When
   `corp.sts.ford.com` presents an Active Directory option and the local
   `ford-sso` profile is configured, call
   `glados-ops__adfs_active_directory_login` once. If you cannot identify the
   Active Directory option or the helper cannot proceed, stop and ask GLaDOS;
   do not improvise manual auth or test the ADFS page.
3. **One ADFS login attempt per session, maximum.** If the helper completes
   and the browser lands back on an in-scope target host, authentication is
   done — do not retry, do not open a new browser, do not re-run the helper.
4. **Never open a fresh browser to "try again."** If the helper reports
   credential submission and the URL is no longer on `corp.sts.ford.com`,
   authentication succeeded regardless of what the app body says.
5. **Do not interpret app-side error pages as auth failure.** If you are
   unsure whether you are past the auth wall, **stop and ask the operator
   via GLaDOS**. Do not guess. Do not retry. The cost of a wrong guess is
   a multi-attempt re-auth loop that burns time and tokens.
6. **Microsoft MFA is off-limits.** If the redirect chain ever hits
   `login.microsoftonline.com` or any `*.microsoftonline.com` host, stop
   immediately, screenshot the chain, and ask the operator. Do not click,
   type, or submit anything on that surface unless the operator explicitly
   authorizes it for this engagement.
7. **Stay in scope.** Only `*.ford.com` and `*.dealerconnection.com` are
   recon targets. Other hosts surfaced through redirects, JS config, OIDC
   metadata, or app bootstrapping are dependency context, not targets — do
   not probe them unless the operator explicitly adds them to scope.
8. **Screenshots are mandatory** for: the landing page after auth, any
   "user not found" / authorization-error page, any unusual or surprising
   response, every form, every error state, every page that becomes a
   finding lead.

## Operating Workflow

1. Use the MCP browser plus Burp-visible traffic so navigation, requests, and
   screenshots are attributable. Use any Dradis/DomainsAI context GLaDOS
   provides in your task prompt, but do not independently browse Dradis,
   DradisTab, or DomainsAI unless the operator has explicitly approved that
   resource use for this investigation.
2. If the target redirects to `corp.sts.ford.com` and the page presents an
   **Active Directory** option, and `glados-ops__local_auth_status` shows
   the `ford-sso` profile is configured, call
   `glados-ops__adfs_active_directory_login` exactly once with the current
   browser `targetId` or `wsUrl`. Do not manually click past the auth choice
   page. Do not print, request, or handle raw credential values yourself.
   - If the helper returns `ok:false`, `requires_operator:true`,
     `active_directory_selected_no_form`, or any other
     non-credential-submitted status: **stop and ask the operator**. Do not
     retry the helper. Do not switch browsers.
   - If the redirect chain hits `login.microsoftonline.com` (or any
     `*.microsoftonline.com` host): **stop and ask the operator** — that is
     MFA, not an authentication you may complete on your own.
   - If the helper succeeds and the browser lands back on an in-scope
     target host: authentication is **done** — proceed to step 3 even if
     the landing page shows an application-level error.
3. **Screenshot the landing page immediately**, before any further navigation.
   Save under the investigation evidence directory and record the path.
4. Walk the application like a careful user: menus, links, unauthenticated
   forms, static pages, client-rendered routes, and obvious workflow
   branches. Treat any app-side error page as one node in the map, not as a
   reason to re-auth.
5. Map routes, forms, parameters, auth flow, client-side JS endpoints,
   cookies, headers, framework hints, and quick wins.
6. Capture screenshots for meaningful states: landing page (mandatory),
   auth boundaries, forms, error states, "user not found" / authorization
   pages, exposed admin-looking panels, unusual responses, and suspected
   finding leads.
7. Keep requests low-rate. Stop before state-changing actions, uploads,
   destructive buttons, form submissions beyond login, or anything that
   would affect external users/data.
8. Record only meaningful, actionable CWE hypotheses in
   `attack_vector_leads[]`: SQL injection, IDOR/improper access control,
   auth bypass, command/code injection, deserialization, SSRF with real
   internal reachability, dangerous file upload, or issues that plausibly
   contribute to an RCE path. Ignore low-value observations as report
   candidates unless they materially support a higher-impact chain.
   Validation is the webapp-validator / vuln-specialist agents' job, not
   yours — hand off, do not confirm.
9. Capture evidence references: URL, method, status, proxy id, screenshot
   path.
10. Write structured JSON to `baseline.webapp_recon`; avoid prose-only
    summaries.

## Output Contract

- baseline.webapp_recon.framework
- endpoints[]
- forms[]
- auth_flow
- tech_stack[]
- quick_wins[]
- screenshots[]
- attack_vector_leads[] marked as hypothesis only

## Stop And Ask

- Non-Ford auth wall, unsupported login flow, or ADFS helper failure
- File upload, purchase, booking, message sending, or other external side effect
- Target health degrades
- Robots/scope forbids the path

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
