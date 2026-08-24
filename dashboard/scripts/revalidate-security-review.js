#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { BLACKBOARD_DB, GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { revalidateFailedSecurityReview } = require('../lib/security-review/finalize');
const { securityReviewArtifactRoot } = require('../lib/security-review/workflow');

const ids = process.argv.slice(2);
if (!ids.length) {
  process.stderr.write('usage: revalidate-security-review.js <engagement-id> [...]\n');
  process.exit(2);
}

let failed = false;
for (const engagementId of ids) {
  const exact = securityReviewArtifactRoot(path.dirname(GLADOS_INVESTIGATIONS_DIR), engagementId);
  let artifactRoot = exact;
  if (!fs.existsSync(path.join(exact, 'run.json'))) {
    const matches = fs.readdirSync(GLADOS_INVESTIGATIONS_DIR, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory()) return [];
      const reviewRoot = path.join(GLADOS_INVESTIGATIONS_DIR, entry.name, 'security-review');
      for (const relative of ['completion-receipt.json', 'scan-manifest.json', 'findings.json', 'observations.json']) {
        try {
          const document = JSON.parse(fs.readFileSync(path.join(reviewRoot, relative), 'utf8'));
          if (document.engagement_id === engagementId) return [reviewRoot];
        } catch {}
      }
      return [];
    });
    if (matches.length === 1) artifactRoot = matches[0];
  }
  const result = revalidateFailedSecurityReview({
    dbPath: BLACKBOARD_DB,
    artifactRoot,
    engagementId,
  });
  process.stdout.write(`${JSON.stringify({ engagementId, ...result })}\n`);
  if (!result.passed) failed = true;
}
process.exitCode = failed ? 1 : 0;
