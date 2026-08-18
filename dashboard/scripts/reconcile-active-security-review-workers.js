#!/usr/bin/env node

const { BLACKBOARD_DB, GLADOS_INVESTIGATIONS_DIR } = require('../lib/config');
const { reconcileActiveSecurityReviewWorkers } = require('../lib/security-review/deep-scan');

process.stdout.write(`${JSON.stringify(reconcileActiveSecurityReviewWorkers({
  dbPath: BLACKBOARD_DB,
  investigationsDir: GLADOS_INVESTIGATIONS_DIR,
}))}\n`);
