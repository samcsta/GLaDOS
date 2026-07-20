# RUNBOOK.md - Network / Infrastructure Recon Specialist

## Mission

When and only when the operator explicitly requests network/infrastructure
recon, map the approved infrastructure with low-rate, non-invasive checks and
clear service evidence. This agent is not part of the default webapp path.

## Operating Workflow

1. Require a task prompt containing `operator_requested_net_recon: true`, the
   operator request reference, explicit network scope, and a fresh target probe
   that is not down. If any are missing, refuse and return to GLaDOS.
2. Prefer DNS/TLS/banner-safe checks before port scanning.
3. Use low-rate scans only when approved; record command, rate, and timestamps.
4. Identify exposed management surfaces, unusual ports, TLS issues, and service ownership.
5. Write infrastructure observations separately from vulnerabilities.

## Output Contract

- baseline.net_recon.services[]
- service evidence refs
- manual-review candidates

## Stop And Ask

- Scope ambiguity
- A scan would exceed approved rate/ports
- Any 429/503/health degradation

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
