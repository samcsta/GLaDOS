# OpenClaw Agent-to-Agent Dispatch Issue

## Summary

`sessions_send` to named agent sessions is being denied with "Agent-to-agent messaging denied by tools.agentToAgent.allow" even though the config has `tools.agentToAgent.enabled = true` and all target agent IDs in the `allow` list.

---

## Setup

- OpenClaw version: **2026.4.5**
- macOS, LaunchAgent gateway
- 23 named agents configured in `openclaw.json` under `agents.list`
- Agent IDs: glados, osint, origin-ip, net-recon, webapp-recon, source-code, webapp-vuln, webapp-validator, api-expert, api-validator, poc-coder, poc-validator, postex, postex-validator, ad-expert, ad-validator, c2-builder, c2-validator, phisherman, phish-validator, report-writer, report-validator, ai-specialist
- Calling agent: `glados` (session key: `agent:glados:main`)
- Target agents: `osint` (session key: `agent:osint:main`), `webapp-vuln` (session key: `agent:webapp-vuln:main`)

---

## Config Applied

Via `gateway config.patch`, then confirmed written to `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "profile": "full",
    "sessions": {
      "visibility": "all"
    },
    "agentToAgent": {
      "enabled": true,
      "allow": [
        "osint",
        "webapp-recon",
        "webapp-vuln",
        "webapp-validator",
        "api-expert",
        "api-validator",
        "poc-coder",
        "poc-validator",
        "report-writer",
        "report-validator",
        "source-code",
        "postex",
        "postex-validator",
        "ad-expert",
        "ad-validator",
        "c2-builder",
        "c2-validator",
        "phisherman",
        "phish-validator",
        "ai-specialist",
        "origin-ip",
        "net-recon"
      ]
    }
  }
}
```

---

## Steps Taken

1. Applied config via `gateway config.patch` — gateway did SIGUSR1 reload, confirmed restart sentinel written
2. Verified config written correctly: `openclaw config get tools.agentToAgent` returns the correct object
3. Ran `openclaw gateway restart` (full LaunchAgent restart) — gateway confirmed running on pid 39651
4. Ran `openclaw doctor --non-interactive` — only issue is memory search embedding provider (unrelated)
5. Verified all 23 agents exist: `openclaw agents list` shows all agents with correct workspaces and models
6. Verified `tools.sessions.visibility = "all"` is set
7. Confirmed target sessions exist and are visible via `sessions_list`

---

## The Error

Every call to `sessions_send` targeting a named agent session returns:

```json
{
  "status": "forbidden",
  "error": "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
  "sessionKey": "agent:osint:main"
}
```

Even a minimal test ping fails:

```
sessions_send(sessionKey="agent:osint:main", message="ping", timeoutSeconds=15)
→ forbidden: Agent-to-agent messaging denied by tools.agentToAgent.allow.
```

---

## What We Need

The ability for the `glados` agent to send tasks to named peer agent sessions (`osint`, `webapp-vuln`, etc.) via `sessions_send` with no timeout — so long-running assessment tasks can run without being killed by the `sessions_spawn` hard timeout.

**The use case:** GLaDOS is an orchestrator agent that dispatches work to 22 specialist agents (osint, webapp-vuln, webapp-validator, etc.). Each agent has its own persistent named session. GLaDOS should be able to `sessions_send` a task to `agent:osint:main`, fire-and-forget (`timeoutSeconds: 0`), and the osint agent runs until done with no kill timer.

**Why not `sessions_spawn`?** It has a hard `runTimeoutSeconds` limit. Long assessments (blind SQLi, OSINT, etc.) consistently time out. Named agent sessions via `sessions_send` have no such limit.

---

## Questions / Things to Check

1. Does `tools.agentToAgent.allow` contain the **target** agent IDs or the **source** agent IDs? The docs say target, but maybe the check is inverted.
2. Does the calling agent (`glados`) also need to be listed? Or does the target need to allowlist the caller?
3. Is there a per-agent config that also needs to be set (e.g., in `~/.openclaw/agents/osint/agent/config.json`)? Those files currently only contain `models.json`, no `config.json`.
4. Could the format need to be the full session key (`agent:osint:main`) instead of just the agent ID (`osint`)?
5. Is there a sandbox clamp overriding `visibility: all`? `agents.defaults.sandbox` is not set.
6. Does the `glados` agent need to be added to its own allowlist somehow?

---

## Relevant File Paths

- Main config: `~/.openclaw/openclaw.json`
- Agent dirs: `~/.openclaw/agents/[agent-id]/agent/` (contains `IDENTITY.md` and `models.json` only)
- Agent workspaces: `~/.glados/workspaces/agents/[agent-id]/`
- Glados session key: `agent:glados:main`
- Target session keys: `agent:osint:main`, `agent:webapp-vuln:main`, etc.

---

## Docs Reference

From `/opt/homebrew/lib/node_modules/openclaw/docs/gateway/configuration-reference.md`:

> `all`: any session. Cross-agent targeting still requires `tools.agentToAgent`.

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],  // agent IDs
    },
  },
}
```

From the session tool docs:
> `sessions_send` delivers a message to another session and optionally waits for the response.
> Cross-agent still requires `tools.agentToAgent`.
