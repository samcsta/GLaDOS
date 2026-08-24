#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { securityReviewArtifactRoot } = require('../lib/security-review/workflow');

const engagementId = 'Users-samcsta-Desktop-FORD-GH-REPOS-FNV3x-System-Integration-Test-Step-Implement-20260818-f0e02b';
const root = securityReviewArtifactRoot(path.dirname(GLADOS_INVESTIGATIONS_DIR), engagementId);

function readJsonLines(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function writeJsonLines(relative, rows) {
  const file = path.join(root, relative);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const sourceFiles = [
  'discovery/findings.jsonl',
  'tracks/data-flow-injection/findings.jsonl',
  'tracks/secrets-history/findings.jsonl',
  'tracks/resilience-error-handling/findings.jsonl',
  'tracks/iac-config-manifests/findings.jsonl',
];
const findings = new Map();
for (const relative of sourceFiles) for (const row of readJsonLines(relative)) {
  findings.set(row.finding_id || row.id, row);
}

const reportable = new Set(['DFI-F008', 'SH-001', 'IAC-001']);
const observations = new Set(['DFI-F001', 'DFI-F002', 'DFI-F003', 'DFI-F004', 'DFI-F006', 'FNV3X-REH-001']);
const duplicates = new Map([
  ['DFI-F005', 'SH-001'],
  ['FNV3X-REH-002', 'worker-003-C0001'],
  ['IAC-002', 'worker-002-C0001'],
  ['IAC-003', 'worker-002-C0004'],
  ['IAC-004', 'worker-002-C0002'],
]);
const notApplicable = new Set(['DFI-F007']);
const required = new Set([...reportable, ...observations, ...duplicates.keys(), ...notApplicable]);
if (findings.size !== required.size || [...findings.keys()].some(id => !required.has(id))) {
  throw new Error(`unexpected FNV3 finding set: ${[...findings.keys()].sort().join(', ')}`);
}

const closure = readJsonLines('validation/candidate-closure.jsonl').filter(row => !required.has(row.candidate_id));
const attacks = readJsonLines('validation/attack-paths.jsonl').filter(row => !required.has(row.candidate_id));

function evidence(row) {
  return row.source_to_sink || row.source_to_sink_evidence || row.validated_evidence || row.reachability;
}

for (const id of [...required].sort()) {
  const finding = findings.get(id);
  const counterevidence = finding.counterevidence || 'The reviewed snapshot does not establish all deployment, identity, runner, or downstream enforcement controls.';
  const proofGaps = Array.isArray(finding.proof_gaps) ? finding.proof_gaps : [];
  if (reportable.has(id)) {
    closure.push({
      candidate_id: id,
      disposition: 'REPORTABLE',
      finding_ids: [id],
      validation_method: 'Independent source trace and retained isolated validation review',
      evidence: evidence(finding),
      counterevidence,
      proof_gaps: proofGaps,
    });
    attacks.push({
      candidate_id: id,
      disposition: 'REPORTABLE',
      rationale: id === 'DFI-F008'
        ? 'Feature-controlled text reaches generated script data and isolated validation confirmed a closing-script breakout; contributor and report-viewer preconditions lower severity but do not remove the injection weakness.'
        : id === 'SH-001'
          ? 'Hotspot password values are directly interpolated into automation logs and assertion output; log access and credential authenticity affect severity, not the cleartext logging defect.'
          : 'A changed YAML file can make the orphan checker fail while the workflow explicitly records success, bypassing the source-visible validation control; required-check deployment affects severity, not the defective gate.',
      reachability: finding.reachability,
    });
    continue;
  }
  if (observations.has(id)) {
    closure.push({
      candidate_id: id,
      disposition: 'OBSERVATION',
      observation_ids: [`OBS-${id}`],
      observation_category: 'source-confirmed-capability-with-unproven-security-impact',
      validation_method: 'Independent source trace and downstream-control review',
      evidence: evidence(finding),
      counterevidence,
      proof_gaps: proofGaps,
      reportability_rationale: 'The source-level control weakness is confirmed, but downstream acceptance, lower-trust execution authority, or consequential security impact is not established.',
    });
    attacks.push({
      candidate_id: id,
      disposition: 'OBSERVATION',
      rationale: 'Scenario-controlled or persistent bench state reaches the cited operation, but the reviewed snapshot does not establish downstream harmful acceptance or a security-relevant impact beyond test integrity or runner availability.',
      reachability: finding.reachability,
    });
    continue;
  }
  if (duplicates.has(id)) {
    closure.push({
      candidate_id: id,
      disposition: 'SUPPRESSED',
      validation_method: 'Independent duplicate reconciliation against canonical source candidate',
      evidence: evidence(finding),
      counterevidence: `The same weakness is retained under ${duplicates.get(id)}; reporting this ID separately would double-count one attack path.`,
      proof_gaps: [],
      suppression_reason: `DUPLICATE_OF:${duplicates.get(id)}`,
    });
    attacks.push({
      candidate_id: id,
      disposition: 'IGNORE',
      rationale: `Duplicate attack path retained under ${duplicates.get(id)}.`,
      reachability: finding.reachability,
    });
    continue;
  }
  closure.push({
    candidate_id: id,
    disposition: 'NOT_APPLICABLE',
    validation_method: 'Independent intended-function review',
    evidence: evidence(finding),
    counterevidence: 'The registered step explicitly exists to exercise a non-valid APN value; flexible malformed input is the intended negative-test capability.',
    proof_gaps: [],
  });
  attacks.push({
    candidate_id: id,
    disposition: 'NOT_APPLICABLE',
    rationale: 'No separate vulnerability follows from a test step performing its named negative-input function; no parser exploit or resource-consumption path is evidenced.',
    reachability: finding.reachability,
  });
}

for (const row of closure) if (!row.evidence) row.evidence = findings.get(row.candidate_id)?.source_to_sink || findings.get(row.candidate_id)?.source_to_sink_evidence || findings.get(row.candidate_id)?.title || 'Source locations and control behavior are retained in the specialist finding artifact.';

const promote = new Map([
  ['worker-002-C0001', 'IAC-002'],
  ['worker-002-C0002', 'IAC-004'],
  ['worker-002-C0004', 'IAC-003'],
]);
for (const row of closure) {
  const findingId = promote.get(row.candidate_id);
  if (!findingId) continue;
  row.disposition = 'REPORTABLE';
  row.finding_ids = [findingId];
  delete row.observation_ids;
  delete row.observation_category;
  delete row.reportability_rationale;
}
for (const row of attacks) if (promote.has(row.candidate_id)) {
  row.disposition = 'REPORTABLE';
  row.rationale = `${row.rationale} The absent integrity control is reportable with trusted-artifact compromise and authorized workflow execution as explicit preconditions.`;
}

const promotedFindingIds = new Set(promote.values());
for (const row of closure) if (promotedFindingIds.has(row.candidate_id)) {
  row.disposition = 'SUPPRESSED';
  row.validation_method = 'Independent duplicate reconciliation against canonical discovery candidate';
  row.counterevidence = `The same weakness is retained as a reportable canonical discovery candidate; reporting ${row.candidate_id} separately would double-count one attack path.`;
  row.proof_gaps = [];
  row.suppression_reason = `DUPLICATE_OF:${[...promote.entries()].find(([, id]) => id === row.candidate_id)[0]}`;
  delete row.finding_ids;
  delete row.observation_ids;
  delete row.observation_category;
  delete row.reportability_rationale;
}
for (const row of attacks) if (promotedFindingIds.has(row.candidate_id)) {
  row.disposition = 'IGNORE';
  row.rationale = `Duplicate attack path retained under ${[...promote.entries()].find(([, id]) => id === row.candidate_id)[0]}.`;
}

writeJsonLines('validation/candidate-closure.jsonl', closure);
writeJsonLines('validation/attack-paths.jsonl', attacks);
process.stdout.write(`${JSON.stringify({ artifactRoot: root, closureRows: closure.length, attackRows: attacks.length })}\n`);
