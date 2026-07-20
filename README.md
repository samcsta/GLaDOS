# GLaDOS

GLaDOS v4.0.0 is a local Electron application for supervised red-team assessment. The Claude Agent SDK runs the coordinator and named specialists against the LiteLLM Anthropic Messages endpoint. Blackboard, watchdog, GLaDOS Ops, and per-agent Playwright browser servers are attached as MCP servers.

The application has no OpenClaw or Burp Suite runtime dependency. HTTP capture, replay, history, metrics, and per-agent attribution are provided by a supervised local mitmproxy process behind `/api/proxy/*`.

## Operator Data

Application code is replaceable. Operator data is not.

| Data | Location |
| --- | --- |
| Editable agent workspaces | `~/.glados/workspaces/agents/<agent-id>/` |
| Agent SDK resume registry | `~/.glados/sessions/agent-sdk-sessions.json` |
| Reports | `~/.glados/reports/` |
| Investigations and evidence | `~/.glados/investigations/` |
| Blackboard | `~/.glados/blackboard/blackboard.db` |
| Watchdog and halt audit | `~/.glados/watchdog/`, `~/.glados/halts/` |
| Redacted proxy traffic | `~/.glados/traffic/` |
| MITM CA and fallback secrets | `~/.glados/secrets/` |
| Per-agent model overrides | `~/.glados/model-overrides.json` |

Updates never include or delete `~/.glados`. The LiteLLM key is stored in macOS Keychain, with a `0600` file fallback; it does not belong in `.env`.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `dashboard/` | Local API server and renderer application |
| `desktop/` | Electron main/preload source and packaging configuration |
| `templates/agents/default/` | Versioned seeds for fresh agent workspaces |
| `blackboard/`, `watchdog/`, `tools/` | Runtime services and MCP implementations |
| `config/` | Versioned policy and tool manifests |
| `scripts/` | Bootstrap, update, diagnostics, and operator utilities |
| `artifacts/desktop/` | Disposable generated Electron packages; never committed |
| `~/.glados/` | The only operator runtime root; never part of the repository |

There is intentionally no repo-local `workspaces/`, `Reports/`,
`investigations/`, or `.glados/` runtime. Fresh installs seed editable agents
from `templates/agents/default/` into `~/.glados/workspaces/agents/` without
overwriting operator edits.

## Install

Prerequisites are macOS, Apple Command Line Tools, Homebrew, and Node 20 or 22.

```bash
xcode-select --install
brew install node@22 git
brew link --overwrite --force node@22

git clone https://github.com/samcsta/GLaDOS.git
cd GLaDOS
scripts/bootstrap-macos.sh
scripts/setup-llm-secret.sh
scripts/glados-ca.sh trust
scripts/glados-doctor.sh
scripts/install-desktop-app.sh
open /Applications/GLaDOS.app
```

Bootstrap installs the app/MCP dependencies, the required core CLI set, seeds missing agent workspaces without overwriting operator edits, creates the runtime databases, and generates a unique local MITM CA. `scripts/setup-redteam-tools.sh --all --install` installs the wider specialist tool set.

## Launch

```bash
open /Applications/GLaDOS.app
```

The app is named `GLaDOS.app`; the in-window title is `GLaDOS Ops`. Electron allocates a dynamic loopback port for the dashboard. For source-only development, run `npm start --prefix desktop`. For server-only development, run `npm start --prefix dashboard` and use the URL printed by the server.

## Runtime

- `@anthropic-ai/claude-agent-sdk@0.3.207` streams partial messages directly to the dashboard.
- `ANTHROPIC_BASE_URL` defaults to `https://llmapi.redteamstuff.com`; models use bare aliases such as `claude-sonnet-5`.
- Every enabled agent mounts Bash plus its role tools. Only GLaDOS mounts Task/Agent dispatch.
- The authoritative `PreToolUse` gate enforces agent enablement, operator halt, tool existence, dispatch policy, plan phase, scope, target health, proxy attribution, and secret boundaries.
- Browser-capable agents receive isolated Playwright MCP servers with an immutable per-agent header. The proxy records and strips that header before forwarding upstream.
- Halt is per agent. A halt marker immediately interrupts that agent's root turn or its parent GLaDOS turn and is shown to GLaDOS on the next turn.

## Proxy

The desktop supervisor starts mitmproxy on `127.0.0.1:18080`. Captured events are redacted, rotated, and retained for 14 days by default. Sensitive headers and common JSON/form secret fields are replaced with `[REDACTED]`. Raw mitmproxy flow files are disabled unless `GLADOS_PROXY_RAW_FLOWS=1` is explicitly set.

Manage the per-operator CA with:

```bash
scripts/glados-ca.sh status
scripts/glados-ca.sh trust
scripts/glados-ca.sh untrust
scripts/glados-ca.sh rotate
```

## Updates

Source checkouts use the operator-initiated Settings update button or `scripts/update.sh`. The app blocks normal updates while agents are active or the tree is dirty, streams progress over SSE, then asks the Electron supervisor to restart the dashboard child.

Packaged instances use an authenticated generic HTTPS feed through `electron-updater`. Each operator stores a per-user feed token with the OS credential store and chooses when to check, download, and install. Developer ID signing, hardened runtime, and notarization are release-time requirements. Updates replace the app bundle only; runtime state under `~/.glados` remains outside the payload and is snapshotted before installation.

## Models And Agents

Edit agent behavior under `~/.glados/workspaces/agents/<agent-id>/`. Prompt assembly order is `IDENTITY.md`, `SOUL.md`, `RUNBOOK.md`, `TOOLS.md`, `USER.md`, `AGENTS.md`, followed by discovered `skills/` metadata.

Use the Settings model picker or edit `~/.glados/model-overrides.json`. Settings queries LiteLLM's authenticated `/v1/models` catalog each time it opens, excludes embedding-only entries, and validates new selections against a fresh catalog response. Existing assignments that were removed upstream remain visible as unavailable until the operator selects a live replacement. Overrides must contain bare gateway aliases. High-risk `c2-*`, `phish-*`/`phisherman`, and `postex*` agents remain disabled until the operator explicitly enables them.

## Verification

```bash
npm test --prefix dashboard
scripts/glados-doctor.sh
npm run pack --prefix desktop
npm run verify:pack --prefix desktop
```

The release marker is `v4.0.0`. Build artifacts are written under
`artifacts/desktop/` and use the product name `GLaDOS`, so the bundle remains
`GLaDOS.app`.
