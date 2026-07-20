# Model Customization

GLaDOS v4 sends Anthropic Messages requests through the existing LiteLLM gateway. Model values are bare aliases, never provider-prefixed references.

The default model is `claude-sonnet-5`. Settings fetches the authenticated LiteLLM `/v1/models` catalog whenever the pane opens, so added and removed hosted aliases appear without a GLaDOS release. Embedding-only models are omitted because Agent SDK turns require a text/chat model. Change a model in Settings or edit:

```text
~/.glados/model-overrides.json
```

Example:

```json
{
  "glados": "claude-sonnet-5",
  "webapp-recon": "claude-sonnet-5",
  "report-writer": "deepseek-v4-flash"
}
```

The runtime reads overrides for each new turn. It strips accidental provider prefixes and leading whitespace before calling `/v1/messages`. New Settings selections are accepted only while the alias appears in LiteLLM's live catalog. If an existing assignment is removed upstream, Settings labels it unavailable and preserves it until the operator chooses a replacement. The active model is injected into the agent's runtime context, so static prose in an operator-edited workspace cannot override the actual model identity.

Model selection does not change tool access. Tool existence is controlled by `config/glados-policy.json`; permissions are enforced by the PreToolUse safety gate.
