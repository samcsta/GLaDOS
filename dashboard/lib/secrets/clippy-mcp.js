const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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

function normalizeClippyToken(value) {
  const token = String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 16_384 || /[\r\n\0]/.test(token)) throw new Error('Enter a valid Clippy bearer token');
  return token;
}

function saveClippyToken(value, env = process.env) {
  const token = normalizeClippyToken(value);
  const file = secretPath(env);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Clippy secret directory is invalid');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.clippy-mcp-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function removeClippyToken(env = process.env) {
  const file = secretPath(env);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('Clippy credential is not a regular file');
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function probeClippyConnection(value, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const token = normalizeClippyToken(value);
  const response = await fetchImpl(CLIPPY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Clippy rejected this credential'
    : `Clippy returned HTTP ${response.status}`);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).find(line => line !== '[DONE]')
    : body;
  let result;
  try { result = JSON.parse(payload); }
  catch { throw new Error('Clippy returned an unreadable response'); }
  if (result?.error || !Array.isArray(result?.result?.tools)) throw new Error('Clippy did not provide a tool catalog');
  return { connected: true, toolCount: result.result.tools.length };
}

module.exports = { CLIPPY_URL, READ_TOOLS, DENIED_TOOLS, secretPath, loadClippyToken, normalizeClippyToken, saveClippyToken, removeClippyToken, probeClippyConnection };
