---
name: subagents-status
description: Fetch the live subagent roster and session state from the GLaDOS Ops Dashboard. Use when the operator asks "what agents are running", "who's live", "show subagents", "/subagents", or whenever GLaDOS needs an authoritative answer about which subagent sessions are currently active. Replaces the old /subagents OpenClaw command that returned stale/empty data. NOT for: per-agent transcript reading (open the dashboard tab instead), halting agents (use the HALT button or watchdog_mcp).
---

# Subagents Status

## Why this exists

The built-in `/subagents` command returned empty results during engagements — it read `~/.openclaw/subagents/runs.json`, which lagged real session state and missed agents that exited dirty. The operator now runs a local GLaDOS Ops Dashboard at `http://localhost:4280` which tails every agent's live JSONL and applies a liveness check (session status=running AND JSONL mtime within last 2 min AND no endedAt).

This skill just calls the dashboard's REST endpoint — there is one source of truth.

## Protocol

1. Curl the dashboard:

   ```bash
   curl -sS http://localhost:4280/api/agents
   ```

2. Parse `agents[]`. Each entry has `{id, name, model, workspace, active, session}`.
   - `active: true` — a live session is attached (fresh JSONL, status running, no clean end).
   - `session.sessionId` — current session ID if live, else null.

3. Format a short table for the operator:

   ```
   AGENT             ACTIVE   MODEL                                       SESSION
   glados            ●        claude-sonnet-4-6                           <id or —>
   webapp-recon      ○        claude-sonnet-4-6                           —
   ```

4. If the dashboard is down (connection refused), say so and point the operator at `cd dashboard && npm start` from the GLaDOS repo. Do not fall back to reading `runs.json` — it lies.

## Do not

- Do not write to the dashboard from this skill. Control actions (halt / resume / chat) go through explicit tools or the UI.
- Do not cache the response — every call must hit the live endpoint, because agent state changes turn-by-turn.
