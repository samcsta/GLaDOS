#!/usr/bin/env node

const path = require('node:path');
const { BLACKBOARD_DB, GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { revalidateFailedSecurityReview } = require('../lib/security-review/finalize');

const ids = process.argv.slice(2);
if (!ids.length) {
  process.stderr.write('usage: revalidate-security-review.js <engagement-id> [...]\n');
  process.exit(2);
}

let failed = false;
for (const engagementId of ids) {
  const artifactRoot = path.join(GLADOS_INVESTIGATIONS_DIR, engagementId, 'security-review');
  const result = revalidateFailedSecurityReview({
    dbPath: BLACKBOARD_DB,
    artifactRoot,
    engagementId,
  });
  process.stdout.write(`${JSON.stringify({ engagementId, ...result })}\n`);
  if (!result.passed) failed = true;
}
process.exitCode = failed ? 1 : 0;
