# Model Customization

How per-agent model assignment works in GLaDOS, why it used to reset on every update, and how to
make cheap-but-fast choices that persist.

## TL;DR

- Fresh install: every agent runs the default Sonnet model (`GLADOS_PRIMARY_MODEL`).
- To offset cost, move individual agents to a cheaper HPC model via the **dashboard model picker**
  or by editing **`~/.glados/model-overrides.json`**.
- Those choices **survive `git pull` + `scripts/update.sh`** — no more reassigning each update.
- Reasoning-heavy cheap models (e.g. `minimax-m2.7`) are capped to a low thinking level for
  latency-sensitive agents (Atlas by default) so they reply fast.

## Why assignments used to reset

There were two halves that didn't share a durable store:

- **Write side:** the dashboard model picker (`POST /api/agents/:id/model` →
  `dashboard/lib/agent-details.js:updateAgentModel`) wrote the chosen model **only** into
  `~/.openclaw/openclaw.json` (`agents.list[].model`).
- **Wipe side:** the next `update` runs `generateOpenClawConfig()`
  (`scripts/lib/glados-local.js`), which rebuilds `agents.list` from scratch
  (`list: agents`) out of the registry / per-agent `agent.json` and re-applies the
  `GLADOS_DISABLE_OLLAMA` → Sonnet swap. The dashboard's edits were overwritten and lost.

Editing the tracked `templates/agent-registry.json` didn't help either — `git pull` clobbers it.

## The fix: a durable override layer

`~/.glados/model-overrides.json` is a flat map of agent id → model ref:

```json
{
  "atlas": "custom-llmapi-redteamstuff-com/minimax-m2.7",
  "report-writer": "custom-llmapi-redteamstuff-com/qwen3.6-27b-fp8"
}
```

- Lives in the runtime dir (outside the repo, gitignored): survives `git pull` **and** config regen.
- Read on every regen by `localAgentEntries()` with the highest precedence:
  **override → `agent.json` → registry → fallback**.
- Applied **verbatim** and **exempt** from the `GLADOS_DISABLE_OLLAMA` swap — an explicit choice
  always wins.
- The dashboard picker writes here automatically (and also patches the live `openclaw.json` for
  instant effect). So a dashboard change is both immediate and durable.

Set it up / edit it:

```bash
scripts/setup-model-overrides.sh        # seeds ~/.glados/model-overrides.json
# edit the file, then apply:
scripts/update.sh                        # or: node scripts/lib/glados-local.js update
```

> Do **not** hand-edit `~/.openclaw/openclaw.json`. It is generated; the next update overwrites it.
> Put per-agent models in `model-overrides.json` instead.

## Response speed on reasoning models

Cheap HPC models vary a lot in latency. Reasoning models like `minimax-m2.7` generate hidden
reasoning tokens before answering — fine for heavy exploitation agents, but it makes a chatty
assistant feel broken (e.g. ~30s to say "No problem, anytime").

OpenClaw resolves a model's thinking level from `agents.defaults.models[<ref>].params.thinking`
(`off` / `minimal` / `low` / `medium` / `high`). Set it per agent two ways:

- **Atlas ChatBot page** — the **reasoning dropdown** next to the model picker. Default `minimal`.
  Changing it restarts the gateway (~3s) so it applies immediately.
- **By hand** — edit `~/.glados/thinking-overrides.json`, a gitignored `{"<agent-id>": "<level>"}`
  map (seeded with `{"atlas": "minimal"}`). Apply with `scripts/update.sh`.

This file lives outside the repo and is read on every regen, so the level **survives updates**. To
avoid hurting the red-team fleet, a level is applied **only to a model whose every agent agrees on
it**, and **never to the shared Sonnet primary**. Practically: give your fast assistant its own cheap
model (as Atlas has `minimax-m2.7`) so its dropdown choice applies cleanly.

> True per-message *adaptive* reasoning (the model decides how hard to think) is a native Anthropic
> 4.6 feature — Sonnet agents like GLaDOS already use it. Through the LiteLLM proxy, non-Anthropic
> models can't do real adaptive (OpenClaw maps `adaptive` → a fixed `medium`), which is why the
> dropdown offers fixed levels for cheap models like minimax.

### Guidance: which cheap model for what

- **Conversational / meta agents** (atlas, report-writer, scope-guardian): prefer a fast,
  non-reasoning or low-thinking model. A reasoning model is fine *if* its thinking is capped.
- **Exploitation / synthesis agents** (webapp-vuln, poc-coder, glados): keep full reasoning; Sonnet
  or a strong reasoning model earns its latency here.
- Note the LiteLLM gateway idle timeout (~60s, see `workspaces/glados/agent-timeout-issue.md`): an
  uncapped reasoning model that exceeds it will hard-fail a turn — another reason to cap thinking on
  chat agents.

## Verifying

```bash
# overrides applied + survive regen, thinking cap present:
node scripts/lib/glados-local.js update
jq '.agents.list[] | select(.id=="atlas") | .model' ~/.openclaw/openclaw.json
jq '.agents.defaults.models' ~/.openclaw/openclaw.json

# apply to the running gateway:
scripts/update.sh        # restarts the gateway, or: openclaw daemon restart
```
