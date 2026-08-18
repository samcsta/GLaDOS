const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { REQUIRED_MODEL_ROLES, discoverySaturationCheckpoint, markDeepScanSaturated, projectSecurityReviewLedgers } = require('./deep-scan');
const { sourceReviewGateStatus } = require('./workflow');
const { generateSecurityReviewDeliverables } = require('./deliverables');
const { normalizeSecurityReviewArtifacts } = require('./normalize-artifacts');

const ROLE_AGENTS = Object.freeze({
  coordinator: 'glados',
  'source-code-primary': 'source-code',
  'authorization-access-control': 'source-code',
  'data-flow-injection': 'source-code',
  'secrets-history': 'source-code',
  'resilience-error-handling': 'source-code',
  'iac-config-manifests': 'source-code',
  'cryptography-suppressions': 'source-code',
  'source-review-validator': 'source-review-validator',
});

const SEALED_ARTIFACTS = Object.freeze([
  'run.json',
  'context/threat-model.json',
  'discovery/deep/workers.jsonl',
  'discovery/deep/dedupe.json',
  'discovery/candidates.jsonl',
  'validation/candidate-closure.jsonl',
  'validation/attack-paths.jsonl',
  'validation/runtime-model-observations.jsonl',
  'validation/model-receipts.jsonl',
  'findings.json',
  'observations.json',
  'coverage.json',
  'inventory/secrets-head.json',
  'inventory/secrets-history.json',
  'inventory/sensitive-data-head.json',
  'inventory/pii-head.json',
  'inventory/pii-history.json',
  'validation/semantic-coverage.json',
  'validation/challenge-matrix.json',
  'tracks/secrets-history/history-receipt.json',
  'tracks/secrets-history/sensitive-data-dispositions.jsonl',
  'validation/sensitive-data-verifications.jsonl',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(file, rows) {
  atomicWrite(file, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function authoritativeRows(db, engagementId) {
  return {
    workers: db.prepare(`
      SELECT * FROM security_review_worker_runs WHERE engagement_id=? ORDER BY sequence
    `).all(engagementId),
    observations: db.prepare(`
      SELECT observation_id, engagement_id, controller_job_id, agent_id, review_role, worker_id,
             requested_model, actual_model, billed_model_name, source, request_id, gateway_model_id,
             cost_usd, observed_at, logical_model_alias, provider_model, attestation_level, gateway_call_id
      FROM security_review_model_observations WHERE engagement_id=? ORDER BY observed_at, observation_id
    `).all(engagementId),
  };
}

function securityReviewQuiescenceStatus(db, engagementId) {
  const blockers = [];
  const startedWorkers = db.prepare(`
    SELECT COUNT(*) AS n FROM security_review_worker_runs WHERE engagement_id=? AND status='STARTED'
  `).get(engagementId).n;
  const startedAttempts = db.prepare(`
    SELECT COUNT(*) AS n FROM security_review_worker_attempts WHERE engagement_id=? AND status='STARTED'
  `).get(engagementId).n;
  const requests = db.prepare(`
    SELECT status, COUNT(*) AS n FROM security_review_llm_requests WHERE engagement_id=? GROUP BY status
  `).all(engagementId);
  if (startedWorkers) blockers.push(`${startedWorkers} discovery worker(s) remain STARTED`);
  if (startedAttempts) blockers.push(`${startedAttempts} discovery attempt(s) remain STARTED`);
  for (const row of requests) {
    if (row.status === 'PENDING' || row.status === 'CONFLICT') blockers.push(`${row.n} model request(s) remain ${row.status}`);
  }
  return { passed: blockers.length === 0, blockers };
}

function generateModelReceipts(observations) {
  return REQUIRED_MODEL_ROLES.map(role => {
    const expectedAgent = ROLE_AGENTS[role];
    const matches = observations.filter(row => row.review_role === role
      && row.agent_id === expectedAgent
      && (role !== 'source-code-primary' || row.worker_id));
    if (!matches.length) throw new Error(`required model role ${role} has no authoritative observation`);
    const selected = matches[0];
    return {
      role,
      requested_model: selected.requested_model || selected.logical_model_alias,
      actual_model: selected.actual_model,
      billed_model_name: selected.billed_model_name,
      gateway_model_id: selected.gateway_model_id,
      provider_model: selected.provider_model || null,
      attestation_level: selected.attestation_level,
      observation_source: selected.source,
      observation_ids: [selected.observation_id],
    };
  });
}

function findingId(row) {
  return row?.id || row?.finding_id || null;
}

function normalizeFinding(row) {
  const out = { ...row, id: findingId(row) };
  delete out.finding_id;
  if (out.cvss_score == null && out.cvss?.score != null) out.cvss_score = out.cvss.score;
  if (!out.cvss_vector && out.cvss?.vector) out.cvss_vector = out.cvss.vector;
  if ((!Array.isArray(out.cwe_ids) || !out.cwe_ids.length) && Array.isArray(out.candidate_cwe_ids)) out.cwe_ids = out.candidate_cwe_ids;
  if ((!Array.isArray(out.locations) || !out.locations.length) && Array.isArray(out.exact_candidate_evidence?.locations)) out.locations = out.exact_candidate_evidence.locations;
  if (!out.counterevidence && out.exact_candidate_evidence?.counterevidence) out.counterevidence = out.exact_candidate_evidence.counterevidence;
  if (!out.proof_gaps && Array.isArray(out.exact_candidate_evidence?.proof_gaps)) out.proof_gaps = out.exact_candidate_evidence.proof_gaps;
  if (!out.description) out.description = out.source_to_sink_evidence || out.source_to_sink || out.summary || out.trace
    || out.exact_candidate_evidence?.summary || out.exact_candidate_evidence?.evidence
    || (Array.isArray(out.evidence) ? out.evidence.join(' ') : out.evidence);
  if (!out.title) out.title = out.summary || out.description;
  const sourceLocations = Array.isArray(out.locations) ? out.locations.filter(item => item.role === 'source') : [];
  const sinkLocations = Array.isArray(out.locations) ? out.locations.filter(item => item.role === 'sink') : [];
  const locationText = items => items.map(item => `${item.path}:${item.start_line || item.line_range || '?'}${item.end_line ? `-${item.end_line}` : ''}`).join('; ');
  if (!out.source) out.source = locationText(sourceLocations) || locationText(out.locations || []);
  if (!out.sink) out.sink = locationText(sinkLocations) || out.title;
  if (!out.reachability) out.reachability = out.reachable_entry_point || (Array.isArray(out.entry_points) ? out.entry_points.join('; ') : null)
    || (Array.isArray(out.exploitability_assumptions) ? out.exploitability_assumptions.join(' ') : out.exploitability_assumptions);
  if (!out.impact) out.impact = out.impact_description || out.severity_rationale || out.cvss_preconditions || out.cvss?.preconditions || out.reachability || out.exploitability_assumptions;
  if (!out.recommendation) out.recommendation = Array.isArray(out.proof_gaps) && out.proof_gaps.length
    ? `Resolve the documented proof gaps and remediate the cited source-to-sink control failure: ${out.proof_gaps[0]}`
    : 'Remediate the cited source-to-sink control failure and verify the fix in an isolated environment.';
  if (!out.status && out.validated === true) {
    out.status = 'REPORTABLE_SOURCE_VALIDATED';
  }
  return out;
}

function candidateFindingIds(artifactRoot) {
  const rows = readJsonLines(path.join(artifactRoot, 'validation', 'candidate-closure.jsonl'));
  return [...new Set(rows
    .filter(row => String(row.disposition || '').toUpperCase() === 'REPORTABLE')
    .flatMap(row => Array.isArray(row.finding_ids) ? row.finding_ids : []))].sort();
}

function candidateObservationIds(artifactRoot) {
  const rows = readJsonLines(path.join(artifactRoot, 'validation', 'candidate-closure.jsonl'));
  return [...new Set(rows
    .filter(row => String(row.disposition || '').toUpperCase() === 'OBSERVATION')
    .flatMap(row => Array.isArray(row.observation_ids) ? row.observation_ids : []))].sort();
}

function generateCanonicalFindings(artifactRoot, run) {
  const expected = candidateFindingIds(artifactRoot);
  const candidateRows = readJsonLines(path.join(artifactRoot, 'discovery', 'candidates.jsonl'));
  const validatorFile = path.join(artifactRoot, 'validation', 'new-candidates.jsonl');
  if (fs.existsSync(validatorFile)) candidateRows.push(...readJsonLines(validatorFile));
  const candidates = new Map(candidateRows.map(row => [row.candidate_id, row]));
  const findingCandidates = new Map();
  for (const row of readJsonLines(path.join(artifactRoot, 'validation', 'candidate-closure.jsonl'))) {
    if (String(row.disposition || '').toUpperCase() !== 'REPORTABLE') continue;
    for (const findingId of row.finding_ids || []) if (!findingCandidates.has(findingId)) findingCandidates.set(findingId, row.candidate_id);
  }
  const sources = [];
  for (const track of ['authorization-access-control', 'data-flow-injection', 'secrets-history', 'resilience-error-handling', 'iac-config-manifests', 'cryptography-suppressions']) {
    const file = path.join(artifactRoot, 'tracks', track, 'findings.jsonl');
    if (fs.existsSync(file)) sources.push(...readJsonLines(file));
  }
  for (const relative of ['discovery/findings.jsonl']) {
    const file = path.join(artifactRoot, relative);
    if (!fs.existsSync(file)) continue;
    const value = relative.endsWith('.jsonl') ? readJsonLines(file) : readJson(file).findings || [];
    sources.push(...value.map(row => row.finding_id || row.id ? row : { ...row, finding_id: row.candidate_id, title: row.title || row.summary }));
  }
  const byId = new Map();
  for (const row of sources) {
    const id = findingId(row);
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, row);
      continue;
    }
    const current = byId.get(id);
    for (const [field, value] of Object.entries(row)) {
      if ((current[field] == null || current[field] === '' || (Array.isArray(current[field]) && current[field].length === 0)) && value != null) {
        current[field] = value;
      }
    }
  }
  const missing = expected.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`reportable findings are missing source rows: ${missing.join(', ')}`);
  return {
    schema_version: 1,
    producer: 'glados-security-review/v1',
    engagement_id: run.engagementId || path.basename(path.dirname(artifactRoot)),
    repository_head: run.head,
    findings: expected.map(id => {
      const finding = normalizeFinding(byId.get(id));
      const candidate = candidates.get(findingCandidates.get(id)) || candidates.get(id);
      if (!candidate) return finding;
      if (!finding.description) finding.description = candidate.summary;
      if (!Array.isArray(finding.locations) || !finding.locations.length) finding.locations = candidate.locations;
      const sourceLocations = candidate.locations.filter(item => item.role === 'source');
      const sinkLocations = candidate.locations.filter(item => item.role === 'sink');
      const renderLocations = rows => rows.map(item => `${item.path}:${item.start_line}-${item.end_line}`).join('; ');
      if (!finding.source) finding.source = renderLocations(sourceLocations) || renderLocations(candidate.locations);
      if (!finding.sink || finding.sink === finding.title) finding.sink = renderLocations(sinkLocations) || candidate.sink;
      return finding;
    }),
  };
}

function generateCanonicalObservations(artifactRoot, run) {
  const candidateRows = readJsonLines(path.join(artifactRoot, 'discovery', 'candidates.jsonl'));
  const validatorFile = path.join(artifactRoot, 'validation', 'new-candidates.jsonl');
  if (fs.existsSync(validatorFile)) candidateRows.push(...readJsonLines(validatorFile));
  const candidates = new Map(candidateRows.map(row => [row.candidate_id, row]));
  const expected = [];
  for (const disposition of readJsonLines(path.join(artifactRoot, 'validation', 'candidate-closure.jsonl'))) {
    if (String(disposition.disposition || '').toUpperCase() !== 'OBSERVATION') continue;
    for (const id of disposition.observation_ids || []) expected.push({ id, disposition });
  }
  return {
    schema_version: 1,
    producer: 'glados-security-review/v1',
    engagement_id: run.engagementId || path.basename(path.dirname(artifactRoot)),
    repository_head: run.head,
    observations: expected.map(({ id, disposition }) => {
      const candidate = candidates.get(disposition.candidate_id);
      if (!candidate) throw new Error(`observation ${id} is missing retained candidate ${disposition.candidate_id}`);
      return {
        id,
        candidate_id: disposition.candidate_id,
        title: candidate.summary,
        category: disposition.observation_category || 'conditional-security-observation',
        rationale: disposition.reportability_rationale,
        recommendation: disposition.recommendation || `Resolve the proof gaps and harden the cited ${candidate.cwe_ids?.[0] || 'security'} control.`,
        cwe_ids: candidate.cwe_ids,
        locations: candidate.locations,
        evidence: candidate.evidence,
        reachability: candidate.reachability,
        counterevidence: candidate.counterevidence,
        proof_gaps: candidate.proof_gaps,
        confidence: candidate.confidence,
      };
    }),
  };
}

function generateCanonicalCoverage(artifactRoot, run) {
  const inventory = readJsonLines(path.join(artifactRoot, 'inventory', 'files.jsonl'));
  const ledger = readJsonLines(path.join(artifactRoot, 'discovery', 'coverage-ledger.jsonl'));
  const byPath = new Map();
  for (const row of ledger) {
    if (!row.path || byPath.has(row.path)) throw new Error(`coverage ledger has missing or duplicate path ${row.path || '(missing)'}`);
    byPath.set(row.path, row);
  }
  const expected = new Set(inventory.map(row => row.path));
  const extra = [...byPath.keys()].filter(value => !expected.has(value));
  const missing = [...expected].filter(value => !byPath.has(value));
  if (extra.length || missing.length) throw new Error(`coverage ledger mismatch: missing=${missing.length} extra=${extra.length}`);
  return {
    schema_version: 1,
    producer: 'glados-security-review/v1',
    engagement_id: run.engagementId || path.basename(path.dirname(artifactRoot)),
    repository_head: run.head,
    files: inventory.map(item => {
      const row = byPath.get(item.path);
      return {
        path: item.path,
        disposition: row.disposition || row.status || row.terminal_disposition || row.coverage_disposition,
        review_method: row.review_method || (Array.isArray(row.evidence_locations) && row.evidence_locations.length ? 'file-specific-review' : 'deterministic-artifact-disposition'),
        ...(Array.isArray(row.finding_ids) && row.finding_ids.length ? { finding_ids: row.finding_ids } : {}),
      };
    }),
  };
}

function sealSecurityReview(artifactRoot, run, engagementId) {
  if (run?.deepScan?.terminalState !== 'SATURATED') throw new Error('refusing to seal security review before run reaches SATURATED');
  const missing = SEALED_ARTIFACTS.filter(relative => !fs.existsSync(path.join(artifactRoot, relative)));
  if (missing.length) throw new Error(`refusing to seal security review with missing artifacts: ${missing.join(', ')}`);
  const artifactSha256 = Object.fromEntries(SEALED_ARTIFACTS.map(relative => [relative, sha256(path.join(artifactRoot, relative))]));
  const manifest = {
    schema_version: 1,
    producer: 'glados-security-review/v1',
    engagement_id: engagementId,
    repository_head: run.head,
    terminal_state: 'SATURATED',
    artifact_sha256: artifactSha256,
  };
  writeJson(path.join(artifactRoot, 'scan-manifest.json'), manifest);
  writeJson(path.join(artifactRoot, 'completion-receipt.json'), {
    ...manifest,
    status: 'SEALED',
    scan_manifest_sha256: sha256(path.join(artifactRoot, 'scan-manifest.json')),
  });
  return artifactSha256;
}

function invalidateSecurityReviewSeal(artifactRoot) {
  for (const relative of ['scan-manifest.json', 'completion-receipt.json']) {
    try { fs.unlinkSync(path.join(artifactRoot, relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function finalizeSecurityReview({ db, artifactRoot, engagementId, campaignExpected = false }) {
  const quiescence = securityReviewQuiescenceStatus(db, engagementId);
  if (!quiescence.passed) return { passed: false, recoverable: true, blockers: quiescence.blockers };
  try {
    projectSecurityReviewLedgers({ db, artifactRoot, engagementId });
    const authority = authoritativeRows(db, engagementId);
    const runFile = path.join(artifactRoot, 'run.json');
    let run = readJson(runFile);
    run.engagementId = engagementId;
    if (run?.deepScan?.terminalState !== 'SATURATED') {
      if (run?.deepScan?.terminalState !== 'RUNNING') {
        return { passed: false, recoverable: false, blockers: [`run.json.deepScan.terminalState is ${run?.deepScan?.terminalState || '(missing)'}, expected RUNNING or SATURATED`] };
      }
      const saturation = discoverySaturationCheckpoint(artifactRoot);
      if (!saturation.passed) {
        return { passed: false, recoverable: false, blockers: saturation.invalid.length
          ? saturation.invalid
          : [`run.json.deepScan.terminalState is ${run?.deepScan?.terminalState || '(missing)'}, expected SATURATED`] };
      }
      markDeepScanSaturated(artifactRoot);
      run = readJson(runFile);
      run.engagementId = engagementId;
    }
    normalizeSecurityReviewArtifacts(artifactRoot);
    writeJsonLines(path.join(artifactRoot, 'validation', 'model-receipts.jsonl'), generateModelReceipts(authority.observations));
    writeJson(path.join(artifactRoot, 'findings.json'), generateCanonicalFindings(artifactRoot, run));
    writeJson(path.join(artifactRoot, 'observations.json'), generateCanonicalObservations(artifactRoot, run));
    writeJson(path.join(artifactRoot, 'coverage.json'), generateCanonicalCoverage(artifactRoot, run));
    invalidateSecurityReviewSeal(artifactRoot);
    const preSealGate = sourceReviewGateStatus(artifactRoot, {
      authoritativeWorkerRuns: authority.workers,
      authoritativeModelObservations: authority.observations,
      campaignExpected,
      skipSealValidation: true,
    });
    if (preSealGate.missing.length || preSealGate.invalid.length) {
      const gate = { ...preSealGate, passed: false };
      return { passed: false, recoverable: false, blockers: [...gate.missing, ...gate.invalid], gate };
    }
    sealSecurityReview(artifactRoot, run, engagementId);
    const gate = sourceReviewGateStatus(artifactRoot, {
      authoritativeWorkerRuns: authority.workers,
      authoritativeModelObservations: authority.observations,
      campaignExpected,
    });
    if (!gate.passed) {
      invalidateSecurityReviewSeal(artifactRoot);
      return { passed: false, recoverable: false, blockers: [...gate.missing, ...gate.invalid], gate };
    }
    try {
      generateSecurityReviewDeliverables(artifactRoot);
    } catch (error) {
      invalidateSecurityReviewSeal(artifactRoot);
      throw error;
    }
    return { passed: gate.passed, recoverable: false, blockers: [...gate.missing, ...gate.invalid], gate };
  } catch (error) {
    return { passed: false, recoverable: false, blockers: [error.message] };
  }
}

function revalidateFailedSecurityReview({ dbPath, artifactRoot, engagementId }) {
  const db = new Database(dbPath);
  try {
    const job = db.prepare(`
      SELECT * FROM controller_jobs WHERE engagement_id=? AND job_type='security_review_workflow_v3' ORDER BY created_at DESC LIMIT 1
    `).get(engagementId);
    if (!job) throw new Error(`security-review job not found for ${engagementId}`);
    const goal = job.goal_id ? db.prepare('SELECT * FROM controller_goals WHERE id=?').get(job.goal_id) : null;
    const result = finalizeSecurityReview({ db, artifactRoot, engagementId, campaignExpected: false });
    if (!result.passed) return result;
    const stamp = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE controller_jobs SET status='succeeded', error=NULL, finished_at=?, updated_at=? WHERE id=?").run(stamp, stamp, job.id);
      if (goal) db.prepare("UPDATE controller_goals SET status='complete', completed_at=?, updated_at=? WHERE id=?").run(stamp, stamp, goal.id);
      db.prepare("UPDATE engagements SET status='complete', completed_at=? WHERE id=?").run(stamp, engagementId);
      db.prepare(`INSERT INTO controller_events (goal_id,job_id,event_type,message,data_json) VALUES (?,?,'security_review_revalidated',?,?)`)
        .run(job.goal_id || null, job.id, `Revalidated and resealed ${engagementId} without model execution.`, JSON.stringify({ engagement_id: engagementId }));
    })();
    return result;
  } finally { db.close(); }
}

module.exports = {
  SEALED_ARTIFACTS,
  finalizeSecurityReview,
  generateCanonicalCoverage,
  generateCanonicalFindings,
  generateCanonicalObservations,
  generateModelReceipts,
  invalidateSecurityReviewSeal,
  revalidateFailedSecurityReview,
  sealSecurityReview,
  securityReviewQuiescenceStatus,
};
