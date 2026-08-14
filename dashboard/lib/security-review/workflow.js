const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_DEEP_ARTIFACTS,
  normalizeDeepScanConfig,
  validateDeepScanArtifacts,
} = require('./deep-scan');

const WORKFLOW_VERSION = 3;
const SPECIALIST_TRACKS = [
  'authorization-access-control',
  'data-flow-injection',
  'secrets-history',
  'resilience-error-handling',
  'iac-config-manifests',
  'cryptography-suppressions',
];
const SEMANTIC_REVIEW_CHECKS = [
  {
    id: 'request-binding-mass-assignment',
    requirement: 'Compare every externally bound object with every field and association persisted or passed to privileged services; typed binding is not proof of allowlisting.',
  },
  {
    id: 'directory-query-filter-injection',
    requirement: 'Trace user-controlled values into OData, Microsoft Graph, LDAP, and directory filter/search builders and prove escaping or parameterization.',
  },
  {
    id: 'graphql-abuse-controls',
    requirement: 'Disposition introspection, depth, complexity, aliases, batching, variable size, and execution timeout controls separately from SQL injection.',
  },
  {
    id: 'bearer-token-replay',
    requirement: 'Trace jti/uti/nonce or equivalent token identifiers to replay detection, revocation, and one-time-use enforcement; signature and expiry validation alone are insufficient.',
  },
  {
    id: 'oauth-operation-scope-enforcement',
    requirement: 'Compare every operation-declared OAuth scope with token scope claims and the middleware code that enforces the required values.',
  },
  {
    id: 'authorization-policy-constant-consistency',
    requirement: 'Compare route intent and operation names with the exact permission/role constant enforced at every handler and service boundary.',
  },
  {
    id: 'orm-mutation-ordering',
    requirement: 'Verify ownership and authorization predicates are applied before Create, Save, Update, and Delete execute; fluent calls after a terminal mutation do not constrain it.',
  },
  {
    id: 'deployment-reachability-claims',
    requirement: 'Separate static configuration presence from observed deployment state and exploitation; every active-production claim needs runtime evidence or must be phrased conditionally.',
  },
  {
    id: 'cross-track-referral-closure',
    requirement: 'Give every concern referred by one specialist to another a final finding, tested-negative, not-applicable, or blocker disposition; no concern may disappear between tracks.',
  },
];
const TERMINAL_SEMANTIC_STATUSES = new Set(['FINDING', 'TESTED_NEGATIVE', 'NOT_APPLICABLE']);

function securityReviewArtifactRoot(runtimeDir, engagementId) {
  return path.join(runtimeDir, 'investigations', engagementId, 'security-review');
}

function securityReviewCoordinatorPrompt({
  repositoryPath,
  engagementId,
  goalId,
  artifactRoot,
  contextMode = 'blind',
  deepScan = {},
  modelPolicy = {},
  reviewProfile = 'comprehensive',
  campaign = null,
}) {
  const mode = ['blind', 'regression', 'informed'].includes(contextMode) ? contextMode : 'blind';
  const profile = reviewProfile === 'expedited' ? 'expedited' : 'comprehensive';
  const scan = normalizeDeepScanConfig(deepScan);
  const campaignContract = campaign ? [
    '',
    'EXPEDITED MULTI-REPOSITORY CAMPAIGN CONTRACT:',
    `- The harness-created portfolio/repositories.json defines ${campaign.repository_count} required repositories. Preserve it; do not delete, reorder, rename, or silently merge repositories.`,
    `- Required breadth assignments: ${campaign.repositories.map(repo => `${repo.required_discovery_worker}=${repo.repository_id}:${repo.relative_path}`).join(', ')}.`,
    '- Breadth wave: before any repeated or cross-repository hotspot pass, dispatch exactly one blind-discovery worker scoped to each required repository using its assigned worker ID. Batches may contain up to the configured discovery concurrency. A broad worker inventories trust boundaries, entry points, authn/authz, data flows, secrets exposure, dependency/config/IaC risk, and executable security controls for its repository.',
    '- Depth wave: only after every breadth worker succeeds, use the shared threat model, deterministic inventories, and canonical candidates to rank hotspots across the portfolio. Spend remaining discovery attempts on the most attack-relevant paths, varying trust boundary and vulnerability class. Repository size alone is not a risk ranking.',
    '- Expedited means breadth-then-risk-ranked-depth, not reduced evidence standards. Do not sample away a repository, waive candidate closure, weaken High/Critical validation, or describe deferred/unreviewed coverage as clean.',
    '- Write portfolio/coverage.jsonl with exactly one row per repository: {"repository_id":"repo-NNN","status":"STANDARD_COMPLETE|TARGETED_DEEP_COMPLETE","discovery_worker_ids":["worker-NNN"],"inventory_file_count":1,"covered_file_count":1,"high_risk_surfaces":["path or component"],"specialist_tracks":["track-name"],"evidence":["artifact or exact source reference"],"residual_risks":[]}. The assigned breadth worker must be included. Counts must equal the deterministic manifest and coverage ledger for that repository. BLOCKED, DEFERRED, PARTIAL, and CLEAN_WITHOUT_REVIEW do not pass.',
    '- Generated, binary, vendored, and static assets may receive tooling-backed or deterministic class dispositions, but every file remains in the manifest and coverage ledger. Every security-sensitive candidate file still requires deep file-specific review.',
  ] : [];
  const contextContract = mode === 'blind'
    ? [
        'CONTEXT MODE: BLIND',
        '- This is an intentional independent capability assessment. Do not search for, open, infer, summarize, or compare any prior report, Dradis project, historical finding, previous GLaDOS investigation, blackboard finding, report directory, or operator context containing earlier conclusions.',
        '- Do not run Stage 5 historical regression. Mark it NOT_REQUESTED_BLIND_MODE. The absence of regression does not block completion in this mode.',
        '- The operator may provide the prior report later in a separate regression/comparison request. Keep this run uncontaminated until then.',
      ]
    : mode === 'regression'
      ? [
          'CONTEXT MODE: REGRESSION',
          '- This run is a historical comparison. Load only the prior report/context explicitly supplied by the operator or already attached to this security-review run.',
          '- Do not claim independent blind discovery. Disposition every supplied historical finding and produce a delta table.',
        ]
      : [
          'CONTEXT MODE: INFORMED',
          '- Run blind discovery first without exposing prior finding details to the blind task, then perform mandatory historical regression with matched prior context.',
        ];
  return [
    'SOURCE SECURITY REVIEW WORKFLOW v3 — DEEP COORDINATOR CONTRACT',
    `repository_path: ${repositoryPath}`,
    `engagement_id: ${engagementId}`,
    `controller_goal_id: ${goalId}`,
    `artifact_root: ${artifactRoot}`,
    `context_mode: ${mode}`,
    `review_profile: ${profile}`,
    `campaign_manifest: ${campaign ? 'portfolio/repositories.json' : 'none'}`,
    `deadline_at: ${deepScan.deadlineAt || 'none (operator did not set a wall-clock limit)'}`,
    `model_policy: ${JSON.stringify(modelPolicy)}`,
    ...contextContract,
    ...campaignContract,
    '',
    'The assessed repository is read-only. You may write only under artifact_root and the blackboard.',
    'Do not deliver conclusions after one broad pass. Run the ordered workflow below and preserve each artifact.',
    '',
    'Stage 1 — Intake and context controls:',
    '- Record real repository root, branch, HEAD commit, dirty state, explicit scope, and exclusions in intake/scope.json.',
    mode === 'blind'
      ? '- Record that historical lookup is prohibited by operator request; do not enumerate prior reports.'
      : '- Resolve prior context only as allowed by the context-mode contract and repository identity, never by basename alone.',
    '',
    'Stage 2 — Deterministic inventory:',
    '- Require a complete sorted file manifest, route inventory, linter suppression inventory, crypto-operation inventory, HTTP-client inventory, security-sensitive semantic candidate inventory, HEAD secrets-scan receipt, and git-history secrets-scan receipt.',
    '- Every manifest, deployment overlay, Terraform module, CI task, configuration, and script must be enumerated. Sampling is prohibited.',
    '- A directory snapshot without .git metadata is valid. Use its deterministic snapshot hash as the immutable revision and record Git-history scanning as unavailable with the exact blocker; do not reject the review.',
    '',
    'Stage 3 — Threat model and repeated blind discovery:',
    '- First write context/threat-model.json with summary, trust_boundaries, entry_points, assets, attacker_goals, and priority_hypotheses. Derive it only from this repository and the operator-declared scope.',
    `- Run at least ${scan.minDiscoveryRuns} successful source-code discovery attempts, stopping only after ${scan.stopAfterNoNew} consecutive successful attempts add no canonical candidates.${scan.maxDiscoveryRuns == null ? ' This completion-driven profile has no fixed discovery-attempt ceiling.' : ` Never start more than ${scan.maxDiscoveryRuns} attempts.`} Never continue after an operator-set deadline in run.json.`,
    campaign
      ? `- Campaign saturation cannot be evaluated until all ${campaign.repository_count} required breadth workers have succeeded and are present in centralized deduplication. A no-new streak reached before the breadth wave ends is not saturation.`
      : '- Saturation is evaluated across the single assessed source tree after the minimum successful run count.',
    `- Coordinator dispatch boundary: GLaDOS owns orchestration and aggregation. Dispatch discovery in ordered batches of up to ${scan.discoveryConcurrency} synchronous Agent SDK source-code tasks in one assistant response so the SDK runs that batch concurrently. Never ask one source-code task to run the complete workflow, multiple discovery workers, validation, or multiple specialist tracks. Each worker writes only its own directory. After the full batch returns, reconcile terminal rows and run centralized deduplication strictly by worker ordinal before dispatching the next batch. Never let completion order alter canonical ordering or saturation. Before dispatch, record started_at and the current runtime observation IDs; after return, use only harness-issued observations bound to that worker. Never invent, predict, alias, or use a placeholder observation ID.`,
    '- Every blind-discovery Agent SDK task prompt must begin with these three standalone machine-readable lines exactly: security_review_role: blind-discovery; worker_id: worker-NNN; artifact_root: <the absolute artifact_root above>. Put each field on its own line with no bullets, backticks, trailing punctuation, aliases such as "Artifact root", or surrounding prose. The runtime denies dispatch when any header is missing or noncanonical.',
    '- Every attempt is a durable worker. Append exactly one terminal row to discovery/deep/workers.jsonl using {"worker_id":"worker-NNN","sequence":1,"attempt":1,"status":"SUCCEEDED|FAILED|CANCELED","requested_model":"...","actual_model":"...","model_observation_ids":["model-observation-..."],"started_at":"ISO-8601","completed_at":"ISO-8601","retry_of":null,"candidates_artifact":"discovery/deep/worker-NNN/candidates.jsonl","receipt_artifact":"discovery/deep/worker-NNN/receipt.json"}. Use error instead of candidate/receipt paths for a failed or canceled attempt. Do not rename completed_at to finished_at or candidates_artifact to candidate_artifact. model_observation_ids must be exact IDs already present in the harness runtime ledger and bound to the same worker_id.',
    '- A failed or canceled worker must be retried successfully or listed in discovery/deep/manifest.json omitted_workers with a concrete reason. A missing worker result is a failure, not zero findings.',
    '- Each successful worker writes its own candidates.jsonl plus receipt.json. The receipt schema is exactly {"worker_id":"worker-NNN","status":"SUCCEEDED","candidate_count":N,"candidates_sha256":"<64 lowercase hex>"}. Empty candidate files are valid successful results. COMPLETED, CLEAN, and prose-only receipts are invalid.',
    '- Dispatch source-code without prior-finding titles, CWEs, paths, conclusions, or any existing report content. Vary each discovery prompt by threat-model hypothesis, vulnerability class, trust boundary, and previously under-reviewed surface; do not merely repeat identical broad prompts.',
    '- Require findings with file:line, source-to-sink trace, reachability, attack assumptions, confidence, and CVSS preconditions.',
    '- Require tested-negative claims at exact file:line ranges. Package-level or directory-level CLEAN claims are invalid.',
    '- Every raw and canonical candidate uses this exact shape: {"candidate_id":"worker-NNN-CNNN","cwe_ids":["CWE-N"],"locations":[{"path":"repo/relative/file","start_line":1,"end_line":1,"role":"source|control|sink|evidence"}],"summary":"...","evidence":"...","control":"...","sink":"...","reachability":"...","counterevidence":"...","proof_gaps":[],"confidence":"high|medium|low"}. Raw candidate IDs must match their worker exactly (for example worker-001-C0001). Do not add a category token to the ID or substitute file/line/symbol keys, absolute paths, or prose line ranges.',
    '- After every successful attempt, run centralized deduplication. Write discovery/deep/dedupe.json using exactly {"input_worker_ids":["worker-001"],"mappings":[{"worker_id":"worker-001","source_candidate_id":"worker-001-C0001","canonical_candidate_id":"worker-001-C0001","rationale":"..."}],"new_candidate_counts":{"worker-001":1},"no_new_streak":0}. input_worker_ids must contain all successful workers in sequence order; every raw candidate must appear in exactly one mapping; new_candidate_counts is the count of canonical candidates first introduced by each worker; no_new_streak is the computed trailing zero count. Do not use successful_input_worker_ids, raw_candidate_id, first_introduction_new_candidate_counts, or trailing_no_new_streak.',
    '- Preserve the harness-created discovery/deep/manifest.json fields schema_version, status, config, started_at, deadline_at, and omitted_workers. Do not replace that file with a different schema. Add completed_at and set status to SATURATED only after the no-new threshold and every hard gate pass; set status to CAPPED only when the deadline or run ceiling is reached.',
    '- Write the canonical union to discovery/candidates.jsonl. Location-only or title-only similarity cannot silently merge distinct vulnerability instances. Preserve contrary evidence and proof gaps during merges.',
    '',
    `Stage 4 — Independent specialist tracks: ${SPECIALIST_TRACKS.join(', ')}.`,
    `- After discovery saturation, dispatch specialist tracks in batches of up to ${scan.specialistConcurrency} separate synchronous source-code Agent SDK tasks in one assistant response. The SDK runs each batch concurrently. A returned primary worker cannot satisfy a specialist track, even if its broad pass discussed that class.`,
    '- Put `security_review_role: <exact-track-name>` in every specialist task prompt. Put `security_review_role: blind-discovery` and the exact worker_id in each discovery prompt, and `security_review_role: source-review-validator` in the validator prompt. Runtime model attribution depends on these durable role labels.',
    '- Authorization must produce a route/method/authn/scope/ownership/repository-filter matrix and trace handler -> service -> repository/ORM operation.',
    '- Secrets must inspect HEAD and git history while redacting values.',
    '- IaC must disposition every base and production overlay file.',
    '- Resilience must inspect every HTTP client timeout/retry and every swallowed operational error.',
    '- Crypto must resolve every nosec/nolint/gosec-equivalent suppression.',
    '',
    'Machine-checked semantic closure contract:',
    '- Write validation/semantic-coverage.json with top-level arrays checks, candidate_dispositions, and referrals.',
    '- checks must contain exactly the following IDs, each with terminal status FINDING, TESTED_NEGATIVE, or NOT_APPLICABLE; analysis; and at least one evidence object containing exact file, line_range, rule, observed_evidence, and result:',
    ...SEMANTIC_REVIEW_CHECKS.map(check => `  - ${check.id}: ${check.requirement}`),
    '- A FINDING check must include finding_ids. A NOT_APPLICABLE check must include a concrete reason and evidence of the applicability search. BLOCKED and REFERRED are nonterminal and cannot pass completion.',
    '- candidate_dispositions must have exact key equality with inventory/security-sensitive.jsonl using inventory_key. Each row must retain the inventory check_id and rule, cite that candidate file and exact line range, and end as FINDING, TESTED_NEGATIVE, or NOT_APPLICABLE.',
    '- referrals must include every issue one track hands to another and give it a terminal status plus evidence or finding_ids. An empty referrals array asserts that no track made a referral; verify that assertion against all track notes.',
    '- Any file in inventory/security-sensitive.jsonl requires deep file-specific coverage. reviewed-as-class, reviewed-class-level, and equivalent generic dispositions cannot close it.',
    '',
    'Stage 5 — Historical regression (mode-controlled):',
    mode === 'blind'
      ? '- SKIP. Write regression/delta.json with status NOT_REQUESTED_BLIND_MODE and no prior-finding content.'
      : '- Provide permitted prior context to a dedicated source-code task. Every historical finding must be CONFIRMED, CONFIRMED_FIXED, CONFIRMED_PARTIAL_FIX, NOT_IN_CURRENT_TREE, or BLOCKED with exact evidence.',
    '',
    'Stage 6 — Omission-focused independent validation:',
    '- Dispatch source-review-validator. It must inventory independently, inspect source rather than trust the primary coverage ledger, challenge every semantic check and candidate disposition, search for omitted vulnerability classes, and produce validation/challenge-matrix.json plus the final validation/semantic-coverage.json.',
    '- High/Critical findings require independent reproduction from source. Record primary and validator model aliases. If models match, record a model-diversity blocker for operator review.',
    '- Centralize every canonical candidate in validation/candidate-closure.jsonl with exactly one terminal disposition: REPORTABLE, SUPPRESSED, NOT_APPLICABLE, or DEFERRED. Preserve validation method, evidence, counterevidence, proof gaps, and finding IDs.',
    '- Analyze every canonical candidate in validation/attack-paths.jsonl with exactly one REPORTABLE, IGNORE, NOT_APPLICABLE, or DEFERRED decision, plus concrete reachability and rationale. This step ranks and chains candidates but may not delete them.',
    '- The harness correlates SDK request IDs with LiteLLM spend logs and appends gateway-observed deployment receipts to validation/runtime-model-observations.jsonl. Do not edit or synthesize that ledger. Write validation/model-receipts.jsonl for coordinator, source-code-primary, every specialist track, and source-review-validator; each receipt must cite one or more observation_ids proving the gateway deployment for the correct agent. Enforce run.json modelPolicy; SDK aliases and static roster labels are not proof of deployment.',
    '',
    'Stage 7 — Safe dynamic validation:',
    '- For medium-or-lower-confidence findings, perform only local/isolated safe validation when feasible; otherwise record the precise blocker. Never contact production merely to raise confidence.',
    '',
    'Stage 8 — Operator gate and reporting:',
    '- Automatically retry incomplete static-analysis/validation tasks and resolve recoverable registry/tooling errors without asking the operator. Do not pause merely to continue analysis.',
    '- When all analysis gates pass, deliver the validated findings, prior dispositions when applicable, delta table, challenge matrix, and residual blockers directly to the operator. Do not require approval to complete or present a security review.',
    '- Produce canonical additive artifacts scan-manifest.json, findings.json, coverage.json, and completion-receipt.json. Use producer glados-security-review/v1. Seal SHA-256 digests for run.json, the threat model, worker ledger, dedupe result, canonical candidates, validation closure, attack paths, model receipts, findings, and coverage in both the manifest and completion receipt.',
    '- SATURATED is the only successful terminal state. If an operator-set deadline or maximum-run ceiling arrives first, write CAPPED with exact residual work and stop; never convert CAPPED into CLEAN, COMPLETE, or SATURATED.',
    '- Explicit operator approval is required only for live/target-facing actions and for generating or publishing the formal report package. Do not dispatch report agents without explicit operator wrap approval.',
    '',
    'Hard completion gates:',
    ...(campaign ? [
      `0. Portfolio repository manifest and portfolio coverage have exact set equality across all ${campaign.repository_count} repositories; every assigned breadth worker succeeded, per-repository inventory and covered-file counts match, and no repository is partial, blocked, deferred, or silently omitted.`,
    ] : []),
    '1. File manifest and coverage ledger have exact set equality.',
    '2. Route inventory and authorization matrix have exact set equality.',
    '3. Security-sensitive candidate inventory and semantic candidate dispositions have exact set equality; every candidate file received deep file-specific review.',
    '4. All required semantic checks are terminal with exact evidence, and all cross-track referrals are closed.',
    '5. Injection/exposure findings and negative claims include complete source-to-sink evidence.',
    mode === 'blind' ? '6. Historical regression records NOT_REQUESTED_BLIND_MODE without reading prior content.' : '6. Every supplied prior finding is dispositioned.',
    '7. Tested-negative rows cite exact files, line ranges, rule, observed evidence, and result.',
    '8. Every suppression is ACCEPTED with justification or mapped to a finding.',
    '9. CVSS >=7 documents metric preconditions; CVSS >=9 names a reachable unauthenticated network path or is blocked for downgrade review.',
    '10. Every High/Critical finding has validator confirmation.',
    '11. HEAD and history secret-scan receipts exist for the recorded HEAD.',
    '12. Every discovery worker is terminal; failures are successfully retried or explicitly omitted with reason.',
    `13. Every raw candidate is deduplicated exactly once, every canonical candidate reaches centralized validation and attack-path analysis, and saturation is proven by ${scan.stopAfterNoNew} consecutive no-new successful runs.`,
    '14. Every required review role has an observed model receipt that satisfies run.json modelPolicy.',
    '15. Canonical findings and coverage have exact closure with candidate dispositions and deterministic inventory, and all sealed artifact digests verify.',
    '16. No unexplained file, route, prior-finding, suppression, worker, raw candidate, canonical candidate, track, referral, model, or validation gap remains.',
    '',
    'Create one blackboard task per stage/track and include engagement_id in every blackboard_task_update. A returned model answer is not proof that a gate passed. Mark the analysis goal complete and deliver validated results once analysis gates pass; wait for operator approval only before live actions or formal report generation/publication.',
  ].join('\n');
}

const REQUIRED_REVIEW_ARTIFACTS = [
  'run.json',
  'intake/scope.json',
  'inventory/files.jsonl',
  'inventory/routes.jsonl',
  'inventory/suppressions.jsonl',
  'inventory/http-clients.jsonl',
  'inventory/crypto-operations.jsonl',
  'inventory/security-sensitive.jsonl',
  'inventory/secrets-head.json',
  'inventory/secrets-history.json',
  'discovery/findings.jsonl',
  'discovery/coverage-ledger.jsonl',
  ...SPECIALIST_TRACKS.map(track => `tracks/${track}/findings.jsonl`),
  'tracks/authorization-access-control/route-authz-matrix.jsonl',
  'tracks/data-flow-injection/source-sink-matrix.jsonl',
  'tracks/secrets-history/history-receipt.json',
  'tracks/resilience-error-handling/http-client-matrix.jsonl',
  'tracks/iac-config-manifests/disposition-matrix.jsonl',
  'tracks/cryptography-suppressions/crypto-matrix.jsonl',
  'tracks/cryptography-suppressions/suppression-dispositions.jsonl',
  'regression/delta.json',
  'dynamic-validation/matrix.jsonl',
  'validation/challenge-matrix.json',
  'validation/semantic-coverage.json',
  ...REQUIRED_DEEP_ARTIFACTS,
];

function readJsonArtifact(artifactRoot, relative, invalid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(artifactRoot, relative), 'utf8'));
  } catch (error) {
    invalid.push(`${relative}: invalid JSON (${error.message})`);
    return null;
  }
}

function readJsonLinesArtifact(artifactRoot, relative, invalid) {
  const rows = [];
  let text;
  try {
    text = fs.readFileSync(path.join(artifactRoot, relative), 'utf8');
  } catch (error) {
    invalid.push(`${relative}: unreadable (${error.message})`);
    return rows;
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('row is not an object');
      rows.push(row);
    } catch (error) {
      invalid.push(`${relative}:${index + 1}: invalid JSONL (${error.message})`);
    }
  }
  return rows;
}

function keyedRows(rows, fields, label, invalid, { allowEmpty = true } = {}) {
  const out = new Map();
  for (const [index, row] of rows.entries()) {
    const key = fields.map(field => row[field]).find(value => typeof value === 'string' && value.trim());
    if (!key) {
      invalid.push(`${label}:${index + 1}: missing ${fields.join(' or ')}`);
      continue;
    }
    if (out.has(key)) invalid.push(`${label}: duplicate key ${key}`);
    out.set(key, row);
  }
  if (!allowEmpty && out.size === 0) invalid.push(`${label}: must contain at least one row`);
  return out;
}

function requireExactKeys(left, right, label, invalid) {
  const missing = [...left.keys()].filter(key => !right.has(key));
  const extra = [...right.keys()].filter(key => !left.has(key));
  if (missing.length || extra.length) {
    invalid.push(`${label}: key mismatch (missing ${missing.length}, extra ${extra.length})`
      + `${missing.length ? `; first missing: ${missing.slice(0, 3).join(', ')}` : ''}`
      + `${extra.length ? `; first extra: ${extra.slice(0, 3).join(', ')}` : ''}`);
  }
}

function requireText(value, label, invalid) {
  if (typeof value !== 'string' || !value.trim()) invalid.push(`${label}: required non-empty string`);
}

function validateEvidence(evidence, label, invalid, { expectedFile = null, expectedRule = null } = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    invalid.push(`${label}: evidence must be an object`);
    return;
  }
  for (const field of ['file', 'line_range', 'rule', 'observed_evidence', 'result']) {
    requireText(evidence[field], `${label}.${field}`, invalid);
  }
  if (typeof evidence.line_range === 'string' && !/\d/.test(evidence.line_range)) {
    invalid.push(`${label}.line_range: must contain exact line numbers`);
  }
  if (expectedFile && evidence.file !== expectedFile) {
    invalid.push(`${label}.file: expected ${expectedFile}`);
  }
  if (expectedRule && evidence.rule !== expectedRule) {
    invalid.push(`${label}.rule: expected ${expectedRule}`);
  }
}

function sourceReviewGateStatus(artifactRoot, options = {}) {
  let runPreview = null;
  try { runPreview = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8')); } catch {}
  const campaignExpected = options.campaignExpected === true;
  const campaignEnabled = runPreview?.campaign?.enabled === true;
  const requiredArtifacts = campaignExpected || campaignEnabled
    ? [...REQUIRED_REVIEW_ARTIFACTS, 'portfolio/repositories.json', 'portfolio/coverage.jsonl']
    : REQUIRED_REVIEW_ARTIFACTS;
  const missing = requiredArtifacts.filter(relative => !fs.existsSync(path.join(artifactRoot, relative)));
  const invalid = [];
  const available = relative => !missing.includes(relative);

  const jsonl = relative => available(relative) ? readJsonLinesArtifact(artifactRoot, relative, invalid) : [];
  const json = relative => available(relative) ? readJsonArtifact(artifactRoot, relative, invalid) : null;

  const manifest = keyedRows(jsonl('inventory/files.jsonl'), ['key', 'path'], 'inventory/files.jsonl', invalid, { allowEmpty: false });
  const coverage = keyedRows(jsonl('discovery/coverage-ledger.jsonl'), ['key', 'path'], 'discovery/coverage-ledger.jsonl', invalid);
  if (available('inventory/files.jsonl') && available('discovery/coverage-ledger.jsonl')) {
    requireExactKeys(manifest, coverage, 'file manifest vs coverage ledger', invalid);
  }

  const routes = keyedRows(jsonl('inventory/routes.jsonl'), ['key'], 'inventory/routes.jsonl', invalid);
  const routeMatrix = keyedRows(jsonl('tracks/authorization-access-control/route-authz-matrix.jsonl'), ['inventory_key'], 'route authorization matrix', invalid);
  if (available('inventory/routes.jsonl') && available('tracks/authorization-access-control/route-authz-matrix.jsonl')) {
    requireExactKeys(routes, routeMatrix, 'route inventory vs authorization matrix', invalid);
    for (const [key, row] of routeMatrix) {
      for (const field of ['authn', 'scope_role', 'ownership', 'repository_filter', 'trace', 'disposition']) {
        if (row[field] === undefined || row[field] === null || row[field] === '') {
          invalid.push(`route authorization matrix ${key}: missing ${field}`);
        }
      }
      const mutation = /^(?:POST|PUT|PATCH|DELETE)$/i.test(String(row.method || ''));
      const clean = /CLEAN/.test(String(row.disposition || '').toUpperCase());
      const unenforced = value => /^(?:N\/A|NONE|UNKNOWN|UNVERIFIED)$/i.test(String(value || '').trim());
      const intentionallyPublic = /INTENTIONAL|PUBLIC|LOGIN|CALLBACK/.test(String(row.disposition || '').toUpperCase());
      if (mutation && clean && !intentionallyPublic && (unenforced(row.authn) || unenforced(row.scope_role))) {
        invalid.push(`route authorization matrix ${key}: clean mutation lacks concrete authn/scope enforcement`);
      }
    }
  }

  const candidates = keyedRows(jsonl('inventory/security-sensitive.jsonl'), ['inventory_key'], 'inventory/security-sensitive.jsonl', invalid);
  for (const candidate of candidates.values()) {
    const fileCoverage = coverage.get(candidate.file);
    if (!fileCoverage) continue;
    const method = `${fileCoverage.review_method || ''} ${fileCoverage.disposition || ''}`;
    if (!fileCoverage.review_method || /reviewed[-_ ]?as[-_ ]?class|class[-_ ]?level/i.test(method)) {
      invalid.push(`coverage ledger ${candidate.file}: security-sensitive candidate requires deep file-specific review`);
    }
  }

  const semantic = json('validation/semantic-coverage.json');
  if (semantic) {
    if (!Array.isArray(semantic.checks)) invalid.push('validation/semantic-coverage.json: checks must be an array');
    if (!Array.isArray(semantic.candidate_dispositions)) invalid.push('validation/semantic-coverage.json: candidate_dispositions must be an array');
    if (!Array.isArray(semantic.referrals)) invalid.push('validation/semantic-coverage.json: referrals must be an array');

    const checks = keyedRows(Array.isArray(semantic.checks) ? semantic.checks : [], ['id'], 'semantic checks', invalid);
    const requiredChecks = new Map(SEMANTIC_REVIEW_CHECKS.map(check => [check.id, check]));
    requireExactKeys(requiredChecks, checks, 'required semantic checks', invalid);
    for (const [id, check] of checks) {
      const status = String(check.status || '').toUpperCase();
      if (!TERMINAL_SEMANTIC_STATUSES.has(status)) {
        invalid.push(`semantic check ${id}: status ${status || '(missing)'} is not terminal`);
      }
      requireText(check.analysis, `semantic check ${id}.analysis`, invalid);
      if (!Array.isArray(check.evidence) || check.evidence.length === 0) {
        invalid.push(`semantic check ${id}: evidence must contain at least one exact evidence object`);
      } else {
        check.evidence.forEach((item, index) => validateEvidence(item, `semantic check ${id}.evidence[${index}]`, invalid));
      }
      if (status === 'FINDING' && (!Array.isArray(check.finding_ids) || check.finding_ids.length === 0)) {
        invalid.push(`semantic check ${id}: FINDING requires finding_ids`);
      }
      if (status === 'NOT_APPLICABLE') requireText(check.reason, `semantic check ${id}.reason`, invalid);
    }

    const dispositions = keyedRows(
      Array.isArray(semantic.candidate_dispositions) ? semantic.candidate_dispositions : [],
      ['inventory_key'],
      'semantic candidate dispositions',
      invalid
    );
    requireExactKeys(candidates, dispositions, 'security-sensitive inventory vs semantic candidate dispositions', invalid);
    for (const [key, disposition] of dispositions) {
      const candidate = candidates.get(key);
      const status = String(disposition.status || '').toUpperCase();
      if (!TERMINAL_SEMANTIC_STATUSES.has(status)) {
        invalid.push(`semantic candidate ${key}: status ${status || '(missing)'} is not terminal`);
      }
      if (candidate && disposition.check_id !== candidate.check_id) {
        invalid.push(`semantic candidate ${key}: expected check_id ${candidate.check_id}`);
      }
      validateEvidence(disposition.evidence, `semantic candidate ${key}.evidence`, invalid, {
        expectedFile: candidate?.file || null,
        expectedRule: candidate?.rule || null,
      });
      if (status === 'FINDING' && (!Array.isArray(disposition.finding_ids) || disposition.finding_ids.length === 0)) {
        invalid.push(`semantic candidate ${key}: FINDING requires finding_ids`);
      }
      if (status === 'NOT_APPLICABLE') requireText(disposition.reason, `semantic candidate ${key}.reason`, invalid);
    }

    for (const [index, referral] of (Array.isArray(semantic.referrals) ? semantic.referrals : []).entries()) {
      requireText(referral?.id, `semantic referral[${index}].id`, invalid);
      const status = String(referral?.status || '').toUpperCase();
      if (!TERMINAL_SEMANTIC_STATUSES.has(status)) {
        invalid.push(`semantic referral ${referral?.id || index}: status ${status || '(missing)'} is not terminal`);
      }
      const hasFinding = Array.isArray(referral?.finding_ids) && referral.finding_ids.length > 0;
      if (!hasFinding && !referral?.evidence) invalid.push(`semantic referral ${referral?.id || index}: requires evidence or finding_ids`);
      if (referral?.evidence) validateEvidence(referral.evidence, `semantic referral ${referral?.id || index}.evidence`, invalid);
    }
  }

  const suppressions = keyedRows(jsonl('inventory/suppressions.jsonl'), ['key'], 'inventory/suppressions.jsonl', invalid);
  const suppressionDispositions = keyedRows(jsonl('tracks/cryptography-suppressions/suppression-dispositions.jsonl'), ['inventory_key'], 'suppression dispositions', invalid);
  if (available('inventory/suppressions.jsonl') && available('tracks/cryptography-suppressions/suppression-dispositions.jsonl')) {
    requireExactKeys(suppressions, suppressionDispositions, 'suppression inventory vs dispositions', invalid);
    for (const [key, row] of suppressionDispositions) {
      const accepted = /^ACCEPTED(?:_|$)/i.test(String(row.disposition || ''));
      if (!accepted && !row.finding_id && !(Array.isArray(row.finding_ids) && row.finding_ids.length)) {
        invalid.push(`suppression disposition ${key}: must be accepted with rationale or mapped to a finding`);
      }
      requireText(row.rationale || row.notes, `suppression disposition ${key}.rationale`, invalid);
    }
  }

  const crypto = keyedRows(jsonl('inventory/crypto-operations.jsonl'), ['key'], 'inventory/crypto-operations.jsonl', invalid);
  const cryptoMatrix = keyedRows(jsonl('tracks/cryptography-suppressions/crypto-matrix.jsonl'), ['inventory_key'], 'crypto matrix', invalid);
  if (available('inventory/crypto-operations.jsonl') && available('tracks/cryptography-suppressions/crypto-matrix.jsonl')) {
    requireExactKeys(crypto, cryptoMatrix, 'crypto inventory vs crypto matrix', invalid);
  }

  const httpClients = keyedRows(jsonl('inventory/http-clients.jsonl'), ['key'], 'inventory/http-clients.jsonl', invalid);
  const httpMatrix = keyedRows(jsonl('tracks/resilience-error-handling/http-client-matrix.jsonl'), ['inventory_key'], 'HTTP client matrix', invalid);
  if (available('inventory/http-clients.jsonl') && available('tracks/resilience-error-handling/http-client-matrix.jsonl')) {
    requireExactKeys(httpClients, httpMatrix, 'HTTP client inventory vs resilience matrix', invalid);
  }

  const run = json('run.json');
  const scope = json('intake/scope.json');
  if (campaignExpected && run?.campaign?.enabled !== true) {
    invalid.push('run.json.campaign.enabled: controller expected a campaign run and the campaign marker must remain true');
  }
  if (run?.campaign?.enabled && run.reviewProfile !== 'expedited') {
    invalid.push('run.json.reviewProfile: campaign runs require the expedited profile');
  }
  if (run) {
    requireText(run.head, 'run.json.head', invalid);
    if (Number(run.fileCount) !== manifest.size) {
      invalid.push(`run.json.fileCount: expected ${manifest.size}, received ${run.fileCount}`);
    }
    if (scope?.repository?.head && scope.repository.head !== run.head) {
      invalid.push('intake/scope.json: repository head does not match run.json');
    }
  }

  if (run?.campaign?.enabled) {
    const portfolio = json('portfolio/repositories.json');
    const portfolioCoverageRows = jsonl('portfolio/coverage.jsonl');
    const repositories = keyedRows(
      Array.isArray(portfolio?.repositories) ? portfolio.repositories : [],
      ['repository_id'],
      'portfolio repositories',
      invalid,
      { allowEmpty: false }
    );
    const repositoryCoverage = keyedRows(
      portfolioCoverageRows,
      ['repository_id'],
      'portfolio coverage',
      invalid,
      { allowEmpty: false }
    );
    requireExactKeys(repositories, repositoryCoverage, 'portfolio repositories vs coverage', invalid);
    if (Number(portfolio?.repository_count) !== repositories.size) {
      invalid.push(`portfolio/repositories.json.repository_count: expected ${repositories.size}, received ${portfolio?.repository_count}`);
    }
    if (Number(run.campaign.repositoryCount) !== repositories.size) {
      invalid.push(`run.json.campaign.repositoryCount: expected ${repositories.size}, received ${run.campaign.repositoryCount}`);
    }
    const successfulWorkers = new Set(json('discovery/deep/dedupe.json')?.input_worker_ids || []);
    for (const [repositoryId, repository] of repositories) {
      requireText(repository.relative_path, `portfolio repository ${repositoryId}.relative_path`, invalid);
      requireText(repository.required_discovery_worker, `portfolio repository ${repositoryId}.required_discovery_worker`, invalid);
    }
    for (const [repositoryId, row] of repositoryCoverage) {
      const repository = repositories.get(repositoryId);
      const status = String(row.status || '').toUpperCase();
      if (!['STANDARD_COMPLETE', 'TARGETED_DEEP_COMPLETE'].includes(status)) {
        invalid.push(`portfolio coverage ${repositoryId}: status ${status || '(missing)'} is not complete`);
      }
      for (const field of ['discovery_worker_ids', 'high_risk_surfaces', 'specialist_tracks', 'evidence', 'residual_risks']) {
        if (!Array.isArray(row[field])) invalid.push(`portfolio coverage ${repositoryId}.${field}: must be an array`);
      }
      if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
        invalid.push(`portfolio coverage ${repositoryId}.evidence: at least one artifact or exact source reference is required`);
      }
      const workers = Array.isArray(row.discovery_worker_ids) ? row.discovery_worker_ids : [];
      if (repository?.required_discovery_worker && !workers.includes(repository.required_discovery_worker)) {
        invalid.push(`portfolio coverage ${repositoryId}: missing assigned breadth worker ${repository.required_discovery_worker}`);
      }
      for (const workerId of workers) {
        if (!successfulWorkers.has(workerId)) invalid.push(`portfolio coverage ${repositoryId}: worker ${workerId} is not a successful deduplicated discovery worker`);
      }
      const relativePath = typeof repository?.relative_path === 'string' ? repository.relative_path : '';
      const prefix = relativePath ? `${relativePath.replace(/\/$/, '')}/` : null;
      if (prefix) {
        const expectedInventoryCount = [...manifest.keys()].filter(key => key === relativePath || key.startsWith(prefix)).length;
        const expectedCoverageCount = [...coverage.keys()].filter(key => key === relativePath || key.startsWith(prefix)).length;
        if (Number(row.inventory_file_count) !== expectedInventoryCount) {
          invalid.push(`portfolio coverage ${repositoryId}.inventory_file_count: expected ${expectedInventoryCount}, received ${row.inventory_file_count}`);
        }
        if (Number(row.covered_file_count) !== expectedCoverageCount) {
          invalid.push(`portfolio coverage ${repositoryId}.covered_file_count: expected ${expectedCoverageCount}, received ${row.covered_file_count}`);
        }
      }
    }
  }

  const headReceipt = json('inventory/secrets-head.json');
  if (headReceipt && headReceipt.completed !== true) invalid.push('inventory/secrets-head.json: scan must be completed');
  if (run?.head && headReceipt?.head && headReceipt.head !== run.head) {
    invalid.push('inventory/secrets-head.json: head does not match run.json');
  }
  const historyReceipt = json('inventory/secrets-history.json');
  if (historyReceipt && historyReceipt.completed !== true) {
    if (historyReceipt.unavailable !== true || typeof historyReceipt.reason !== 'string' || !historyReceipt.reason.trim()) {
      invalid.push('inventory/secrets-history.json: incomplete scan requires unavailable=true and an exact reason');
    }
  }
  if (run?.head && historyReceipt?.head && historyReceipt.head !== run.head) {
    invalid.push('inventory/secrets-history.json: head does not match run.json');
  }

  const trackHistoryReceipt = json('tracks/secrets-history/history-receipt.json');
  if (run?.head && trackHistoryReceipt?.snapshot_head && trackHistoryReceipt.snapshot_head !== run.head) {
    invalid.push('tracks/secrets-history/history-receipt.json: snapshot_head does not match run.json');
  }

  const challengeMatrix = json('validation/challenge-matrix.json');
  const findingRows = [
    ...jsonl('discovery/findings.jsonl'),
    ...SPECIALIST_TRACKS.flatMap(track => jsonl(`tracks/${track}/findings.jsonl`)),
  ];
  if (challengeMatrix) {
    if (!Array.isArray(challengeMatrix.outcomes)) {
      invalid.push('validation/challenge-matrix.json: outcomes must be an array');
    } else {
      const outcomes = challengeMatrix.outcomes;
      for (const [index, finding] of findingRows.entries()) {
        if (!/^(?:high|critical)$/i.test(String(finding.severity || ''))) continue;
        const findingId = finding.id || finding.finding_id;
        if (!findingId) {
          invalid.push(`high/critical finding row ${index + 1}: missing id or finding_id`);
          continue;
        }
        const validation = outcomes.find(row => row?.id === findingId || row?.primary_id === findingId);
        if (!validation || !/^CONFIRMED(?:_|$)/i.test(String(validation.outcome || ''))) {
          invalid.push(`high/critical finding ${findingId}: missing validator confirmation`);
        }
      }
    }
  }

  for (const relative of [
    'regression/delta.json',
  ]) json(relative);
  for (const relative of [
    'tracks/data-flow-injection/source-sink-matrix.jsonl',
    'tracks/iac-config-manifests/disposition-matrix.jsonl',
    'dynamic-validation/matrix.jsonl',
  ]) jsonl(relative);

  const deep = validateDeepScanArtifacts(artifactRoot, options);
  for (const relative of deep.missing) if (!missing.includes(relative)) missing.push(relative);
  invalid.push(...deep.invalid);
  return {
    workflowVersion: WORKFLOW_VERSION,
    passed: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

module.exports = {
  WORKFLOW_VERSION,
  SPECIALIST_TRACKS,
  SEMANTIC_REVIEW_CHECKS,
  REQUIRED_REVIEW_ARTIFACTS,
  securityReviewArtifactRoot,
  securityReviewCoordinatorPrompt,
  sourceReviewGateStatus,
};
