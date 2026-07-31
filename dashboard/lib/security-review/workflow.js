const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_VERSION = 2;
const SPECIALIST_TRACKS = [
  'authorization-access-control',
  'data-flow-injection',
  'secrets-history',
  'resilience-error-handling',
  'iac-config-manifests',
  'cryptography-suppressions',
];

function securityReviewArtifactRoot(runtimeDir, engagementId) {
  return path.join(runtimeDir, 'investigations', engagementId, 'security-review');
}

function securityReviewCoordinatorPrompt({ repositoryPath, engagementId, goalId, artifactRoot, contextMode = 'blind' }) {
  const mode = ['blind', 'regression', 'informed'].includes(contextMode) ? contextMode : 'blind';
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
    'SOURCE SECURITY REVIEW WORKFLOW v2 — COORDINATOR CONTRACT',
    `repository_path: ${repositoryPath}`,
    `engagement_id: ${engagementId}`,
    `controller_goal_id: ${goalId}`,
    `artifact_root: ${artifactRoot}`,
    `context_mode: ${mode}`,
    ...contextContract,
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
    '- Require a complete sorted file manifest, route inventory, linter suppression inventory, crypto-operation inventory, HTTP-client inventory, HEAD secrets-scan receipt, and git-history secrets-scan receipt.',
    '- Every manifest, deployment overlay, Terraform module, CI task, configuration, and script must be enumerated. Sampling is prohibited.',
    '',
    'Stage 3 — Blind discovery:',
    '- Dispatch source-code without prior-finding titles, CWEs, paths, or conclusions.',
    '- Require findings with file:line, source-to-sink trace, reachability, attack assumptions, confidence, and CVSS preconditions.',
    '- Require tested-negative claims at exact file:line ranges. Package-level or directory-level CLEAN claims are invalid.',
    '',
    `Stage 4 — Independent specialist tracks (run as separate tasks, serially if necessary): ${SPECIALIST_TRACKS.join(', ')}.`,
    '- Authorization must produce a route/method/authn/scope/ownership/repository-filter matrix and trace handler -> service -> repository/ORM operation.',
    '- Secrets must inspect HEAD and git history while redacting values.',
    '- IaC must disposition every base and production overlay file.',
    '- Resilience must inspect every HTTP client timeout/retry and every swallowed operational error.',
    '- Crypto must resolve every nosec/nolint/gosec-equivalent suppression.',
    '',
    'Stage 5 — Historical regression (mode-controlled):',
    mode === 'blind'
      ? '- SKIP. Write regression/delta.json with status NOT_REQUESTED_BLIND_MODE and no prior-finding content.'
      : '- Provide permitted prior context to a dedicated source-code task. Every historical finding must be CONFIRMED, CONFIRMED_FIXED, CONFIRMED_PARTIAL_FIX, NOT_IN_CURRENT_TREE, or BLOCKED with exact evidence.',
    '',
    'Stage 6 — Omission-focused independent validation:',
    '- Dispatch source-review-validator. It must inventory independently, inspect source rather than trust the primary coverage ledger, search for omitted vulnerability classes, and produce validation/challenge-matrix.json.',
    '- High/Critical findings require independent reproduction from source. Record primary and validator model aliases. If models match, record a model-diversity blocker for operator review.',
    '',
    'Stage 7 — Safe dynamic validation:',
    '- For medium-or-lower-confidence findings, perform only local/isolated safe validation when feasible; otherwise record the precise blocker. Never contact production merely to raise confidence.',
    '',
    'Stage 8 — Operator gate and reporting:',
    '- Present findings, prior dispositions, delta table, challenge matrix, and gate blockers. Do not dispatch report agents without explicit operator wrap approval.',
    '',
    'Hard completion gates:',
    '1. File manifest and coverage ledger have exact set equality.',
    '2. Route inventory and authorization matrix have exact set equality.',
    '3. Injection/exposure findings and negative claims include complete source-to-sink evidence.',
    mode === 'blind' ? '4. Historical regression records NOT_REQUESTED_BLIND_MODE without reading prior content.' : '4. Every supplied prior finding is dispositioned.',
    '5. Tested-negative rows cite exact files, line ranges, rule, observed evidence, and result.',
    '6. Every suppression is ACCEPTED with justification or mapped to a finding.',
    '7. CVSS >=7 documents metric preconditions; CVSS >=9 names a reachable unauthenticated network path or is blocked for downgrade review.',
    '8. Every High/Critical finding has validator confirmation.',
    '9. HEAD and history secret-scan receipts exist for the recorded HEAD.',
    '10. No unexplained file, route, prior-finding, suppression, track, or validation gap remains.',
    '',
    'Create one blackboard task per stage/track and include engagement_id in every blackboard_task_update. A returned model answer is not proof that a gate passed. Do not mark the goal complete; finish at pending operator confirmation unless the operator explicitly approves wrap/reporting.',
  ].join('\n');
}

function sourceReviewGateStatus(artifactRoot) {
  const required = [
    'intake/scope.json',
    'inventory/files.jsonl',
    'inventory/routes.jsonl',
    'inventory/suppressions.jsonl',
    'inventory/secrets-head.json',
    'inventory/secrets-history.json',
    'discovery/findings.jsonl',
    'discovery/coverage-ledger.jsonl',
    ...SPECIALIST_TRACKS.map(track => `tracks/${track}.json`),
    'regression/delta.json',
    'validation/challenge-matrix.json',
  ];
  const missing = required.filter(relative => !fs.existsSync(path.join(artifactRoot, relative)));
  return { workflowVersion: WORKFLOW_VERSION, passed: missing.length === 0, missing };
}

module.exports = {
  WORKFLOW_VERSION,
  SPECIALIST_TRACKS,
  securityReviewArtifactRoot,
  securityReviewCoordinatorPrompt,
  sourceReviewGateStatus,
};
