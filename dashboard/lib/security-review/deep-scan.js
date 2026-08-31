const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  canonicalCandidateLocationRole,
  normalizeDedupeCounters,
  repairConcatenatedJsonLines,
} = require('./normalize-artifacts');

const DEEP_SCAN_DEFAULTS = Object.freeze({
  minDiscoveryRuns: 3,
  stopAfterNoNew: 3,
  maxDiscoveryRuns: 60,
  maxDurationMinutes: null,
  discoveryConcurrency: 3,
  specialistConcurrency: 3,
});

const SECURITY_REVIEW_ORCHESTRATION_REVISION = 3;
const SECURITY_REVIEW_CONTRACT_REVISION = 'v4.3-source-reportability-semantic-dedupe';

const REQUIRED_DEEP_ARTIFACTS = Object.freeze([
  'context/threat-model.json',
  'discovery/deep/manifest.json',
  'discovery/deep/workers.jsonl',
  'discovery/deep/dedupe.json',
  'discovery/candidates.jsonl',
  'validation/new-candidates.jsonl',
  'validation/candidate-closure.jsonl',
  'validation/attack-paths.jsonl',
  'validation/runtime-model-observations.jsonl',
  'validation/model-receipts.jsonl',
  'scan-manifest.json',
  'findings.json',
  'coverage.json',
  'completion-receipt.json',
]);

const REQUIRED_MODEL_ROLES = Object.freeze([
  'coordinator',
  'source-code-primary',
  'authorization-access-control',
  'data-flow-injection',
  'secrets-history',
  'resilience-error-handling',
  'iac-config-manifests',
  'cryptography-suppressions',
  'source-review-validator',
]);
const MODEL_ROLE_AGENTS = Object.freeze({
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

const WORKER_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const CANDIDATE_DISPOSITIONS = new Set(['REPORTABLE', 'OBSERVATION', 'SUPPRESSED', 'NOT_APPLICABLE', 'DEFERRED']);
const ATTACK_PATH_DISPOSITIONS = new Set(['REPORTABLE', 'OBSERVATION', 'IGNORE', 'NOT_APPLICABLE', 'DEFERRED']);

function discoveryWorkerIdFromPrompt(prompt = '') {
  return String(prompt).match(/^worker_id:\s*(worker-\d{3})\s*$/im)?.[1] || null;
}

function engagementIdFromArtifactRoot(artifactRoot) {
  return path.basename(path.dirname(path.resolve(artifactRoot)));
}

function claimDiscoveryWorker({
  dbPath,
  artifactRoot,
  engagementId,
  workerId,
  toolCallId,
  retryOf = null,
  requestedModel = null,
  startedAt = new Date().toISOString(),
}) {
  if (!dbPath || !engagementId || !/^worker-\d{3}$/.test(String(workerId || '')) || !toolCallId) {
    return { claimed: false, reason: 'discovery worker claim requires database, engagement, canonical worker_id, and tool_call_id' };
  }
  if (retryOf != null && !/^worker-\d{3}$/.test(String(retryOf))) {
    return { claimed: false, reason: 'discovery retry_of must use worker-NNN' };
  }
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const sequence = Number(workerId.slice('worker-'.length));
    const claim = db.transaction(() => {
      const dispatched = db.prepare(`
        SELECT COUNT(DISTINCT worker_id) AS n FROM security_review_worker_attempts WHERE engagement_id=?
      `).get(engagementId).n;
      let maxDiscoveryRuns = DEEP_SCAN_DEFAULTS.maxDiscoveryRuns;
      try {
        maxDiscoveryRuns = normalizeDeepScanConfig(JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.deepScan || {}).maxDiscoveryRuns;
      } catch {}
      if (maxDiscoveryRuns != null && dispatched >= maxDiscoveryRuns) return { claimed: false, reason: `discovery maximum of ${maxDiscoveryRuns} attempts has been reached` };
      const existing = db.prepare(`
        SELECT status FROM security_review_worker_runs WHERE engagement_id=? AND worker_id=?
      `).get(engagementId, workerId);
      const retryingInterrupted = existing?.status === 'CANCELED' || existing?.status === 'FAILED';
      if (!retryingInterrupted && sequence !== dispatched + 1) return { claimed: false, reason: `worker ${workerId} is out of sequence; controller dispatch ledger expects worker-${String(dispatched + 1).padStart(3, '0')}` };
      if (retryOf) {
        const retryTarget = db.prepare(`
          SELECT worker_id, sequence, status FROM security_review_worker_runs
          WHERE engagement_id=? AND worker_id=?
        `).get(engagementId, retryOf);
        if (!retryTarget || !['FAILED', 'CANCELED'].includes(retryTarget.status) || retryTarget.sequence >= sequence) {
          return { claimed: false, reason: `retry_of ${retryOf} must reference an earlier failed or canceled discovery worker` };
        }
        const settledRetry = db.prepare(`
          SELECT worker_id FROM security_review_worker_runs
          WHERE engagement_id=? AND retry_of=? AND status IN ('STARTED','SUCCEEDED')
          LIMIT 1
        `).get(engagementId, retryOf);
        if (settledRetry) return { claimed: false, reason: `${retryOf} already has an active or successful retry ${settledRetry.worker_id}` };
      }
      const active = db.prepare(`
        SELECT worker_id FROM security_review_worker_attempts
        WHERE engagement_id=? AND status='STARTED'
        ORDER BY sequence
      `).all(engagementId);
      let discoveryConcurrency = DEEP_SCAN_DEFAULTS.discoveryConcurrency;
      try {
        discoveryConcurrency = normalizeDeepScanConfig(JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'))?.deepScan || {}).discoveryConcurrency;
      } catch {}
      if (active.length >= discoveryConcurrency) return { claimed: false, reason: `discovery concurrency limit ${discoveryConcurrency} reached` };
      try {
        const attempt = db.prepare(`
          SELECT COALESCE(MAX(attempt), 0) + 1 AS n
          FROM security_review_worker_attempts WHERE engagement_id=? AND worker_id=?
        `).get(engagementId, workerId).n;
        db.prepare(`
          INSERT INTO security_review_worker_attempts
            (engagement_id, worker_id, sequence, attempt, tool_call_id, status, started_at)
          VALUES (?, ?, ?, ?, ?, 'STARTED', ?)
        `).run(engagementId, workerId, sequence, attempt, toolCallId, startedAt);
        if (retryingInterrupted) {
          db.prepare(`
            UPDATE security_review_worker_runs
            SET tool_call_id=?, status='STARTED', started_at=?, completed_at=NULL, error=NULL
            WHERE engagement_id=? AND worker_id=? AND status IN ('CANCELED','FAILED')
          `).run(toolCallId, startedAt, engagementId, workerId);
        } else {
          db.prepare(`
            INSERT INTO security_review_worker_runs
              (engagement_id, worker_id, sequence, tool_call_id, status, started_at, requested_model, attempt, retry_of)
            VALUES (?, ?, ?, ?, 'STARTED', ?, ?, ?, ?)
          `).run(engagementId, workerId, sequence, toolCallId, startedAt, requestedModel, attempt, retryOf);
        }
      } catch (error) {
        return { claimed: false, reason: `discovery worker ${workerId} was already dispatched` };
      }
      return { claimed: true };
    })();
    return claim;
  } finally {
    db.close();
  }
}

function finalizeDiscoveryWorker({ dbPath, artifactRoot = null, engagementId, toolCallId, status, error = null, completedAt = new Date().toISOString() }) {
  if (!dbPath || !engagementId || !toolCallId) return false;
  const terminal = String(status || '').toUpperCase();
  if (!WORKER_STATUSES.has(terminal)) return false;
  const db = new Database(dbPath);
  try {
    if (terminal === 'SUCCEEDED') {
      if (!artifactRoot) return false;
      const worker = db.prepare(`
        SELECT worker_id FROM security_review_worker_runs
        WHERE engagement_id=? AND tool_call_id=? AND status='STARTED'
      `).get(engagementId, toolCallId);
      if (!worker) return false;
      const materialized = materializeWorkerReceipt(artifactRoot, worker.worker_id);
      const artifacts = materialized.valid ? validateWorkerArtifacts(artifactRoot, worker.worker_id) : materialized;
      if (!materialized.valid || !artifacts.valid) {
        const artifactError = materialized.error || artifacts.error || 'worker output failed candidate validation';
        const failure = `worker output rejected before terminal receipt acceptance: ${artifactError}`;
        const result = db.prepare(`
          UPDATE security_review_worker_runs
          SET status='FAILED', completed_at=?, error=?
          WHERE engagement_id=? AND tool_call_id=? AND status='STARTED'
        `).run(completedAt, failure, engagementId, toolCallId);
        db.prepare(`
          UPDATE security_review_worker_attempts
          SET status='FAILED', completed_at=?, error=?
          WHERE engagement_id=? AND tool_call_id=? AND status='STARTED'
        `).run(completedAt, failure, engagementId, toolCallId);
        return result.changes === 1;
      }
      const observations = workerObservationRows(db, engagementId, worker.worker_id, toolCallId, {
        allowLegacy: !usesDispatchBoundEvidence(artifactRoot),
      })
        .map(row => row.actual_model).filter(Boolean);
      if (observations.length !== 1) return false;
    }
    const result = db.prepare(`
      UPDATE security_review_worker_runs
      SET status=?, completed_at=?, error=?
      WHERE engagement_id=? AND tool_call_id=? AND status='STARTED'
    `).run(terminal, completedAt, error, engagementId, toolCallId);
    db.prepare(`
      UPDATE security_review_worker_attempts
      SET status=?, completed_at=?, error=?
      WHERE engagement_id=? AND tool_call_id=? AND status='STARTED'
    `).run(terminal, completedAt, error, engagementId, toolCallId);
    return result.changes === 1;
  } finally {
    db.close();
  }
}

function reconcileCompletedDiscoveryWorker({ dbPath, artifactRoot, engagementId, toolCallId, completedAt = new Date().toISOString() }) {
  if (!dbPath || !artifactRoot || !engagementId || !toolCallId) return false;
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const worker = db.prepare(`
      SELECT * FROM security_review_worker_runs WHERE engagement_id=? AND tool_call_id=?
    `).get(engagementId, toolCallId);
    if (!worker) return false;
    const materialized = materializeWorkerReceipt(artifactRoot, worker.worker_id);
    if (!materialized.valid) return false;
    const artifacts = validateWorkerArtifacts(artifactRoot, worker.worker_id);
    if (!artifacts.valid) return false;
    const observations = workerObservationRows(db, engagementId, worker.worker_id, toolCallId, {
      allowLegacy: !usesDispatchBoundEvidence(artifactRoot),
    })
      .map(row => row.actual_model).filter(Boolean);
    if (observations.length !== 1) return false;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE security_review_worker_runs
        SET status='SUCCEEDED', completed_at=COALESCE(completed_at, ?), error=NULL
        WHERE engagement_id=? AND tool_call_id=? AND status IN ('STARTED','CANCELED')
      `).run(completedAt, engagementId, toolCallId);
      db.prepare(`
        UPDATE security_review_worker_attempts
        SET status='SUCCEEDED', completed_at=COALESCE(completed_at, ?), error=NULL
        WHERE engagement_id=? AND tool_call_id=? AND status IN ('STARTED','CANCELED')
      `).run(completedAt, engagementId, toolCallId);
    });
    tx();
    projectSecurityReviewLedgers({ db, artifactRoot, engagementId });
    return true;
  } finally { db.close(); }
}

function workerArtifactPaths(artifactRoot, workerId) {
  for (const directory of [`discovery/deep/${workerId}`, `discovery/workers/${workerId}`]) {
    const candidatesRelative = `${directory}/candidates.jsonl`;
    const receiptRelative = `${directory}/receipt.json`;
    if (fs.existsSync(path.join(artifactRoot, candidatesRelative))) {
      return { candidatesRelative, receiptRelative };
    }
  }
  return {
    candidatesRelative: `discovery/deep/${workerId}/candidates.jsonl`,
    receiptRelative: `discovery/deep/${workerId}/receipt.json`,
  };
}

function usesDispatchBoundEvidence(artifactRoot) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
    return Number(run?.orchestrationRevision || 0) >= SECURITY_REVIEW_ORCHESTRATION_REVISION;
  } catch { return false; }
}

function workerObservationRows(db, engagementId, workerId, toolCallId, { allowLegacy = false } = {}) {
  const exact = db.prepare(`
    SELECT DISTINCT actual_model
    FROM security_review_model_observations
    WHERE engagement_id=? AND worker_id=? AND worker_tool_call_id=?
      AND agent_id='source-code' AND review_role='source-code-primary'
  `).all(engagementId, workerId, toolCallId);
  if (exact.length || !allowLegacy) return exact;
  // Compatibility for completed reviews created before dispatch-bound
  // attestations existed. New observations always carry worker_tool_call_id.
  return db.prepare(`
    SELECT DISTINCT actual_model
    FROM security_review_model_observations
    WHERE engagement_id=? AND worker_id=? AND worker_tool_call_id IS NULL
      AND agent_id='source-code' AND review_role='source-code-primary'
  `).all(engagementId, workerId);
}

function materializeWorkerReceipt(artifactRoot, workerId) {
  const { candidatesRelative, receiptRelative } = workerArtifactPaths(artifactRoot, workerId);
  const candidatesFile = path.join(artifactRoot, candidatesRelative);
  const receiptFile = path.join(artifactRoot, receiptRelative);
  let candidates;
  try {
    repairConcatenatedJsonLines(candidatesFile);
    candidates = fs.readFileSync(candidatesFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    let normalizedLocations = false;
    candidates = candidates.map(candidate => ({
      ...candidate,
      locations: (candidate.locations || []).map(location => {
        const role = canonicalCandidateLocationRole(location.role);
        if (location.start_line === 0 && Number.isInteger(location.end_line) && location.end_line >= 1) {
          normalizedLocations = true;
          return { ...location, start_line: 1, role };
        }
        if (role !== location.role) normalizedLocations = true;
        return role === location.role ? location : { ...location, role };
      }),
    }));
    if (normalizedLocations) atomicWriteJsonLines(candidatesFile, candidates);
    const bytes = fs.readFileSync(candidatesFile);
    const validation = validateWorkerCandidateRows(artifactRoot, workerId, candidates, candidatesRelative);
    if (!validation.valid) return validation;
    atomicWriteJson(receiptFile, {
      worker_id: workerId,
      status: 'SUCCEEDED',
      candidate_count: candidates.length,
      candidates_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  } catch (error) {
    return { valid: false, error: `worker candidate artifact is missing or invalid: ${error.message}` };
  }
  return { valid: true, candidatesRelative, receiptRelative, candidateCount: candidates.length };
}

function reconcileActiveSecurityReviewWorkers({ dbPath, investigationsDir }) {
  if (!dbPath || !investigationsDir) return { checked: 0, reconciled: 0 };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare(`
      SELECT run.engagement_id, run.tool_call_id
      FROM security_review_worker_runs run
      JOIN engagements engagement ON engagement.id=run.engagement_id
      WHERE engagement.status='active' AND run.status IN ('STARTED','CANCELED')
      ORDER BY run.engagement_id, run.sequence
    `).all();
  } finally { db.close(); }
  let reconciled = 0;
  for (const row of rows) {
    const artifactRoot = path.join(investigationsDir, row.engagement_id, 'security-review');
    if (!fs.existsSync(artifactRoot)) continue;
    if (reconcileCompletedDiscoveryWorker({
      dbPath, artifactRoot, engagementId: row.engagement_id, toolCallId: row.tool_call_id,
    })) reconciled += 1;
  }
  return { checked: rows.length, reconciled };
}

function reconcileInvalidSuccessfulDiscoveryWorkers({ dbPath, artifactRoot, engagementId, completedAt = new Date().toISOString() }) {
  if (!dbPath || !artifactRoot || !engagementId) return [];
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const invalid = db.prepare(`
      SELECT worker_id, tool_call_id FROM security_review_worker_runs
      WHERE engagement_id=? AND status='SUCCEEDED' ORDER BY sequence
    `).all(engagementId).flatMap(worker => {
      const artifacts = validateWorkerArtifacts(artifactRoot, worker.worker_id);
      return artifacts.valid ? [] : [{ ...worker, error: artifacts.error }];
    });
    if (!invalid.length) return [];
    db.transaction(() => {
      for (const worker of invalid) {
        const error = `invalid legacy success reconciliation: ${worker.error}`;
        db.prepare(`
          UPDATE security_review_worker_runs SET status='FAILED', completed_at=?, error=?
          WHERE engagement_id=? AND tool_call_id=? AND status='SUCCEEDED'
        `).run(completedAt, error, engagementId, worker.tool_call_id);
        db.prepare(`
          UPDATE security_review_worker_attempts SET status='FAILED', completed_at=?, error=?
          WHERE engagement_id=? AND tool_call_id=? AND status='SUCCEEDED'
        `).run(completedAt, error, engagementId, worker.tool_call_id);
      }
    })();
    return invalid.map(worker => worker.worker_id);
  } finally { db.close(); }
}

function validateWorkerArtifacts(artifactRoot, workerId) {
  const { candidatesRelative, receiptRelative } = workerArtifactPaths(artifactRoot, workerId);
  const candidatesFile = path.join(artifactRoot, candidatesRelative);
  const receiptFile = path.join(artifactRoot, receiptRelative);
  let candidates;
  let receipt;
  try {
    candidates = fs.readFileSync(candidatesFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  } catch (error) {
    return { valid: false, error: `worker artifacts are missing or invalid: ${error.message}` };
  }
  const validation = validateWorkerCandidateRows(artifactRoot, workerId, candidates, candidatesRelative);
  if (!validation.valid) return validation;
  if (receipt.worker_id !== workerId || receipt.status !== 'SUCCEEDED'
      || receipt.candidate_count !== candidates.length || receipt.candidates_sha256 !== sha256File(candidatesFile)) {
    return { valid: false, error: 'worker receipt is not identity/count/hash bound to its candidate artifact' };
  }
  return { valid: true, candidatesRelative, receiptRelative };
}

function validateWorkerCandidateRows(artifactRoot, workerId, candidates, candidatesRelative = `discovery/deep/${workerId}/candidates.jsonl`) {
  const invalid = [];
  let inventoryFiles = null;
  const inventoryFile = path.join(artifactRoot, 'inventory', 'files.jsonl');
  if (fs.existsSync(inventoryFile)) {
    try {
      inventoryFiles = new Set(fs.readFileSync(inventoryFile, 'utf8').split(/\r?\n/)
        .filter(Boolean).map(JSON.parse).map(row => row.path).filter(Boolean));
    } catch (error) {
      invalid.push(`inventory/files.jsonl: cannot validate worker locations (${error.message})`);
    }
  }
  const candidateIds = new Set();
  candidates.forEach((candidate, index) => {
    const label = `${candidatesRelative}:${index + 1}`;
    validateCandidate(candidate, label, invalid, inventoryFiles);
    const candidateId = String(candidate?.candidate_id || '');
    if (!new RegExp(`^${workerId}-C\\d{4}$`).test(candidateId)) {
      invalid.push(`${label}.candidate_id: expected ${workerId}-CNNNN`);
    } else if (candidateIds.has(candidateId)) invalid.push(`${label}.candidate_id: duplicate ${candidateId}`);
    candidateIds.add(candidateId);
  });
  return invalid.length
    ? { valid: false, error: invalid.slice(0, 8).join('; '), invalid }
    : { valid: true };
}

function atomicWriteJsonLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function jsonLinesText(rows) {
  return rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
}

function projectSecurityReviewLedgers({ dbPath = null, db = null, artifactRoot, engagementId }) {
  if (!artifactRoot || !engagementId || (!db && !dbPath)) return { workers: 0, observations: 0 };
  const connection = db || new Database(dbPath);
  try {
    const dispatchBound = usesDispatchBoundEvidence(artifactRoot);
    const observations = connection.prepare(`
      SELECT observation_id, agent_id, review_role, worker_id, worker_tool_call_id, requested_model,
             actual_model AS model, billed_model_name, source, request_id, gateway_model_id,
             cost_usd, observed_at, logical_model_alias, provider_model, attestation_level, gateway_call_id
      FROM security_review_model_observations
      WHERE engagement_id=?
      ORDER BY observed_at, observation_id
    `).all(engagementId);
    const byWorkerDispatch = new Map();
    const legacyByWorker = new Map();
    for (const observation of observations) {
      if (!observation.worker_id) continue;
      const key = observation.worker_tool_call_id
        ? `${observation.worker_id}\0${observation.worker_tool_call_id}`
        : observation.worker_id;
      const target = observation.worker_tool_call_id ? byWorkerDispatch : legacyByWorker;
      const list = target.get(key) || [];
      list.push(observation);
      target.set(key, list);
    }
    const workers = connection.prepare(`
      SELECT * FROM security_review_worker_runs WHERE engagement_id=? ORDER BY sequence
    `).all(engagementId).filter(row => row.status !== 'STARTED').map(row => {
      const workerObservations = byWorkerDispatch.get(`${row.worker_id}\0${row.tool_call_id}`)
        || (!dispatchBound ? legacyByWorker.get(row.worker_id) : null)
        || [];
      const models = [...new Set(workerObservations.map(item => item.model).filter(Boolean))];
      const projected = {
        worker_id: row.worker_id,
        dispatch_id: row.tool_call_id,
        sequence: row.sequence,
        attempt: Number(row.attempt || 1),
        status: row.status,
        requested_model: row.requested_model || workerObservations[0]?.logical_model_alias || workerObservations[0]?.requested_model || 'unknown',
        actual_model: models.length === 1 ? models[0] : null,
        model_observation_ids: workerObservations.map(item => item.observation_id),
        started_at: row.started_at,
        completed_at: row.completed_at,
        retry_of: row.retry_of || null,
      };
      if (row.status === 'SUCCEEDED') return {
        ...projected,
        candidates_artifact: workerArtifactPaths(artifactRoot, row.worker_id).candidatesRelative,
        receipt_artifact: workerArtifactPaths(artifactRoot, row.worker_id).receiptRelative,
      };
      return { ...projected, error: row.error || `worker ${row.status.toLowerCase()}` };
    });
    const outputs = [
      [path.join(artifactRoot, 'validation', 'runtime-model-observations.jsonl'), observations],
      [path.join(artifactRoot, 'discovery', 'deep', 'workers.jsonl'), workers],
    ];
    const changedOutputs = outputs.filter(([file, rows]) => {
      try { return fs.readFileSync(file, 'utf8') !== jsonLinesText(rows); }
      catch { return true; }
    });
    let sealInvalidated = false;
    if (changedOutputs.length && fs.existsSync(path.join(artifactRoot, 'completion-receipt.json'))) {
      for (const relative of ['completion-receipt.json', 'scan-manifest.json']) {
        try { fs.unlinkSync(path.join(artifactRoot, relative)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      sealInvalidated = true;
    }
    for (const [file, rows] of changedOutputs) atomicWriteJsonLines(file, rows);
    return {
      workers: workers.length,
      observations: observations.length,
      changed: changedOutputs.length > 0,
      sealInvalidated,
    };
  } finally { if (!db) connection.close(); }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function appendRuntimeModelObservation(artifactRoot, observation) {
  if (!artifactRoot || !observation || typeof observation !== 'object') return null;
  const agentId = String(observation.agent_id || '').trim();
  const model = String(observation.model || '').trim();
  const source = String(observation.source || '').trim();
  if (!agentId || !model || !source) return null;
  if (/^<[^>]+>$/.test(model) || /^(?:synthetic|unknown|default|null|undefined)$/i.test(model)) return null;
  const identity = [agentId, model, source, observation.worker_id || '', observation.request_id || observation.parent_tool_use_id || observation.sdk_uuid || ''].join('\0');
  const row = {
    observation_id: observation.observation_id || `model-observation-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`,
    agent_id: agentId,
    model,
    source,
    observed_at: observation.observed_at || new Date().toISOString(),
    sdk_uuid: observation.sdk_uuid || null,
    parent_tool_use_id: observation.parent_tool_use_id || null,
    review_role: observation.review_role || null,
    worker_id: observation.worker_id || null,
    requested_model: observation.requested_model || null,
    request_id: observation.request_id || null,
    gateway_model_id: observation.gateway_model_id || null,
    billed_model_name: observation.billed_model_name || null,
    cost_usd: observation.cost_usd != null && Number.isFinite(Number(observation.cost_usd)) ? Number(observation.cost_usd) : null,
  };
  const file = path.join(artifactRoot, 'validation', 'runtime-model-observations.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  if (!existing.split(/\r?\n/).some(line => line.includes(`\"observation_id\":\"${row.observation_id}\"`))) {
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }
  return row;
}

function bindRuntimeModelObservationToWorker(artifactRoot, {
  workerId,
  observationId,
  actualModel,
} = {}) {
  if (!artifactRoot || !workerId || !observationId || !actualModel) return false;
  const file = path.join(artifactRoot, 'discovery', 'deep', 'workers.jsonl');
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch { return false; }
  let changed = false;
  const rows = lines.map(line => {
    const row = JSON.parse(line);
    if (row.worker_id !== workerId) return row;
    const ids = Array.isArray(row.model_observation_ids) ? row.model_observation_ids : [];
    if (!ids.includes(observationId)) {
      row.model_observation_ids = [...ids, observationId];
      changed = true;
    }
    if (row.actual_model !== actualModel) {
      row.actual_model = actualModel;
      changed = true;
    }
    return row;
  });
  if (!changed) return false;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return true;
}

function reconcileRuntimeModelObservationsToWorkers(artifactRoot) {
  const workersFile = path.join(artifactRoot, 'discovery', 'deep', 'workers.jsonl');
  const observationsFile = path.join(artifactRoot, 'validation', 'runtime-model-observations.jsonl');
  let workers;
  let observations;
  try {
    workers = fs.readFileSync(workersFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    observations = fs.readFileSync(observationsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch { return 0; }
  const byWorker = new Map();
  for (const observation of observations) {
    if (observation?.agent_id !== 'source-code'
        || observation?.review_role !== 'source-code-primary'
        || !observation?.worker_id
        || !observation?.observation_id
        || !observation?.model
        || !observation?.request_id
        || !observation?.gateway_model_id
        || !['litellm:spend-log', 'litellm:response-headers'].includes(observation?.source)) continue;
    const rows = byWorker.get(observation.worker_id) || [];
    rows.push(observation);
    byWorker.set(observation.worker_id, rows);
  }
  let updated = 0;
  for (const worker of workers) {
    const matches = (byWorker.get(worker.worker_id) || [])
      .sort((left, right) => String(left.observed_at || '').localeCompare(String(right.observed_at || ''))
        || String(left.observation_id).localeCompare(String(right.observation_id)));
    const models = [...new Set(matches.map(row => row.model))];
    if (models.length !== 1) continue;
    const ids = [...new Set([
      ...(Array.isArray(worker.model_observation_ids) ? worker.model_observation_ids : []),
      ...matches.map(row => row.observation_id),
    ])];
    if (JSON.stringify(ids) === JSON.stringify(worker.model_observation_ids || []) && worker.actual_model === models[0]) continue;
    worker.model_observation_ids = ids;
    worker.actual_model = models[0];
    updated += 1;
  }
  if (!updated) return 0;
  const temporary = `${workersFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${workers.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(temporary, workersFile);
  return updated;
}

function normalizeDeepScanConfig(value = {}) {
  const positiveInteger = (input, fallback, maximum) => {
    const parsed = Number(input);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
  };
  const maxDiscoveryRuns = Object.hasOwn(value, 'maxDiscoveryRuns') && value.maxDiscoveryRuns === null
    ? null
    : positiveInteger(value.maxDiscoveryRuns, DEEP_SCAN_DEFAULTS.maxDiscoveryRuns, 200);
  const minDiscoveryRuns = positiveInteger(value.minDiscoveryRuns, DEEP_SCAN_DEFAULTS.minDiscoveryRuns, 200);
  const stopAfterNoNew = positiveInteger(value.stopAfterNoNew, DEEP_SCAN_DEFAULTS.stopAfterNoNew, 20);
  return {
    minDiscoveryRuns: maxDiscoveryRuns == null ? minDiscoveryRuns : Math.min(minDiscoveryRuns, maxDiscoveryRuns),
    stopAfterNoNew: maxDiscoveryRuns == null ? stopAfterNoNew : Math.min(stopAfterNoNew, maxDiscoveryRuns),
    maxDiscoveryRuns,
    maxDurationMinutes: value.maxDurationMinutes == null
      ? null
      : positiveInteger(value.maxDurationMinutes, null, 24 * 60),
    discoveryConcurrency: positiveInteger(value.discoveryConcurrency, DEEP_SCAN_DEFAULTS.discoveryConcurrency, 8),
    specialistConcurrency: positiveInteger(value.specialistConcurrency, DEEP_SCAN_DEFAULTS.specialistConcurrency, 8),
  };
}

function initializeDeepScanRun(artifactRoot, {
  config = {},
  allowedModels = [],
  expectedModels = {},
  requireModelDiversity = true,
  modelDiversityWaiver = null,
  reviewProfile = 'comprehensive',
  campaign = null,
} = {}) {
  const runFile = path.join(artifactRoot, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const deepScan = normalizeDeepScanConfig(config);
  const startedAt = new Date();
  const deadlineAt = deepScan.maxDurationMinutes
    ? new Date(startedAt.getTime() + deepScan.maxDurationMinutes * 60_000)
    : null;
  run.workflowVersion = 4;
  run.orchestrationRevision = SECURITY_REVIEW_ORCHESTRATION_REVISION;
  run.contractRevision = SECURITY_REVIEW_CONTRACT_REVISION;
  run.reviewProfile = reviewProfile === 'expedited' ? 'expedited' : 'comprehensive';
  run.campaign = campaign ? {
    enabled: true,
    repositoryCount: campaign.repository_count,
    manifestArtifact: 'portfolio/repositories.json',
    coverageArtifact: 'portfolio/coverage.jsonl',
  } : { enabled: false };
  run.deepScan = {
    ...deepScan,
    startedAt: startedAt.toISOString(),
    deadlineAt: deadlineAt?.toISOString() || null,
    terminalState: 'RUNNING',
  };
  run.modelPolicy = {
    allowedModels: [...new Set(allowedModels.map(value => String(value).trim()).filter(Boolean))],
    expectedModels: Object.fromEntries(Object.entries(expectedModels)
      .map(([role, model]) => [String(role), String(model || '').trim()])
      .filter(([, model]) => model)),
    requireDiversity: requireModelDiversity !== false,
    diversityWaiver: modelDiversityWaiver || null,
  };
  writeJson(runFile, run);
  writeJson(path.join(artifactRoot, 'discovery', 'deep', 'manifest.json'), {
    schema_version: 1,
    status: 'RUNNING',
    config: deepScan,
    started_at: run.deepScan.startedAt,
    deadline_at: run.deepScan.deadlineAt,
    omitted_workers: [],
  });
  if (campaign) writeJson(path.join(artifactRoot, 'portfolio', 'repositories.json'), campaign);
  return run;
}

function markDeepScanCapped(artifactRoot, reason = 'security-review wall-clock limit reached') {
  const stamp = new Date().toISOString();
  for (const relative of ['run.json', 'discovery/deep/manifest.json']) {
    const file = path.join(artifactRoot, relative);
    let document = {};
    try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (relative === 'run.json') {
      document.deepScan = { ...(document.deepScan || {}), terminalState: 'CAPPED', completedAt: stamp, capReason: reason };
    } else {
      document.status = 'CAPPED';
      document.completed_at = stamp;
      document.cap_reason = reason;
    }
    writeJson(file, document);
  }
}

function markDeepScanSaturated(artifactRoot, completedAt = new Date().toISOString()) {
  const runFile = path.join(artifactRoot, 'run.json');
  const manifestFile = path.join(artifactRoot, 'discovery', 'deep', 'manifest.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (run?.deepScan?.terminalState === 'CAPPED' || manifest?.status === 'CAPPED') {
    throw new Error('refusing to mark a capped security review saturated');
  }
  run.deepScan = { ...(run.deepScan || {}), terminalState: 'SATURATED', completedAt };
  delete run.deepScan.failureReason;
  delete run.deepScan.capReason;
  manifest.status = 'SATURATED';
  manifest.completed_at = completedAt;
  delete manifest.failure_reason;
  delete manifest.cap_reason;
  writeJson(runFile, run);
  writeJson(manifestFile, manifest);
  return { run, manifest };
}

function discoveryDispatchCheckpoint(artifactRoot, {
  nextWorkerId,
  retryOf = null,
  saturationProbe = false,
  lifecycleState = 'RUNNING',
} = {}) {
  const invalid = [];
  const workerMatch = String(nextWorkerId || '').match(/^worker-(\d{3})$/);
  if (!workerMatch) return { passed: false, invalid: ['next worker_id must use worker-NNN'] };
  const nextSequence = Number(workerMatch[1]);
  const parseJson = relative => {
    try { return JSON.parse(fs.readFileSync(path.join(artifactRoot, relative), 'utf8')); }
    catch (error) { invalid.push(`${relative}: ${error.message}`); return null; }
  };
  const parseJsonl = relative => {
    let text = '';
    try { text = fs.readFileSync(path.join(artifactRoot, relative), 'utf8'); }
    catch (error) { invalid.push(`${relative}: ${error.message}`); return []; }
    const rows = [];
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try { rows.push(JSON.parse(line)); }
      catch (error) { invalid.push(`${relative}:${index + 1}: ${error.message}`); }
    });
    return rows;
  };
  const safeArtifact = relative => {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) return null;
    const file = path.join(artifactRoot, relative);
    try {
      const trustedRoot = fs.realpathSync(artifactRoot);
      const trustedParent = fs.realpathSync(path.dirname(file));
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || (trustedParent !== trustedRoot && !trustedParent.startsWith(`${trustedRoot}${path.sep}`))) return null;
    } catch { return null; }
    return file;
  };

  const manifest = parseJson('discovery/deep/manifest.json');
  const run = parseJson('run.json');
  const saturationTransition = saturationProbe
    && ['RUNNING', 'SATURATED'].includes(manifest?.status)
    && ['RUNNING', 'SATURATED'].includes(run?.deepScan?.terminalState);
  if (manifest) {
    if (manifest.schema_version !== 1 || (manifest.status !== lifecycleState && !saturationTransition)) {
      invalid.push(`discovery/deep/manifest.json: expected harness schema_version 1 and ${lifecycleState} status`);
    }
    if (!manifest.config || typeof manifest.started_at !== 'string' || (manifest.deadline_at !== null && typeof manifest.deadline_at !== 'string') || !Array.isArray(manifest.omitted_workers)) {
      invalid.push('discovery/deep/manifest.json: harness fields config, started_at, deadline_at, and omitted_workers must be preserved');
    }
  }
  const config = normalizeDeepScanConfig(run?.deepScan || {});
  for (const field of ['minDiscoveryRuns', 'stopAfterNoNew', 'maxDiscoveryRuns', 'maxDurationMinutes', 'discoveryConcurrency', 'specialistConcurrency']) {
    if (manifest?.config?.[field] !== run?.deepScan?.[field] || run?.deepScan?.[field] !== config[field]) {
      invalid.push(`discovery config ${field} must be normalized and identical in run.json and manifest`);
    }
  }
  if (run?.deepScan?.terminalState !== lifecycleState && !saturationTransition) invalid.push(`run.json deep scan is not ${lifecycleState}`);
  if (manifest?.deadline_at !== run?.deepScan?.deadlineAt) invalid.push('discovery deadline must match run.json');
  const deadlineMs = manifest?.deadline_at ? Date.parse(manifest.deadline_at) : null;
  if (manifest?.deadline_at && !Number.isFinite(deadlineMs)) invalid.push('discovery deadline is invalid');
  else if (lifecycleState === 'RUNNING' && Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) invalid.push('discovery deadline has elapsed; mark the run CAPPED');
  if (!saturationProbe && config.maxDiscoveryRuns != null && nextSequence > config.maxDiscoveryRuns) invalid.push(`discovery maximum of ${config.maxDiscoveryRuns} attempts has been reached`);

  const workersFile = path.join(artifactRoot, 'discovery/deep/workers.jsonl');
  if (nextSequence <= config.discoveryConcurrency && (!fs.existsSync(workersFile) || !fs.readFileSync(workersFile, 'utf8').trim())) {
    if (fs.existsSync(workersFile) && fs.readFileSync(workersFile, 'utf8').trim()) invalid.push('worker-001 cannot start after a worker ledger already exists');
    return { passed: invalid.length === 0, invalid };
  }

  const workers = parseJsonl('discovery/deep/workers.jsonl').sort((left, right) => Number(left?.sequence) - Number(right?.sequence));
  const firstOpenSequence = workers.length + 1;
  const lastParallelSequence = config.maxDiscoveryRuns == null
    ? workers.length + config.discoveryConcurrency
    : Math.min(config.maxDiscoveryRuns, workers.length + config.discoveryConcurrency);
  if (!saturationProbe && (nextSequence < firstOpenSequence || nextSequence > lastParallelSequence)) {
    invalid.push(`worker ${nextWorkerId} must be in the next ordered discovery batch ${firstOpenSequence}-${lastParallelSequence}`);
  }
  workers.forEach((worker, index) => {
    if (worker.sequence !== index + 1) invalid.push(`worker ledger sequence ${index + 1} is missing or out of order`);
    if (worker.worker_id !== `worker-${String(index + 1).padStart(3, '0')}`) invalid.push(`worker ledger row ${index + 1} has a noncanonical worker_id`);
    if (!WORKER_STATUSES.has(worker.status)) invalid.push(`worker ${worker.worker_id || index + 1} is not terminal`);
    for (const field of ['requested_model', 'actual_model', 'started_at', 'completed_at']) {
      if (typeof worker[field] !== 'string' || !worker[field]) invalid.push(`worker ${worker.worker_id || index + 1}.${field} is missing`);
    }
    if ('finished_at' in worker || 'candidate_artifact' in worker) invalid.push(`worker ${worker.worker_id || index + 1} uses legacy ledger field names`);
  });

  const observations = new Map(parseJsonl('validation/runtime-model-observations.jsonl')
    .filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => [row.observation_id, row]));
  const succeeded = workers.filter(row => row.status === 'SUCCEEDED');
  const rawKeys = new Set();
  for (const worker of succeeded) {
    const candidatesFile = safeArtifact(worker.candidates_artifact);
    const receiptFile = safeArtifact(worker.receipt_artifact);
    if (!candidatesFile || !receiptFile || !fs.existsSync(candidatesFile) || !fs.existsSync(receiptFile)) {
      invalid.push(`worker ${worker.worker_id} candidate/receipt artifacts are not durably present`);
      continue;
    }
    const candidates = parseJsonl(worker.candidates_artifact);
    candidates.forEach((candidate, index) => {
      validateCandidate(candidate, `${worker.candidates_artifact}:${index + 1}`, invalid);
      if (!new RegExp(`^${worker.worker_id}-C\\d{4}$`).test(String(candidate.candidate_id || ''))) {
        invalid.push(`${worker.candidates_artifact}:${index + 1}.candidate_id: expected ${worker.worker_id}-CNNNN`);
      }
      rawKeys.add(`${worker.worker_id}\0${candidate.candidate_id}`);
    });
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
    catch (error) { invalid.push(`${worker.receipt_artifact}: ${error.message}`); }
    if (receipt && (receipt.worker_id !== worker.worker_id || receipt.status !== 'SUCCEEDED' || receipt.candidate_count !== candidates.length || receipt.candidates_sha256 !== sha256File(candidatesFile))) {
      invalid.push(`worker ${worker.worker_id} receipt is not identity/count/hash bound to its candidate artifact`);
    }
    const observationIds = Array.isArray(worker.model_observation_ids) ? worker.model_observation_ids : [];
    const proven = observationIds.length > 0 && observationIds.every(id => {
      const row = observations.get(id);
      return row?.agent_id === 'source-code' && row.review_role === 'source-code-primary' && row.worker_id === worker.worker_id && row.model === worker.actual_model;
    });
    if (!proven) invalid.push(`worker ${worker.worker_id} is not bound to its own harness runtime model observation`);
  }

  const omitted = new Map((manifest?.omitted_workers || []).map(row => [row?.worker_id, row]));
  const byId = new Map(workers.map(row => [row.worker_id, row]));
  const successfulRetryOf = workerId => succeeded.some(candidate => {
    const seen = new Set();
    let cursor = candidate;
    while (cursor?.retry_of && !seen.has(cursor.retry_of)) {
      if (cursor.retry_of === workerId) return true;
      seen.add(cursor.retry_of);
      cursor = byId.get(cursor.retry_of);
    }
    return false;
  });
  const unresolvedFailures = workers.filter(worker => worker.status !== 'SUCCEEDED'
    && !successfulRetryOf(worker.worker_id)
    && !(typeof omitted.get(worker.worker_id)?.reason === 'string' && omitted.get(worker.worker_id).reason.trim()));
  if (unresolvedFailures.length) {
    const unresolvedIds = unresolvedFailures.map(worker => worker.worker_id);
    if (saturationProbe) {
      invalid.push(`failed workers require a successful retry or explicit omission: ${unresolvedIds.join(', ')}`);
    } else if (!retryOf || !unresolvedIds.includes(retryOf)) {
      invalid.push(`next discovery worker must declare retry_of for one unresolved worker: ${unresolvedIds.join(', ')}`);
    }
  } else if (retryOf) {
    invalid.push(`retry_of ${retryOf} does not reference an unresolved failed worker`);
  }

  // Before the first successful worker there is nothing to aggregate. A
  // transport-failed first worker must be retryable from the durable ledger
  // without asking the coordinator model to fabricate empty canonical files
  // merely to satisfy the next-dispatch gate.
  const aggregateExists = fs.existsSync(path.join(artifactRoot, 'discovery/deep/dedupe.json'));
  const dedupe = succeeded.length || aggregateExists ? parseJson('discovery/deep/dedupe.json') : null;
  const expectedWorkerIds = succeeded.map(row => row.worker_id);
  let computedNoNewStreak = 0;
  if (dedupe) {
    if (JSON.stringify(dedupe.input_worker_ids) !== JSON.stringify(expectedWorkerIds)) invalid.push('dedupe input_worker_ids do not match all successful workers in sequence order');
    if ('successful_input_worker_ids' in dedupe || 'first_introduction_new_candidate_counts' in dedupe || 'trailing_no_new_streak' in dedupe) {
      invalid.push('dedupe uses legacy field names');
    }
    const mappings = Array.isArray(dedupe.mappings) ? dedupe.mappings : [];
    const mapped = new Set();
    const canonicalRows = parseJsonl('discovery/candidates.jsonl');
    const canonicalIds = new Set(canonicalRows.map(row => row?.candidate_id).filter(Boolean));
    const sequenceByWorker = new Map(succeeded.map(worker => [worker.worker_id, worker.sequence]));
    const ownersByCanonical = new Map();
    for (const mapping of mappings) {
      const key = `${mapping?.worker_id}\0${mapping?.source_candidate_id}`;
      if (!rawKeys.has(key) || mapped.has(key) || !canonicalIds.has(mapping?.canonical_candidate_id) || typeof mapping?.rationale !== 'string' || !mapping.rationale.trim()) {
        invalid.push('dedupe mappings do not provide exact one-to-one raw candidate closure');
        break;
      }
      mapped.add(key);
      const owners = ownersByCanonical.get(mapping.canonical_candidate_id) || [];
      owners.push(mapping.worker_id);
      ownersByCanonical.set(mapping.canonical_candidate_id, owners);
    }
    if (mapped.size !== rawKeys.size) invalid.push('dedupe mappings do not cover every prior raw candidate exactly once');
    if (!dedupe.new_candidate_counts || !Number.isInteger(dedupe.no_new_streak)) invalid.push('dedupe new_candidate_counts and no_new_streak are required');
    const countKeys = Object.keys(dedupe.new_candidate_counts || {});
    if (JSON.stringify(countKeys.sort()) !== JSON.stringify([...expectedWorkerIds].sort())) invalid.push('dedupe new_candidate_counts keys do not exactly match successful workers');
    const firstOwners = [...ownersByCanonical.values()].map(owners => [...new Set(owners)]
      .sort((left, right) => sequenceByWorker.get(left) - sequenceByWorker.get(right))[0]);
    const computedCounts = Object.fromEntries(expectedWorkerIds.map(workerId => [
      workerId,
      firstOwners.filter(owner => owner === workerId).length,
    ]));
    for (const workerId of expectedWorkerIds) {
      if (dedupe.new_candidate_counts?.[workerId] !== computedCounts[workerId]) invalid.push(`dedupe new_candidate_counts.${workerId} does not match canonical first introductions`);
    }
    for (const workerId of [...expectedWorkerIds].reverse()) {
      if (computedCounts[workerId] !== 0) break;
      computedNoNewStreak += 1;
    }
    if (dedupe.no_new_streak !== computedNoNewStreak) invalid.push('dedupe no_new_streak does not match canonical first introductions');
  }
  if (succeeded.length && !fs.existsSync(path.join(artifactRoot, 'discovery/candidates.jsonl'))) {
    invalid.push('canonical discovery/candidates.jsonl is missing');
  }
  if (!saturationProbe && succeeded.length >= config.minDiscoveryRuns && computedNoNewStreak >= config.stopAfterNoNew) {
    invalid.push('discovery is already saturated; additional workers are prohibited');
  }
  return { passed: invalid.length === 0, invalid };
}

function discoverySaturationCheckpoint(artifactRoot) {
  const invalid = [];
  const workers = readJsonLines(artifactRoot, 'discovery/deep/workers.jsonl', invalid);
  const nextWorkerId = `worker-${String(workers.length + 1).padStart(3, '0')}`;
  let lifecycleState = 'RUNNING';
  try {
    const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'discovery/deep/manifest.json'), 'utf8'));
    const runState = run?.deepScan?.terminalState;
    if (runState === manifest?.status && ['RUNNING', 'SATURATED'].includes(runState)) lifecycleState = runState;
  } catch {}
  const chain = discoveryDispatchCheckpoint(artifactRoot, {
    nextWorkerId, retryOf: null, saturationProbe: true, lifecycleState,
  });
  invalid.push(...chain.invalid);
  const manifest = readJson(artifactRoot, 'discovery/deep/manifest.json', invalid);
  const dedupe = readJson(artifactRoot, 'discovery/deep/dedupe.json', invalid);
  if (manifest && dedupe) {
    const successful = workers.filter(row => row.status === 'SUCCEEDED');
    const minimum = Number(manifest.config?.minDiscoveryRuns || DEEP_SCAN_DEFAULTS.minDiscoveryRuns);
    const threshold = Number(manifest.config?.stopAfterNoNew || DEEP_SCAN_DEFAULTS.stopAfterNoNew);
    const trailing = dedupe.no_new_streak;
    if (successful.length < minimum) invalid.push(`discovery saturation requires at least ${minimum} successful workers`);
    if (dedupe.no_new_streak !== trailing) invalid.push('dedupe no_new_streak does not match the computed trailing zero count');
    if (trailing < threshold) invalid.push(`discovery saturation requires ${threshold} consecutive zero-new successful workers; observed ${trailing}`);
    if (manifest.config?.maxDiscoveryRuns != null && workers.length >= Number(manifest.config.maxDiscoveryRuns) && trailing < threshold) {
      const reason = 'discovery attempt ceiling reached without saturation';
      invalid.push(`${reason}; mark the run CAPPED`);
      try { markDeepScanCapped(artifactRoot, reason); } catch {}
    }
  }
  return { passed: invalid.length === 0, invalid };
}

function ensureDiscoverySaturated(artifactRoot, completedAt = new Date().toISOString()) {
  // Worker identity/order and first-introduction counters are mechanical. Fix
  // these projection fields from the harness-owned ledger before evaluating
  // saturation so a model typo cannot force another coordinator turn.
  try { normalizeDedupeCounters(artifactRoot); } catch {}
  const checkpoint = discoverySaturationCheckpoint(artifactRoot);
  if (!checkpoint.passed) return checkpoint;
  try {
    const run = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'run.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'discovery/deep/manifest.json'), 'utf8'));
    if (run?.deepScan?.terminalState !== 'SATURATED' || manifest?.status !== 'SATURATED') {
      markDeepScanSaturated(artifactRoot, completedAt);
    }
  } catch (error) {
    return { passed: false, invalid: [`could not atomically transition discovery to SATURATED: ${error.message}`] };
  }
  return discoverySaturationCheckpoint(artifactRoot);
}

function readJson(root, relative, invalid) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    invalid.push(`${relative}: invalid JSON (${error.message})`);
    return null;
  }
}

function readJsonLines(root, relative, invalid) {
  let text;
  try { text = fs.readFileSync(path.join(root, relative), 'utf8'); }
  catch (error) {
    invalid.push(`${relative}: unreadable (${error.message})`);
    return [];
  }
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('expected an object');
      rows.push(row);
    } catch (error) { invalid.push(`${relative}:${index + 1}: invalid JSONL (${error.message})`); }
  }
  return rows;
}

function requireText(value, label, invalid) {
  if (typeof value !== 'string' || !value.trim()) invalid.push(`${label}: required non-empty string`);
}

function keyed(rows, field, label, invalid, { allowEmpty = true } = {}) {
  const result = new Map();
  rows.forEach((row, index) => {
    const key = row?.[field];
    if (typeof key !== 'string' || !key.trim()) invalid.push(`${label}:${index + 1}: missing ${field}`);
    else if (result.has(key)) invalid.push(`${label}: duplicate ${field} ${key}`);
    else result.set(key, row);
  });
  if (!allowEmpty && result.size === 0) invalid.push(`${label}: must not be empty`);
  return result;
}

function requireExactKeys(expected, actual, label, invalid) {
  const missing = [...expected.keys()].filter(key => !actual.has(key));
  const extra = [...actual.keys()].filter(key => !expected.has(key));
  if (missing.length || extra.length) invalid.push(`${label}: key mismatch (missing ${missing.length}, extra ${extra.length})`);
}

function validateCandidate(candidate, label, invalid, inventoryFiles = null) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    invalid.push(`${label}: expected an object`);
    return;
  }
  const allowedFields = new Set(['candidate_id', 'cwe_ids', 'locations', 'summary', 'evidence', 'control', 'sink', 'reachability', 'counterevidence', 'proof_gaps', 'confidence']);
  const unknownFields = Object.keys(candidate || {}).filter(field => !allowedFields.has(field));
  if (unknownFields.length) invalid.push(`${label}: unsupported fields ${unknownFields.join(', ')}`);
  requireText(candidate.summary, `${label}.summary`, invalid);
  requireText(candidate.evidence, `${label}.evidence`, invalid);
  requireText(candidate.control, `${label}.control`, invalid);
  requireText(candidate.sink, `${label}.sink`, invalid);
  requireText(candidate.reachability, `${label}.reachability`, invalid);
  requireText(candidate.counterevidence, `${label}.counterevidence`, invalid);
  if (!Array.isArray(candidate.proof_gaps)) invalid.push(`${label}.proof_gaps: required array`);
  if (!/^(?:high|medium|low)$/i.test(String(candidate.confidence || ''))) invalid.push(`${label}.confidence: expected high, medium, or low`);
  if (!Array.isArray(candidate.cwe_ids)) invalid.push(`${label}.cwe_ids: required array`);
  else candidate.cwe_ids.forEach((cwe, index) => {
    if (!/^CWE-[1-9]\d*$/.test(String(cwe || ''))) invalid.push(`${label}.cwe_ids[${index}]: expected CWE-N`);
  });
  if (!Array.isArray(candidate.locations) || candidate.locations.length === 0) {
    invalid.push(`${label}.locations: required non-empty array`);
  } else {
    candidate.locations.forEach((location, index) => {
      const unknownLocationFields = Object.keys(location || {}).filter(field => !['path', 'start_line', 'end_line', 'role'].includes(field));
      if (unknownLocationFields.length) invalid.push(`${label}.locations[${index}]: unsupported fields ${unknownLocationFields.join(', ')}`);
      requireText(location?.path, `${label}.locations[${index}].path`, invalid);
      if (inventoryFiles && typeof location?.path === 'string' && !inventoryFiles.has(location.path)) {
        invalid.push(`${label}.locations[${index}].path: not present in deterministic inventory`);
      }
      if (!Number.isInteger(location?.start_line) || location.start_line < 1) invalid.push(`${label}.locations[${index}].start_line: expected positive integer`);
      if (!Number.isInteger(location?.end_line) || location.end_line < location.start_line) invalid.push(`${label}.locations[${index}].end_line: expected line at or after start_line`);
      requireText(location?.role, `${label}.locations[${index}].role`, invalid);
      if (!['source', 'control', 'sink', 'evidence'].includes(location?.role)) invalid.push(`${label}.locations[${index}].role: invalid typed location role`);
    });
  }
}

const ACTIVE_ISSUE_DISPOSITIONS = new Set(['REPORTABLE', 'OBSERVATION']);
const DEPLOYMENT_EVIDENCE_STATUSES = new Set(['SOURCE_CONFIGURED', 'DEPLOYMENT_UNVERIFIED', 'RUNTIME_CONFIRMED']);
const OBSERVATION_WEAKNESS_STATUSES = new Set(['NOT_ESTABLISHED', 'HARDENING_ONLY', 'OPERATIONAL_ONLY']);
const MISSING_REPORTABILITY_ELEMENTS = new Set(['SECURITY_CONTROL_FAILURE', 'PLAUSIBLE_ATTACKER', 'SECURITY_IMPACT']);
const DEDUPE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'has', 'in', 'is', 'it',
  'may', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'via', 'with', 'without', 'allows', 'could',
]);

function issueTokens(...values) {
  return new Set(values
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g)
    ?.filter(token => !DEDUPE_STOP_WORDS.has(token)) || []);
}

function candidateCwes(candidate = {}, closure = {}) {
  const values = [
    ...(Array.isArray(candidate.cwe_ids) ? candidate.cwe_ids : []),
    ...(Array.isArray(closure.cwe_ids) ? closure.cwe_ids : []),
    candidate.cwe,
    closure.cwe,
  ];
  return new Set(values.filter(value => /^CWE-[1-9]\d*$/i.test(String(value || ''))).map(value => String(value).toUpperCase()));
}

function candidateLocations(candidate = {}, closure = {}) {
  return [...(Array.isArray(candidate.locations) ? candidate.locations : []), ...(Array.isArray(closure.locations) ? closure.locations : [])]
    .filter(location => location && typeof location.path === 'string'
      && Number.isInteger(location.start_line) && Number.isInteger(location.end_line));
}

function overlappingLocation(left, right) {
  return left.some(a => right.some(b => a.path === b.path
    && a.start_line <= b.end_line && b.start_line <= a.end_line));
}

function tokenOverlap(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / Math.min(left.size, right.size);
}

function validateSemanticIssueClosure(closureRows, candidates, invalid, { strict = true } = {}) {
  if (!strict) return;
  const active = closureRows.filter(row => ACTIVE_ISSUE_DISPOSITIONS.has(String(row.disposition || '').toUpperCase()));
  const issueOwners = new Map();

  closureRows.forEach((row, index) => {
    const disposition = String(row.disposition || '').toUpperCase();
    const label = `candidate closure ${row.candidate_id || index + 1}`;
    if (ACTIVE_ISSUE_DISPOSITIONS.has(disposition)) {
      requireText(row.issue_key, `${label}.issue_key`, invalid);
      if (typeof row.issue_key === 'string' && row.issue_key.trim()) {
        const owner = issueOwners.get(row.issue_key);
        if (owner) invalid.push(`${label}.issue_key: duplicate active issue_key ${row.issue_key} also used by ${owner}`);
        else issueOwners.set(row.issue_key, row.candidate_id || String(index + 1));
      }
    }
    if (disposition === 'REPORTABLE') {
      if (!Array.isArray(row.finding_ids) || row.finding_ids.length !== 1) invalid.push(`${label}: REPORTABLE requires exactly one finding_id`);
      if (row.source_weakness_status !== 'SOURCE_CONFIRMED') invalid.push(`${label}.source_weakness_status: REPORTABLE requires SOURCE_CONFIRMED`);
      requireText(row.minimum_attacker_access, `${label}.minimum_attacker_access`, invalid);
      if (!Array.isArray(row.preconditions)) invalid.push(`${label}.preconditions: required array`);
      if (!DEPLOYMENT_EVIDENCE_STATUSES.has(row.deployment_evidence_status)) invalid.push(`${label}.deployment_evidence_status: invalid status`);
    }
    if (disposition === 'OBSERVATION') {
      if (!Array.isArray(row.observation_ids) || row.observation_ids.length !== 1) invalid.push(`${label}: OBSERVATION requires exactly one observation_id`);
      if (!OBSERVATION_WEAKNESS_STATUSES.has(row.source_weakness_status)) invalid.push(`${label}.source_weakness_status: observation must establish why no source vulnerability exists`);
      if (!MISSING_REPORTABILITY_ELEMENTS.has(row.missing_reportability_element)) invalid.push(`${label}.missing_reportability_element: invalid or missing reportability element`);
    }
    if (disposition === 'SUPPRESSED' && row.duplicate_of_issue_key !== undefined) {
      requireText(row.duplicate_of_issue_key, `${label}.duplicate_of_issue_key`, invalid);
    }
  });

  for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      const leftCandidate = candidates.get(left.candidate_id) || {};
      const rightCandidate = candidates.get(right.candidate_id) || {};
      const leftCwes = candidateCwes(leftCandidate, left);
      const rightCwes = candidateCwes(rightCandidate, right);
      if (![...leftCwes].some(cwe => rightCwes.has(cwe))) continue;
      if (!overlappingLocation(candidateLocations(leftCandidate, left), candidateLocations(rightCandidate, right))) continue;
      const leftTokens = issueTokens(leftCandidate.summary, leftCandidate.title, leftCandidate.evidence, leftCandidate.control, left.title, left.summary, left.root_cause);
      const rightTokens = issueTokens(rightCandidate.summary, rightCandidate.title, rightCandidate.evidence, rightCandidate.control, right.title, right.summary, right.root_cause);
      if (tokenOverlap(leftTokens, rightTokens) < 0.35) continue;
      invalid.push(`probable semantic duplicate: ${left.candidate_id} and ${right.candidate_id} share CWE, source lines, and root-cause language; retain one active issue_key and suppress the alias with duplicate_of_issue_key`);
    }
  }
}

function validateDeepScanArtifacts(artifactRoot, {
  authoritativeModelObservations = [],
  authoritativeWorkerRuns = [],
  skipSealValidation = false,
  preSeal = false,
} = {}) {
  const sealArtifacts = new Set(['scan-manifest.json', 'completion-receipt.json']);
  const controllerProjectionArtifacts = new Set(['findings.json', 'coverage.json']);
  const missing = REQUIRED_DEEP_ARTIFACTS
    .filter(relative => !(skipSealValidation || preSeal) || !sealArtifacts.has(relative))
    .filter(relative => !preSeal || !controllerProjectionArtifacts.has(relative))
    .filter(relative => !fs.existsSync(path.join(artifactRoot, relative)));
  const invalid = [];
  const available = relative => !missing.includes(relative);
  const json = relative => available(relative) ? readJson(artifactRoot, relative, invalid) : null;
  const jsonl = relative => available(relative) ? readJsonLines(artifactRoot, relative, invalid) : [];

  const run = json('run.json');
  const inventoryFiles = keyed(jsonl('inventory/files.jsonl'), 'path', 'inventory/files.jsonl', invalid, { allowEmpty: false });
  const threatModel = json('context/threat-model.json');
  if (threatModel) {
    for (const field of ['summary', 'trust_boundaries', 'entry_points', 'assets', 'attacker_goals', 'priority_hypotheses']) {
      if (field === 'summary') requireText(threatModel[field], `context/threat-model.json.${field}`, invalid);
      else if (!Array.isArray(threatModel[field])) invalid.push(`context/threat-model.json.${field}: required array`);
    }
    if (Number(run?.orchestrationRevision || 0) >= SECURITY_REVIEW_ORCHESTRATION_REVISION) {
      if (!Array.isArray(threatModel.attacker_profiles) || threatModel.attacker_profiles.length === 0) {
        invalid.push('context/threat-model.json.attacker_profiles: required non-empty array');
      } else threatModel.attacker_profiles.forEach((profile, index) => {
        requireText(profile?.id, `context/threat-model.json.attacker_profiles[${index}].id`, invalid);
        requireText(profile?.minimum_access, `context/threat-model.json.attacker_profiles[${index}].minimum_access`, invalid);
        if (!Array.isArray(profile?.entry_points) || profile.entry_points.length === 0) invalid.push(`context/threat-model.json.attacker_profiles[${index}].entry_points: required non-empty array`);
        if (!Array.isArray(profile?.goals) || profile.goals.length === 0) invalid.push(`context/threat-model.json.attacker_profiles[${index}].goals: required non-empty array`);
      });
    }
  }

  const deepConfig = normalizeDeepScanConfig(run?.deepScan || {});
  for (const field of ['minDiscoveryRuns', 'stopAfterNoNew', 'maxDiscoveryRuns', 'maxDurationMinutes', 'discoveryConcurrency', 'specialistConcurrency']) {
    const nullable = field === 'maxDurationMinutes' || field === 'maxDiscoveryRuns';
    const valid = nullable && run?.deepScan?.[field] === null
      ? true
      : Number.isInteger(run?.deepScan?.[field]) && run.deepScan[field] >= 1 && run.deepScan[field] === deepConfig[field];
    if (!valid) {
      invalid.push(`run.json.deepScan.${field}: invalid bounded positive integer`);
    }
  }
  if (run?.deepScan?.terminalState !== 'SATURATED') {
    invalid.push(`run.json.deepScan.terminalState: expected SATURATED, received ${run?.deepScan?.terminalState || '(missing)'}`);
  }
  const deadline = run?.deepScan?.deadlineAt ? Date.parse(run.deepScan.deadlineAt) : null;
  const completed = Date.parse(run?.deepScan?.completedAt || '');
  if (run?.deepScan?.deadlineAt && !Number.isFinite(deadline)) invalid.push('run.json.deepScan.deadlineAt: invalid timestamp');
  if (!Number.isFinite(completed)) invalid.push('run.json.deepScan.completedAt: invalid timestamp');
  if (Number.isFinite(deadline) && Number.isFinite(completed) && completed > deadline) invalid.push('run.json.deepScan: completion occurred after deadline');

  const manifest = json('discovery/deep/manifest.json');
  if (manifest?.status !== 'SATURATED') invalid.push(`discovery/deep/manifest.json.status: expected SATURATED, received ${manifest?.status || '(missing)'}`);
  if (manifest?.deadline_at !== run?.deepScan?.deadlineAt) invalid.push('discovery/deep/manifest.json: deadline does not match run.json');
  for (const field of ['minDiscoveryRuns', 'stopAfterNoNew', 'maxDiscoveryRuns', 'maxDurationMinutes', 'discoveryConcurrency', 'specialistConcurrency']) {
    if (manifest?.config?.[field] !== run?.deepScan?.[field]) invalid.push(`discovery/deep/manifest.json.config.${field}: does not match run.json`);
  }

  const workers = jsonl('discovery/deep/workers.jsonl');
  const workersById = keyed(workers, 'worker_id', 'discovery/deep/workers.jsonl', invalid, { allowEmpty: false });
  const succeeded = [];
  workers.forEach((worker, index) => {
    const label = `deep worker ${worker.worker_id || index + 1}`;
    const status = String(worker.status || '').toUpperCase();
    if (!WORKER_STATUSES.has(status) || worker.status !== status) invalid.push(`${label}.status: expected uppercase SUCCEEDED, FAILED, or CANCELED`);
    if (!Number.isInteger(worker.sequence) || worker.sequence < 1) invalid.push(`${label}.sequence: expected positive integer`);
    const expectedWorkerId = `worker-${String(index + 1).padStart(3, '0')}`;
    if (worker.sequence !== index + 1 || worker.worker_id !== expectedWorkerId) invalid.push(`${label}: expected contiguous ${expectedWorkerId} at sequence ${index + 1}`);
    if (!Number.isInteger(worker.attempt) || worker.attempt < 1) invalid.push(`${label}.attempt: expected positive integer`);
    requireText(worker.requested_model, `${label}.requested_model`, invalid);
    requireText(worker.actual_model, `${label}.actual_model`, invalid);
    if (Number(run?.orchestrationRevision || 0) >= SECURITY_REVIEW_ORCHESTRATION_REVISION) {
      requireText(worker.dispatch_id, `${label}.dispatch_id`, invalid);
    }
    requireText(worker.started_at, `${label}.started_at`, invalid);
    requireText(worker.completed_at, `${label}.completed_at`, invalid);
    if (worker.retry_of && !workersById.has(worker.retry_of)) invalid.push(`${label}.retry_of: referenced worker does not exist`);
    if (status === 'SUCCEEDED') {
      succeeded.push(worker);
      requireText(worker.candidates_artifact, `${label}.candidates_artifact`, invalid);
      requireText(worker.receipt_artifact, `${label}.receipt_artifact`, invalid);
    } else requireText(worker.error, `${label}.error`, invalid);
  });
  const sequences = workers.map(row => row.sequence).filter(Number.isInteger);
  if (new Set(sequences).size !== sequences.length) invalid.push('discovery/deep/workers.jsonl: duplicate sequence');
  succeeded.sort((a, b) => a.sequence - b.sequence);
  if (succeeded.length < deepConfig.minDiscoveryRuns) invalid.push(`deep discovery: expected at least ${deepConfig.minDiscoveryRuns} successful runs, received ${succeeded.length}`);
  if (deepConfig.maxDiscoveryRuns != null && workers.length > deepConfig.maxDiscoveryRuns) invalid.push(`deep discovery: worker count exceeds maxDiscoveryRuns ${deepConfig.maxDiscoveryRuns}`);
  if (authoritativeWorkerRuns.length) {
    const authoritative = new Map(authoritativeWorkerRuns.map(row => [row.worker_id, row]));
    requireExactKeys(workersById, authoritative, 'worker ledger vs controller dispatch ledger', invalid);
    for (const worker of workers) {
      const dispatch = authoritative.get(worker.worker_id);
      if (dispatch?.status === 'STARTED') invalid.push(`deep worker ${worker.worker_id}: controller dispatch is still in flight`);
      if (dispatch && dispatch.status !== worker.status) invalid.push(`deep worker ${worker.worker_id}: status differs from controller dispatch ledger`);
      if (dispatch && Number(run?.orchestrationRevision || 0) >= SECURITY_REVIEW_ORCHESTRATION_REVISION
          && worker.dispatch_id !== dispatch.tool_call_id) {
        invalid.push(`deep worker ${worker.worker_id}: dispatch identity differs from controller dispatch ledger`);
      }
    }
  } else {
    invalid.push('controller-owned discovery dispatch ledger is unavailable');
  }

  const omittedRows = Array.isArray(manifest?.omitted_workers) ? manifest.omitted_workers : [];
  const omitted = new Map(omittedRows.map(row => [row?.worker_id, row]));
  for (const omission of omittedRows) {
    const omittedWorker = workersById.get(omission?.worker_id);
    if (!omittedWorker) invalid.push(`omitted worker ${omission?.worker_id || '(missing)'}: worker does not exist`);
    else if (omittedWorker.status === 'SUCCEEDED') invalid.push(`omitted worker ${omission.worker_id}: successful workers cannot be omitted`);
  }
  const successfulRetryDescendsFrom = workerId => succeeded.some(candidate => {
    const seen = new Set();
    let cursor = candidate;
    while (cursor?.retry_of && !seen.has(cursor.retry_of)) {
      if (cursor.retry_of === workerId) return true;
      seen.add(cursor.retry_of);
      cursor = workersById.get(cursor.retry_of);
    }
    return false;
  });
  for (const worker of workers.filter(row => row.status !== 'SUCCEEDED')) {
    const retry = successfulRetryDescendsFrom(worker.worker_id);
    const omission = omitted.get(worker.worker_id);
    if (!retry && !omission) invalid.push(`deep worker ${worker.worker_id}: failure is neither retried successfully nor explicitly omitted`);
    if (omission) requireText(omission.reason, `omitted worker ${worker.worker_id}.reason`, invalid);
  }

  const rawCandidates = new Map();
  const claimedWorkerObservationIds = new Set();
  for (const worker of succeeded) {
    const candidatesPath = worker.candidates_artifact;
    const receiptPath = worker.receipt_artifact;
    const unsafeCandidates = path.isAbsolute(candidatesPath || '') || String(candidatesPath).split(/[\\/]+/).includes('..');
    const unsafeReceipt = path.isAbsolute(receiptPath || '') || String(receiptPath).split(/[\\/]+/).includes('..');
    if (unsafeCandidates) invalid.push(`deep worker ${worker.worker_id}: unsafe candidates_artifact`);
    if (unsafeReceipt) invalid.push(`deep worker ${worker.worker_id}: unsafe receipt_artifact`);
    if (unsafeCandidates || unsafeReceipt) continue;
    if (!candidatesPath || !fs.existsSync(path.join(artifactRoot, candidatesPath))) {
      invalid.push(`deep worker ${worker.worker_id}: missing candidates artifact ${candidatesPath || '(missing)'}`);
      continue;
    }
    if (!receiptPath || !fs.existsSync(path.join(artifactRoot, receiptPath))) {
      invalid.push(`deep worker ${worker.worker_id}: missing receipt artifact ${receiptPath || '(missing)'}`);
      continue;
    }
    const rows = readJsonLines(artifactRoot, candidatesPath, invalid);
    rows.forEach((candidate, index) => {
      const sourceId = candidate.candidate_id;
      requireText(sourceId, `${candidatesPath}:${index + 1}.candidate_id`, invalid);
      const escapedWorkerId = String(worker.worker_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`^${escapedWorkerId}-C\\d{4}$`).test(String(sourceId || ''))) {
        invalid.push(`${candidatesPath}:${index + 1}.candidate_id: expected ${worker.worker_id}-CNNNN`);
      }
      validateCandidate(candidate, `${candidatesPath}:${index + 1}`, invalid, inventoryFiles);
      const key = `${worker.worker_id}\0${sourceId}`;
      if (rawCandidates.has(key)) invalid.push(`${candidatesPath}: duplicate candidate_id ${sourceId}`);
      rawCandidates.set(key, candidate);
    });
    const receipt = readJson(artifactRoot, receiptPath, invalid);
    const receiptUnknown = Object.keys(receipt || {}).filter(field => !['worker_id', 'status', 'candidate_count', 'candidates_sha256'].includes(field));
    if (receiptUnknown.length) invalid.push(`${receiptPath}: unsupported fields ${receiptUnknown.join(', ')}`);
    if (receipt?.worker_id !== worker.worker_id || receipt?.status !== 'SUCCEEDED') invalid.push(`${receiptPath}: worker identity/status mismatch`);
    if (!/^[a-f0-9]{64}$/.test(String(receipt?.candidates_sha256 || ''))) invalid.push(`${receiptPath}: candidates_sha256 must be 64 lowercase hexadecimal characters`);
    if (Number(receipt?.candidate_count) !== rows.length) invalid.push(`${receiptPath}: candidate_count does not match candidate artifact`);
    if (receipt?.candidates_sha256 !== sha256File(path.join(artifactRoot, candidatesPath))) invalid.push(`${receiptPath}: candidates_sha256 mismatch`);
  }

  const canonicalRows = jsonl('discovery/candidates.jsonl');
  const canonical = keyed(canonicalRows, 'candidate_id', 'discovery/candidates.jsonl', invalid);
  canonicalRows.forEach((row, index) => validateCandidate(row, `discovery/candidates.jsonl:${index + 1}`, invalid, inventoryFiles));
  const validatorCandidateRows = fs.existsSync(path.join(artifactRoot, 'validation', 'new-candidates.jsonl'))
    ? readJsonLines(artifactRoot, 'validation/new-candidates.jsonl', invalid)
    : [];
  const validatorCandidates = keyed(validatorCandidateRows, 'candidate_id', 'validation/new-candidates.jsonl', invalid);
  validatorCandidateRows.forEach((row, index) => validateCandidate(row, `validation/new-candidates.jsonl:${index + 1}`, invalid, inventoryFiles));
  const closureCandidates = new Map(canonical);
  for (const [id, row] of validatorCandidates) {
    if (closureCandidates.has(id)) invalid.push(`validation/new-candidates.jsonl: duplicate canonical candidate ${id}`);
    else closureCandidates.set(id, row);
  }
  const sourceFindingFiles = [
    'discovery/findings.jsonl',
    'tracks/authorization-access-control/findings.jsonl',
    'tracks/data-flow-injection/findings.jsonl',
    'tracks/secrets-history/findings.jsonl',
    'tracks/resilience-error-handling/findings.jsonl',
    'tracks/iac-config-manifests/findings.jsonl',
    'tracks/cryptography-suppressions/findings.jsonl',
  ];
  const sourceFindings = new Map();
  for (const relative of sourceFindingFiles) {
    if (!fs.existsSync(path.join(artifactRoot, relative))) continue;
    for (const [index, row] of readJsonLines(artifactRoot, relative, invalid).entries()) {
      const findingId = row.finding_id || row.id;
      requireText(findingId, `${relative}:${index + 1}.finding_id`, invalid);
      if (!findingId) continue;
      const existing = sourceFindings.get(findingId);
      if (existing && existing.title && row.title && existing.title !== row.title) {
        invalid.push(`source finding ${findingId}: conflicting titles across finding artifacts`);
      }
      if (!existing || relative.startsWith('tracks/')) sourceFindings.set(findingId, row);
    }
  }
  const dedupe = json('discovery/deep/dedupe.json');
  const expectedWorkerIds = succeeded.map(row => row.worker_id);
  if (JSON.stringify(dedupe?.input_worker_ids || []) !== JSON.stringify(expectedWorkerIds)) invalid.push('discovery/deep/dedupe.json: input_worker_ids do not exactly match successful workers in sequence order');
  const mappings = Array.isArray(dedupe?.mappings) ? dedupe.mappings : [];
  if (!Array.isArray(dedupe?.mappings)) invalid.push('discovery/deep/dedupe.json.mappings: required array');
  const mappedRaw = new Set();
  const introduced = new Map(expectedWorkerIds.map(workerId => [workerId, new Set()]));
  const sequenceByWorker = new Map(succeeded.map(worker => [worker.worker_id, worker.sequence]));
  const ownersByCanonical = new Map();
  mappings.forEach((mapping, index) => {
    const key = `${mapping?.worker_id}\0${mapping?.source_candidate_id}`;
    if (!rawCandidates.has(key)) invalid.push(`dedupe mapping ${index + 1}: raw candidate does not exist`);
    if (mappedRaw.has(key)) invalid.push(`dedupe mapping ${index + 1}: raw candidate mapped more than once`);
    mappedRaw.add(key);
    if (!canonical.has(mapping?.canonical_candidate_id)) invalid.push(`dedupe mapping ${index + 1}: canonical candidate does not exist`);
    requireText(mapping?.rationale, `dedupe mapping ${index + 1}.rationale`, invalid);
    const owners = ownersByCanonical.get(mapping?.canonical_candidate_id) || [];
    owners.push(mapping?.worker_id);
    ownersByCanonical.set(mapping?.canonical_candidate_id, owners);
  });
  for (const [canonicalId, owners] of ownersByCanonical) {
    const first = [...new Set(owners)].sort((left, right) => sequenceByWorker.get(left) - sequenceByWorker.get(right))[0];
    introduced.get(first)?.add(canonicalId);
  }
  if (mappedRaw.size !== rawCandidates.size) invalid.push(`dedupe mapping closure: expected ${rawCandidates.size} raw candidates, mapped ${mappedRaw.size}`);
  const mappedCanonical = new Map([...new Set(mappings.map(row => row.canonical_candidate_id))].map(key => [key, true]));
  requireExactKeys(canonical, mappedCanonical, 'dedupe mappings vs canonical candidates', invalid);
  const claimedCounts = dedupe?.new_candidate_counts || {};
  const computedCounts = expectedWorkerIds.map(workerId => introduced.get(workerId)?.size || 0);
  expectedWorkerIds.forEach((workerId, index) => {
    if (Number(claimedCounts[workerId]) !== computedCounts[index]) invalid.push(`dedupe new_candidate_counts.${workerId}: expected ${computedCounts[index]}, received ${claimedCounts[workerId]}`);
  });
  let noNewStreak = 0;
  for (let index = computedCounts.length - 1; index >= 0 && computedCounts[index] === 0; index--) noNewStreak++;
  if (Number(dedupe?.no_new_streak) !== noNewStreak) invalid.push(`dedupe no_new_streak: expected ${noNewStreak}, received ${dedupe?.no_new_streak}`);
  if (noNewStreak < deepConfig.stopAfterNoNew) invalid.push(`deep discovery is not saturated: ${noNewStreak} consecutive no-new runs; requires ${deepConfig.stopAfterNoNew}`);

  const closureRows = jsonl('validation/candidate-closure.jsonl');
  const closure = keyed(closureRows, 'candidate_id', 'validation/candidate-closure.jsonl', invalid);
  const reportableFindingOwners = new Map();
  for (const row of closureRows) {
    if (String(row.disposition || '').toUpperCase() !== 'REPORTABLE') continue;
    for (const findingId of row.finding_ids || []) {
      const owners = reportableFindingOwners.get(findingId) || [];
      owners.push(row.candidate_id);
      reportableFindingOwners.set(findingId, owners);
    }
  }
  for (const [findingId, finding] of sourceFindings) {
    const owners = reportableFindingOwners.get(findingId) || [];
    if (owners.length > 1) invalid.push(`source finding ${findingId}: referenced by multiple reportable candidates`);
    if (owners.length) {
      if (closure.has(findingId) && !closureCandidates.has(findingId)) closureCandidates.set(findingId, finding);
      continue;
    }
    if (!closureCandidates.has(findingId)) closureCandidates.set(findingId, finding);
  }
  requireExactKeys(closureCandidates, closure, 'canonical and validator candidates vs validation closure', invalid);
  closureRows.forEach((row, index) => {
    const label = `candidate closure ${row.candidate_id || index + 1}`;
    if (!CANDIDATE_DISPOSITIONS.has(String(row.disposition || '').toUpperCase())) invalid.push(`${label}.disposition: invalid terminal disposition`);
    if (String(row.disposition || '').toUpperCase() === 'DEFERRED') invalid.push(`${label}.disposition: DEFERRED cannot pass successful completion`);
    requireText(row.validation_method, `${label}.validation_method`, invalid);
    requireText(row.evidence, `${label}.evidence`, invalid);
    requireText(row.counterevidence, `${label}.counterevidence`, invalid);
    if (!Array.isArray(row.proof_gaps)) invalid.push(`${label}.proof_gaps: required array`);
    if (String(row.disposition || '').toUpperCase() === 'REPORTABLE' && (!Array.isArray(row.finding_ids) || row.finding_ids.length === 0)) invalid.push(`${label}: REPORTABLE requires finding_ids`);
    if (String(row.disposition || '').toUpperCase() === 'OBSERVATION') {
      if (!Array.isArray(row.observation_ids) || row.observation_ids.length === 0) invalid.push(`${label}: OBSERVATION requires observation_ids`);
      requireText(row.reportability_rationale, `${label}.reportability_rationale`, invalid);
    }
  });
  validateSemanticIssueClosure(closureRows, closureCandidates, invalid, {
    strict: Number(run?.orchestrationRevision || 0) >= SECURITY_REVIEW_ORCHESTRATION_REVISION,
  });

  const attackRows = jsonl('validation/attack-paths.jsonl');
  const attackPaths = keyed(attackRows, 'candidate_id', 'validation/attack-paths.jsonl', invalid);
  requireExactKeys(closureCandidates, attackPaths, 'canonical and validator candidates vs attack-path analysis', invalid);
  attackRows.forEach((row, index) => {
    const label = `attack path ${row.candidate_id || index + 1}`;
    if (!ATTACK_PATH_DISPOSITIONS.has(String(row.disposition || '').toUpperCase())) invalid.push(`${label}.disposition: invalid terminal disposition`);
    if (String(row.disposition || '').toUpperCase() === 'DEFERRED') invalid.push(`${label}.disposition: DEFERRED cannot pass successful completion`);
    requireText(row.rationale, `${label}.rationale`, invalid);
    requireText(row.reachability, `${label}.reachability`, invalid);
    const closureDisposition = String(closure.get(row.candidate_id)?.disposition || '').toUpperCase();
    const expectedDisposition = { REPORTABLE: 'REPORTABLE', OBSERVATION: 'OBSERVATION', SUPPRESSED: 'IGNORE', NOT_APPLICABLE: 'NOT_APPLICABLE' }[closureDisposition];
    if (expectedDisposition && String(row.disposition || '').toUpperCase() !== expectedDisposition) {
      invalid.push(`${label}.disposition: expected ${expectedDisposition} to match candidate closure ${closureDisposition}`);
    }
  });

  const challengeMatrix = fs.existsSync(path.join(artifactRoot, 'validation/challenge-matrix.json'))
    ? readJson(artifactRoot, 'validation/challenge-matrix.json', invalid)
    : null;
  const challengeOutcomes = Array.isArray(challengeMatrix?.outcomes) ? challengeMatrix.outcomes : [];
  for (const findingId of sourceFindings.keys()) {
    const matches = challengeOutcomes.filter(row => (row.id || row.finding_id || row.candidate_id) === findingId);
    if (matches.length !== 1) invalid.push(`source finding ${findingId}: requires exactly one validator challenge outcome`);
    else if (!/^(?:CONFIRMED(?:_|$)|DOWNGRADED$|REJECTED$)/i.test(String(matches[0].outcome || ''))) {
      invalid.push(`source finding ${findingId}: validator outcome is not terminal`);
    }
  }
  for (const candidateId of validatorCandidates.keys()) {
    const matches = challengeOutcomes.filter(row => row.candidate_id === candidateId && String(row.outcome || '').toUpperCase() === 'NEW');
    if (matches.length !== 1) invalid.push(`validator candidate ${candidateId}: requires exactly one NEW challenge outcome with the same candidate_id`);
  }

  const observations = keyed(jsonl('validation/runtime-model-observations.jsonl'), 'observation_id', 'validation/runtime-model-observations.jsonl', invalid, { allowEmpty: false });
  const authority = new Map(authoritativeModelObservations.map(row => [row.observation_id, row]));
  const nullableNumber = value => value == null ? null : Number(value);
  for (const [id, observation] of observations) {
    requireText(observation.agent_id, `model observation ${id}.agent_id`, invalid);
    requireText(observation.model, `model observation ${id}.model`, invalid);
    if (!['litellm:spend-log', 'litellm:response-headers'].includes(observation.source)) {
      invalid.push(`model observation ${id}.source: expected authoritative LiteLLM spend-log or response-header evidence`);
    }
    requireText(observation.request_id, `model observation ${id}.request_id`, invalid);
    requireText(observation.gateway_model_id, `model observation ${id}.gateway_model_id`, invalid);
    requireText(observation.billed_model_name, `model observation ${id}.billed_model_name`, invalid);
    const trusted = authority.get(id);
    if (!trusted
        || trusted.request_id !== observation.request_id
        || trusted.gateway_model_id !== observation.gateway_model_id
        || trusted.actual_model !== observation.model
        || trusted.agent_id !== observation.agent_id
        || trusted.review_role !== observation.review_role
        || (trusted.worker_id || null) !== (observation.worker_id || null)
        || (trusted.worker_tool_call_id || null) !== (observation.worker_tool_call_id || null)
        || (trusted.requested_model || null) !== (observation.requested_model || null)
        || (trusted.billed_model_name || null) !== (observation.billed_model_name || null)
        || nullableNumber(trusted.cost_usd) !== nullableNumber(observation.cost_usd)) {
      invalid.push(`model observation ${id}: not present unchanged in the controller-owned gateway ledger`);
    }
    if (observation.review_role) requireText(observation.review_role, `model observation ${id}.review_role`, invalid);
  }
  for (const worker of succeeded) {
    const ids = Array.isArray(worker.model_observation_ids) ? worker.model_observation_ids : [];
    if (ids.length === 0) {
      invalid.push(`deep worker ${worker.worker_id}.model_observation_ids: required non-empty array`);
      continue;
    }
    const matched = ids.map(id => observations.get(id)).filter(Boolean);
    for (const id of ids) {
      if (claimedWorkerObservationIds.has(id)) invalid.push(`deep worker ${worker.worker_id}: runtime model observation ${id} is reused by another worker`);
      claimedWorkerObservationIds.add(id);
    }
    if (matched.length !== ids.length) invalid.push(`deep worker ${worker.worker_id}: references a missing runtime model observation`);
      if (!matched.some(row => row.agent_id === 'source-code'
          && row.review_role === 'source-code-primary'
          && row.worker_id === worker.worker_id
          && (Number(run?.orchestrationRevision || 0) < SECURITY_REVIEW_ORCHESTRATION_REVISION
            || row.worker_tool_call_id === worker.dispatch_id)
          && row.model === worker.actual_model
          && authority.has(row.observation_id))) {
        invalid.push(`deep worker ${worker.worker_id}: actual model is not proven by an authoritative gateway observation`);
    }
  }
  const modelReceipts = jsonl('validation/model-receipts.jsonl');
  const modelRoles = keyed(modelReceipts, 'role', 'validation/model-receipts.jsonl', invalid);
  const requiredRoles = new Map(REQUIRED_MODEL_ROLES.map(role => [role, true]));
  requireExactKeys(requiredRoles, modelRoles, 'required review roles vs model receipts', invalid);
  const allowedModels = new Set(Array.isArray(run?.modelPolicy?.allowedModels) ? run.modelPolicy.allowedModels : []);
  const expectedModels = run?.modelPolicy?.expectedModels && typeof run.modelPolicy.expectedModels === 'object'
    ? run.modelPolicy.expectedModels
    : {};
  modelReceipts.forEach(receipt => {
    requireText(receipt.requested_model, `model receipt ${receipt.role}.requested_model`, invalid);
    requireText(receipt.actual_model, `model receipt ${receipt.role}.actual_model`, invalid);
    requireText(receipt.observation_source, `model receipt ${receipt.role}.observation_source`, invalid);
    if (!Array.isArray(receipt.observation_ids) || receipt.observation_ids.length === 0) {
      invalid.push(`model receipt ${receipt.role}.observation_ids: required non-empty array`);
    } else {
      const expectedAgent = MODEL_ROLE_AGENTS[receipt.role];
      const matched = receipt.observation_ids.map(id => observations.get(id)).filter(Boolean);
      if (matched.length !== receipt.observation_ids.length) invalid.push(`model receipt ${receipt.role}: references a missing runtime observation`);
      if (!matched.some(row => row.agent_id === expectedAgent && row.model === receipt.actual_model && row.review_role === receipt.role)) {
        invalid.push(`model receipt ${receipt.role}: actual model is not proven by an authoritative gateway observation for ${expectedAgent}`);
      }
    }
    if (allowedModels.size && !allowedModels.has(receipt.requested_model)) invalid.push(`model receipt ${receipt.role}: requested model ${receipt.requested_model} is outside the allowed model policy`);
    if (expectedModels[receipt.role] && expectedModels[receipt.role] !== receipt.requested_model) {
      invalid.push(`model receipt ${receipt.role}: requested model ${receipt.requested_model} does not match configured model ${expectedModels[receipt.role]}`);
    }
    if (expectedModels[receipt.role] && expectedModels[receipt.role] !== receipt.billed_model_name) {
      invalid.push(`model receipt ${receipt.role}: billed model ${receipt.billed_model_name || '(missing)'} does not match configured model ${expectedModels[receipt.role]}`);
    }
    const receiptProviderProven = (receipt.observation_ids || []).some(id => observations.get(id)?.attestation_level === 'provider');
    if (allowedModels.size && receiptProviderProven && !allowedModels.has(receipt.actual_model)) invalid.push(`model receipt ${receipt.role}: actual model ${receipt.actual_model} is outside the allowed model policy`);
  });
  const actualModels = new Set(modelReceipts.map(row => row.actual_model).filter(Boolean));
  const successfulDispatches = new Set(authoritativeWorkerRuns
    .filter(row => row.status === 'SUCCEEDED' && row.tool_call_id)
    .map(row => `${row.worker_id}\0${row.tool_call_id}`));
  for (const [id, observation] of observations) {
    const operative = !observation.worker_id
      || Number(run?.orchestrationRevision || 0) < SECURITY_REVIEW_ORCHESTRATION_REVISION
      || successfulDispatches.has(`${observation.worker_id}\0${observation.worker_tool_call_id || ''}`);
    if (!operative) continue;
    const requestedModel = allowedModels.has(observation.requested_model)
      ? observation.requested_model
      : observation.logical_model_alias || observation.billed_model_name || observation.requested_model;
    if (allowedModels.size && MODEL_ROLE_AGENTS[observation.review_role] && !allowedModels.has(requestedModel)) {
      invalid.push(`model observation ${id}: requested model ${requestedModel} is outside the allowed model policy`);
    }
    if (allowedModels.size && MODEL_ROLE_AGENTS[observation.review_role]
        && observation.attestation_level === 'provider' && !allowedModels.has(observation.model)) {
      invalid.push(`model observation ${id}: actual model ${observation.model} is outside the allowed model policy`);
    }
  }
  const primaryReceipt = modelRoles.get('source-code-primary');
  const validatorReceipt = modelRoles.get('source-review-validator');
  const primaryModel = primaryReceipt?.observation_ids?.map(id => observations.get(id)?.gateway_model_id).find(Boolean);
  const validatorModel = validatorReceipt?.observation_ids?.map(id => observations.get(id)?.gateway_model_id).find(Boolean);
  if (run?.modelPolicy?.requireDiversity && primaryModel === validatorModel && !run?.modelPolicy?.diversityWaiver) invalid.push('model policy: primary discovery and independent validator used the same actual model without an operator waiver');

  if (!preSeal) {
    const findingsDocument = json('findings.json');
    const findingRows = Array.isArray(findingsDocument?.findings) ? findingsDocument.findings : [];
    if (findingsDocument && !Array.isArray(findingsDocument.findings)) invalid.push('findings.json.findings: required array');
    const findings = keyed(findingRows, 'id', 'findings.json.findings', invalid);
    const expectedFindingIds = new Map();
    closureRows.filter(row => String(row.disposition || '').toUpperCase() === 'REPORTABLE').forEach(row => (row.finding_ids || []).forEach(id => expectedFindingIds.set(id, true)));
    requireExactKeys(expectedFindingIds, findings, 'reportable candidate findings vs findings.json', invalid);
    findingRows.forEach((finding, index) => {
      for (const field of ['title', 'severity', 'description', 'impact', 'recommendation', 'source', 'sink', 'reachability']) requireText(finding[field], `finding ${finding.id || index + 1}.${field}`, invalid);
      if (!Array.isArray(finding.locations) || finding.locations.length === 0) invalid.push(`finding ${finding.id || index + 1}.locations: required non-empty array`);
    });

    const observationCount = closureRows.filter(row => String(row.disposition || '').toUpperCase() === 'OBSERVATION').length;
    const observationsDocument = fs.existsSync(path.join(artifactRoot, 'observations.json'))
      ? json('observations.json')
      : observationCount ? (missing.push('observations.json'), null) : { observations: [] };
    const observationRows = Array.isArray(observationsDocument?.observations) ? observationsDocument.observations : [];
    if (observationsDocument && !Array.isArray(observationsDocument.observations)) invalid.push('observations.json.observations: required array');
    const observationsById = keyed(observationRows, 'id', 'observations.json.observations', invalid);
    const expectedObservationIds = new Map();
    closureRows.filter(row => String(row.disposition || '').toUpperCase() === 'OBSERVATION').forEach(row => (row.observation_ids || []).forEach(id => expectedObservationIds.set(id, true)));
    requireExactKeys(expectedObservationIds, observationsById, 'observation candidate dispositions vs observations.json', invalid);
    observationRows.forEach((row, index) => {
      for (const field of ['title', 'category', 'rationale', 'recommendation', 'evidence', 'reachability', 'counterevidence']) requireText(row[field], `observation ${row.id || index + 1}.${field}`, invalid);
      if (!Array.isArray(row.locations) || row.locations.length === 0) invalid.push(`observation ${row.id || index + 1}.locations: required non-empty array`);
      if (!Array.isArray(row.proof_gaps)) invalid.push(`observation ${row.id || index + 1}.proof_gaps: required array`);
    });

    const coverageDocument = json('coverage.json');
    const coverageRows = Array.isArray(coverageDocument?.files) ? coverageDocument.files : [];
    if (coverageDocument && !Array.isArray(coverageDocument.files)) invalid.push('coverage.json.files: required array');
    const canonicalCoverage = keyed(coverageRows, 'path', 'coverage.json.files', invalid, { allowEmpty: false });
    requireExactKeys(inventoryFiles, canonicalCoverage, 'inventory files vs canonical coverage', invalid);
    coverageRows.forEach(row => {
      requireText(row.disposition, `coverage ${row.path}.disposition`, invalid);
      requireText(row.review_method, `coverage ${row.path}.review_method`, invalid);
    });
  }

  const skipFinalSealValidation = skipSealValidation || preSeal;
  const scanManifest = skipFinalSealValidation ? null : json('scan-manifest.json');
  if (!skipFinalSealValidation && scanManifest?.producer !== 'glados-security-review/v1') invalid.push('scan-manifest.json.producer: expected glados-security-review/v1');
  if (!skipFinalSealValidation && scanManifest?.terminal_state !== 'SATURATED') invalid.push('scan-manifest.json.terminal_state: expected SATURATED');
  if (!skipFinalSealValidation && scanManifest?.repository_head !== run?.head) invalid.push('scan-manifest.json.repository_head: does not match run.json');
  const receipt = skipFinalSealValidation ? null : json('completion-receipt.json');
  if (!skipFinalSealValidation && (receipt?.status !== 'SEALED' || receipt?.terminal_state !== 'SATURATED')) invalid.push('completion-receipt.json: expected SEALED SATURATED receipt');
  const digests = receipt?.artifact_sha256 || {};
  const scanManifestFile = path.join(artifactRoot, 'scan-manifest.json');
  if (!skipFinalSealValidation && fs.existsSync(scanManifestFile)
      && receipt?.scan_manifest_sha256 !== sha256File(scanManifestFile)) {
    invalid.push('completion-receipt.json: scan_manifest_sha256 mismatch');
  }
  if (!skipFinalSealValidation) for (const relative of Object.keys(digests)) {
      if (!fs.existsSync(path.join(artifactRoot, relative))) continue;
      const actual = sha256File(path.join(artifactRoot, relative));
      if (digests[relative] !== actual) invalid.push(`completion-receipt.json: digest mismatch for ${relative}`);
      if (scanManifest?.artifact_sha256?.[relative] !== actual) invalid.push(`scan-manifest.json: digest mismatch for ${relative}`);
  }

  return { passed: missing.length === 0 && invalid.length === 0, missing, invalid };
}

module.exports = {
  DEEP_SCAN_DEFAULTS,
  SECURITY_REVIEW_ORCHESTRATION_REVISION,
  SECURITY_REVIEW_CONTRACT_REVISION,
  REQUIRED_DEEP_ARTIFACTS,
  REQUIRED_MODEL_ROLES,
  appendRuntimeModelObservation,
  bindRuntimeModelObservationToWorker,
  reconcileRuntimeModelObservationsToWorkers,
  claimDiscoveryWorker,
  discoveryWorkerIdFromPrompt,
  engagementIdFromArtifactRoot,
  finalizeDiscoveryWorker,
  discoveryDispatchCheckpoint,
  discoverySaturationCheckpoint,
  ensureDiscoverySaturated,
  initializeDeepScanRun,
  markDeepScanCapped,
  markDeepScanSaturated,
  materializeWorkerReceipt,
  normalizeDeepScanConfig,
  projectSecurityReviewLedgers,
  reconcileActiveSecurityReviewWorkers,
  reconcileInvalidSuccessfulDiscoveryWorkers,
  reconcileCompletedDiscoveryWorker,
  workerArtifactPaths,
  validateWorkerArtifacts,
  validateSemanticIssueClosure,
  validateDeepScanArtifacts,
};
