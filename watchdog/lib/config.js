const path = require('node:path');
const os = require('node:os');

const GLADOS_RUNTIME_DIR = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados');

module.exports = {
  GLADOS_RUNTIME_DIR,
  WATCHDOG_DB: process.env.WATCHDOG_DB || path.join(GLADOS_RUNTIME_DIR, 'watchdog', 'watchdog.db'),
  HALTS_DIR: path.join(GLADOS_RUNTIME_DIR, 'halts'),
};
