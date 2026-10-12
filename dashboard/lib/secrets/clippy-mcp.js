const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIPPY_URL = 'https://clippy.redteamstuff.com:8443/mcp/';
const READ_TOOLS = new Set([
  'search', 'read', 'list_files', 'projects_search',
  'directory_lookup', 'directory_search', 'cross_search',
  'infra_lookup', 'infra_search', 'domain_lookup', 'domain_search',
  'github_property_values', 'github_lookup', 'github_search',
]);
const DENIED_TOOLS = [
  'context_put', 'infra_add', 'infra_add_note', 'domain_add',
  'start_session', 'cancel_assessment', 'testbox_action',
  'share_put', 'share_link', 'share_delete',
  'support_report_bug', 'support_request_feature',
];

function secretPath(env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  return path.join(runtimeDir, 'secrets', 'clippy-mcp.json');
}

function loadClippyToken(env = process.env) {
  if (env.GLADOS_CLIPPY_MCP === '0' || env.GLADOS_SECURITY_REVIEW === '1') return null;
  const file = secretPath(env);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('Clippy MCP credential must be a regular owner-only file (chmod 600)');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const token = String(parsed?.token || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 16_384 || /[\r\n\0]/.test(token)) {
    throw new Error('Clippy MCP credential is empty or invalid');
  }
  return token;
}

module.exports = { CLIPPY_URL, READ_TOOLS, DENIED_TOOLS, secretPath, loadClippyToken };
