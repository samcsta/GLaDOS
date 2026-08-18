const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = new Set(['FINDING', 'TESTED_NEGATIVE', 'NOT_APPLICABLE']);

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
  if (!source?.file || !source?.rule) return supplied;
  const range = match?.[2] || source.line_ranges?.[0]
    && `${source.line_ranges[0].start_line}-${source.line_ranges[0].end_line}`;
  if (!range) return supplied;
  return {
    file: source.file,
    line_range: range,
    rule: source.rule,
    observed_evidence: row.analysis || row.rationale || 'File-specific semantic disposition recorded.',
    result: row.status || row.disposition,
  };
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
    return next;
  });
  semantic.referrals = (semantic.referrals || []).map(row => {
    const next = { ...row };
    if (!next.id && next.referral_id) { next.id = next.referral_id; changed = true; }
    if (!next.status && TERMINAL.has(String(next.disposition || '').toUpperCase())) {
      next.status = String(next.disposition).toUpperCase();
      changed = true;
    }
    if (Array.isArray(next.evidence)) {
      const evidence = next.evidence[0];
      if (evidence && typeof evidence === 'object') { next.evidence = evidence; changed = true; }
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
  if (Array.isArray(matrix.outcomes) || !Array.isArray(matrix.candidate_reviews)) return false;
  matrix.outcomes = matrix.candidate_reviews.map(row => ({ ...row, id: row.candidate_id }));
  writeJson(file, matrix);
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
  if (normalizeSemanticCoverage(artifactRoot)) changed.push('validation/semantic-coverage.json');
  if (normalizeChallengeMatrix(artifactRoot)) changed.push('validation/challenge-matrix.json');
  for (const [inventory, matrix] of [
    ['inventory/suppressions.jsonl', 'tracks/cryptography-suppressions/suppression-dispositions.jsonl'],
    ['inventory/crypto-operations.jsonl', 'tracks/cryptography-suppressions/crypto-matrix.jsonl'],
    ['inventory/http-clients.jsonl', 'tracks/resilience-error-handling/http-client-matrix.jsonl'],
  ]) if (normalizeEmptyMatrix(artifactRoot, inventory, matrix)) changed.push(matrix);
  return { changed };
}

module.exports = { normalizeSecurityReviewArtifacts };
