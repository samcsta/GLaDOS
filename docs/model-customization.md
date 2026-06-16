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

## Response speed: choose the right model (don't fight reasoning)

Cheap HPC models vary a lot in latency, and this is best solved by **model choice**, not a thinking
knob. We tried exposing a per-agent reasoning level and removed it after testing, because:

- **minimax-m2.7 ignores it.** With `thinking: "off"` set and confirmed applied (the session logs a
  `thinking_level_change → off`), minimax still returns a `reasoning_content` block. Over the LiteLLM
  `openai-completions` path, OpenClaw cannot disable minimax's reasoning.
- **The latency is mostly the endpoint, not the reasoning.** Even with reasoning reduced to one
  short sentence, a trivial Atlas reply took ~20s — that's minimax's TTFT/throughput on the gateway,
  which no thinking level changes.

So for a snappy conversational agent, **switch the model**, don't tune thinking:

- Fast + cheap, non-reasoning: `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite-preview`,
  `gemma-4-31b-it-fp8`.
- Fast + smart, with real per-message *adaptive* reasoning: `claude-sonnet-4-6` (native Anthropic
  feature; Sonnet agents like GLaDOS already use it by default).

Use the model picker on the Atlas page (persisted via `model-overrides.json`, above) to switch.

> Note: OpenClaw's `thinking` level (`off`/`minimal`/`low`/`medium`/`high`/`adaptive`) *is* honored
> by models that support it (e.g. Anthropic), via `agents.defaults.models[<ref>].params.thinking`.
> It just doesn't help for non-adaptive proxy models like minimax, which is why GLaDOS doesn't expose
> a per-agent reasoning control.

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
