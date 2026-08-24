const fs = require('node:fs');
const path = require('node:path');
const { sensitiveDataDispositionBootstrap } = require('./sensitive-data');

const TERMINAL = new Set(['FINDING', 'TESTED_NEGATIVE', 'NOT_APPLICABLE']);
const CLOSURE_DISPOSITIONS = new Set(['REPORTABLE', 'OBSERVATION', 'SUPPRESSED', 'NOT_APPLICABLE', 'DEFERRED']);
const CANDIDATE_LOCATION_ROLES = new Set(['source', 'control', 'sink', 'evidence']);
const VALID_SENSITIVE_PRESENCE = new Set(['PATTERN_ONLY', 'CONFIRMED_LITERAL', 'REFERENCE_ONLY', 'CONTAINER_KEY_ONLY', 'SCHEMA_ONLY', 'NOT_SENSITIVE']);
const VALID_SENSITIVE_VALIDATION = new Set(['UNVERIFIED', 'STRUCTURALLY_VALID', 'INVALID_SECRET', 'VALID_SECRET', 'PII_PATTERN_ONLY', 'CONFIRMED_PII', 'NOT_SENSITIVE']);
const UNSAFE_SENSITIVE_FIELDS = ['value', 'raw', 'sample', 'prefix', 'suffix', 'request_body', 'response_body'];

function canonicalCandidateLocationRole(value) {
  const role = String(value || '').toLowerCase();
  if (CANDIDATE_LOCATION_ROLES.has(role)) return role;
  return role === 'entry' || role === 'invocation' ? 'source'
    : role === 'source-and-sink' || role === 'generated-script-sink' || role === 'execution-sink' ? 'sink'
      : role === 'caller' || role === 'reachability' || role === 'counterevidence' ? 'evidence'
        : role;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function splitConcatenatedJsonValues(text) {
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error(`unexpected JSONL character at offset ${index}`);
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        values.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start >= 0 || inString || depth !== 0) throw new Error('unterminated JSONL value');
  return values;
}

function repairConcatenatedJsonLines(file) {
  if (!fs.existsSync(file)) return false;
  try {
    readJsonLines(file);
    return false;
  } catch {
    const text = fs.readFileSync(file, 'utf8');
    try {
      const rows = splitConcatenatedJsonValues(text);
      writeJsonLines(file, rows);
      return true;
    } catch {}
    const rows = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
        continue;
      } catch (error) {
        const offset = Number(String(error.message || '').match(/position\s+(\d+)/i)?.[1]);
        if (Number.isFinite(offset)) {
          const prefix = line.slice(0, offset);
          const suffix = line.slice(offset);
          if (prefix.endsWith('}') && suffix.startsWith(',')) {
            try {
              rows.push(JSON.parse(`${prefix.slice(0, -1)}${suffix}`));
              continue;
            } catch {}
          }
        }
        rows.push(...splitConcatenatedJsonValues(line));
      }
    }
    writeJsonLines(file, rows);
    return true;
  }
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

function canonicalLineRange(value) {
  if (typeof value === 'string' && /\d/.test(value)) return value;
  if (Array.isArray(value)) {
    const ranges = value.map(canonicalLineRange).filter(Boolean);
    return ranges.length ? ranges.join(',') : null;
  }
  if (!value || typeof value !== 'object') return null;
  const start = value.start_line ?? value.start ?? value.line;
  const end = value.end_line ?? value.end ?? start;
  return Number.isFinite(Number(start)) && Number.isFinite(Number(end)) ? `${start}-${end}` : null;
}

function canonicalEvidenceObject(value, fallbacks = {}) {
  const supplied = Array.isArray(value) ? value[0] : value;
  const object = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const stringEvidence = typeof supplied === 'string' ? supplied : null;
  const stringMatch = stringEvidence?.match(/^(.*?):(\d+(?:-\d+)?)(?:\s|$)/);
  const file = object.file || object.path || fallbacks.file || stringMatch?.[1];
  const lineRange = canonicalLineRange(object.line_range || object.line_ranges)
    || canonicalLineRange({
      start_line: object.start_line ?? object.start,
      end_line: object.end_line ?? object.end,
    })
    || canonicalLineRange(fallbacks.line_range || fallbacks.line_ranges)
    || stringMatch?.[2];
  const rule = object.rule || fallbacks.rule;
  const observed = object.observed_evidence || object.detail || object.analysis || object.rationale
    || fallbacks.observed_evidence || fallbacks.analysis || fallbacks.rationale || stringEvidence;
  const result = object.result || fallbacks.result || fallbacks.status || fallbacks.disposition;
  if (!file || !lineRange || !rule || !observed || !result) return supplied;
  return {
    ...object,
    file,
    line_range: lineRange,
    rule,
    observed_evidence: String(observed),
    result: String(result),
  };
}

function normalizeEvidence(row, source) {
  const line = Array.isArray(row.line_evidence) ? row.line_evidence[0] : null;
  const match = String(line || '').match(/^(.*?):(\d+(?:-\d+)?)(?:,.*)?$/);
  return canonicalEvidenceObject(row.evidence, {
    ...row,
    file: source?.file || row.file || match?.[1],
    rule: source?.rule || row.rule,
    line_range: source?.line_ranges || row.line_range || match?.[2],
    observed_evidence: row.observed_evidence || row.analysis || row.rationale,
  });
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
    if (Array.isArray(next.evidence)) {
      const evidence = next.evidence.map(item => canonicalEvidenceObject(item, {
        rule: next.id || next.check_id,
        status: next.status,
        analysis: next.analysis,
      }));
      if (JSON.stringify(evidence) !== JSON.stringify(next.evidence)) {
        next.evidence = evidence;
        changed = true;
      }
    }
    if (next.status === 'NOT_APPLICABLE' && !next.reason && next.analysis) {
      next.reason = next.analysis;
      changed = true;
    }
    return next;
  });
  semantic.candidate_dispositions = (semantic.candidate_dispositions || []).map(row => {
    const next = { ...row };
    const source = inventory.get(next.inventory_key);
    if (!next.status && TERMINAL.has(String(next.disposition || '').toUpperCase())) {
      next.status = String(next.disposition).toUpperCase();
      changed = true;
    }
    const evidence = normalizeEvidence(next, source);
    if (evidence && evidence !== next.evidence) { next.evidence = evidence; changed = true; }
    if (next.evidence && typeof next.evidence === 'object' && !Array.isArray(next.evidence) && source) {
      const range = canonicalLineRange(source.line_ranges);
      const boundEvidence = {
        ...next.evidence,
        file: source.file,
        rule: source.rule,
        ...(range ? { line_range: range } : {}),
      };
      if (JSON.stringify(boundEvidence) !== JSON.stringify(next.evidence)) {
        next.evidence = boundEvidence;
        changed = true;
      }
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
    if (next.evidence) {
      const evidence = canonicalEvidenceObject(next.evidence, {
        rule: 'cross-track-referral-closure',
        status: next.status,
        observed_evidence: next.concern || next.analysis,
      });
      if (evidence && JSON.stringify(evidence) !== JSON.stringify(next.evidence)) {
        next.evidence = evidence;
        changed = true;
      }
    }
    return next;
  });

  const sourceFindingIds = new Set();
  for (const findingsFile of sourceFindingFiles(artifactRoot)) {
    if (!fs.existsSync(findingsFile)) continue;
    for (const finding of readJsonLines(findingsFile)) {
      const id = finding.finding_id || finding.id;
      if (id) sourceFindingIds.add(id);
    }
  }
  const checksById = new Map((semantic.checks || []).map(row => [row.id || row.check_id, row]));
  semantic.candidate_dispositions = (semantic.candidate_dispositions || []).map(row => {
    if (String(row.status || '').toUpperCase() !== 'FINDING'
        || Array.isArray(row.finding_ids) && row.finding_ids.length) return row;
    const retained = String(row.result || row.evidence?.result || '');
    const resultIds = [...sourceFindingIds].filter(id => new RegExp(`(?:^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9_-])`).test(retained));
    const checkIds = (checksById.get(row.check_id)?.finding_ids || []).filter(id => sourceFindingIds.has(id));
    const findingIds = resultIds.length ? resultIds : checkIds;
    if (!findingIds.length) return row;
    changed = true;
    return { ...row, finding_ids: [...new Set(findingIds)] };
  });
  if (changed) writeJson(file, semantic);
  return changed;
}

function normalizeChallengeMatrix(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'challenge-matrix.json');
  if (!fs.existsSync(file)) return false;
  const matrix = readJson(file);
  let changed = false;
  if (!Array.isArray(matrix.outcomes) && Array.isArray(matrix.findings)) {
    matrix.outcomes = matrix.findings.map(row => ({ ...row, id: row.id || row.finding_id }));
    changed = true;
  }
  if (!Array.isArray(matrix.outcomes) && Array.isArray(matrix.candidate_reviews)) {
    matrix.outcomes = matrix.candidate_reviews.map(row => ({ ...row, id: row.candidate_id }));
    changed = true;
  }
  if (Array.isArray(matrix.outcomes)) {
    matrix.outcomes = matrix.outcomes.map(row => {
      if (!row) return row;
      const next = { ...row };
      if (!next.id && next.subject_id) { next.id = next.subject_id; changed = true; }
      if (!next.candidate_id && next.subject_type === 'validator_candidate' && next.subject_id) {
        next.candidate_id = next.subject_id;
        changed = true;
      }
      return next;
    });
    const closureFile = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
    const closure = fs.existsSync(closureFile) ? readJsonLines(closureFile) : [];
    const byId = new Map(matrix.outcomes.map(row => [row.id || row.candidate_id, row]));
    const candidateToFindings = new Map();
    const sourceFindingIds = new Set();
    const sourceFindings = new Map();
    const findingFiles = [
      'discovery/findings.jsonl',
      'tracks/authorization-access-control/findings.jsonl',
      'tracks/data-flow-injection/findings.jsonl',
      'tracks/secrets-history/findings.jsonl',
      'tracks/resilience-error-handling/findings.jsonl',
      'tracks/iac-config-manifests/findings.jsonl',
      'tracks/cryptography-suppressions/findings.jsonl',
    ].map(relative => path.join(artifactRoot, relative));
    for (const findingsFile of findingFiles) {
      if (!fs.existsSync(findingsFile)) continue;
      for (const finding of readJsonLines(findingsFile)) {
        const findingId = finding.finding_id || finding.id;
        if (findingId) {
          sourceFindingIds.add(findingId);
          sourceFindings.set(findingId, finding);
        }
        for (const candidateId of [finding.candidate_id, ...(finding.candidate_ids || [])].filter(Boolean)) {
          const ids = candidateToFindings.get(candidateId) || [];
          if (findingId) ids.push(findingId);
          candidateToFindings.set(candidateId, ids);
        }
      }
    }
    const findingOwners = new Map();
    for (const row of closure) {
      for (const findingId of row.finding_ids || []) {
        const owners = findingOwners.get(findingId) || [];
        owners.push(row.candidate_id);
        findingOwners.set(findingId, owners);
      }
    }
    for (const [candidateId, findingIds] of candidateToFindings) {
      for (const findingId of findingIds) {
        const owners = findingOwners.get(findingId) || [];
        if (!owners.includes(candidateId)) owners.push(candidateId);
        findingOwners.set(findingId, owners);
      }
    }
    for (const [findingId, owners] of findingOwners) {
      if (!sourceFindingIds.has(findingId)) continue;
      if (byId.has(findingId)) continue;
      const uniqueOwners = [...new Set(owners)].filter(Boolean);
      if (uniqueOwners.length !== 1) continue;
      const candidateId = uniqueOwners[0];
      const outcome = byId.get(candidateId);
      if (!outcome) continue;
      const findingOutcome = {
        ...outcome,
        id: findingId,
        finding_id: findingId,
        source_candidate_id: candidateId,
      };
      matrix.outcomes.push(findingOutcome);
      byId.set(findingId, findingOutcome);
      changed = true;
    }
    const candidates = new Map();
    for (const relative of ['discovery/candidates.jsonl', 'validation/new-candidates.jsonl']) {
      const candidateFile = path.join(artifactRoot, relative);
      if (!fs.existsSync(candidateFile)) continue;
      for (const candidate of readJsonLines(candidateFile)) {
        if (candidate.candidate_id) candidates.set(candidate.candidate_id, candidate);
      }
    }
    const rangesOverlap = (left, right) => (left.locations || []).some(a => (right.locations || []).some(b =>
      a.path === b.path && Number(a.start_line) <= Number(b.end_line) && Number(b.start_line) <= Number(a.end_line)));
    for (const [findingId, finding] of sourceFindings) {
      if (byId.has(findingId)) continue;
      const candidateOutcomes = new Map();
      for (const row of matrix.outcomes) {
        if (!/^(?:CONFIRMED(?:_|$)|DOWNGRADED$|REJECTED$)/i.test(String(row.outcome || ''))) continue;
        const candidateId = row.source_candidate_id || row.candidate_id || row.subject_id || row.id;
        if (!candidates.has(candidateId) || candidateOutcomes.has(candidateId)) continue;
        candidateOutcomes.set(candidateId, row);
      }
      const ranked = [...candidateOutcomes.entries()]
        .map(([candidateId, row]) => ({ row, candidate: candidates.get(candidateId) }))
        .filter(item => rangesOverlap(item.candidate, finding))
        .map(item => ({ ...item, score: findingLinkScore(item.candidate, null, finding) }))
        .sort((left, right) => right.score - left.score);
      if (!ranked.length || ranked[1]?.score === ranked[0].score) continue;
      const sourceCandidateId = ranked[0].candidate.candidate_id;
      const findingOutcome = {
        ...ranked[0].row,
        id: findingId,
        finding_id: findingId,
        source_candidate_id: sourceCandidateId,
      };
      matrix.outcomes.push(findingOutcome);
      byId.set(findingId, findingOutcome);
      changed = true;
    }
  }
  if (changed) writeJson(file, matrix);
  return changed;
}

function normalizeValidatorCandidates(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'new-candidates.jsonl');
  if (!fs.existsSync(file)) return false;
  let changed = false;
  const rows = readJsonLines(file).map(row => {
    const next = { ...row };
    if (next.source_to_sink_evidence && !next.evidence) next.evidence = next.source_to_sink_evidence;
    delete next.source_to_sink_evidence;
    if (Object.keys(next).length !== Object.keys(row).length || next.evidence !== row.evidence) changed = true;
    next.locations = (row.locations || []).map(location => {
      const role = String(location.role || '').toLowerCase();
      const normalized = canonicalCandidateLocationRole(role);
      if (normalized !== role) changed = true;
      return { ...location, role: normalized };
    });
    return next;
  });
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function normalizeInventoryMatrix(artifactRoot, inventoryRelative, matrixRelative) {
  const inventoryFile = path.join(artifactRoot, inventoryRelative);
  const matrixFile = path.join(artifactRoot, matrixRelative);
  if (!fs.existsSync(inventoryFile) || !fs.existsSync(matrixFile)) return false;
  const inventory = readJsonLines(inventoryFile);
  const expected = new Set(inventory.map(row => row.key).filter(Boolean));
  let changed = false;
  const sourceRows = readJsonLines(matrixFile).map(row => {
    if (row.inventory_key == null && typeof row.key === 'string' && expected.has(row.key)) {
      changed = true;
      return { ...row, inventory_key: row.key };
    }
    return row;
  });
  const byKey = new Map();
  for (const row of sourceRows) {
    if (!expected.has(row.inventory_key)) { changed = true; continue; }
    const rows = byKey.get(row.inventory_key) || [];
    rows.push(row);
    byKey.set(row.inventory_key, rows);
  }
  const rows = inventory.flatMap(item => byKey.get(item.key) || []);
  if (JSON.stringify(rows) !== JSON.stringify(sourceRows)) changed = true;
  if (changed) writeJsonLines(matrixFile, rows);
  return changed;
}

function normalizeGroupedCryptoDispositions(artifactRoot) {
  const inventoryFile = path.join(artifactRoot, 'inventory', 'crypto-operations.jsonl');
  const groupedFile = path.join(artifactRoot, 'tracks', 'cryptography-suppressions', 'crypto-operation-dispositions.jsonl');
  const matrixFile = path.join(artifactRoot, 'tracks', 'cryptography-suppressions', 'crypto-matrix.jsonl');
  if (!fs.existsSync(inventoryFile) || !fs.existsSync(groupedFile)) return false;
  const inventory = readJsonLines(inventoryFile);
  const existing = fs.existsSync(matrixFile) ? readJsonLines(matrixFile) : [];
  if (existing.length) return false;
  const grouped = readJsonLines(groupedFile);
  if (!inventory.length || !grouped.length) return false;
  const byRule = new Map();
  for (const row of grouped) {
    if (typeof row.rule !== 'string' || byRule.has(row.rule)) return false;
    byRule.set(row.rule, row);
  }
  const inventoryCounts = new Map();
  for (const item of inventory) inventoryCounts.set(item.rule, (inventoryCounts.get(item.rule) || 0) + 1);
  if (grouped.some(row => Number(row.inventory_entry_count) !== inventory.length
      || Number(row.inventory_entries) !== (inventoryCounts.get(row.rule) || 0))) return false;
  if ([...inventoryCounts.keys()].some(rule => !byRule.has(rule))) return false;
  const rows = inventory.map(item => {
    const review = byRule.get(item.rule);
    return {
      inventory_key: item.key,
      rule: item.rule,
      disposition: review.disposition,
      rationale: review.rationale,
      evidence: review.evidence,
      finding_id: review.finding_id ?? null,
    };
  });
  if (rows.some(row => !row.disposition || !row.rationale || !row.evidence)) return false;
  writeJsonLines(matrixFile, rows);
  return true;
}

function normalizeRouteAuthorizationMatrix(artifactRoot) {
  const file = path.join(artifactRoot, 'tracks', 'authorization-access-control', 'route-authz-matrix.jsonl');
  const inventoryFile = path.join(artifactRoot, 'inventory', 'routes.jsonl');
  if (!fs.existsSync(file) || !fs.existsSync(inventoryFile)) return false;
  const existing = readJsonLines(file);
  if (!existing.length) return false;
  let changed = false;
  const rows = existing.map(row => {
    const next = { ...row };
    const aliases = {
      authn: row.authentication,
      scope_role: row.scope_or_role_enforcement || row.authorization_scope || row.scope_authorization || row.scope,
      ownership: row.ownership_or_object_filter || row.ownership_or_repository_filter,
      repository_filter: row.repository_filter || row.repository_operation || row.repository_orm_operation,
      disposition: row.terminal_disposition,
    };
    for (const [field, value] of Object.entries(aliases)) {
      if (next[field] == null && value != null) { next[field] = value; changed = true; }
    }
    if (next.repository_filter == null && Array.isArray(row.repository_or_orm_trace)) {
      next.repository_filter = JSON.stringify(row.repository_or_orm_trace);
      changed = true;
    }
    if (next.trace == null && (row.handler_trace || row.service_trace || row.repository_or_orm_trace)) {
      next.trace = JSON.stringify({
        handler: row.handler_trace || [],
        service: row.service_trace || [],
        repository: row.repository_or_orm_trace || [],
      });
      changed = true;
    }
    if (next.trace == null && typeof row.evidence === 'string' && row.evidence.trim()) {
      next.trace = row.evidence;
      changed = true;
    }
    if (next.trace == null && row.evidence && typeof row.evidence === 'object') {
      next.trace = JSON.stringify(row.evidence);
      changed = true;
    }
    return next;
  });
  if (!changed) return false;
  writeJsonLines(file, rows);
  return true;
}

function normalizeRequiredTrackArtifacts(artifactRoot) {
  const changed = [];
  const copy = (sourceRelative, destinationRelative) => {
    const source = path.join(artifactRoot, sourceRelative);
    const destination = path.join(artifactRoot, destinationRelative);
    if (!fs.existsSync(source) || fs.existsSync(destination)) return;
    writeJsonLines(destination, readJsonLines(source));
    changed.push(destinationRelative);
  };
  copy('tracks/resilience-error-handling/http-client-timeout-retry-matrix.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl');
  copy('tracks/iac-config-manifests/manifest-dispositions.jsonl', 'tracks/iac-config-manifests/disposition-matrix.jsonl');
  copy('tracks/cryptography-suppressions/crypto-operation-matrix.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl');
  for (const [relative, inventory] of [
    ['tracks/authorization-access-control/route-authz-matrix.jsonl', 'inventory/routes.jsonl'],
    ['tracks/resilience-error-handling/http-client-matrix.jsonl', 'inventory/http-clients.jsonl'],
    ['tracks/cryptography-suppressions/crypto-matrix.jsonl', 'inventory/crypto-operations.jsonl'],
    ['tracks/cryptography-suppressions/suppression-dispositions.jsonl', 'inventory/suppressions.jsonl'],
  ]) {
    const file = path.join(artifactRoot, relative);
    const inventoryFile = path.join(artifactRoot, inventory);
    if (fs.existsSync(file) || !fs.existsSync(inventoryFile) || readJsonLines(inventoryFile).length) continue;
    writeJsonLines(file, []);
    changed.push(relative);
  }
  const history = path.join(artifactRoot, 'tracks', 'secrets-history', 'history-receipt.json');
  if (!fs.existsSync(history)) {
    const inventoryHistory = path.join(artifactRoot, 'inventory', 'secrets-history.json');
    const runFile = path.join(artifactRoot, 'run.json');
    if (fs.existsSync(inventoryHistory) && fs.existsSync(runFile)) {
      const inventory = readJson(inventoryHistory);
      const run = readJson(runFile);
      writeJson(history, {
        completed: inventory.completed === true,
        unavailable: inventory.unavailable === true,
        reason: inventory.reason || null,
        snapshot_head: run.head,
        source: 'inventory/secrets-history.json',
      });
      changed.push('tracks/secrets-history/history-receipt.json');
    }
  }
  return changed;
}

function normalizeRouteInventory(artifactRoot) {
  const file = path.join(artifactRoot, 'inventory', 'routes.jsonl');
  if (!fs.existsSync(file)) return false;
  let changed = false;
  const rows = readJsonLines(file).map(row => {
    if (row.key || !row.inventory_key) return row;
    changed = true;
    return { ...row, key: row.inventory_key };
  });
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function normalizeDiscoveryFindingTitles(artifactRoot) {
  const discoveryFile = path.join(artifactRoot, 'discovery', 'findings.jsonl');
  if (!fs.existsSync(discoveryFile)) return false;
  const trackFiles = [
    'authorization-access-control',
    'data-flow-injection',
    'secrets-history',
    'resilience-error-handling',
    'iac-config-manifests',
    'cryptography-suppressions',
  ].map(track => path.join(artifactRoot, 'tracks', track, 'findings.jsonl'));
  const authoritativeTitles = new Map();
  for (const file of trackFiles) {
    if (!fs.existsSync(file)) continue;
    for (const row of readJsonLines(file)) {
      const findingId = row.finding_id || row.id;
      if (findingId && typeof row.title === 'string' && row.title.trim()) {
        authoritativeTitles.set(findingId, row.title);
      }
    }
  }
  let changed = false;
  const rows = readJsonLines(discoveryFile).map(row => {
    const findingId = row.finding_id || row.id;
    const title = authoritativeTitles.get(findingId);
    if (!title || row.title === title) return row;
    changed = true;
    return { ...row, title };
  });
  if (changed) writeJsonLines(discoveryFile, rows);
  return changed;
}

function normalizeDedupeCounters(artifactRoot) {
  const workersFile = path.join(artifactRoot, 'discovery', 'deep', 'workers.jsonl');
  const dedupeFile = path.join(artifactRoot, 'discovery', 'deep', 'dedupe.json');
  if (!fs.existsSync(workersFile) || !fs.existsSync(dedupeFile)) return false;
  const workers = readJsonLines(workersFile)
    .filter(row => String(row.status || '').toUpperCase() === 'SUCCEEDED')
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  const workerIds = workers.map(row => row.worker_id).filter(Boolean);
  if (!workerIds.length) return false;
  const sequence = new Map(workerIds.map((workerId, index) => [workerId, index]));
  const dedupe = readJson(dedupeFile);
  const owners = new Map();
  for (const mapping of Array.isArray(dedupe.mappings) ? dedupe.mappings : []) {
    if (!sequence.has(mapping.worker_id) || !mapping.canonical_candidate_id) continue;
    const rows = owners.get(mapping.canonical_candidate_id) || new Set();
    rows.add(mapping.worker_id);
    owners.set(mapping.canonical_candidate_id, rows);
  }
  const counts = Object.fromEntries(workerIds.map(workerId => [workerId, 0]));
  for (const candidates of owners.values()) {
    const first = [...candidates].sort((left, right) => sequence.get(left) - sequence.get(right))[0];
    if (first) counts[first] += 1;
  }
  let noNewStreak = 0;
  for (let index = workerIds.length - 1; index >= 0 && counts[workerIds[index]] === 0; index--) noNewStreak += 1;
  const changed = JSON.stringify(dedupe.input_worker_ids || []) !== JSON.stringify(workerIds)
    || JSON.stringify(dedupe.new_candidate_counts || {}) !== JSON.stringify(counts)
    || Number(dedupe.no_new_streak) !== noNewStreak;
  if (!changed) return false;
  writeJson(dedupeFile, {
    ...dedupe,
    input_worker_ids: workerIds,
    new_candidate_counts: counts,
    no_new_streak: noNewStreak,
  });
  return true;
}

function normalizeCandidateClosure(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
  if (!fs.existsSync(file)) return false;
  let changed = false;
  const rows = readJsonLines(file).map(row => {
    const next = { ...row };
    // Validators sometimes label the exact same terminal decision under a
    // compatibility field. The sealing gate owns the canonical `disposition`
    // field, so make that normalization deterministic instead of dispatching
    // a repair turn merely to copy an already-recorded decision.
    const compatibleDisposition = [
      next.disposition,
      next.terminal_disposition,
      next.closure_disposition,
      next.decision,
    ]
      .map(value => String(value || '').trim().toUpperCase())
      .find(value => CLOSURE_DISPOSITIONS.has(value) || value === 'IGNORE');
    const normalizedDisposition = compatibleDisposition === 'IGNORE'
      ? (next.duplicate_of_issue_key ? 'SUPPRESSED' : 'NOT_APPLICABLE')
      : compatibleDisposition;
    if (normalizedDisposition && next.disposition !== normalizedDisposition) {
      next.disposition = normalizedDisposition;
      changed = true;
    }
    for (const field of ['evidence', 'counterevidence']) {
      if (Array.isArray(next[field])) {
        next[field] = next[field].join(' ');
        changed = true;
      } else if (next[field] && typeof next[field] === 'object') {
        next[field] = JSON.stringify(next[field]);
        changed = true;
      }
    }
    return next;
  });
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function sourceFindingFiles(artifactRoot) {
  return [
    'discovery/findings.jsonl',
    'tracks/authorization-access-control/findings.jsonl',
    'tracks/data-flow-injection/findings.jsonl',
    'tracks/secrets-history/findings.jsonl',
    'tracks/resilience-error-handling/findings.jsonl',
    'tracks/iac-config-manifests/findings.jsonl',
    'tracks/cryptography-suppressions/findings.jsonl',
  ].map(relative => path.join(artifactRoot, relative));
}

function locationOverlapScore(candidate, finding) {
  let score = 0;
  for (const left of candidate?.locations || []) for (const right of finding?.locations || []) {
    if (!left?.path || left.path !== right?.path) continue;
    score += 3;
    const leftStart = Number(left.start_line);
    const leftEnd = Number(left.end_line ?? left.start_line);
    const rightStart = Number(right.start_line);
    const rightEnd = Number(right.end_line ?? right.start_line);
    if ([leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)
        && leftStart <= rightEnd && rightStart <= leftEnd) score += 5;
  }
  return score;
}

function findingLinkScore(candidate, closure, finding) {
  const locationScore = locationOverlapScore(candidate, finding);
  if (!locationScore) return 0;
  const words = value => new Set(String(value || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const candidateWords = words([
    closure?.issue_key, candidate?.summary, candidate?.evidence, candidate?.control,
    candidate?.sink, candidate?.reachability,
  ].join(' '));
  const findingWords = words([
    finding?.title, finding?.description, finding?.source_to_sink_evidence,
    finding?.impact, finding?.reachability,
  ].join(' '));
  const generic = new Set(['finding', 'source', 'review', 'security', 'application', 'configured', 'requires', 'without']);
  let wordScore = 0;
  for (const word of candidateWords) if (!generic.has(word) && findingWords.has(word)) wordScore += 1;
  return locationScore + Math.min(wordScore, 12);
}

function normalizeReportableFindingLinks(artifactRoot) {
  const closureFile = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
  const candidatesFile = path.join(artifactRoot, 'discovery', 'candidates.jsonl');
  if (!fs.existsSync(closureFile) || !fs.existsSync(candidatesFile)) return false;
  const findings = new Map();
  for (const file of sourceFindingFiles(artifactRoot)) {
    if (!fs.existsSync(file)) continue;
    for (const row of readJsonLines(file)) {
      const id = row.finding_id || row.id;
      if (id && !findings.has(id)) findings.set(id, row);
    }
  }
  if (!findings.size) return false;
  const candidateRows = readJsonLines(candidatesFile);
  const validatorFile = path.join(artifactRoot, 'validation', 'new-candidates.jsonl');
  if (fs.existsSync(validatorFile)) candidateRows.push(...readJsonLines(validatorFile));
  const candidates = new Map(candidateRows.map(row => [row.candidate_id, row]));
  const rows = readJsonLines(closureFile);
  const claimed = new Set(rows
    .filter(row => String(row.disposition || '').toUpperCase() === 'REPORTABLE')
    .flatMap(row => row.finding_ids || [])
    .filter(id => findings.has(id)));
  const replacements = new Map();
  let changed = false;
  const normalized = rows.map(row => {
    if (String(row.disposition || '').toUpperCase() !== 'REPORTABLE'
        || Array.isArray(row.finding_ids) && row.finding_ids.length === 1 && findings.has(row.finding_ids[0])) return row;
    const candidate = candidates.get(row.candidate_id);
    if (!candidate) return row;
    const ranked = [...findings.entries()]
      .filter(([id]) => !claimed.has(id))
      .map(([id, finding]) => ({ id, score: findingLinkScore(candidate, row, finding) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    if (!ranked.length || ranked[1]?.score === ranked[0].score) return row;
    const findingId = ranked[0].id;
    claimed.add(findingId);
    replacements.set(row.candidate_id, findingId);
    changed = true;
    return { ...row, finding_ids: [findingId] };
  });
  if (!changed) return false;
  writeJsonLines(closureFile, normalized);
  const attackFile = path.join(artifactRoot, 'validation', 'attack-paths.jsonl');
  if (fs.existsSync(attackFile)) {
    const attacks = readJsonLines(attackFile).map(row => replacements.has(row.candidate_id)
      ? { ...row, finding_ids: [replacements.get(row.candidate_id)] }
      : row);
    writeJsonLines(attackFile, attacks);
  }
  const challengeFile = path.join(artifactRoot, 'validation', 'challenge-matrix.json');
  if (fs.existsSync(challengeFile)) {
    const challenge = readJson(challengeFile);
    if (Array.isArray(challenge.outcomes)) {
      challenge.outcomes = challenge.outcomes.map(row => {
        const candidateId = row.subject_id || row.candidate_id || row.id;
        return replacements.has(candidateId) ? { ...row, finding_ids: [replacements.get(candidateId)] } : row;
      });
      writeJson(challengeFile, challenge);
    }
  }
  return true;
}

function normalizeAttackPaths(artifactRoot) {
  const file = path.join(artifactRoot, 'validation', 'attack-paths.jsonl');
  if (!fs.existsSync(file)) return false;
  let changed = false;
  const closureFile = path.join(artifactRoot, 'validation', 'candidate-closure.jsonl');
  const closure = new Map((fs.existsSync(closureFile) ? readJsonLines(closureFile) : [])
    .map(row => [row.candidate_id, row]));
  let rows = readJsonLines(file).map(row => {
    const next = { ...row };
    if (!next.disposition && (next.closure_disposition || next.decision)) {
      next.disposition = String(next.closure_disposition || next.decision).toUpperCase();
      changed = true;
    }
    for (const field of ['rationale', 'reachability']) {
      if (!next[field] || typeof next[field] !== 'object') continue;
      next[field] = JSON.stringify(next[field]);
      changed = true;
    }
    const disposition = closure.get(next.candidate_id);
    const expected = {
      REPORTABLE: 'REPORTABLE',
      OBSERVATION: 'OBSERVATION',
      SUPPRESSED: 'IGNORE',
      NOT_APPLICABLE: 'NOT_APPLICABLE',
    }[String(disposition?.disposition || '').toUpperCase()];
    if (expected && String(next.disposition || '').toUpperCase() !== expected) {
      next.disposition = expected;
      changed = true;
    }
    if (disposition?.duplicate_of_issue_key && !next.duplicate_of_issue_key) {
      next.duplicate_of_issue_key = disposition.duplicate_of_issue_key;
      changed = true;
    }
    return next;
  });
  if (closure.size) {
    const counts = new Map();
    for (const row of rows) counts.set(row.candidate_id, (counts.get(row.candidate_id) || 0) + 1);
    if ([...closure.keys()].every(id => counts.get(id) === 1)) {
      const canonical = rows.filter(row => closure.has(row.candidate_id));
      if (canonical.length !== rows.length) { rows = canonical; changed = true; }
    }
  }
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function normalizeRegressionDelta(artifactRoot) {
  const file = path.join(artifactRoot, 'regression', 'delta.json');
  if (!fs.existsSync(file)) return false;
  const delta = readJson(file);
  if (!Array.isArray(delta.dispositions)) return false;
  let changed = false;
  delta.dispositions = delta.dispositions.map(row => {
    const next = { ...row };
    if (!next.prior_finding_id && (next.prior_id || next.finding_id)) {
      next.prior_finding_id = next.prior_id || next.finding_id;
      changed = true;
    }
    if (!next.disposition && next.status) {
      next.disposition = next.status;
      changed = true;
    }
    if (!next.evidence && next.current_source_evidence) {
      next.evidence = JSON.stringify(next.current_source_evidence);
      changed = true;
    }
    if (!next.evidence && next.current_evidence) {
      next.evidence = JSON.stringify(next.current_evidence);
      changed = true;
    }
    return next;
  });
  const terminal = new Set(['CONFIRMED', 'CONFIRMED_FIXED', 'CONFIRMED_PARTIAL_FIX', 'NOT_IN_CURRENT_TREE', 'BLOCKED']);
  if (!delta.status && delta.dispositions.length
      && delta.dispositions.every(row => terminal.has(row.disposition)
        && ((typeof row.evidence === 'string' && row.evidence.trim())
          || row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) && Object.keys(row.evidence).length))) {
    delta.status = 'COMPLETE';
    changed = true;
  }
  if (changed) writeJson(file, delta);
  return changed;
}

function normalizeCoveragePartitions(artifactRoot) {
  const inventoryFile = path.join(artifactRoot, 'inventory', 'files.jsonl');
  const partitionsDirectory = path.join(artifactRoot, 'discovery', 'coverage-partitions');
  const ledgerFile = path.join(artifactRoot, 'discovery', 'coverage-ledger.jsonl');
  if (!fs.existsSync(inventoryFile) || !fs.existsSync(partitionsDirectory) || !fs.existsSync(ledgerFile)) return false;
  const inventory = readJsonLines(inventoryFile);
  const expected = new Map(inventory.map(row => [row.key || row.path, row]));
  const selected = [];
  for (const entry of fs.readdirSync(partitionsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const range = entry.name.match(/^(\d+)-(\d+)\.jsonl$/);
    if (!range) continue;
    selected.push({ file: path.join(partitionsDirectory, entry.name), start: Number(range[1]), end: Number(range[2]) });
  }
  selected.sort((left, right) => left.start - right.start || left.end - right.end);
  const covered = new Map();
  const used = [];
  for (const partition of selected) {
    let rows;
    try { rows = readJsonLines(partition.file); } catch { continue; }
    const expectedRows = inventory.slice(partition.start - 1, partition.end);
    if (rows.length !== partition.end - partition.start + 1 || expectedRows.length !== rows.length) continue;
    const exact = rows.every((row, index) => {
      const key = row.key || row.path;
      const expectedKey = expectedRows[index].key || expectedRows[index].path;
      return key === expectedKey
        && typeof row.review_method === 'string' && row.review_method.trim()
        && !/DEFERRED|UNREVIEWED/i.test(String(row.disposition || row.status || ''));
    });
    if (!exact || rows.some(row => covered.has(row.key || row.path))) continue;
    for (const row of rows) covered.set(row.key || row.path, row);
    used.push(path.basename(partition.file));
  }
  const existing = new Map(readJsonLines(ledgerFile).map(row => [row.key || row.path, row]));
  for (const [key, row] of existing) {
    if (!expected.has(key) || covered.has(key) || /DEFERRED|UNREVIEWED/i.test(String(row.disposition || row.status || ''))) continue;
    covered.set(key, row);
  }
  if (covered.size !== expected.size) return false;
  const rows = inventory.map(item => covered.get(item.key || item.path));
  if (rows.some(row => !row || /DEFERRED|UNREVIEWED/i.test(String(row.disposition || row.status || '')))) return false;
  const existingRows = readJsonLines(ledgerFile);
  if (JSON.stringify(rows) === JSON.stringify(existingRows)) return false;
  writeJsonLines(ledgerFile, rows);
  writeJson(path.join(artifactRoot, 'discovery', 'coverage-aggregation.json'), {
    schema_version: 1,
    producer: 'glados-security-review/v1',
    inventory_rows: inventory.length,
    coverage_rows: rows.length,
    unique_keys: covered.size,
    exact_key_and_ordinal_equality: true,
    partitions: used,
  });
  return true;
}

function normalizeSensitiveDataDispositions(artifactRoot) {
  const file = path.join(artifactRoot, 'tracks', 'secrets-history', 'sensitive-data-dispositions.jsonl');
  if (!fs.existsSync(file)) return false;
  const inventoryFile = path.join(artifactRoot, 'inventory', 'sensitive-data-head.json');
  if (fs.existsSync(inventoryFile)) {
    const candidates = readJson(inventoryFile).candidates || [];
    const existing = readJsonLines(file);
    const byKey = new Map(existing.map(row => [row.inventory_key, row]));
    const rows = [...new Map(candidates.map(candidate => [candidate.inventory_key, candidate])).values()].map(candidate => {
      const row = byKey.get(candidate.inventory_key);
      const usable = row
        && VALID_SENSITIVE_PRESENCE.has(row.presence_status)
        && VALID_SENSITIVE_VALIDATION.has(row.validation_status)
        && row.value_redacted === true
        && typeof row.rationale === 'string' && row.rationale.trim()
        && !UNSAFE_SENSITIVE_FIELDS.some(field => Object.hasOwn(row, field));
      return usable ? row : sensitiveDataDispositionBootstrap(candidate);
    });
    if (JSON.stringify(rows) === JSON.stringify(existing)) return false;
    writeJsonLines(file, rows);
    return true;
  }
  let changed = false;
  const rows = readJsonLines(file).map(row => {
    if (VALID_SENSITIVE_VALIDATION.has(row.validation_status)) return row;
    changed = true;
    return {
      ...row,
      validation_status: row.kind === 'PII' ? 'NOT_SENSITIVE' : 'UNVERIFIED',
      rationale: `${row.rationale || 'Candidate reviewed.'} Unsupported terminal validation status normalized by the controller.`,
    };
  });
  if (changed) writeJsonLines(file, rows);
  return changed;
}

function normalizeCoverageLedger(artifactRoot) {
  const file = path.join(artifactRoot, 'discovery', 'coverage-ledger.jsonl');
  const inventoryFile = path.join(artifactRoot, 'inventory', 'files.jsonl');
  if (!fs.existsSync(inventoryFile)) return false;
  if (!fs.existsSync(file)) {
    const rows = readJsonLines(inventoryFile).map(item => ({
      key: item.key || item.path,
      path: item.path,
      disposition: 'DEFERRED',
      review_method: 'controller-inventory-bootstrap',
      rationale: 'Awaiting evidence-backed file review disposition from the coordinator.',
    }));
    writeJsonLines(file, rows);
    return true;
  }
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
  const routeKeys = fs.existsSync(path.join(artifactRoot, 'inventory', 'routes.jsonl'))
    ? inventoryKeys('inventory/routes.jsonl') : new Set();
  copy('tracks/authorization-access-control/route-method-authz-matrix.jsonl', 'tracks/authorization-access-control/route-authz-matrix.jsonl', rows => rows.filter(row => routeKeys.has(row.inventory_key)).map(row => ({
    ...row,
    authn: row.authn || row.authentication,
    scope_role: row.scope_role || row.scope_or_role_enforcement,
    ownership: row.ownership || row.ownership_or_object_filter,
    repository_filter: row.repository_filter || JSON.stringify(row.repository_or_orm_trace || []),
    trace: row.trace || JSON.stringify({ handler: row.handler_trace || [], service: row.service_trace || [], repository: row.repository_or_orm_trace || [] }),
    disposition: row.disposition || row.terminal_disposition,
  })));
  copy('tracks/authorization-access-control/route-method-authn-scope-ownership-matrix.jsonl', 'tracks/authorization-access-control/route-authz-matrix.jsonl', rows => rows.filter(row => routeKeys.has(row.inventory_key)).map(row => ({
    ...row,
    authn: row.authn || row.authentication,
    scope_role: row.scope_role || row.scope_or_role_enforcement || row.authorization_scope,
    ownership: row.ownership || row.ownership_or_object_filter || row.ownership_or_repository_filter,
    repository_filter: row.repository_filter || JSON.stringify(row.repository_or_orm_trace || []),
    trace: row.trace || JSON.stringify({ handler: row.handler_trace || [], service: row.service_trace || [], repository: row.repository_or_orm_trace || [] }),
    disposition: row.disposition || row.terminal_disposition,
  })));
  copy('tracks/authorization-access-control/route-authorization-matrix.jsonl', 'tracks/authorization-access-control/route-authz-matrix.jsonl', rows => rows.filter(row => routeKeys.has(row.inventory_key)).map(row => ({
    ...row,
    authn: row.authn || row.authentication,
    scope_role: row.scope_role || row.scope_authorization || row.scope,
    ownership: row.ownership || row.ownership_or_object_filter,
    repository_filter: row.repository_filter || row.repository_orm_operation,
    trace: row.trace || JSON.stringify(row.source_lines || row.evidence || []),
    disposition: row.disposition || row.terminal_disposition,
  })));
  copy('tracks/data-flow-injection/source-to-sink-matrix.jsonl', 'tracks/data-flow-injection/source-sink-matrix.jsonl');
  copy('tracks/data-flow-injection/input-to-sink-matrix.jsonl', 'tracks/data-flow-injection/source-sink-matrix.jsonl');
  copy('tracks/data-flow-injection/source-sink-matrix.json', 'tracks/data-flow-injection/source-sink-matrix.jsonl', value => Array.isArray(value) ? value : [value]);
  copy('tracks/secrets-history/head-history-receipt.json', 'tracks/secrets-history/history-receipt.json');
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
  copy('tracks/iac-config-manifests/coverage.jsonl', 'tracks/iac-config-manifests/disposition-matrix.jsonl');
  copy('tracks/iac-config-manifests/coverage-ledger.jsonl', 'tracks/iac-config-manifests/disposition-matrix.jsonl', rows => rows.map(row => ({
    ...row,
    inventory_key: row.inventory_key || row.asset_key,
    disposition: row.disposition || row.result,
    rationale: row.rationale || row.evidence,
  })));
  if (fs.existsSync(path.join(artifactRoot, 'inventory', 'crypto-operations.jsonl'))) {
    const keys = inventoryKeys('inventory/crypto-operations.jsonl');
    copy('tracks/cryptography-suppressions/crypto-operation-dispositions.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl', rows => rows.filter(row => keys.has(row.inventory_key)));
    copy('tracks/cryptography-suppressions/crypto-operations-dispositions.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl', rows => rows.filter(row => keys.has(row.inventory_key)).map(row => ({
      ...row,
      disposition: row.disposition || row.terminal_disposition,
      rationale: row.rationale || row.justification,
    })));
  }
  copy('tracks/cryptography-suppressions/suppressions-dispositions.jsonl', 'tracks/cryptography-suppressions/suppression-dispositions.jsonl', rows => rows.map(row => ({
    ...row,
    disposition: row.disposition || row.terminal_disposition,
    rationale: row.rationale || row.justification,
  })));
  copy('tracks/resilience-error-handling/http-client-resilience-matrix.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl');
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
  for (const relative of ['validation/candidate-closure.jsonl', 'validation/attack-paths.jsonl']) {
    if (repairConcatenatedJsonLines(path.join(artifactRoot, relative))) changed.push(relative);
  }
  changed.push(...normalizeTrackAliases(artifactRoot));
  changed.push(...normalizeRequiredTrackArtifacts(artifactRoot));
  if (normalizeDiscoveryFindingTitles(artifactRoot)) changed.push('discovery/findings.jsonl');
  if (normalizeDedupeCounters(artifactRoot)) changed.push('discovery/deep/dedupe.json');
  if (normalizeRouteInventory(artifactRoot)) changed.push('inventory/routes.jsonl');
  if (normalizeRouteAuthorizationMatrix(artifactRoot)) changed.push('tracks/authorization-access-control/route-authz-matrix.jsonl');
  if (normalizeCompletedRun(artifactRoot)) changed.push('run.json');
  if (normalizeRegressionDelta(artifactRoot)) changed.push('regression/delta.json');
  if (normalizeCandidateClosure(artifactRoot)) changed.push('validation/candidate-closure.jsonl');
  if (normalizeReportableFindingLinks(artifactRoot)) changed.push('validation/candidate-closure.jsonl', 'validation/attack-paths.jsonl', 'validation/challenge-matrix.json');
  if (normalizeAttackPaths(artifactRoot)) changed.push('validation/attack-paths.jsonl');
  if (normalizeCoveragePartitions(artifactRoot)) changed.push('discovery/coverage-ledger.jsonl', 'discovery/coverage-aggregation.json');
  if (normalizeCoverageLedger(artifactRoot)) changed.push('discovery/coverage-ledger.jsonl');
  if (normalizeSensitiveDataDispositions(artifactRoot)) changed.push('tracks/secrets-history/sensitive-data-dispositions.jsonl');
  if (normalizeSemanticCoverage(artifactRoot)) changed.push('validation/semantic-coverage.json');
  if (normalizeChallengeMatrix(artifactRoot)) changed.push('validation/challenge-matrix.json');
  if (normalizeValidatorCandidates(artifactRoot)) changed.push('validation/new-candidates.jsonl');
  if (normalizeGroupedCryptoDispositions(artifactRoot)) changed.push('tracks/cryptography-suppressions/crypto-matrix.jsonl');
  for (const [inventory, matrix] of [
    ['inventory/suppressions.jsonl', 'tracks/cryptography-suppressions/suppression-dispositions.jsonl'],
    ['inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl'],
    ['inventory/http-clients.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl'],
  ]) if (normalizeEmptyMatrix(artifactRoot, inventory, matrix)) changed.push(matrix);
  for (const [inventory, matrix] of [
    ['inventory/routes.jsonl', 'tracks/authorization-access-control/route-authz-matrix.jsonl'],
    ['inventory/suppressions.jsonl', 'tracks/cryptography-suppressions/suppression-dispositions.jsonl'],
    ['inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl'],
    ['inventory/http-clients.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl'],
  ]) if (normalizeInventoryMatrix(artifactRoot, inventory, matrix)) changed.push(matrix);
  return { changed };
}

module.exports = {
  canonicalCandidateLocationRole,
  normalizeDedupeCounters,
  normalizeSecurityReviewArtifacts,
  repairConcatenatedJsonLines,
};
