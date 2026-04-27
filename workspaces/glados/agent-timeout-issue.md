# OpenClaw Named Agent Session Timeout — Root Cause & Rundown

## TL;DR

Named agent sessions (`agent:osint:main`, `agent:webapp-vuln:main`) are being killed mid-run by an **LLM API idle timeout of 60 seconds** on the upstream provider (`llmapi.redteamstuff.com`). This is not an OpenClaw config issue. The fix needs to be on the API proxy side (increase idle/response timeout), OR OpenClaw needs to handle this error and retry rather than treating it as a fatal session abort.

---

## Observed Behavior

- Agent receives a task via `sessions_send` with `timeoutSeconds: 0` (no kill timer)
- Agent runs successfully for 8–9 minutes, making tool calls and writing evidence files
- Session abruptly dies mid-run with `status: timeout` / `abortedLastRun: true`
- No work is lost up to the point of failure, but the agent doesn't finish or write its summary

---

## Exact Error from Session Log

File: `~/.openclaw/agents/webapp-vuln/sessions/*.jsonl` — last entry:

```json
{
  "type": "custom",
  "customType": "openclaw:prompt-error",
  "data": {
    "timestamp": 1776116753712,
    "runId": "997c5590-8a03-47f5-9500-e1e305f68e11",
    "sessionId": "932371e8-09f0-4e87-8294-f8540c6b2556",
    "provider": "custom-llmapi-redteamstuff-com",
    "model": "claude-sonnet-4-6",
    "api": "openai-completions",
    "error": "LLM idle timeout (60s): no response from model"
  },
  "id": "b12948a5",
  "parentId": "cdc54b01",
  "timestamp": "2026-04-13T21:45:53.712Z"
}
```

**The error is: `LLM idle timeout (60s): no response from model`**

This fires when the LLM API connection is open but no tokens have been streamed for 60 consecutive seconds. The model is doing inference (thinking through a long turn with large context) but the API proxy drops the connection before it responds.

---

## Timeline of the Failing Run

From the session JSONL, the agent was actively working right up until the timeout:

| Timestamp | Action |
|---|---|
| 21:43:52 | XSS tests completed, results written |
| 21:43:57 | Agent requests next tool call (encoded XSS reflection check) |
| 21:44:08 | File upload bypass tests started |
| 21:44:10 | File upload results returned |
| 21:44:16 | Path traversal tests started |
| 21:44:17 | Path traversal results returned |
| 21:44:23 | Large file test started |
| 21:44:25 | Large file results returned |
| 21:44:28 | HTTP method probing started |
| 21:44:29 | HTTP method results returned |
| 21:44:35 | Evidence saving started |
| 21:44:38 | SRI check started |
| 21:44:39 | SRI check results returned |
| 21:44:43 | Cookie HttpOnly check started |
| 21:44:43 | Cookie HttpOnly results returned |
| 21:44:48 | Full header capture started |
| 21:44:49 | Full header capture results returned |
| **21:45:53** | **💀 LLM idle timeout (60s) — session killed** |

The agent had finished all 10 test vectors and was about to write its findings report. The model was synthesizing ~8 minutes of tool call results into a structured findings document — a long inference task — and the API dropped the connection at 60s of generation time.

---

## Root Cause Analysis

### Why 60 seconds?

The upstream API proxy at `llmapi.redteamstuff.com` has a **60-second idle/read timeout** on the HTTP response stream. When Claude is generating a long response (synthesizing a detailed findings report after many tool calls = large context + long output), it can take >60s for the first tokens to arrive. The proxy cuts the connection.

### Why doesn't `timeoutSeconds: 0` help?

`timeoutSeconds: 0` is an OpenClaw parameter that disables the *session-level* kill timer (the one that was causing `sessions_spawn` to die at 5/10 min). It does not control the LLM API HTTP connection timeout. These are two separate layers:

```
sessions_send timeout (0 = disabled) ← this is fine now
    └── OpenClaw gateway ← fine
        └── llmapi.redteamstuff.com HTTP proxy ← 60s idle timeout ← THIS IS THE PROBLEM
            └── Anthropic API (Claude)
```

### Why does it happen specifically at the findings-writing step?

After 8+ minutes of tool calls, the agent context window is large (all test results, evidence, HTTP responses). Asking Claude to synthesize all of that into a structured report in a single response = long inference time. The idle timeout fires before the first token streams back.

---

## Configuration Checked

```json
// openclaw.json - agents.defaults
{
  "model": { "primary": "custom-llmapi-redteamstuff-com/claude-sonnet-4-6" },
  "workspace": "~/.glados/workspaces/agents",
  "compaction": { "mode": "safeguard" },
  "maxConcurrent": 6,
  "subagents": { "maxConcurrent": 23 }
}
```

No `llmTimeout`, `idleTimeout`, or `readTimeout` config exists in OpenClaw's config schema for the LLM provider connection. The 60s timeout appears to be hardcoded in the OpenClaw LLM client or configurable only in the upstream proxy.

---

## Possible Fixes

### Fix 1 — Increase timeout on llmapi.redteamstuff.com (Recommended)
The API proxy at `llmapi.redteamstuff.com` needs its idle/read timeout raised from 60s to 300s+. This is the cleanest fix — no OpenClaw changes needed.

**Where to look:** Nginx `proxy_read_timeout`, HAProxy `timeout tunnel`, or whatever reverse proxy sits in front of the Anthropic API at llmapi.redteamstuff.com.

### Fix 2 — OpenClaw: Configurable LLM read timeout
Add a `llmReadTimeoutMs` or `idleTimeoutMs` config field to the provider config in `openclaw.json`:

```json
"providers": {
  "custom-llmapi-redteamstuff-com": {
    "baseUrl": "https://llmapi.redteamstuff.com/",
    "idleTimeoutMs": 300000  // ← new field
  }
}
```

### Fix 3 — OpenClaw: Retry on idle timeout
Instead of killing the session on `LLM idle timeout`, OpenClaw could retry the last inference request once before aborting. The session state is intact up to that point.

### Fix 4 — Workaround: Break long synthesis into smaller steps
Agent tasks can be structured to write findings incrementally (one finding per turn) rather than synthesizing everything at the end. This keeps individual LLM responses short enough to avoid the 60s window. GLaDOS can enforce this in task prompts going forward.

---

## Relevant Files

- Session log: `~/.openclaw/agents/webapp-vuln/sessions/*.jsonl` (last ~20 lines show the error)
- Gateway log: `/tmp/openclaw/openclaw-2026-04-13.log` (contains `embedded_run_failover_decision` events around the timeout)
- OpenClaw config: `~/.openclaw/openclaw.json`
- Provider in use: `custom-llmapi-redteamstuff-com` → `claude-sonnet-4-6`

---

## What Claude Code Should Fix

1. **If access to `llmapi.redteamstuff.com` infra:** Raise the proxy read/idle timeout to ≥300s.
2. **In OpenClaw source:** Look for where `"LLM idle timeout (60s)"` is defined/thrown — make the 60s value configurable via provider config (`idleTimeoutMs` or `llmReadTimeoutMs`).
3. **Bonus:** On `openclaw:prompt-error` with `error` containing `"idle timeout"`, consider retrying the inference request once before marking the session as aborted.

---

## Raw Logs

### Gateway Log — All Timeout Events (2026-04-13)

Three separate runs hit the same failure, all in `subsystem-CVf5iEWk.js:325`:

```
Event: embedded_run_failover_decision
Tags: error_handling, failover, assistant, surface_error
Decision: surface_error
FailoverReason: timeout
ProfileFailureReason: timeout
Provider: custom-llmapi-redteamstuff-com
Model: claude-sonnet-4-6
FallbackConfigured: false
TimedOut: true
Aborted: true
```

**Run 1** — `238a5d3f` — 2026-04-13T21:31:30Z (osint agent, first dispatch via sessions_spawn)
**Run 2** — `467d0a4a` — 2026-04-13T21:42:53Z (osint agent, second dispatch via sessions_send)
**Run 3** — `997c5590` — 2026-04-13T21:45:53Z (webapp-vuln agent, via sessions_send)

All point to the same line in the compiled bundle: `subsystem-CVf5iEWk.js:325`

### Session JSONL — webapp-vuln last run (932371e8)

```
21:43:34 - 21:44:49  [message] — tool calls executing (XSS, file upload, path traversal, HTTP methods, SRI, cookie checks)
21:44:49              Last successful tool result received
21:45:53 [custom/openclaw:prompt-error] — LLM idle timeout (60s)
```

**64 seconds of silence** between last tool result (21:44:49) and the timeout error (21:45:53) — exactly 60s + ~4s overhead. The model was generating its findings report from a large accumulated context and the API dropped the connection before it could stream the first token.

### Full prompt-error event:
```json
{
  "type": "custom",
  "customType": "openclaw:prompt-error",
  "data": {
    "timestamp": 1776116753712,
    "runId": "997c5590-8a03-47f5-9500-e1e305f68e11",
    "sessionId": "932371e8-09f0-4e87-8294-f8540c6b2556",
    "provider": "custom-llmapi-redteamstuff-com",
    "model": "claude-sonnet-4-6",
    "api": "openai-completions",
    "error": "LLM idle timeout (60s): no response from model"
  },
  "timestamp": "2026-04-13T21:45:53.712Z"
}
```

### Code Location

The timeout is thrown at:
```
file:///opt/homebrew/lib/node_modules/openclaw/dist/subsystem-CVf5iEWk.js:325:51
```

Search the source for `"LLM idle timeout"` or `"no response from model"` or the 60s constant to find where this is configured.
