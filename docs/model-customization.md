# Model Customization

GLaDOS v4 sends Anthropic Messages requests through the existing LiteLLM gateway. Model values are bare aliases, never provider-prefixed references.

The default model is `claude-sonnet-5`. The gateway also exposes `claude-opus-4-8`, `claude-fable-5`, and configured HPC aliases. Change a model in Settings or edit:

```text
~/.glados/model-overrides.json
```

Example:

```json
{
  "glados": "claude-sonnet-5",
  "webapp-recon": "claude-sonnet-5",
  "report-writer": "qwen3.6-27b-fp8"
}
```

The runtime reads overrides for each new turn. It strips accidental provider prefixes and leading whitespace before calling `/v1/messages`. The active model is injected into the agent's runtime context, so static prose in an operator-edited workspace cannot override the actual model identity.

Model selection does not change tool access. Tool existence is controlled by `config/glados-policy.json`; permissions are enforced by the PreToolUse safety gate.
