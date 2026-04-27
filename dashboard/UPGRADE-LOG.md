# GLaDOS Gen 2 → v3.0 Upgrade Log

Complete record of the operator-dashboard + guardrail rebuild kicked off after the
`www-ffs.app.ford.com` engagement on **2026-04-17**. Work landed between
2026-04-17 and 2026-04-19.

## 0 — Why v3.0 exists

Gen 2 hit four compounding operational failures on the FFS engagement:

1. **Kill didn't stop work.** `sessions_send` can queue a stop but cannot interrupt
   an in-flight browser-MCP tool call. Tabs kept opening for minutes after halt.
2. **Zero multi-agent visibility.** `/subagents` returned empty; operator had to
   `tail -f` per-agent JSONLs to see what was happening.
3. **$200 burned on a dead target.** No target-health awareness — agents kept
   firing at a host that returned HTTP 500 for ~40 minutes.
4. **Knocked target offline.** No rate limiting, throttling, or concurrency cap
   anywhere; app team reported the activity.

Documented in
`workspaces/glados/investigations/www-ffs.app.ford.com/analysis/SESSION-STRUGGLES.md`.

## 1 — Architecture decision

Unify the fix under a single **GLaDOS Ops Dashboard** at `dashboard/`
(Node.js + Express + SSE, bound to `127.0.0.1:4280`). Sits next to OpenClaw TUI.
Guardrails (watchdog-mcp, Burp rate caps, circuit breaker) live in a **separate**
MCP so the blackboard stays focused on findings.

## 2 — Milestone 1: Dashboard skeleton + read-only views

Landed first to unblock visibility.

- `dashboard/server.js` — Express app, per-agent transcript SSE, lobby SSE.
- `dashboard/lib/agent-watcher.js` — chokidar on `~/.openclaw/agents/`; emits
  `session-started` / `session-ended`.
- `dashboard/lib/jsonl-tail.js` — incremental JSONL tail for live transcripts.
- `dashboard/lib/openclaw.js` — registry read + `sendMessageToAgent` shelling
  `openclaw agent --json`.
- `dashboard/public/index.html` + `app.js` + `styles.css` — tab model, auto-spawn
  tab on `session-started`, GLaDOS chat pane.
- **REST surface**: `/api/agents`, `/api/agents/stream`,
  `/api/agents/:id/transcript`, `/api/chat/glados`, `/api/healthz`.

## 3 — Milestone 2: Guardrails

- **`watchdog-mcp`** at `watchdog/watchdog-mcp/index.js`. Tools: `target_probe`,
  `target_health`, `target_mark`, `agent_halt`, `agent_resume`, `agent_status`,
  `engagement_halt_all`, `circuit_status`. Owns `watchdog.db` (separate from
  blackboard) with the `target_health(target_url, last_probed_at, last_status,
  consecutive_failures, state)` table.
- **B1 pre-dispatch health gate**: rule added to
  `workspaces/glados/SOUL.md` — every `blackboard_task_create` must be preceded
  by `target_probe` + `target_health`. Dispatch refused unless `state=healthy`.
- **B3 rate cap**: `tools/burp-redteam-defaults.json` — resource pool
  3 concurrent per host / 500ms min interval / 8 global max.

## 4 — Milestone 3: Real kill switch

- `tools/burp-gate.sh` — flips Burp scope to `exclude ^.*$` via
  `PUT /v0.1/scope`; `halt-agent` writes deny rules to
  `~/.openclaw/exec-approvals.json`; `halt-all` does both.
- `dashboard/server.js` — wired `POST /api/halt/:id`,
  `POST /api/resume/:id`, `POST /api/halt-all`, all calling
  `glados-watchdog/lib/halt.js`.
- **Header buttons** in the dashboard: `Halt agent` + `HALT ALL`.

## 5 — Milestone 4: Automation

- `watchdog/lib/breaker.js` — polls Burp
  `/v0.1/proxy/http_history` every 5s. If 3× 5xx/429 from one host within 60s,
  marks target `state='down'` and calls `engagementHaltAll()`.
- LIVE EVENTS footer in dashboard — shows breaker trips, halts, session
  lifecycle, target-health transitions.
- `workspaces/glados/REDTEAM_MASTER.md` + `glados-flow-diagram.html` updated to
  reference dashboard, kill switch, rate caps.
- `workspaces/glados/skills/subagents-status.skill` — `/subagents` replacement
  curls `localhost:4280/api/agents`.

## 6 — Bug fixes from live use

### 6.1 Ghost-running subagents
`webapp-recon` + `webapp-vuln` showed "active" indefinitely when no engagement
was running. `sessions.json` leaves `status="running"` on dirty exits.

**Fix**: `dashboard/lib/openclaw.js` `currentSessionForAgent` — treat a session
as live only if `status=running` **AND** no clean `endedAt` **AND** JSONL mtime
within 2 min (`LIVE_MTIME_MS`).

### 6.2 Chat responses not visible until tab switch
User had to tab away from GLaDOS Chat and back to see the response.

Four compounding bugs, fixed in `public/app.js`:

- **SSE closure bug** — `onmessage` handler captured the DOM element at
  subscribe time; switching tabs orphaned events on a detached node. Fix: handler
  always writes to `rec.el` which is reassigned on each `renderPane`.
- **Sticky scroll** — per-record `autoScroll` flag, double-rAF
  `scheduleStickyScroll`, 300ms/1200ms catch-up timeouts for backfill.
- **Blocking fetch** — chat `send` awaited the whole agent turn before showing
  anything. Fix: fire-and-forget fetch, optimistic user-message render with
  `_optimistic: true`, "GLaDOS is thinking…" indicator cleared on first
  assistant/thinking/tool-result event.
- **Scroll tracker disengaging on backfill** — synthetic scroll events during
  replay looked like user scroll-up. Fix: 1.5s settling period in
  `attachScrollTracker` before honoring scroll-up as intent.

### 6.3 Duplicate `healthPill` declaration
Script threw `Identifier 'healthPill' has already been declared` after adding
Reports/Settings, which aborted init and left click handlers unwired. Removed
duplicate block in `public/app.js`.

## 7 — UX iterations

### 7.1 Reports tab
- `dashboard/lib/reports.js` — walks
  `~/.glados/investigations/`; `safeResolve`
  guards path traversal.
- `/api/reports/tree`, `/api/reports/file`.
- Client: tree-pane grid layout, `marked@12.0.0` CDN for rendering.

### 7.2 Settings tab
- `dashboard/lib/agent-details.js` — `agentDetails(id)` returns agent metadata
  (AGENTS.md, TOOLS.md, IDENTITY.md, skills, MCP list). `updateAgentModel`
  atomically edits `~/.openclaw/openclaw.json` with `.bak.<ts>` backup.
- `/api/agents/:id/details`, `/api/models`, `POST /api/agents/:id/model`.
- Client: 23 agent cards, lazy-loaded on expand; model dropdown saves in place.

### 7.3 Expandable entries
Any transcript entry >500 chars gets a "▸ expand (N chars)" toggle.
`renderCollapsible` helper in `public/app.js`; fadeout via
`linear-gradient(transparent, var(--bg))`.

### 7.4 Slash-command autocomplete
- `/api/slash-commands` exposes 8 commands: `/help`, `/agents`, `/halt <a>`,
  `/halt-all`, `/resume <a>`, `/probe <url>`, `/breaker`, `/clear`.
- Floating menu above textarea (`.slash-menu`), keyboard nav
  (ArrowUp/Down/Tab/Enter/Escape).
- Local dispatch via `runSlashCommand`.

### 7.5 Icon cleanup
Removed 📝/⚙ emoji glyphs from workspace sidebar links.

### 7.6 Universal file viewer
Previously `.md`-only; now handles every file type in `investigations/`.

- `reports.js` walks **all** non-hidden files; tags each with
  `kind ∈ {markdown, text, image, pdf, binary}` based on extension.
- `GET /api/reports/raw?path=…` — streams raw bytes with inferred `Content-Type`.
- Client `loadReport` branches:
  - markdown → `marked.parse`
  - text/code → `<pre class="code-view">`
  - image → `<img src=/api/reports/raw?…>`
  - pdf → `<iframe>`
  - binary → download link

### 7.7 Reset session button
- `POST /api/agents/:id/reset-session` — renames current JSONL to
  `.archived-<iso>`, drops the `sessions.json` entry for
  `agent:<id>:main` so openclaw creates a fresh session on the next turn.
- In-memory ring buffer for that agent is cleared.
- Lobby broadcasts `session-reset`.
- Header button next to Halt agent.

### 7.8 Restart gateway button
- `POST /api/gateway/restart` shells `openclaw daemon restart` (30s timeout).
- Header button with blue accent; flips to "Restarting…" → "Restarted ✓"
  for 1.5s on success.
- Lobby broadcasts `gateway-restart`.

### 7.9 About tab
- `GET /api/flow-diagram` serves `glados-flow-diagram.html`.
- Pane renders an iframe + start-to-finish checklist:
  - **One-time install** (6 steps: clone, `openclaw onboard`, deps,
    Burp CA trust, register watchdog-mcp, agent proxy env)
  - **Start-of-engagement** (8 steps: Burp, resource pool, gateway status,
    dashboard, proxy env, curl sanity, dashboard sanity, chat test)
  - **If something gets wedged** (7 steps: reset session, restart gateway,
    reload browser, check Burp REST API, fix CA trust, expected halt limits,
    hard reset)
  - Emergency stop reference.
- Responsive grid: 2-col on wide, stacks to 1-col below 900px.

### 7.10 Editable / deletable reports
- `DELETE /api/reports/file?path=…` — path-traversal-safe unlink; refuses
  directories.
- `PUT /api/reports/file` with `{path, content}` — restricted to `.md`.
- Client: "edit" / "delete" links in the report header. Edit toggles a
  `<textarea class="report-editor">` with save/cancel.

### 7.11 Terminal tab
- `lib/terminal.js` — `node-pty` PTY bridged to a WebSocket. Spawn failures
  return an ANSI-red error to the client instead of crashing the server.
- `ws` WebSocket server mounted at `/api/terminal` on the same HTTP server
  (`http.createServer(app)`), still bound to `127.0.0.1` only.
- Client uses `xterm@5.3.0` + `xterm-addon-fit@0.8.0` from CDN. Full
  `$SHELL -l` in `$HOME`. Reuses the xterm instance across tab switches to
  preserve scrollback.

## 8 — Final surface

**Top bar**: Restart gateway · Reset session · Halt agent · HALT ALL.

**Sidebar**: Agents · Indicators (Target health, Burp RPS) · Workspace
(Reports, Settings, Terminal, About).

**Tabs**: GLaDOS Chat + any auto-spawned agent tab + any workspace tab.

**Chat**: slash autocomplete, optimistic render, thinking/tool events stream
live, ▸ expand for long entries.

**Footer**: LIVE EVENTS feed.

## 9 — Known limitations (unchanged from plan)

- **No in-flight cancel.** OpenClaw session SDK has no
  `sessions_interrupt(session_key)`. The A1 (Burp scope drop) + A2
  (exec-approvals deny) combo makes the **next** tool call fail within one
  turn, which is the practical equivalent. Upstream feature request filed
  separately; not blocking.
- **Burp CA trust must be manual.** Dashboard can't install the CA for you;
  Burp's installer does it on first run. Documented in About → step 1.4.
- **Terminal tab spawns a full shell.** Dashboard binds to `127.0.0.1` only —
  do not expose the port on a LAN/tailnet without adding auth.

## 10 — Critical files (quick index)

**Dashboard:**
- [server.js](server.js)
- [lib/openclaw.js](lib/openclaw.js)
- [lib/agent-watcher.js](lib/agent-watcher.js)
- [lib/jsonl-tail.js](lib/jsonl-tail.js)
- [lib/reports.js](lib/reports.js)
- [lib/agent-details.js](lib/agent-details.js)
- [lib/terminal.js](lib/terminal.js)
- [public/index.html](public/index.html)
- [public/app.js](public/app.js)
- [public/styles.css](public/styles.css)

**Watchdog:**
- `watchdog/watchdog-mcp/index.js`
- `watchdog/lib/halt.js`
- `watchdog/lib/health.js`
- `watchdog/lib/breaker.js`

**Tools:**
- `tools/burp-gate.sh`
- `tools/burp-redteam-defaults.json`

**Workspace:**
- `workspaces/glados/SOUL.md` (B1 rule added)
- `workspaces/glados/REDTEAM_MASTER.md` (dashboard-as-primary-UI)
- `workspaces/glados/skills/subagents-status.skill`
- `glados-flow-diagram.html` (served to About tab)

## 11 — Verification matrix (final)

| Scenario | Expected | Status |
|---|---|---|
| GLaDOS designates `webapp-recon` + `webapp-validator` | Two tabs auto-open with live thought stream | ✓ |
| Chat pane send | Optimistic render; thinking + tool events stream live | ✓ |
| B1 health gate on 500ing target | `blackboard_task_create` refused, gate fire in LIVE EVENTS | ✓ |
| B3 rate cap under 5 agents | Burp RPS indicator capped concurrency 3 | ✓ |
| A1+A2 per-agent halt | Burp traffic stops within one request cycle; next tool call denied | ✓ |
| B2 circuit breaker on 500 repeats | Auto `engagement_halt_all` within ~15s | ✓ |
| `/subagents` skill | Populated table from `localhost:4280/api/agents` | ✓ |
| Reports tab — .md render | marked → HTML, headings styled | ✓ |
| Reports tab — image | `<img>` via `/api/reports/raw` | ✓ |
| Reports tab — .py/.txt/.json | `<pre class="code-view">` | ✓ |
| Edit `.md` → save | File on disk updated | ✓ |
| Delete file | `unlink`; tree refreshes | ✓ |
| Settings → change model | `openclaw.json` atomically updated; `.bak.<ts>` written | ✓ |
| Slash menu | 8 commands, keyboard nav | ✓ |
| Reset session | JSONL archived, fresh session on next turn | ✓ |
| Restart gateway | `openclaw daemon restart` succeeds; button flips "Restarted ✓" | ✓ |
| Terminal tab | WebSocket connects, live `$SHELL -l` bridged | ✓ (user machine only — sandbox blocks PTY spawn) |
| About tab | 3 sections + emergency stop + flow-diagram iframe | ✓ |
