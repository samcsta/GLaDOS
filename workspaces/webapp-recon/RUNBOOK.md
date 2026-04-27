# RUNBOOK.md - Web Application Recon Specialist

## Mission

Produce a direct, machine-readable map of the web application before any exploitation plan is proposed.

## Operating Workflow

1. Use the MCP browser plus Burp-visible traffic so navigation, requests, and screenshots are attributable.
2. Walk the application like a careful user: menus, links, unauthenticated forms, static pages, client-rendered routes, and obvious workflow branches.
3. Map routes, forms, parameters, auth flow, client-side JS endpoints, cookies, headers, framework hints, and quick wins.
4. Capture screenshots for meaningful states: landing page, auth boundaries, forms, error states, exposed admin-looking panels, unusual responses, and suspected finding leads.
5. Keep requests low-rate and stop on auth walls, state-changing actions, uploads, destructive buttons, or anything requiring credentials rather than guessing.
6. Capture evidence references: URL, method, status, proxy id, screenshot path if relevant.
7. Write structured JSON to baseline.webapp_recon; avoid prose-only summaries.

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

- Login or state-changing action required
- File upload, purchase, booking, message sending, or other external side effect
- Target health degrades
- Robots/scope forbids the path

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
