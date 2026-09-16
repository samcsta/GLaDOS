#!/usr/bin/env node

const { generateEngagementDeliverables } = require('../lib/engagement-deliverables');

const ids = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
if (!ids.length) {
  process.stderr.write('usage: generate-engagement-deliverables.js <engagement-id> [...]\n');
  process.exit(2);
}

for (const engagementId of ids) {
  const result = generateEngagementDeliverables(engagementId);
  process.stdout.write(`${JSON.stringify({
    engagementId,
    reportRoot: result.reportRoot,
    htmlPath: result.htmlPath,
    pdfPath: result.pdfPath,
    manifestPath: result.manifestPath,
  })}\n`);
}
