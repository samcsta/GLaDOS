const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = new Set(['FINDING', 'TESTED_NEGATIVE', 'NOT_APPLICABLE']);
const CANDIDATE_LOCATION_ROLES = new Set(['source', 'control', 'sink', 'evidence']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(file, rows) {
  write(file, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
}

function normalizeEvidence(row, source) {
  const supplied = Array.isArray(row.evidence) ? row.evidence[0] : row.evidence;
  if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) return supplied;
  const line = Array.isArray(row.line_evidence) ? row.line_evidence[0] : null;
  const match = String(line || '').match(/^(.*?):(\d+(?:-\d+)?)(?:,.*)?$/);
  if (!source?.file || !source?.rule || !(row.analysis || row.rationale || supplied)) return supplied;
  const range = match?.[2] || source.line_ranges?.[0]
    && `${source.line_ranges[0].start_line}-${source.line_ranges[0].end_line}`;
  if (!range) return supplied;
  return {
    file: source.file,
    line_range: range,
    rule: source.rule,
    observed_evidence: row.analysis || row.rationale || String(supplied),
    result: row.status || row.disposition,
  };
}

function normalizeTerminalStatus(value) {
  const status = String(value || '').toUpperCase();
  if (TERMINAL.has(status)) return status;
  if (status === 'OBSERVATION') return 'OBSERVATION';
  if (status === 'REPORTABLE') return 'FINDING';
  return null;
}

function normalizeSemanticCoverage(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'semantic-coverage.json');
  if (!fs.existsSync(file)) return false;
  const semantic = readJson(file);
  const inventory = new Map(readJsonLines(path.join(artifactRoot, 'inventory', 'security-sensitive.jsonl'))
    .map(row => [row.inventory_key, row]));
  let changed = false;
  semantic.checks = (semantic.checks || []).map(row => {
    const next = { ...row };
    if (!next.id && next.check_id) { next.id = next.check_id; changed = true; }
    if (next.status === 'NOT_APPLICABLE' && !next.reason && next.analysis) {
      next.reason = next.analysis;
      changed = true;
    }
    return next;
  });
  semantic.candidate_dispositions = (semantic.candidate_dispositions || []).map(row => {
    const next = { ...row };
    if (!next.status && TERMINAL.has(String(next.disposition || '').toUpperCase())) {
      next.status = String(next.disposition).toUpperCase();
      changed = true;
    }
    const evidence = normalizeEvidence(next, inventory.get(next.inventory_key));
    if (evidence && evidence !== next.evidence) { next.evidence = evidence; changed = true; }
    if (next.evidence && typeof next.evidence === 'object' && !next.evidence.line_range) {
      const source = inventory.get(next.inventory_key);
      const range = source?.line_ranges?.map(item => `${item.start_line}-${item.end_line}`).join(',');
      if (range) { next.evidence = { ...next.evidence, line_range: range }; changed = true; }
    }
    if (next.status === 'NOT_APPLICABLE' && !next.reason && next.analysis) {
      next.reason = next.analysis;
      changed = true;
    }
    if (next.status === 'NOT_APPLICABLE' && !next.reason && next.evidence?.observed_evidence) {
      next.reason = next.evidence.observed_evidence;
      changed = true;
    }
    return next;
  });
  semantic.referrals = (semantic.referrals || []).map(row => {
    const next = { ...row };
    if (!next.id && next.referral_id) { next.id = next.referral_id; changed = true; }
    if (!next.status && TERMINAL.has(String(next.disposition || '').toUpperCase())) {
      next.status = String(next.disposition).toUpperCase();
      changed = true;
    }
    const terminalStatus = normalizeTerminalStatus(next.disposition);
    if (!next.status && terminalStatus) {
      next.status = terminalStatus;
      changed = true;
    }
    if (!next.status && Array.isArray(next.related_finding_ids) && next.related_finding_ids.length) {
      next.status = 'FINDING';
      next.finding_ids = next.related_finding_ids;
      changed = true;
    }
    if (Array.isArray(next.evidence)) {
      const evidence = next.evidence[0];
      if (typeof evidence === 'string') {
        const match = evidence.match(/^(.*?):(\d+(?:-\d+)?)/);
        if (match) {
          next.evidence = {
            file: match[1], line_range: match[2], rule: 'cross-track-referral-closure',
            observed_evidence: next.concern || next.analysis || 'Cross-track concern recorded.', result: next.status,
          };
          changed = true;
        }
      } else if (evidence && typeof evidence === 'object') { next.evidence = evidence; changed = true; }
    }
    return next;
  });
  if (changed) writeJson(file, semantic);
  return changed;
}

function normalizeChallengeMatrix(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'challenge-matrix.json');
  if (!fs.existsSync(file)) return false;
  const matrix = readJson(file);
  let changed = false;
  if (!Array.isArray(matrix.outcomes) && Array.isArray(matrix.candidate_reviews)) {
    matrix.outcomes = matrix.candidate_reviews.map(row => ({ ...row, id: row.candidate_id }));
    changed = true;
  }
  if (Array.isArray(matrix.outcomes)) {
    const closureFile = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
    const closure = fs.existsSync(closureFile) ? readJsonLines(closureFile) : [];
    const byId = new Map(matrix.outcomes.map(row => [row.id || row.candidate_id, row]));
    const candidateToFindings = new Map();
    const findingsFile = path.join(artifactRoot, 'discovery', 'findings.jsonl');
    if (fs.existsSync(findingsFile)) {
      for (const finding of readJsonLines(findingsFile)) {
        for (const candidateId of [finding.candidate_id, ...(finding.candidate_ids || [])].filter(Boolean)) {
          const ids = candidateToFindings.get(candidateId) || [];
          ids.push(finding.finding_id || finding.id);
          candidateToFindings.set(candidateId, ids);
        }
      }
    }
  }
  if (changed) writeJson(file, matrix);
  return changed;
}

function normalizeValidatorCandidates(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'new-candidates.jsonl');
  if (!fs.existsSync(file)) return false;
  let changed = false;
  const rows = readJsonLines(file).map(row => ({
    ...row,
    locations: (row.locations || []).map(location => {
      const role = String(location.role || '').toLowerCase();
      if (CANDIDATE_LOCATION_ROLES.has(role)) return location;
      const normalized = role === 'entry' ? 'source'
        : role === 'source-and-sink' ? 'sink'
          : role === 'caller' ? 'evidence'
            : role;
      if (normalized !== role) changed = true;
      return { ...location, role: normalized };
    }),
  }));
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function normalizeInventoryMatrix(artifactRoot, inventoryRelative, matrixRelative) {
  const inventoryFile = path.join(artifactRoot, inventoryRelative);
  const matrixFile = path.join(artifactRoot, matrixRelative);
  if (!fs.existsSync(inventoryFile) || !fs.existsSync(matrixFile)) return false;
  const expected = new Set(readJsonLines(inventoryFile).map(row => row.key).filter(Boolean));
  const rows = readJsonLines(matrixFile);
  const supplemental = rows.filter(row => !expected.has(row.inventory_key));
  if (supplemental.length) throw new Error(`${matrixRelative}: contains ${supplemental.length} supplemental row(s) outside deterministic inventory`);
  return false;
}

function normalizeCandidateClosure(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
  if (!fs.existsSync(file)) return false;
  let changed = false;
  const rows = readJsonLines(file).map(row => {
    const next = { ...row };
    for (const field of ['evidence', 'counterevidence']) {
      if (!Array.isArray(next[field])) continue;
      next[field] = next[field].join(' ');
      changed = true;
    }
    return next;
  });
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function normalizeCoverageLedger(artifactRoot) {
  const file = path.join(artifactRoot, 'discovery', 'coverage-ledger.jsonl');
  const inventoryFile = path.join(artifactRoot, 'inventory', 'files.jsonl');
  if (!fs.existsSync(file) || !fs.existsSync(inventoryFile)) return false;
  const existing = readJsonLines(file);
  if (!existing.length || existing.some(row => row.path)) return false;
  if (!existing.every(row => row.candidate_id)) return false;
  const sensitiveFile = path.join(artifactRoot, 'inventory', 'security-sensitive.jsonl');
  const sensitive = fs.existsSync(sensitiveFile) ? readJsonLines(sensitiveFile) : [];
  const sensitiveByPath = new Map();
  for (const row of sensitive) {
    const list = sensitiveByPath.get(row.file) || [];
    list.push(row);
    sensitiveByPath.set(row.file, list);
  }
  const findingIdsByPath = new Map();
  for (const row of existing) {
    for (const location of row.evidence_locations || []) {
      const ids = findingIdsByPath.get(location.path) || new Set();
      for (const id of row.finding_ids || []) ids.add(id);
      findingIdsByPath.set(location.path, ids);
    }
  }
  const inventoryRows = readJsonLines(inventoryFile);
  const coveredPaths = new Set(existing.flatMap(row => (row.evidence_locations || []).map(location => location.path)).filter(Boolean));
  const sensitivePaths = new Set(sensitive.map(row => row.file).filter(Boolean));
  const uncoveredSensitive = [...sensitivePaths].filter(filePath => !coveredPaths.has(filePath));
  const unreviewed = inventoryRows.filter(item => !coveredPaths.has(item.path) && !item.binary);
  if (uncoveredSensitive.length || unreviewed.length) {
    throw new Error(`candidate-shaped coverage cannot prove file review: ${uncoveredSensitive.length} security-sensitive and ${unreviewed.length} other text file(s) lack exact evidence`);
  }
  if (!existing.every(row => row.file_review_complete === true)) {
    throw new Error('candidate-shaped coverage requires file_review_complete=true on every retained candidate row');
  }
  const rows = inventoryRows.map(item => {
    const semantic = sensitiveByPath.get(item.path) || [];
    const findingIds = [...(findingIdsByPath.get(item.path) || [])];
    return {
      path: item.path,
      inventory_key: item.key || item.path,
      disposition: findingIds.length ? 'FINDING_EVIDENCE_REVIEWED'
        : semantic.length ? 'SECURITY_SENSITIVE_REVIEWED'
          : item.binary ? 'BINARY_INVENTORIED' : 'MANIFEST_REVIEWED',
      review_method: semantic.length ? 'deep-file-specific-review'
        : item.binary ? 'deterministic-binary-inventory' : 'deterministic-manifest-and-specialist-review',
      ...(findingIds.length ? { finding_ids: findingIds } : {}),
      ...(semantic.length ? {
        evidence_locations: semantic.flatMap(row => (row.line_ranges || []).map(range => ({
          path: row.file,
          start_line: range.start_line,
          end_line: range.end_line,
          rule: row.rule,
        }))),
      } : {}),
    };
  });
  writeJsonLines(file, rows);
  return true;
}

function normalizeTrackAliases(artifactRoot) {
  const changed = [];
  const copy = (sourceRelative, destinationRelative, transform = value => value) => {
    const source = path.join(artifactRoot, sourceRelative);
    const destination = path.join(artifactRoot, destinationRelative);
    if (!fs.existsSync(source) || fs.existsSync(destination)) return;
    const rows = sourceRelative.endsWith('.jsonl') ? readJsonLines(source) : readJson(source);
    if (destinationRelative.endsWith('.jsonl')) writeJsonLines(destination, transform(rows));
    else writeJson(destination, transform(rows));
    changed.push(destinationRelative);
  };
  const inventoryKeys = relative => new Set(readJsonLines(path.join(artifactRoot, relative)).map(row => row.key).filter(Boolean));
  copy('tracks/authorization-access-control/route-method-authz-matrix.jsonl', 'tracks/authorization-access-control/route-authz-matrix.jsonl', rows => rows.map(row => ({
    ...row,
    authn: row.authn || row.authentication,
    scope_role: row.scope_role || row.scope_or_role_enforcement,
    ownership: row.ownership || row.ownership_or_object_filter,
    repository_filter: row.repository_filter || JSON.stringify(row.repository_or_orm_trace || []),
    trace: row.trace || JSON.stringify({ handler: row.handler_trace || [], service: row.service_trace || [], repository: row.repository_or_orm_trace || [] }),
    disposition: row.disposition || row.terminal_disposition,
  })));
  copy('tracks/data-flow-injection/source-to-sink-matrix.jsonl', 'tracks/data-flow-injection/source-sink-matrix.jsonl');
  copy('tracks/secrets-history/history-unavailable.json', 'tracks/secrets-history/history-receipt.json', row => ({
    ...row,
    snapshot_head: row.snapshot_head || row.repository_revision,
    unavailable: true,
  }));
  if (fs.existsSync(path.join(artifactRoot, 'inventory', 'http-clients.jsonl'))) {
    const keys = inventoryKeys('inventory/http-clients.jsonl');
    copy('tracks/resilience-error-handling/http-client-dispositions.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl', rows => rows.filter(row => keys.has(row.inventory_key)));
  }
  copy('tracks/iac-config-manifests/inventory-dispositions.jsonl', 'tracks/iac-config-manifests/disposition-matrix.jsonl');
  if (fs.existsSync(path.join(artifactRoot, 'inventory', 'crypto-operations.jsonl'))) {
    const keys = inventoryKeys('inventory/crypto-operations.jsonl');
    copy('tracks/cryptography-suppressions/crypto-operation-dispositions.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl', rows => rows.filter(row => keys.has(row.inventory_key)));
  }
  return changed;
}

function normalizeCompletedRun(artifactRoot) {
  const runFile = path.join(artifactRoot, 'run.json');
  const manifestFile = path.join(artifactRoot, 'discovery', 'deep', 'manifest.json');
  if (!fs.existsSync(runFile) || !fs.existsSync(manifestFile)) return false;
  const run = readJson(runFile);
  const manifest = readJson(manifestFile);
  if (run?.deepScan?.terminalState !== 'SATURATED' || run.deepScan.completedAt || !manifest.completed_at) return false;
  run.deepScan.completedAt = manifest.completed_at;
  writeJson(runFile, run);
  return true;
}

function normalizeEmptyMatrix(artifactRoot, inventoryRelative, matrixRelative) {
  const inventory = path.join(artifactRoot, inventoryRelative);
  const matrix = path.join(artifactRoot, matrixRelative);
  if (!fs.existsSync(inventory) || !fs.existsSync(matrix) || fs.readFileSync(inventory, 'utf8').trim()) return false;
  if (!fs.readFileSync(matrix, 'utf8').trim()) return false;
  writeJsonLines(matrix, []);
  return true;
}

function normalizeSecurityReviewArtifacts(artifactRoot) {
  const changed = [];
  changed.push(...normalizeTrackAliases(artifactRoot));
  if (normalizeCompletedRun(artifactRoot)) changed.push('run.json');
  if (normalizeCandidateClosure(artifactRoot)) changed.push('validation/candidate-closure.jsonl');
  if (normalizeCoverageLedger(artifactRoot)) changed.push('discovery/coverage-ledger.jsonl');
  if (normalizeSemanticCoverage(artifactRoot)) changed.push('validation/semantic-coverage.json');
  if (normalizeChallengeMatrix(artifactRoot)) changed.push('validation/challenge-matrix.json');
  if (normalizeValidatorCandidates(artifactRoot)) changed.push('validation/new-candidates.jsonl');
  for (const [inventory, matrix] of [
    ['inventory/suppressions.jsonl', 'tracks/cryptography-suppressions/suppression-dispositions.jsonl'],
    ['inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl'],
    ['inventory/http-clients.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl'],
  ]) if (normalizeEmptyMatrix(artifactRoot, inventory, matrix)) changed.push(matrix);
  if (normalizeInventoryMatrix(artifactRoot, 'inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl')) {
    changed.push('tracks/cryptography-suppressions/crypto-matrix.jsonl');
  }
  return { changed };
}

module.exports = { normalizeSecurityReviewArtifacts };
