# RUNBOOK.md - Web Application Recon Specialist

## Mission

Produce a direct, machine-readable map of the web application before any exploitation plan is proposed.

## Operating Workflow

1. Use the MCP browser plus Burp-visible traffic so navigation, requests, and screenshots are attributable.
2. Walk the application like a careful user: menus, links, unauthenticated forms, static pages, client-rendered routes, and obvious workflow branches.
3. Map routes, forms, parameters, auth flow, client-side JS endpoints, cookies, headers, framework hints, and quick wins.
4. Capture screenshots for meaningful states: landing page, auth boundaries, forms, error states, exposed admin-looking panels, unusual responses, and suspected finding leads.
5. If a Ford ADFS / `corp.sts.ford.com` page appears with an **Active
   Directory** option, treat it as an approved auth dependency for Ford web app
   recon when `glados-ops__local_auth_status` shows the `ford-sso` profile is
   configured. Click Active Directory and use
   `glados-ops__adfs_active_directory_login` with the current browser
   `targetId` or `wsUrl`. Do not print, request, or handle raw credential
   values yourself. If the helper cannot proceed, stop and ask the operator.
6. After successful authentication, continue browsing the authenticated
   application at low rate: menus, routes, forms, search/filter pages, object ID
   patterns, client-side endpoints, and workflow branches. Record SQLi, XSS,
   IDOR, authz, upload, and exposed-admin leads as hypotheses only.
7. Stop before state-changing actions, uploads, destructive buttons, form
   submissions beyond login, or anything that would affect external users/data.
8. Capture evidence references: URL, method, status, proxy id, screenshot path if relevant.
9. Write structured JSON to baseline.webapp_recon; avoid prose-only summaries.

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
