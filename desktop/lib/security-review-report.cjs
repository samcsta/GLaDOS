const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeChild(root, relative, label) {
  const resolved = path.resolve(root, String(relative || ''));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escapes its root`);
  return resolved;
}

function verifyDigestMap(root, files, label) {
  for (const [relative, expected] of Object.entries(files || {})) {
    const file = safeChild(root, relative, label);
    if (!fs.existsSync(file)) throw new Error(`${label} file is missing: ${relative}`);
    if (sha256(file) !== expected) throw new Error(`${label} digest mismatch for ${relative}`);
  }
}

function safeEngagementId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('invalid security-review engagement id');
  return id;
}

function resolveCompletedSecurityReview(investigationsRoot, engagementId) {
  const id = safeEngagementId(engagementId);
  const exact = path.join(investigationsRoot, id, 'security-review');
  if (fs.existsSync(path.join(exact, 'completion-receipt.json'))) return exact;
  const matches = [];
  for (const entry of fs.readdirSync(investigationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const reviewRoot = path.join(investigationsRoot, entry.name, 'security-review');
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(reviewRoot, 'completion-receipt.json'), 'utf8'));
      if (receipt.engagement_id === id) matches.push(reviewRoot);
    } catch {}
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'security-review engagement id is ambiguous' : 'security-review engagement id was not found');
  return matches[0];
}

function loadCompletedSecurityReview(reviewRoot) {
  const receipt = JSON.parse(fs.readFileSync(path.join(reviewRoot, 'completion-receipt.json'), 'utf8'));
  if (receipt.status !== 'SEALED' || receipt.terminal_state !== 'SATURATED') throw new Error('security review is not sealed and saturated');
  verifyDigestMap(reviewRoot, receipt.artifact_sha256, 'security-review');
  if (receipt.scan_manifest_sha256 && sha256(path.join(reviewRoot, 'scan-manifest.json')) !== receipt.scan_manifest_sha256) {
    throw new Error('security-review digest mismatch for scan-manifest.json');
  }
  const deliverable = path.join(reviewRoot, 'deliverables', 'security-review-report.html');
  if (!fs.existsSync(deliverable)) throw new Error('security-review HTML deliverable is missing');
  const manifestFile = path.join(reviewRoot, 'deliverables', 'DELIVERABLES-MANIFEST.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.engagement_id !== receipt.engagement_id) throw new Error('deliverables manifest engagement identity mismatch');
    if (manifest.source_receipt_sha256 !== sha256(path.join(reviewRoot, 'completion-receipt.json'))) {
      throw new Error('deliverables manifest source receipt mismatch');
    }
    verifyDigestMap(path.join(reviewRoot, 'deliverables'), manifest.files, 'security-review deliverable');
  }
  return {
    receipt,
    run: JSON.parse(fs.readFileSync(path.join(reviewRoot, 'run.json'), 'utf8')),
    html: fs.readFileSync(deliverable, 'utf8'),
  };
}

module.exports = { loadCompletedSecurityReview, resolveCompletedSecurityReview, safeEngagementId };
