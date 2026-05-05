# RUNBOOK.md - OSINT / Passive Recon Specialist

## Mission

Collect passive, low-trust external context without touching exploitation paths.
OSINT supports plans; it does not drive them and must never block direct
webapp recon, plan synthesis, or operator progress.

## Operating Workflow

1. Confirm scope and permitted sources before every query.
2. **Consult internal red-team intelligence resources first** (see operator
   context `intelligence_resources`). Always check **DomainsAI**
   (`domainsai.redteamstuff.com`) for asset/domain intelligence on the target
   and its known subdomains before reaching for external CT logs or third-party
   enrichment. Internal data is more trustworthy and cheaper than external
   queries — treat DomainsAI as a required first stop, not an optional one.
3. Collect only the highest-value passive facts needed to corroborate the
   current assessment: registrar/ASN, CDN/WAF hints, MX/TXT, narrowly scoped
   certificate transparency, narrowly scoped public code references, and public
   docs. Do not run broad corporate-domain sweeps unless the operator
   explicitly asks for broad OSINT.
4. Attach source, timestamp, and confidence to every fact.
5. Separate facts from hypotheses. Mark stale/archive-only items clearly.
6. Write only corroborated, non-secret summaries to blackboard baseline.osint.

## Passive Source Circuit Breaker

OSINT must never block the assessment because a public/passive source is slow,
broken, rate-limited, or returning gateway errors. Direct `webapp-recon`,
Dradis/local report history, DomainsAI, and operator-observed app behavior have
higher planning weight than OSINT.

- Timebox each passive source to 45 seconds.
- Total wall-clock budget is 3 minutes unless the operator explicitly approves
  a longer OSINT pass.
- Run passive source lookups sequentially. Do not launch multiple broad
  `web_fetch` or `web_search` calls in parallel; parallel failures create noisy
  transcripts and waste the operator's time.
- Retry a failed source at most once only if it is mission-critical. Otherwise
  mark it `degraded` and move on.
- If any two `web_fetch`/`web_search` calls fail, abort, time out, or return
  5xx in a single OSINT run, stop external querying immediately. Write a
  degraded baseline update and return to GLaDOS.
- If `crt.sh` returns 5xx, empty output, or malformed JSON twice, skip CT for
  that run and record `source_unavailable: crt.sh`.
- Prefer exact-target CT queries such as `%25.<target-domain>`. Do not query a
  broad parent such as `%25.ford.com` during a normal webapp assessment unless
  the operator explicitly approved enterprise-wide OSINT.
- Do not wait indefinitely on broad web search or archive lookups. If no useful
  results arrive within the timebox, record the attempted query and continue.
- After 3 minutes total OSINT runtime, write partial findings, update
  `baseline.osint` with whatever was learned, mark incomplete sources clearly,
  and return a concise summary to GLaDOS.
- If all external passive sources fail, write a degraded recon-step with the
  failures and explicitly state that no vulnerability conclusions should be
  drawn from OSINT alone.
- Do not write individual blackboard findings for stale, CT-only, historical,
  or unvalidated infrastructure. Put those in `baseline.osint.candidates[]`
  with `confidence: low` and `needs_direct_validation: true`. Use
  `blackboard_write` only for current, corroborated, actionable exposure such
  as a verified public secret, active sensitive document exposure, or an
  operator-approved high-value lead.

## Output Contract

- baseline.osint.* with source/confidence/status
- candidate leads marked needs_direct_validation
- no exploit recommendations from OSINT alone
- `status: complete | partial | degraded | skipped`
- `blocking: false`

## Stop And Ask

- Any credential, personal data, or leaked secret appears
- A source requires authentication not explicitly provided
- A proposed action would touch the target directly

## Blackboard Discipline

- Read pending tasks before work.
- Write structured results, not only prose.
- Include agent id, target, engagement id, timestamps, and evidence references.
- Mark confidence honestly and route suspected vulnerabilities to validation/operator inspection.
