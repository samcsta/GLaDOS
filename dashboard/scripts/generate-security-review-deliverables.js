#!/usr/bin/env node

const path = require('node:path');
const { GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { generateSecurityReviewDeliverables } = require('../lib/security-review/deliverables');

const ids = process.argv.slice(2);
if (!ids.length) {
  process.stderr.write('usage: generate-security-review-deliverables.js <engagement-id> [...]\n');
  process.exit(2);
}
for (const engagementId of ids) {
  const artifactRoot = path.join(GLADOS_INVESTIGATIONS_DIR, engagementId, 'security-review');
  const result = generateSecurityReviewDeliverables(artifactRoot);
  process.stdout.write(`${JSON.stringify({ engagementId, deliveryRoot: result.deliveryRoot })}\n`);
}
