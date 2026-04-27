# GLaDOS Agent and MCP Upgrade

Date: 2026-04-26

## What changed

- Added role-specific `RUNBOOK.md` files for the existing GLaDOS specialist agents.
- Updated agent boot order so agents read `RUNBOOK.md` when present.
- Added six recommended agents:
  - `evidence-curator`
  - `scope-guardian`
  - `js-reverser`
  - `graphql-specialist`
  - `cloud-exposure`
  - `mobile-api-recon`
- Added the `glados-ops` MCP server for operational helper tools.
- Updated the dashboard Settings view to show each agent's `RUNBOOK.md`.
- Updated plan-gate, plan approval ACL generation, GLaDOS SOUL/playbook docs, and plan-synthesizer schema so the new agents fit the Phase 1 / Phase 3 workflow.
- Aligned the OpenClaw LLM idle timeout with the long-reasoning provider timeout: `1200` seconds.

## New MCP tools

The `glados-ops` MCP server exposes:

- `scope_guard_check` - checks scope, health, and plan approval before an action.
- `evidence_bundle_create` - creates durable evidence bundle manifests.
- `js_endpoint_extract` - extracts endpoints, routes, GraphQL operation names, and secret-like key names from JS text or local files.
- `openapi_inventory` - inventories OpenAPI JSON paths, methods, servers, and auth schemes.
- `tool_availability` - reports whether local helper CLIs are installed.
- `safe_ffuf_command` - builds a low-rate ffuf command for operator review without executing it.

## Agent classing

- Phase 1 agents: `osint`, `origin-ip`, `net-recon`, `webapp-recon`, `source-code`, `plan-synthesizer`, `js-reverser`, `mobile-api-recon`.
- Meta agents: `glados`, `atlas`, validators, report agents, `ai-specialist`, `evidence-curator`, `scope-guardian`.
- Exploitation-tier agents requiring approved plans include `webapp-vuln`, `api-expert`, `graphql-specialist`, `cloud-exposure`, `poc-coder`, `postex`, AD, C2, and phishing specialists.

## Verification snapshot

- Dashboard health: healthy.
- Burp proxy health: healthy.
- Burp extension API: healthy.
- ALS, SSRF, and plan-gate patch markers: healthy.
- Agent registry: 31 agents.
- New agents present: yes.
- `glados-ops` registered in OpenClaw MCP list: yes.
- GLaDOS chat smoke: passed.
- Atlas chat smoke: passed.
- Browser console during dashboard Settings verification: no errors or warnings.

## Tooling Install Update

Installed and verified:

- `ffuf`
- `httpx`
- `nuclei`
- `semgrep`
- `ghidraRun`
- `analyzeHeadless`
- `jadx`
- `apktool`
- `bloodhound-python`
- `certipy`
- `nmap`
- `sqlmap`
- `uv`

Local wrappers were added under `tools/bin/`:

- `tools/bin/analyzeHeadless` sets `JAVA_HOME` for Homebrew OpenJDK 21.
- `tools/bin/sqlmap` sets `DYLD_LIBRARY_PATH` for Homebrew `expat`, avoiding the Python 3.14 `pyexpat` runtime issue seen on this host.

`~/.openclaw/openclaw.json` now prepends `tools/bin`, `~/.local/bin`, and Homebrew paths to the OpenClaw environment so agents can find the installed tools.

## Browser Recon Clarification

`webapp-recon` is responsible for MCP-browser-driven, Burp-visible web application walkthroughs during Phase 1. Its runbook now explicitly instructs it to capture screenshots for meaningful states, map routes/forms/auth/JS/client behavior, and write `attack_vector_leads[]` as hypotheses only. Exploitation-tier testing still waits for GLaDOS plan synthesis and operator approval.
