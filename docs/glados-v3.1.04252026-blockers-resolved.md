# GLaDOS v3.1.04252026 — Blockers Resolved

**Audience:** GPT (re-validation pass).
**Companion to:** `glados-v3.1.04242026-implementation-report.md` (v3.1 baseline).

GPT's first validation pass marked v3.1.04242026 *integration-complete, not
assessment-ready*. This addendum covers every release blocker GPT flagged,
plus the doc mismatches. Tag: `v3.1.04252026`.

---

## Resolution matrix

| GPT blocker | Status | Where it landed |
|---|---|---|
| Patch-health false unhealthy (multi-bundle scan) | Fixed | `tools/tag-injector.js::checkMarker` rewritten. |
| `plan-synthesizer` not registered | Fixed | `~/.openclaw/openclaw.json` agents.list now 25 entries. |
| Plan gating advisory only | Fixed | New `GLADOS_PLAN_GATE_V1` bundle patch + `globalThis.__gladosPlanGate` runtime hook in `tag-injector.js`. |
| Baseline recon schema missing | Fixed | New tables `baseline_recon`, `recon_steps` + 4 new MCP tools. |
| `enables_vectors` / replan trigger absent | Fixed | Findings columns + `replan_proposals` table + `blackboard_finding_validate` MCP tool + dashboard 5s watcher emitting `plan-replan-proposed` SSE. |
| HMAC not deployed in SSRF dispatcher | Fixed | SSRF patch upgraded to `GLADOS_SSRF_ROUTE_V2` injecting both plain + signed headers via `globalThis.__gladosSignAgent`. |
| Extension accepted plain-only claims | Fixed | Strict mode toggle (`~/.openclaw/glados-hmac-strict` or `GLADOS_HMAC_STRICT=1`). In strict mode, plain-only becomes `(unsigned:<claimed>)`. |
| ACL not in SSRF dispatcher | Fixed | V2 dispatcher calls `globalThis.__gladosAclAllows`; deny aborts dispatch with synth error. |
| Plan approval non-transactional | Fixed | ACL write happens FIRST; on failure the plan stays `pending_approval`. SQL state-change runs in a `db.transaction(...)`; if the txn fails the ACL is rolled back to its pre-write contents. |
| Burp extension JAR stale | Fixed | Built with `openjdk@17` at `/opt/homebrew/Cellar/openjdk@17/17.0.18`. New JAR is 11.5 MB (vs the prior 38 KB stub). `/health` now reports the new `hmac.{secretLoaded, strict, replayWindowMs}` block. |
| Doc: `dashboard/public/plans.js` doesn't exist | Fixed | v3.1.04242026 report corrected — Plans renderer is inline in `app.js`. |
| Doc: metrics include latency percentiles | Fixed | Report now states the actual fields: `requests, rps, errorRate, status4xx, status5xx, lastTs`. |
| Doc: response key `allow` vs `allowed` | Fixed | Report aligned to the real `allowed` / `phase` shape returned by `planCheckDispatch`. |

---

## What's new in the runtime

### Three patches active in openclaw bundles

`/api/health/burp` now reports three patches, not two:

```json
{
  "healthy": true,
  "patchAls":      { "ok": true, "bundle": "pi-embedded-DWASRjxE.js", "scannedCount": 7 },
  "patchSsrf":     { "ok": true, "bundle": "ssrf-BWjc2mcC.js",        "scannedCount": 3, "version": "v2" },
  "patchPlanGate": { "ok": true, "bundle": "pi-embedded-DWASRjxE.js", "scannedCount": 7 }
}
```

`patchSsrf.version: "v2"` confirms the bundle has the HMAC + ACL upgrade
applied, not the V1 header-only variant.

### Patch-integrity scan handles bundle splitting

The pre-fix bug: `entries.find(...)` returned the first alphabetical match
(`pi-embedded-B67QbpUE.js`, no marker), even though the patcher had correctly
written the marker into `pi-embedded-DWASRjxE.js`. Fixed in
`tools/tag-injector.js::checkMarker`: scans every prefix-matching bundle,
returns ok if any one carries the marker, reports the matching filename and
the total candidates count.

### sessions_spawn dispatch gate

```
sessions_spawn { agentId: "webapp-vuln" }
  → execute() runs:
      try { globalThis.__gladosPlanGate("webapp-vuln") }
  → returns { allowed: false, reason: "no approved plan...", phase: "exploitation" }
  → execute returns jsonResult({ ok:false, error:"GLADOS_PLAN_GATE_DENY", agent, reason, phase, ... })
```

The `globalThis.__gladosPlanGate` hook is installed at preload time by
`tag-injector.js` and `require()`s `watchdog/lib/plan-gate.js` as the
canonical implementation. Bundle patch + runtime hook + `plan_check_dispatch`
MCP tool form three layers of the same rule (defense-in-depth).

### SSRF dispatcher now injects HMAC + enforces ACL

V2 patch wraps `_burp.dispatch`:

1. Derives target host (`opts.origin` URL → `opts.path` regex fallback).
2. Calls `globalThis.__gladosAclAllows(_agent, _aclHost)`. On deny: returns
   `false` with a `GLADOS_ACL_DENY` Error onto the handler — dispatch is
   aborted, no traffic leaves Burp.
3. Calls `globalThis.__gladosSignAgent(_agent)` and adds both headers
   (`X-GLaDOS-Agent`, `X-GLaDOS-Agent-Signed`). Both are written into all
   three undici header shapes (array, object, primitive).

### Burp extension HMAC + strict mode

`/health` now returns:
```json
{
  "ok": true,
  "buffered": 0,
  "hmac": {
    "secretLoaded": true,
    "strict": false,
    "replayWindowMs": 120000
  }
}
```
- `secretLoaded` mirrors whether `~/.openclaw/glados-secret` was found and
  was ≥32 chars. `false` = verifier in compat mode, all claims trusted.
- `strict` reflects whether `~/.openclaw/glados-hmac-strict` exists OR
  `GLADOS_HMAC_STRICT=1` was set in the gateway env when Burp loaded the
  extension. In strict mode, requests with `X-GLaDOS-Agent` but no
  `X-GLaDOS-Agent-Signed` are tagged `(unsigned:<claimed>)` so they show up
  loud in the Proxy tab.
- `replayWindowMs` is the HMAC timestamp skew window. 120000 = 2 minutes.

Operator rollout flow:
1. v3.1.04252026 ships in compat mode (default).
2. Gateway restarts; SSRF V2 patch starts emitting both headers.
3. Once Proxy tab shows zero plain-only requests for 24h, operator runs
   `touch ~/.openclaw/glados-hmac-strict` and reloads the extension.
4. From then on, any plain-only claim is visibly broken in the UI — easy
   audit signal.

### Baseline-recon state on the blackboard

```sql
sqlite> .schema baseline_recon
CREATE TABLE baseline_recon (
  engagement_id   TEXT PRIMARY KEY,
  summary_json    TEXT NOT NULL DEFAULT '{}',
  complete        INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (engagement_id) REFERENCES engagements(id)
);

sqlite> .schema recon_steps
CREATE TABLE recon_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id   TEXT NOT NULL,
  step            TEXT NOT NULL,
  agent_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  output_json     TEXT,
  duration_ms     INTEGER,
  started_at      TEXT DEFAULT (datetime('now')),
  finished_at     TEXT
);
```

New MCP tools on `blackboard-mcp`:
- `blackboard_baseline_get`
- `blackboard_baseline_upsert` (transactional merge — concurrent Phase-1 agents safe)
- `blackboard_recon_step_log`
- `blackboard_recon_steps_list`
- `blackboard_finding_validate` (writes confidence/enables_vectors, opens replan proposal if threshold crossed)
- `blackboard_replan_proposals_list`
- `blackboard_replan_proposal_resolve`

### Dynamic-replan trigger end-to-end

```
validator agent
  → blackboard_finding_validate { finding_id, confidence_score: 0.95, enables_vectors: ["postex","data-exfil"] }
  → UPDATE findings SET ...
  → if confidence ≥ 0.9 AND vectors non-empty:
      INSERT INTO replan_proposals (engagement_id, finding_id, ...) ON CONFLICT idempotent

dashboard server.js (5s tick)
  → SELECT * FROM replan_proposals WHERE state='open'
  → broadcastLobby('plan-replan-proposed', { proposal_id, engagement_id, finding_id, cwe_id, confidence_score, enables_vectors, current_plan_id })

dashboard UI
  → render card, operator clicks Approve / Dismiss
  → POST /api/replan-proposals/:id/resolve { state }
  → broadcastLobby('plan-replan-resolved', { proposal_id, state })
```

Threshold lives at `REPLAN_THRESHOLD = 0.9` in `blackboard-mcp/index.js`.
The vector list comes from `workspaces/glados/cwe-cascade.json`; validators
populate `enables_vectors` from that file.

### Transactional plan approval

`POST /api/plans/:id/approve`:

1. `state` must be `pending_approval` (409 otherwise).
2. **First**: build ACL JSON, snapshot `~/.openclaw/glados-fetch-acl.json`
   contents to memory (rollback buffer), then `writeAclSafe`. If write
   fails → 500, plan stays pending. If `writeAcl=false` is explicitly set
   in the body → ACL skipped, audit recorded as
   `[WARN: writeAcl=false; no ACL written]` in `plan_approvals.reason`.
3. **Then**: `db.transaction(() => { UPDATE plans SET state='approved'; INSERT plan_approvals; })`.
4. If the txn throws → rewrite the ACL file from the rollback buffer (or
   `unlink` if there was no prior file). Plan stays pending; ACL on disk
   matches DB state.

This closes the previous "approve runs without ACL boundary" hole.

### plan-synthesizer registered

```
$ jq '.agents.list | length' ~/.openclaw/openclaw.json
25
$ jq '.agents.list[] | select(.id=="plan-synthesizer")' ~/.openclaw/openclaw.json
{
  "id": "plan-synthesizer",
  "name": "plan-synthesizer",
  "workspace": "~/.glados/workspaces/agents/plan-synthesizer",
  "agentDir": "~/.openclaw/agents/plan-synthesizer/agent",
  "model": "ollama-local/qwen3.6:35b",
  "identity": { "name": "Plan Synthesizer", "theme": "Phase 2 attack-plan synthesis", "emoji": "📋" }
}
```

Backup at `~/.openclaw/openclaw.json.bak-blocker-b-<epoch>`.

---

## Verification (re-runnable from a clean shell)

```bash
# 1. Health: all three patches green, healthy=true
curl -s http://127.0.0.1:4280/api/health/burp | jq '.healthy, .patchAls.ok, .patchSsrf.ok, .patchSsrf.version, .patchPlanGate.ok'
# expect: true true true "v2" true

# 2. plan-synthesizer registered
jq '.agents.list | length, [.agents.list[].id] | inside(["plan-synthesizer"])' ~/.openclaw/openclaw.json
# expect: 25  (and contains plan-synthesizer)

# 3. Extension /health shape (HMAC fields present)
curl -s http://127.0.0.1:1338/health | jq '.hmac'
# expect: { secretLoaded:true, strict:false, replayWindowMs:120000 }

# 4. Blackboard schema
sqlite3 ~/.glados/blackboard/blackboard.db ".tables"
# expect: baseline_recon engagements findings plan_approvals plans recon_steps replan_proposals tasks

# 5. plan_check_dispatch returns "allowed" key (not "allow")
# (via watchdog MCP tool — mock call)
node -e '
  const { planCheckDispatch } = require("<repo>/watchdog/lib/plan-gate.js");
  console.log(planCheckDispatch("osint"));
  console.log(planCheckDispatch("webapp-vuln", "no-such-engagement"));
'
# expect:
#   { allowed: true, reason: "phase 1 recon — always permitted (SOUL I3)", phase: "phase1" }
#   { allowed: false, reason: "no active engagement on blackboard", phase: "exploitation" }   (or similar)

# 6. HMAC round-trip
node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  const secretValue = fs.readFileSync(process.env.HOME + "/.openclaw/glados-secret", "utf8").trim();
  const agent = "webapp-vuln", ts = Date.now();
  const mac = crypto.createHmac("sha256", secretValue).update(`${agent}:${ts}`).digest("hex");
  const header = `${agent}.${ts}.${mac}`;
  const [a,t,m] = header.split(".");
  const check = crypto.createHmac("sha256", secretValue).update(`${a}:${t}`).digest("hex");
  console.log("hmac roundtrip ok:", crypto.timingSafeEqual(Buffer.from(check), Buffer.from(m)));
'
# expect: hmac roundtrip ok: true

# 7. Patch artifacts in dist
grep -c GLADOS_PLAN_GATE_V1 /opt/homebrew/lib/node_modules/openclaw/dist/pi-embedded-DWASRjxE.js
grep -c GLADOS_SSRF_ROUTE_V2 /opt/homebrew/lib/node_modules/openclaw/dist/ssrf-*.js
grep -c GLADOS_ALS_PATCH_V1 /opt/homebrew/lib/node_modules/openclaw/dist/pi-embedded-DWASRjxE.js
# expect: 1 / 1 / 1
```

---

## Remaining caveats

1. **Strict HMAC mode is opt-in.** The default ships permissive so a partial
   gateway rollout doesn't immediately break attribution. Operator flips
   `~/.openclaw/glados-hmac-strict` once they've confirmed all gateways are
   on V2 — this is documented above and on the Proxy tab health banner copy.
2. **Replan watcher polls every 5s.** Worst-case latency from validator
   write to operator notification is ~5s. Easy to drop to 2s if needed; left
   at 5s to stay below 1 query per second on the blackboard.
3. **ACL fail-open on missing file remains.** Intentional: the ACL is a
   per-engagement scope-limiter, not a kill-switch. If the file is missing,
   ACL is disabled (file present + enabled is the only way to enforce).
   This is consistent with the v3.1.04242026 design and unchanged here.
4. **Bundle patches still string-needle based.** mitmproxy sidecar is still
   v3.2 work. The third patch's needle is anchored on the tab indentation +
   `const params = args;` line — robust to whitespace changes inside the
   function body, brittle to a refactor that renames `args` or moves
   `unsupportedParam`. Watched by patch-integrity health.
5. **`globalThis.__gladosPlanGate` re-requires watchdog/lib path.** The
   require is absolute (uses `GLADOS_REPO_ROOT + '/watchdog/lib/... '`).
   If GLaDOS is checked out at a different path, the hook falls back to a
   stub that fails-closed for exploitation agents. Document for non-default
   layouts.

---

## Tag

Version marker: `v3.1.04252026`. Successor to `v3.1.04242026`. Commit the
tag after GPT's revalidation pass clears all of section "Resolution matrix"
above.
