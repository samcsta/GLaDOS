# GLaDOS

GLaDOS is a supervised local red team assessment framework built around OpenClaw agents, a local operator dashboard, Burp Suite observability, MCP tools, and local SQLite state. Each red teamer runs their own copy on their own workstation. Nothing is shared between users unless an operator explicitly exports and shares a report.

## Local-Only Model

The Git repo contains application code, scripts, docs, default agent seed templates, and MCP tooling. Runtime data belongs to the operator and lives outside the repo.

| Data | Location |
| --- | --- |
| Default upstream agent seeds | `templates/agents/default/<agent-id>/` |
| User-owned editable agents | `~/.glados/workspaces/agents/<agent-id>/` |
| Reports | `~/.glados/reports/<engagement>/` |
| Evidence | `~/.glados/investigations/<target>/evidence/` |
| Blackboard DB | `~/.glados/blackboard/blackboard.db` |
| Watchdog DB | `~/.glados/watchdog/watchdog.db` |
| OpenClaw config, sessions, memory | `~/.openclaw/` |
| Operator context | `~/.glados/operator-context.json` |
| Local secrets | `.env` and `~/.glados/secrets/local-auth.json` |

Updates never overwrite local agents, reports, investigations, blackboards, watchdog state, `.env`, or OpenClaw sessions.

## First Install

```bash
cp .env.example .env
# edit .env and add your own local LLM API key
scripts/bootstrap-macos.sh
scripts/setup-local-secrets.sh # optional, local workstation only
scripts/glados-doctor.sh
cd dashboard && npm start
```

Bootstrap copies the default agent seeds once into `~/.glados/workspaces/agents`, creates local runtime directories and DBs, installs Node dependencies, and generates `~/.openclaw/openclaw.json` so OpenClaw points at the local editable agents.

Bootstrap also installs a non-secret starter operator context from `templates/operator-context/ford-redteam.json` into `~/.glados/operator-context.json`. That file can contain background knowledge such as Ford-owned domain indicators, ADFS/SSO hosts, Dradis hosts, and reporting paths. It does not grant active testing scope by itself.

Credentials are local-only. Use `scripts/setup-local-secrets.sh` to create `~/.glados/secrets/local-auth.json` with workstation-specific credential profiles. GLaDOS can check which profiles exist, but the MCP status tool intentionally never returns usernames, passwords, tokens, or secret values.

## Updating

```bash
git pull
scripts/update-macos.sh
scripts/glados-doctor.sh
```

`scripts/update-macos.sh` updates code dependencies and regenerates OpenClaw registration from local agents. It does not copy changed seed files over local agents. If upstream templates changed, status is written to:

```text
~/.glados/upstream-agent-status.json
```

That file can show:

- New upstream agent available
- Upstream template changed
- Local agent differs from installed seed
- Local agent removed by user
- Custom local agent detected

Applying upstream agent changes is an operator decision, not an automatic update.

Updates do not overwrite `~/.glados/operator-context.json` or `~/.glados/secrets/local-auth.json`. If the committed operator context template changes, teammates can review it and refresh their local copy intentionally with:

```bash
scripts/setup-operator-context.sh --force
```

## Customizing Agents

Each operator owns their local agents:

```text
~/.glados/workspaces/agents/<agent-id>/
```

Common editable files:

- `IDENTITY.md`
- `SOUL.md`
- `RUNBOOK.md`
- `TOOLS.md`
- `USER.md`
- `AGENTS.md`
- `skills/`
- `agent.json`

To disable an agent, set `"enabled": false` in `agent.json` or add a `.disabled` file in the agent folder, then run:

```bash
scripts/update-macos.sh
```

To add a custom agent, create a new folder under `~/.glados/workspaces/agents/<new-id>/` with an `agent.json` file. The updater will register it without touching upstream seeds.

## Architecture

```mermaid
flowchart TD
  Operator["Operator"] --> Dashboard["GLaDOS Dashboard :4280"]
  Dashboard --> OpenClaw["OpenClaw Gateway ~/.openclaw"]
  OpenClaw --> Agents["Local Agents ~/.glados/workspaces/agents"]
  Agents --> MCPBlackboard["blackboard MCP"]
  Agents --> MCPWatchdog["watchdog MCP"]
  Agents --> MCPOps["glados-ops MCP"]
  Agents --> Browser["Browser / computer-use MCP"]
  MCPBlackboard --> BlackboardDB["~/.glados/blackboard/blackboard.db"]
  MCPWatchdog --> WatchdogDB["~/.glados/watchdog/watchdog.db"]
  MCPOps --> Evidence["~/.glados/investigations"]
  Agents --> Burp["Burp Proxy :8080"]
  Burp --> BurpExt["GLaDOS Burp Extension :1338"]
  BurpExt --> Dashboard
  Dashboard --> Reports["~/.glados/reports"]
```

Core pieces:

- Dashboard: chat, live transcripts, Plans tab, Proxy tab, Reports tab, health banners, halt/resume controls.
- OpenClaw: runs GLaDOS and subagents, stores local sessions, streams JSONL and raw token events.
- Agents: editable local workspaces that define identity, runbook, tools, and skills.
- Blackboard MCP: shared local SQLite state for findings, tasks, baseline recon, plans, approvals, and replans.
- Watchdog MCP: target health, halts, circuit breaker, and deterministic plan dispatch checks.
- GLaDOS ops MCP: scope guard checks, evidence bundle creation, JS/OpenAPI extraction, and safe command planning.
- Operator context: non-secret background knowledge available to GLaDOS through `glados-ops.operator_context`.
- Local auth status: redacted credential-profile availability through `glados-ops.local_auth_status`; credential values stay local and are not returned to agents.
- Burp integration: routes active web traffic through Burp, attributes requests per agent, and exposes proxy history/metrics to the dashboard.

## Web App Assessment Flow

```mermaid
flowchart TD
  Start["Operator starts assessment for https://example.com"] --> Scope["Confirm scope and ROE"]
  Scope --> Health["Probe target health"]
  Health --> Baseline["Phase 1 baseline recon"]
  Baseline --> DirectRecon["Browser recon, endpoints, forms, auth, JS"]
  Baseline --> Prior["Prior report/tracker lookup if available"]
  Baseline --> DnsTls["DNS/TLS/CDN/WAF fingerprint"]
  Baseline --> Osint["OSINT as lower-weight support"]
  DirectRecon --> Summary["Write baseline summary to blackboard"]
  Prior --> Summary
  DnsTls --> Summary
  Osint --> Summary
  Summary --> Plan["plan-synthesizer proposes attack plan"]
  Plan --> Review["Operator reviews in chat and Plans tab"]
  Review --> Approved{"Approved?"}
  Approved -- "No" --> Revise["Modify, reject, or gather more recon"]
  Revise --> Plan
  Approved -- "Yes" --> ACL["Generate per-agent fetch ACL"]
  ACL --> Execute["Phase 3 approved agent execution"]
  Execute --> Candidate["Suspected finding"]
  Candidate --> Validate["Validator agent checks evidence"]
  Validate --> Manual["Operator manually inspects important findings"]
  Manual --> Replan{"Unlocks new vectors?"}
  Replan -- "Yes" --> Plan
  Replan -- "No" --> Report["report-writer creates local report"]
```

## Simulated Example: `https://example.com/`

1. The operator tells GLaDOS: assess `https://example.com/`.
2. GLaDOS confirms scope and probes target health through watchdog.
3. Phase 1 begins. `webapp-recon` opens the site with the browser MCP, maps pages and forms, records headers and cookies, and identifies a search endpoint at `/search?q=`.
4. DNS/TLS data is recorded. Prior report lookup finds no prior findings. OSINT finds public references, but GLaDOS treats that as lower-weight support.
5. GLaDOS writes a baseline summary to the blackboard.
6. `plan-synthesizer` proposes a plan:
   - Test search/query parameters for SQL injection, CWE-89.
   - Test object IDs for IDOR, CWE-639.
   - Review JavaScript endpoints for API exposure.
   - Keep testing low-rate and route active traffic through Burp.
7. GLaDOS tells the operator the plan in chat. The same plan appears in the Plans tab for approve, selected approve, modify, or reject.
8. The operator approves the SQL injection validation vector.
9. The approved plan generates a fetch ACL so only the selected agents can touch the scoped hosts.
10. `webapp-vuln` tests the approved parameter and observes SQL error behavior. It reports evidence, confidence, endpoint, request/response summary, and risk.
11. `webapp-validator` independently checks the behavior with safe negative controls.
12. GLaDOS asks the operator to manually inspect the evidence before treating it as confirmed.
13. If confirmed, GLaDOS records the finding in the blackboard and asks whether follow-on testing is allowed. If the finding unlocks a new vector, GLaDOS halts and proposes a replan.
14. `report-writer` writes the report under `~/.glados/reports/example-com-YYYYMMDD/`.
15. `report-validator` reviews it before handoff.

## Reports

Reports are local-only:

```text
~/.glados/reports/<engagement>/
```

Evidence bundles and screenshots are local-only:

```text
~/.glados/investigations/<target>/evidence/
```

The dashboard Reports tab reads from the local reports and investigations roots. To export a report:

```bash
scripts/export-report.sh <engagement>
```

The export is written under:

```text
~/.glados/exports/
```

## Repo Hygiene

Before pushing:

```bash
scripts/prepush-secret-scan.sh
```

The scan blocks common credential patterns and runtime artifacts such as `.env`, reports, investigations, DBs, sessions, Burp exports, and known private identifiers. Keep operator data in `~/.glados` and `~/.openclaw`, not in Git.

## Production Readiness Checks

```bash
scripts/glados-doctor.sh
```

Doctor verifies:

- Runtime paths are outside the repo.
- OpenClaw agents point at `~/.glados/workspaces/agents`.
- Reports and investigations are local.
- Local DB paths exist.
- Secret scan passes for distributable source.
