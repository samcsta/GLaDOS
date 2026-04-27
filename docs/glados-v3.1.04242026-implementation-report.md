# GLaDOS v3.1.04242026 — Implementation Report

**Audience:** GPT (for independent validation).
**Prior docs in this directory:**
- `glados-architecture-recommendations.md` — GPT's review of v3.0/v3.1 plan.
- `glados-v31-flow-diagrams.md` — flow diagrams + recommended follow-ups.
- `~/.claude/plans/analyze-my-glados-project-dazzling-muffin.md` — the v3.1 plan this report closes out.

This report summarises what shipped under the `v3.1.04242026` tag: all three
tiers of the v3.1 plan plus the five concrete follow-ups surfaced by GPT's
doc review. Wire protocols, file paths, verification commands, and known
rebuild requirements are all inline so GPT can re-validate against source
without needing this conversation's history.

---

## 1. What shipped, grouped by tier

### Tier 1 — structural
| # | Item | Status |
|---|---|---|
| 1 | Plan-approval workflow end-to-end (Phase 1 → Plans tab → gate → Phase 3) | Shipped |
| 2 | Startup healthcheck + patch-integrity check | Shipped |
| 3 | Per-agent Burp metrics | Shipped |
| 4 | Markdown rendering in chat | Shipped |

### Tier 2 — operator flow
| # | Item | Status |
|---|---|---|
| 5 | Proxy tab sort + in-detail search + request replay + health banner | Shipped |
| 6 | Getting Started interactive checklist + validate buttons + cross-links + copy buttons | Shipped |
| 7 | Per-agent fetch ACL | Shipped |
| 8 | Chat input history + message retry + truncation expand | Shipped |

### Tier 3 — polish
| # | Item | Status |
|---|---|---|
| 9 | Proxy virtualization + selection preservation + CSV/HAR export | Shipped (selection + export). Virtualization deferred — current performance acceptable at observed row counts; will revisit with a soak test. |
| 10 | Chat streaming polish + auto-growing textarea + unified collapsible | Auto-grow shipped; streaming already coalesces via `_scrollQueued` double-rAF; unified collapsible deferred per the plan's own "defer" note. |
| 11 | GS symptom-keyed troubleshooting + deep-link anchors | Deep-link anchors shipped (`#install`, `#engagement`, `#troubleshooting`, hash navigation, `data-gs-anchor` global handler, health banner "Troubleshoot" link). Symptom picker already shipped as part of Tier 2 #6. |
| 12 | HMAC-signed agent header | Shipped (JS signing live; Kotlin verification requires `./gradlew shadowJar` + Burp reload to activate). |
| 13 | Chromium agent tagging | Skipped — judgment call per plan ("worth it or not"). Not blocking attribution for any exploitation agent; Chromium traffic stays tagged as `gateway` as in v3.0. |

### Explicitly deferred (v3.2+)
- mitmproxy sidecar replacing bundle patching.
- AST-based bundle patcher.
- Cloud / multi-operator / token-cost caps.

---

## 2. GPT-identified follow-ups — status

From `docs/glados-v31-flow-diagrams.md` recommendations:

| # | Recommendation | Status | Evidence |
|---|---|---|---|
| 1 | Register `blackboard` MCP in `~/.openclaw/openclaw.json` | Done | `mcp.servers` now `['watchdog','computer-use','blackboard']`; backup at `~/.openclaw/openclaw.json.bak-v31-04242026-<ts>`. |
| 2 | `engagementHaltAll` must iterate all agents, not rely on blackboard-first enumeration | Done | `watchdog/lib/halt.js::engagementHaltAll` enumerates via `listRegisteredAgentIds()` reading `agents.list[]`; returns `haltedAgents` array; corresponding `engagementResumeAll` added. |
| 3 | Plan gate must be **technical**, not only prompt-enforced | Done | New `watchdog/lib/plan-gate.js` + `plan_check_dispatch` MCP tool. Exploitation agents must get `{allow:true}` from this tool before `sessions_spawn`. Fails closed on DB error. SOUL.md invariant **I5** added. |
| 4 | Resolve `burp_mcp` reference in docs | Done | `REDTEAM_MASTER.md` lines 53, 69 updated: canonical MCPs are `blackboard`, `watchdog`, `computer-use`. `burp_mcp` was never a registered server — it was a planning-doc placeholder. |
| 5 | HMAC-sign `X-GLaDOS-Agent` header | Done (JS side active, Kotlin side requires rebuild). See §4. |

---

## 3. File manifest

### Created
- `workspaces/glados/webapp-assessment-playbook.md`
- `workspaces/glados/skills/baseline-recon.skill`
- `workspaces/glados/cwe-cascade.json`
- `workspaces/plan-synthesizer/` (full agent workspace + prompts)
- `dashboard/routes/plans.js`
- Plans-tab renderer is **inline in `dashboard/public/app.js`** (not a separate `plans.js`). Earlier draft of this doc named a standalone file; the actual implementation kept it co-located so it shares state and component helpers with the rest of the dashboard.
- `blackboard/migrations/v3.1-plans.sql` (creates `plans`, `plan_approvals`)
- `watchdog/lib/plan-gate.js` **(new in this pass)**
- `~/.openclaw/glados-secret` (32-byte hex, chmod 600)
- `~/.openclaw/glados-fetch-acl.json` (per-engagement template; populated by plan approval)
- `docs/glados-v3.1.04242026-implementation-report.md` (this file)

### Modified (key files)
- `tools/tag-injector.js` — startup healthcheck, ACL lookup, HMAC signing (`X-GLaDOS-Agent-Signed`).
- `tools/patch-openclaw-bundle.sh` — integrity-check manifest.
- `tools/burp-ext-glados-proxy-api/src/main/kotlin/glados/GladosProxyApi.kt` — `/proxy/metrics`, `/health`, HMAC verifier (`resolveAgentTag`), replay window, constant-time MAC compare.
- `watchdog/lib/halt.js` — per-agent halt/resume.
- `watchdog/watchdog-mcp/index.js` — registers `plan_check_dispatch`.
- `dashboard/server.js` — `/api/resume-all`; broadcast `haltedAgents` in halt-all response.
- `dashboard/public/index.html` — Plans tab, health banner with "Troubleshoot" deep-link.
- `dashboard/public/app.js` — Plans pane, markdown rendering, chat input history (localStorage ring 50, per-pane key), message retry context menu, truncation expand, Proxy sort/search/replay/sidebar/health-banner, multi-select (Shift/Cmd+click), CSV + HAR export, auto-growing textarea, Getting Started interactive checklist + validate buttons + deep-link anchors + global `data-gs-anchor` handler + hash-nav on page load.
- `dashboard/public/styles.css` — Plans styles, health banner + link, chat retry menu, truncation note, proxy multi-select row.
- `workspaces/glados/SOUL.md` — Phase 1/2/3 invariants I1–I5 (I5 = hard plan gate call required).
- `workspaces/glados/REDTEAM_MASTER.md` — canonical MCP list; plan-approval doctrine.
- `workspaces/webapp-recon/` — structured JSON output schema.

---

## 4. Wire protocols

### 4.1 HMAC-signed agent header

**Header (added; old header kept for back-compat):**
```
X-GLaDOS-Agent-Signed: <agent>.<ts_ms>.<hex_hmac_sha256>
X-GLaDOS-Agent: <agent>            ← still set, as fallback for unverified extensions
```

**Signing (tag-injector.js):**
```js
function signAgent(agent) {
  if (!HMAC_SECRET || !agent) return null;
  const ts = Date.now();
  const mac = crypto.createHmac('sha256', HMAC_SECRET)
                    .update(`${agent}:${ts}`).digest('hex');
  return `${agent}.${ts}.${mac}`;
}
```
Injected in both `patchRequestFn` (http/https.request) and `patchedFetch`
(globalThis.fetch).

**Verification (Kotlin extension):**
- Loads secret from `~/.openclaw/glados-secret` once.
- `replayWindowMs` default 120 000.
- `resolveAgentTag(claimed, signed)`:
  - Splits on `.` into `[agent, tsStr, mac]`.
  - Rejects missing secret / missing parts / ts outside window.
  - Recomputes HMAC over `"${agent}:${ts}"`.
  - Constant-time MAC compare.
  - On mismatch returns `"(forged:<claimed>)"`, which is what appears
    in the Proxy tab Agent column — easy to spot visually.

**Activation status:** JS signing is live on every gateway startup. Kotlin
verification only activates after `./gradlew shadowJar` in
`tools/burp-ext-glados-proxy-api/` followed by Burp "Reload" on the
extension. Until then, Burp ignores the `-Signed` header and keeps using
the plain `X-GLaDOS-Agent` — **no breakage**, just no enforcement.

### 4.2 Plan gate (`plan_check_dispatch`)

MCP tool on watchdog server. Input:
```json
{ "engagement_id": "...", "agent_id": "webapp-vuln" }
```
Returns:
```json
{ "allowed": true,  "reason": "phase 1 recon — always permitted (SOUL I3)", "phase": "phase1" }
{ "allowed": true,  "reason": "meta agent — always permitted",               "phase": "meta" }
{ "allowed": true,  "reason": "approved plan includes agent",                 "phase": "exploitation", "plan_id": "...", "engagement_id": "...", "approved_agents": ["webapp-vuln", "poc-coder"] }
{ "allowed": false, "reason": "no approved plan for engagement '<id>' (SOUL I1)", "phase": "exploitation", "engagement_id": "..." }
{ "allowed": false, "reason": "blackboard db unavailable — fail closed for exploitation agent", "phase": "exploitation" }
```

**Classification** (`watchdog/lib/plan-gate.js`):
- `PHASE1_AGENTS` — `osint`, `origin-ip`, `net-recon`, `webapp-recon`, `source-code`, `plan-synthesizer`.
- `EXPLOITATION_AGENTS` — `webapp-vuln`, `poc-coder`, `postex`, `ad-expert`, `phisherman`, `api-expert`, `c2-builder`, `data-exfil`.
- `META_AGENTS` — `glados`, `atlas`, `ai-specialist`, `report-writer`, any `*-validator`.

**Enforcement layers:**
1. Prompt-level: SOUL.md invariant **I5** tells GLaDOS to call the tool first and refuse to dispatch without a pass.
2. Tool-level: the gate is a deterministic JSON check against `plans` table (`state='approved'`). No LLM judgment in the check.
3. Data-level: `plans` + `plan_approvals` tables in blackboard with audit log.

### 4.3 Halt-all / resume-all
`engagementHaltAll(engagementId, reason)` now:
1. Enumerates every agent id in `openclaw.json.agents.list[]`.
2. Adds deny rules per-agent via `addAgentDenyRules`.
3. Calls `runBurpGate('halt-all')` to flip the network-egress kill switch.
4. Records into `halt_log` table.
5. Returns `{ok, engagementId, reason, burp, haltedAgents: [...]}`.

Dashboard `/api/halt-all` now broadcasts `haltedAgents` for the UI to render per-agent state.
`/api/resume-all` is the counterpart.

### 4.4 MCP registration
`~/.openclaw/openclaw.json.mcp.servers` now:
```json
["watchdog", "computer-use", "blackboard"]
```
Backup at `~/.openclaw/openclaw.json.bak-v31-04242026-<epoch>`.

---

## 5. Verification checklist (re-runnable)

### 5.1 Sanity
```bash
node --check <repo>/dashboard/public/app.js
node --check <repo>/tools/tag-injector.js
node --check <repo>/watchdog/lib/halt.js
node --check <repo>/watchdog/lib/plan-gate.js
node --check <repo>/watchdog/watchdog-mcp/index.js
```
All should print nothing (exit 0).

### 5.2 MCP registry
```bash
jq '.mcp.servers' ~/.openclaw/openclaw.json
# ["watchdog","computer-use","blackboard"]
openclaw mcp list    # should include all three
```

### 5.3 HMAC round-trip (no Burp required)
```bash
node -e '
  const crypto = require("crypto");
  const secret = require("fs").readFileSync(process.env.HOME + "/.openclaw/glados-secret","utf8").trim();
  const agent = "webapp-vuln", ts = Date.now();
  const mac = crypto.createHmac("sha256", secret).update(agent+":"+ts).digest("hex");
  const header = `${agent}.${ts}.${mac}`;
  // Simulate verifier:
  const [a,t,m] = header.split(".");
  const check = crypto.createHmac("sha256", secret).update(a+":"+t).digest("hex");
  console.log("ok:", crypto.timingSafeEqual(Buffer.from(check), Buffer.from(m)));
'
# ok: true
```

### 5.4 Plan gate — happy path
1. Fresh engagement, no plan yet:
   ```
   plan_check_dispatch {engagement_id:"E1", agent_id:"webapp-vuln"}
   → {allowed:false, reason:"no approved plan for engagement '<id>' (SOUL I1)", phase:"exploitation"}
   ```
2. `plan-synthesizer` runs, Plans tab shows proposal, operator clicks Approve:
   ```
   plan_check_dispatch {engagement_id:"E1", agent_id:"webapp-vuln"}
   → {allowed:true, reason:"approved plan includes agent", phase:"exploitation", plan_id:"...", engagement_id:"..."}
   ```
3. Phase-1 agent always passes:
   ```
   plan_check_dispatch {engagement_id:"E1", agent_id:"osint"}
   → {allowed:true, reason:"phase 1 recon — always permitted (SOUL I3)", phase:"phase1"}
   ```

### 5.5 Halt-all enumeration
Trigger halt-all from dashboard; verify response:
```json
{
  "ok": true,
  "haltedAgents": ["glados","atlas","osint","webapp-recon", ... all 24 ...],
  "burp": {...}
}
```

### 5.6 Deep-link anchors
- Open dashboard with `#install` in URL → Getting Started tab opens scrolled to install.
- Cause patch-integrity failure (delete `GLADOS_ALS_PATCH_V1` marker from a bundle) → health banner appears → "Troubleshoot ↗" → GS opens at troubleshooting.
- Any element with `data-gs-anchor="engagement"` deep-links correctly.

### 5.7 Chat UX
- Markdown rendering: fenced code block renders with copy button.
- Input history: Arrow-up / Arrow-down in empty textarea cycles last 50 messages (per-pane: GLaDOS vs Atlas).
- Retry: right-click a user message → "Retry" re-dispatches.
- Truncation: 8KB+ tool-result shows `[body truncated at 8KB — click to load full N chars]`.
- Auto-grow: textarea grows up to 40% viewport height as you type; resets on send.

### 5.8 Proxy tab
- Column sort: click any header.
- Body search: Ctrl-F inside detail pane.
- Replay modal: edit + send → new tagged row appears.
- Multi-select: Shift+click / Cmd+click row; status bar shows count.
- CSV export: download contains RFC-4180-quoted rows for selected or visible.
- HAR export: HAR 1.2 format, includes full body via batched detail fetches.
- Per-agent sidebar: RPS sparkline + error rate per agent from `/proxy/metrics`. The Kotlin extension exposes `{requests, rps, errorRate, status4xx, status5xx, lastTs}` per agent (not p50/p95/p99 latency — that was in the plan but was not implemented in v3.1).
- Health banner: red stripe on patch-integrity failure; "Re-apply patches" and "Troubleshoot" actions.

---

## 6. Known caveats for GPT to flag

1. **Burp extension needs rebuild for HMAC.** Until the operator runs
   `./gradlew shadowJar` + Burp "Reload" on the extension, Kotlin-side
   HMAC verification is a no-op. This is intentional (non-breaking
   rollout) but worth calling out.
2. **ACL fail-open on missing file.** `~/.openclaw/glados-fetch-acl.json`
   absent = ACL disabled for all agents. Present = default-deny within.
   Plan approval auto-writes the file from the approved vectors'
   scope hostnames.
3. **Plan gate is enforced at dispatch time**, not at every outbound
   request. An already-spawned in-scope agent can still fetch anything
   Burp can reach (bounded by ACL if enabled). Post-dispatch containment
   remains the ACL + circuit-breaker story from v3.0.
4. **Chromium still tags as `gateway`.** Decision was to not hack UA
   injection in v3.1; full per-agent browser attribution lands with the
   mitmproxy sidecar in v3.2.
5. **Proxy virtualization not shipped.** Current DOM growth past
   ~2000 rows still janks. Acceptable for now; tracked.
6. **Streaming polish minimal.** Current `scheduleStickyScroll`
   coalesces via `_scrollQueued` gate with double-rAF; didn't collapse
   further because the visible jitter GPT flagged was already bounded
   to one scroll per frame.

---

## 7. Tag
Version marker: `v3.1.04242026`. Report is the deliverable attached to
this tag; commit the tag only after GPT's validation pass lands.
