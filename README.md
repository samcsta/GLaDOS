# GLaDOS

GLaDOS v4.5.8 is a local Electron application for supervised red-team assessment. The Claude Agent SDK runs the coordinator and named specialists against the LiteLLM Anthropic Messages endpoint. Blackboard, watchdog, GLaDOS Ops, and per-agent Playwright browser servers are attached as MCP servers.

The application has no OpenClaw or Burp Suite runtime dependency. HTTP capture, replay, history, metrics, and per-agent attribution are provided by a supervised local mitmproxy process behind `/api/proxy/*`. Signed macOS packages include the pinned official Apple-silicon mitmproxy runtime; Linux and Windows first-time installers provision the pinned command-line runtime.

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

Updates never include or delete the GLaDOS runtime directory (`~/.glados` on macOS/Linux and the equivalent user-profile path on Windows). The LiteLLM key is stored in macOS Keychain, with a private per-user file fallback on Linux and Windows; it does not belong in `.env`.

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

Internal macOS operators should follow the full
[Gitea macOS installation guide](docs/install-macos-from-gitea.md). The
desktop target matrix is Apple Silicon macOS, Debian-family Linux (including
Kali and Ubuntu) x86-64, Fedora x86-64, and Windows x64. Windows appears on the
production download page only after its signed native release gates pass.
macOS prerequisites are Apple Command Line Tools, Homebrew, and Node 20 or 22.

```bash
xcode-select --install
brew install node@22 git
brew link --overwrite --force node@22

GITEA_OWNER='your-gitea-repository-owner'
git clone "git@git.r3dt34m.net:${GITEA_OWNER}/glados.git" GLaDOS
cd GLaDOS
scripts/bootstrap-macos.sh
scripts/setup-llm-secret.sh
scripts/glados-ca.sh trust
scripts/glados-doctor.sh
scripts/install-desktop-app.sh
open /Applications/GLaDOS.app
```

After launch, open **Settings → Setup Assistant** to complete workstation
configuration without using Terminal. The guided flow stores the LiteLLM key
in macOS Keychain, optionally writes allowlisted local credential profiles
with owner-only permissions, generates and trusts that Mac's unique proxy CA,
and verifies model discovery, a live Anthropic Messages request, and the
bundled proxy.

To remove the application while preserving operator data for a reinstall:

```bash
scripts/uninstall-desktop-app.sh
```

Use `scripts/uninstall-desktop-app.sh --purge-data` only when the local
workspaces, reports, investigations, credentials, proxy history, and databases
should also be removed. Filesystem data is moved to Trash; the LiteLLM
Keychain item and GLaDOS MITM CA trust are deleted. The macOS DMG also includes
a separately signed and notarized **Uninstall GLaDOS.app**. Uninstall also
unregisters the installed and trashed bundles from Launch Services and
refreshes Spotlight metadata for `/Applications` so GLaDOS no longer appears
as an installed application in Spotlight.

For a first installation, connect to the Red Team VPN and open
`https://updates.r3dt34m.net/`. The download page offers only installers that
have passed their platform release gates and are currently published. After
installation, GLaDOS uses the same private origin for in-app updates.

Linux users should choose **Download easy installer** and run the downloaded
script with `bash ~/Downloads/install-glados-linux.sh`. It detects
Debian/Kali/Ubuntu or Fedora, installs the required runtime tools, places
GLaDOS in the application menu, and uses a stable AppImage path that the
in-app updater can replace.

On a supported Linux x86-64 workstation, bootstrap and install the AppImage
for the current user:

```bash
scripts/bootstrap-linux.sh
scripts/setup-llm-secret.sh
scripts/glados-ca.sh trust
scripts/glados-doctor.sh
scripts/install-desktop-app-linux.sh
~/.local/opt/glados/GLaDOS.AppImage
```

Windows x64 users should download `install-glados-windows.ps1` from the VPN
landing page and run it in PowerShell. The script provisions the required CLI
runtime, verifies both the update metadata hash and the installer's
Authenticode signature, and launches the per-user NSIS installer. Complete CA
trust and LiteLLM setup in **Settings → Setup Assistant** after first launch.

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

Packaged instances use the Red Team VPN-only HTTPS feed through `electron-updater`. GLaDOS derives the correct platform feed automatically, checks after startup and every six hours, and shows a compact banner only when a newer release is available. **Update GLaDOS** downloads and verifies the release, snapshots runtime state, installs it, and restarts the app in one action; installation remains blocked while agents are active. Developer ID/Authenticode signing and Linux artifact verification are release-time requirements. Updates replace the application only; per-user runtime state remains outside the payload and is snapshotted before installation.

## Models And Agents

Edit agent behavior under `~/.glados/workspaces/agents/<agent-id>/`. Prompt assembly order is `IDENTITY.md`, `SOUL.md`, `RUNBOOK.md`, `TOOLS.md`, `USER.md`, `AGENTS.md`, followed by discovered `skills/` metadata.

Use the Settings model picker or edit `~/.glados/model-overrides.json`. Settings queries LiteLLM's authenticated `/v1/models` catalog each time it opens, excludes embedding-only entries, and validates new selections against a fresh catalog response. Existing assignments that were removed upstream remain visible as unavailable until the operator selects a live replacement. Overrides must contain bare gateway aliases. High-risk `c2-*`, `phish-*`/`phisherman`, and `postex*` agents remain disabled until the operator explicitly enables them.

## Security Review Campaigns

Run `/security-review` in GLaDOS Chat to open the native repository chooser.
The default is the expedited, completion-driven workflow. Select a single
repository for one review, or a parent containing multiple Git repositories
for an automatically detected portfolio campaign. Use `/security-review
--full` when you want the comprehensive workflow instead.

```text
/security-review
/security-review --full
```

GLaDOS creates one durable campaign, gives every direct child repository a
required blind breadth pass, and then spends the remaining discovery budget on
the highest-risk trust boundaries and vulnerability classes. The default
expedited campaign has no wall-clock or fixed discovery-attempt ceiling. It
stops only after every repository received its breadth pass and three
consecutive successful passes produced no new canonical candidates. Up to
three passes run concurrently by default, and coordinator continuations resume
from durable artifacts instead of initializing a new review.

Expedited mode does not waive deterministic file coverage, semantic candidate
closure, specialist artifacts, model receipts, or independent High/Critical
validation. A campaign cannot pass its hard gates if a repository is omitted,
partial, blocked, deferred, or represented as clean without evidence.

## Verification

```bash
npm test --prefix dashboard
scripts/glados-doctor.sh
npm run pack --prefix desktop
npm run verify:pack --prefix desktop
npm run smoke:kali:docker --prefix desktop
npm run smoke:fedora:docker --prefix desktop
```

The release marker is `v4.5.8`. Build artifacts are written under
`artifacts/desktop/` and use the product name `GLaDOS`, so the bundle remains
`GLaDOS.app`.
