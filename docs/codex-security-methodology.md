# Codex Security methodology adopted by GLaDOS

GLaDOS Security Review v3 adopts selected orchestration and artifact-contract ideas from OpenAI's Apache-2.0 [`openai/codex-security`](https://github.com/openai/codex-security), reviewed at upstream commit `5625adc159bbbfb4bd85557d83e2805d27379230` on 2026-07-31.

No OpenAI-hosted Codex Security service, Cyber capability, SDK authentication, workbench, or repository-upload path is used. GLaDOS keeps its existing local LiteLLM/Agent SDK runtime, read-only repository boundary, blackboard, specialist roles, deterministic full-file inventory, validation gates, and optional Dradis reporting chain.

The adopted concepts are:

- threat-model-driven discovery rather than one generic pass;
- repeated discovery workers with durable terminal receipts;
- saturation measured by consecutive successful no-new runs;
- explicit reconciliation of failed, canceled, retried, and intentionally omitted workers;
- centralized, auditable mapping from every raw candidate to a canonical candidate;
- harness-issued, worker-bound runtime model observations so configured model labels cannot substitute for proof of the model that actually executed;
- exact candidate-set closure through validation and attack-path analysis;
- additive canonical findings and coverage artifacts sealed by content digests; and
- a distinct `CAPPED` state that cannot be represented as a clean or complete scan.

GLaDOS intentionally does not adopt upstream scope exclusions that would skip tests, CI/CD, documentation examples, Dockerfiles, generated configuration, or deployment manifests. Those files remain in the deterministic inventory because they may contain reachable security behavior, leaked credentials, insecure build/deployment controls, or evidence needed to assess production reachability.
