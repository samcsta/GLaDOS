const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeEngagementId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('invalid security-review engagement id');
  return id;
}

function loadCompletedSecurityReview(reviewRoot) {
  const receipt = JSON.parse(fs.readFileSync(path.join(reviewRoot, 'completion-receipt.json'), 'utf8'));
  if (receipt.status !== 'SEALED' || receipt.terminal_state !== 'SATURATED') throw new Error('security review is not sealed and saturated');
  for (const relative of ['run.json', 'context/threat-model.json', 'findings.json', 'coverage.json']) {
    const expected = receipt.artifact_sha256?.[relative];
    if (expected && sha256(path.join(reviewRoot, relative)) !== expected) throw new Error(`security-review digest mismatch for ${relative}`);
  }
  const deliverable = path.join(reviewRoot, 'deliverables', 'security-review-report.html');
  if (!fs.existsSync(deliverable)) throw new Error('security-review HTML deliverable is missing');
  return { receipt, html: fs.readFileSync(deliverable, 'utf8') };
}

module.exports = { loadCompletedSecurityReview, safeEngagementId };
