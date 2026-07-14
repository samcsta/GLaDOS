# GLaDOS v4 Architecture Delivery

The v4 architecture replaces the legacy agent/proxy stack with these owned boundaries:

1. Electron supervises a dynamic-port dashboard and the local proxy.
2. Claude Agent SDK owns agent turns, native partial streaming, resume identifiers, named Task dispatch, and MCP attachment.
3. The PreToolUse gate owns plan, scope, health, halt, secret, dispatch, and attribution enforcement.
4. SQLite stores durable transcripts, controller jobs, plans, approvals, findings, and audit events.
5. mitmproxy owns TLS interception while GLaDOS owns CA bootstrap, redaction, retention, per-agent history, replay, metrics, and UI APIs.

## Delivered Recommendations

- Session continuity: SDK session identifiers persist under `~/.glados/sessions` and are passed back through the SDK `resume` option.
- Plans: the dashboard exposes pending plans/replans and operator decisions; approved vectors feed the runtime ACL used by the gate.
- Parity: normalized recorded SDK message corpora cover single-agent turns, negative gates, and attributed subagent chains.
- Native packaging: copied MCP/native-module roots are rebuilt for Electron and verified in the packaged resource tree.
- Proxy durability: bounded retention, archive reads, failed-flow records, redaction, and upstream header stripping are enabled by default.
- Tool fleet: `config/redteam-tools.json` maps core/specialist tools to agents and drives bootstrap, doctor, and MCP availability output.
- Hard cut: bootstrap, updater, doctor, dashboard, prompts, and package inputs contain no compatibility runtime path.

## Non-Negotiable Invariants

- Only GLaDOS may dispatch named subagents.
- Disabled agents do not exist in Task definitions.
- Every enabled agent receives Bash; browser MCP exists only for explicitly authorized agents.
- Agent attribution is assigned by the per-agent browser process or enforced on proxied shell commands, then stripped before upstream delivery.
- A per-agent halt interrupts in-flight execution and blocks future tools until explicitly resumed.
- Updates never write operator state or include MITM private keys.
