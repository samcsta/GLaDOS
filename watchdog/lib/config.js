const path = require('node:path');
const os = require('node:os');

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const WATCHDOG_ROOT = path.resolve(__dirname, '..');
const GLADOS_RUNTIME_DIR = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados');

module.exports = {
  OPENCLAW_HOME,
  EXEC_APPROVALS_FILE: path.join(OPENCLAW_HOME, 'exec-approvals.json'),
  WATCHDOG_DB: process.env.WATCHDOG_DB || path.join(GLADOS_RUNTIME_DIR, 'watchdog', 'watchdog.db'),
  BURP_API: process.env.BURP_API || 'http://127.0.0.1:1337',
  BURP_API_KEY: process.env.BURP_API_KEY || '',
  // GLaDOS Montoya extension (tools/burp-ext-glados-proxy-api). Serves proxy
  // history + RPS — Burp's built-in REST does not.
  BURP_EXT_API: process.env.BURP_EXT_API || 'http://127.0.0.1:1338',
  BURP_GATE_SH: process.env.BURP_GATE_SH || path.resolve(WATCHDOG_ROOT, '..', 'tools', 'burp-gate.sh'),
  OPENCLAW_BIN: process.env.OPENCLAW_BIN || 'openclaw',
  // Tools whose use should be denied when an agent is halted.
  NETWORK_TOOL_NAMES: ['browser', 'exec', 'process', 'web_fetch', 'web_search'],
  // Diagnostic Burp error burst window. This no longer triggers automatic halt.
  BREAKER_THRESHOLD: Number(process.env.BREAKER_THRESHOLD || 3),
  BREAKER_WINDOW_MS: Number(process.env.BREAKER_WINDOW_MS || 60_000),
};
