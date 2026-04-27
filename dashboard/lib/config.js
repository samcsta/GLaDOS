const path = require('node:path');
const os = require('node:os');

const GLADOS_RUNTIME_DIR = path.resolve(process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const GLADOS_AGENT_WORKSPACES = path.resolve(
  process.env.GLADOS_AGENT_WORKSPACES || path.join(GLADOS_RUNTIME_DIR, 'workspaces', 'agents')
);
const GLADOS_REPORTS_DIR = path.resolve(process.env.GLADOS_REPORTS_DIR || path.join(GLADOS_RUNTIME_DIR, 'reports'));
const GLADOS_INVESTIGATIONS_DIR = path.resolve(
  process.env.GLADOS_INVESTIGATIONS_DIR || path.join(GLADOS_RUNTIME_DIR, 'investigations')
);
const BLACKBOARD_DB = path.resolve(process.env.BLACKBOARD_DB || path.join(GLADOS_RUNTIME_DIR, 'blackboard', 'blackboard.db'));
const WATCHDOG_DB = path.resolve(process.env.WATCHDOG_DB || path.join(GLADOS_RUNTIME_DIR, 'watchdog', 'watchdog.db'));

module.exports = {
  PORT: Number(process.env.PORT || 4280),
  GLADOS_RUNTIME_DIR,
  GLADOS_AGENT_WORKSPACES,
  GLADOS_REPORTS_DIR,
  GLADOS_INVESTIGATIONS_DIR,
  BLACKBOARD_DB,
  WATCHDOG_DB,
  OPENCLAW_HOME,
  AGENTS_DIR: path.join(OPENCLAW_HOME, 'agents'),
  OPENCLAW_JSON: path.join(OPENCLAW_HOME, 'openclaw.json'),
  GLADOS_AGENT_ID: process.env.GLADOS_AGENT_ID || 'glados',
  OPENCLAW_BIN: process.env.OPENCLAW_BIN || 'openclaw',
};
