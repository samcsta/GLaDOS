const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CLIPPY_URL, READ_TOOLS, loadClippyToken, removeClippyToken } = require('./secrets/clippy-mcp');

const RESERVED = new Set(['blackboard', 'watchdog', 'glados-ops', 'browser', 'clippy']);
const MAX_CONNECTORS = 100;
const MAX_TOOLS = 2000;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,160}$/;
const PROTECTED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PRIVATE_VALUE = '••••';

function publicUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, PRIVATE_VALUE);
  return url.href;
}

function redactedArgs(args = []) {
  let privateNext = false;
  return args.map(argument => {
    if (privateNext) { privateNext = false; return PRIVATE_VALUE; }
    const sensitiveFlag = /^(?:--?(?:[a-z0-9_-]*(?:token|secret|password|credential|authorization)|auth|bearer|pass|key|api[-_]?key|private[-_]?key)|-p)(?:=|$)/i;
    if (sensitiveFlag.test(argument)) {
      const equals = argument.indexOf('=');
      if (equals >= 0) return `${argument.slice(0, equals + 1)}${PRIVATE_VALUE}`;
      privateNext = true;
      return argument;
    }
    if (/^(?:authorization|bearer|api[-_]?key|[a-z0-9_-]*token|password|[a-z0-9_-]*secret)[:=]/i.test(argument)) return argument.replace(/([:=]).*$/, `$1${PRIVATE_VALUE}`);
    return argument.replace(/https?:\/\/[^\s]+/g, candidate => {
      try { return publicUrl(candidate); } catch { return PRIVATE_VALUE; }
    });
  });
}

function restoredArgs(input, prior = []) {
  if (!Array.isArray(input)) return input;
  const redacted = redactedArgs(prior);
  return input.map((argument, index) => {
    if (typeof argument !== 'string' || !argument.includes(PRIVATE_VALUE) && !argument.includes(encodeURIComponent(PRIVATE_VALUE))) return argument;
    if (argument !== redacted[index] || prior[index] === undefined) fail('Re-enter any hidden argument values after changing their position');
    return prior[index];
  });
}

function fail(message, code = 'invalid_connector') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function bounded(value, label, max = 4096, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} is invalid`);
  const result = value.trim();
  if (required && !result) fail(`${label} is required`);
  return result;
}

function stringMap(value, label, keyPattern) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) fail(`${label} must be an object`);
  const result = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    if (PROTECTED_KEYS.has(key) || !keyPattern.test(key)) fail(`${label} contains an invalid name`);
    result[key] = bounded(raw, `${label} value`, 16_384);
  }
  return result;
}

function toolNames(value) {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) fail('Tools must be a list of MCP tool names');
  return [...new Set(value.map(name => {
    if (typeof name !== 'string' || !TOOL.test(name) || PROTECTED_KEYS.has(name)) fail('An MCP tool name is invalid');
    return name;
  }))].sort();
}

function normalizeConnector(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Connector configuration is required');
  for (const key of Object.keys(input)) if (PROTECTED_KEYS.has(key)) fail('Connector configuration contains an invalid key');
  const id = bounded(input.id || existing?.id, 'Connector ID', 64, true);
  if (!ID.test(id) || RESERVED.has(id) || id.startsWith('browser-')) fail('Choose a unique connector ID using lowercase letters, digits, and hyphens');
  if (existing && id !== existing.id) fail('A connector ID cannot be changed');
  const type = input.type || existing?.type || (input.url ? 'http' : 'stdio');
  if (!['http', 'sse', 'stdio'].includes(type)) fail('Choose HTTP, SSE, or a local MCP process');
  const result = {
    id,
    name: bounded(input.name ?? existing?.name ?? id, 'Name', 200, true),
    description: bounded(input.description ?? existing?.description, 'Description', 2000),
    type,
    serverName: `user-${id}`,
    tools: input.tools === undefined ? existing?.tools || [] : toolNames(input.tools),
    knownTools: existing?.knownTools || [],
    enabled: input.enabled === undefined ? existing?.enabled === true : input.enabled === true,
    source: existing?.source || 'custom',
  };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Enabled must be true or false');
  if (type === 'stdio') {
    result.command = bounded(input.command ?? existing?.command, 'Command', 2048, true);
    if (!path.isAbsolute(result.command) && !/^[A-Za-z0-9_.-]+$/.test(result.command)) fail('Use an executable name or absolute path; put arguments in the argument list');
    const args = input.args ?? existing?.args ?? [];
    if (!Array.isArray(args) || args.length > 100) fail('Arguments must be a list');
    result.args = args.map(arg => bounded(arg, 'Argument', 16_384));
  } else {
    const url = bounded(input.url ?? existing?.url, 'MCP URL', 4096, true);
    let parsed;
    try { parsed = new URL(url); } catch { fail('Enter a valid MCP URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) fail('Use an HTTP or HTTPS URL without an embedded login or fragment');
    result.url = url;
  }
  return result;
}

function runtimeRoot(env = process.env) {
  return path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
}

function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) fail('Connector storage must be a regular directory', 'unsafe_storage');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function assertStoragePath(boundary, location) {
  const relative = path.relative(boundary, location);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Connector storage is outside the runtime collection', 'unsafe_storage');
  let current = boundary;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('Connector storage cannot contain symlinks', 'unsafe_storage'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readFile(file, fallback) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail('Connector storage is invalid', 'unsafe_storage');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) fail('Connector storage must be owner-only', 'unsafe_storage');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFile(file, value) {
  secureDirectory(path.dirname(file));
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) fail('Connector storage is invalid', 'unsafe_storage');
  const temporary = path.join(path.dirname(file), `.connector-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

function environmentReferences(value) {
  const result = new Set();
  for (const match of JSON.stringify(value).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) result.add(match[1]);
  return [...result].sort();
}

function resolveReferences(value, env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!env[name]) fail(`The ${name} environment value is unavailable`, 'missing_credentials');
    return env[name];
  });
}

function publicConnector(row, credentials = {}, env = process.env) {
  const requiredEnv = environmentReferences({ args: row.args, url: row.url, ...credentials });
  const missingEnv = requiredEnv.filter(name => !env[name]);
  const args = credentials.args || row.args || [];
  const url = credentials.url || row.url;
  return {
    ...row,
    builtIn: false,
    disconnectable: true,
    ...(url ? { url: publicUrl(url) } : {}),
    ...(row.type === 'stdio' ? { args: redactedArgs(args) } : {}),
    requiredEnv,
    missingEnv,
    configuredEnv: Object.keys(credentials.env || {}),
    configuredHeaders: Object.keys(credentials.headers || {}),
    hasCredentials: !row.disconnected && (Object.keys(credentials.env || {}).length > 0 || Object.keys(credentials.headers || {}).length > 0 || JSON.stringify(args) !== JSON.stringify(redactedArgs(args)) || Boolean(url && new URL(url).search)),
    available: row.enabled === true && !row.archived && !row.disconnected && missingEnv.length === 0 && row.tools.length > 0,
    status: row.archived ? 'archived' : row.disconnected ? 'not connected' : !row.enabled ? 'disabled' : missingEnv.length ? 'needs credentials' : !row.tools.length ? 'needs tool selection' : 'ready',
  };
}

function createConnectorStore({ env = process.env } = {}) {
  const boundary = runtimeRoot(env);
  const root = path.join(boundary, 'connectors');
  const indexFile = path.join(root, 'collection.json');
  const credentialsRoot = path.join(runtimeRoot(env), 'secrets', 'connectors');
  function index() {
    assertStoragePath(boundary, indexFile);
    const value = readFile(indexFile, { schemaVersion: 1, connectors: [] });
    if (value.schemaVersion !== 1 || !Array.isArray(value.connectors)) fail('Connector collection is invalid', 'unsafe_storage');
    return value;
  }
  function secret(id) {
    const file = path.join(credentialsRoot, `${id}.json`);
    assertStoragePath(boundary, file);
    return readFile(file, { env: {}, headers: {} });
  }
  function write(file, value) { assertStoragePath(boundary, file); writeFile(file, value); }
  function find(id, includeArchived = false) {
    if (!ID.test(String(id))) fail('Connector not found', 'not_found');
    const row = index().connectors.find(row => row.id === id && (includeArchived || !row.archived));
    if (!row) fail('Connector not found', 'not_found');
    return row;
  }
  function checkRevision(row, expected) {
    if (!expected || expected !== row.revision) fail('This connector changed. Reload it before saving.', 'conflict');
  }
  function save(input, { expectedRevision, createOnly = false, imported = false } = {}) {
    const collection = index();
    const existing = collection.connectors.find(row => row.id === input?.id);
    if (createOnly && existing) fail('This connector ID already exists', 'conflict');
    if (existing?.archived) fail('This connector was archived. Use a new ID.', 'conflict');
    if (existing) checkRevision(existing, expectedRevision);
    if (!existing && collection.connectors.length >= MAX_CONNECTORS) fail('The connector collection is full');
    const previousSecrets = existing ? secret(existing.id) : { env: {}, headers: {} };
    const previousUrl = previousSecrets.url || existing?.url;
    const unmaskedInput = previousUrl && input.url === publicConnector(existing, previousSecrets, env).url
      ? { ...input, url: previousUrl } : { ...input };
    if (unmaskedInput.url && /••••|%E2%80%A2/i.test(unmaskedInput.url)) fail('Re-enter private URL values after changing the endpoint');
    const previousArgs = previousSecrets.args || existing?.args || [];
    if (unmaskedInput.args !== undefined) unmaskedInput.args = restoredArgs(unmaskedInput.args, previousArgs);
    const normalized = normalizeConnector(unmaskedInput, existing ? { ...existing, url: previousUrl, args: previousArgs } : null);
    if (normalized.url && /••••|%E2%80%A2/i.test(normalized.url)) fail('Re-enter private URL values before reconnecting');
    if ((normalized.args || []).some(argument => /••••|%E2%80%A2/i.test(argument))) fail('Re-enter hidden argument values before reconnecting');
    const credentials = {
      env: input.env === undefined ? previousSecrets.env : stringMap(input.env, 'Environment', /^[A-Za-z_][A-Za-z0-9_]*$/),
      headers: input.headers === undefined ? previousSecrets.headers : stringMap(input.headers, 'Headers', /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/),
      ...(normalized.type === 'stdio' ? { args: normalized.args } : {}),
      ...(normalized.url ? { url: normalized.url } : {}),
    };
    const row = {
      ...normalized,
      ...(normalized.type === 'stdio' ? { args: redactedArgs(normalized.args) } : {}),
      ...(normalized.url ? { url: publicUrl(normalized.url) } : {}),
      ...(imported ? { enabled: false, source: 'imported' } : {}),
      revision: randomUUID(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCheckedAt: existing?.lastCheckedAt || null,
    };
    // Credentials never enter catalog responses or portable agent packages.
    write(path.join(credentialsRoot, `${row.id}.json`), credentials);
    collection.connectors = collection.connectors.filter(item => item.id !== row.id).concat(row);
    write(indexFile, collection);
    return publicConnector(row, credentials, env);
  }
  function list({ includeArchived = false } = {}) {
    return index().connectors.filter(row => includeArchived || !row.archived).map(row => publicConnector(row, secret(row.id), env));
  }
  function get(id) { const row = find(id); return publicConnector(row, secret(id), env); }
  function remove(id, { expectedRevision } = {}) {
    const collection = index();
    const row = find(id);
    checkRevision(row, expectedRevision);
    const archived = { ...row, enabled: false, archived: true, revision: randomUUID(), updatedAt: new Date().toISOString() };
    collection.connectors = collection.connectors.map(item => item.id === id ? archived : item);
    write(indexFile, collection);
    return publicConnector(archived, secret(id), env);
  }
  function disconnect(id, { expectedRevision } = {}) {
    if (id === 'clippy') {
      // Deletion must work even when this runtime has disabled Clippy mounting.
      removeClippyToken(env);
      return integrationConnectors(env).find(row => row.id === id);
    }
    if (RESERVED.has(id) || String(id).startsWith('browser-')) fail('Built-in connectors cannot be disconnected', 'builtin_connector');
    const collection = index();
    const row = find(id);
    checkRevision(row, expectedRevision);
    const file = path.join(credentialsRoot, `${id}.json`);
    assertStoragePath(boundary, file);
    try { if (!fs.lstatSync(file).isFile()) fail('Connector credential storage is invalid', 'unsafe_storage'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const disconnected = { ...row, enabled: false, disconnected: true, revision: randomUUID(), updatedAt: new Date().toISOString() };
    collection.connectors = collection.connectors.map(item => item.id === id ? disconnected : item);
    // Disable first so a failed credential deletion can never leave it mounted.
    write(indexFile, collection);
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return publicConnector(disconnected, {}, env);
  }
  function runtimeConfig(id, { allowDisabled = false } = {}) {
    const row = find(id);
    if (!allowDisabled && (!row.enabled || row.disconnected)) return null;
    if (row.disconnected) fail('Reconnect this connector before checking it', 'missing_credentials');
    const credentials = secret(id);
    const args = credentials.args || row.args || [];
    const url = credentials.url || row.url;
    const missing = environmentReferences({ args, url, ...credentials }).filter(name => !env[name]);
    if (missing.length) fail(`Required environment values are unavailable: ${missing.join(', ')}`, 'missing_credentials');
    const values = map => Object.fromEntries(Object.entries(map || {}).map(([key, value]) => [key, resolveReferences(value, env)]));
    return row.type === 'stdio'
      ? { type: 'stdio', command: row.command, args: args.map(value => resolveReferences(value, env)), env: values(credentials.env) }
      : { type: row.type, url: url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => encodeURIComponent(env[name])), headers: values(credentials.headers) };
  }
  function previewImport(payload) {
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { fail('Upload a valid MCP JSON configuration'); } }
    const config = payload?.config || payload;
    const values = config?.mcpServers || (config?.connector ? { [config.connector.id]: config.connector } : config?.id ? { [config.id]: config } : null);
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length || Object.keys(values).length > MAX_CONNECTORS) fail('The file must contain a connector or an mcpServers object');
    const existing = new Set(index().connectors.map(row => row.id));
    const importedIds = new Set();
    const connectors = Object.entries(values).map(([name, value]) => {
      const row = normalizeConnector({ ...value, id: value.id || name, name: value.name || name, enabled: false });
      if (importedIds.has(row.id)) fail('The imported configuration contains duplicate connector IDs');
      importedIds.add(row.id);
      const credentials = { env: stringMap(value.env, 'Environment', /^[A-Za-z_][A-Za-z0-9_]*$/), headers: stringMap(value.headers, 'Headers', /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/), ...(row.type === 'stdio' ? { args: row.args } : {}) };
      return { ...publicConnector({ ...row, source: 'imported' }, credentials, env), conflict: existing.has(row.id) };
    });
    return { connectors, conflicts: connectors.filter(row => row.conflict).map(row => row.id), executableProcesses: connectors.filter(row => row.type === 'stdio').map(row => ({ id: row.id, command: row.command, args: row.args })), requiresActivation: true };
  }
  function importConfig(payload) {
    const preview = previewImport(payload);
    if (preview.conflicts.length) fail(`Connector IDs already exist: ${preview.conflicts.join(', ')}. Edit the existing connector or choose new IDs.`, 'conflict');
    if (index().connectors.length + preview.connectors.length > MAX_CONNECTORS) fail('The connector collection is full');
    if (typeof payload === 'string') payload = JSON.parse(payload);
    const config = payload?.config || payload;
    const values = config.mcpServers || (config.connector ? { [config.connector.id]: config.connector } : { [config.id]: config });
    return Object.entries(values).map(([name, value]) => save({ ...value, id: value.id || name, name: value.name || name, enabled: false }, { createOnly: true, imported: true }));
  }
  async function test(id, { clientFactory = null, timeoutMs = 12_000 } = {}) {
    const row = find(id);
    const config = runtimeConfig(id, { allowDisabled: true });
    let client;
    let transport;
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    if (clientFactory) ({ client, transport } = clientFactory(config));
    else {
      client = new Client({ name: 'glados-connector-check', version: '1.0.0' }, { capabilities: {} });
      if (config.type === 'stdio') {
        const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
        const cwd = path.join(root, 'processes', id);
        assertStoragePath(boundary, cwd);
        secureDirectory(cwd);
        transport = new StdioClientTransport({ ...config, cwd, env: { ...getDefaultEnvironment(), ...config.env }, stderr: 'ignore' });
      } else if (config.type === 'sse') {
        const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' } });
      } else {
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' } });
      }
    }
    let timer;
    try {
      const probe = (async () => {
        await client.connect(transport, { timeout: timeoutMs });
        const tools = [];
        let cursor;
        for (let page = 0; page < 20; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
          tools.push(...(result.tools || []).map(tool => tool.name));
          if (tools.length > MAX_TOOLS) fail('This connector advertises too many tools');
          cursor = result.nextCursor;
          if (!cursor) return toolNames(tools);
        }
        fail('This connector tool catalog did not finish');
      })();
      const tools = await Promise.race([probe, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connector check timed out')), timeoutMs); })]);
      const collection = index();
      const current = find(id);
      checkRevision(current, row.revision);
      const updated = { ...current, knownTools: tools, tools: !current.enabled && !current.tools.length ? tools : current.tools, lastCheckedAt: new Date().toISOString(), revision: randomUUID() };
      collection.connectors = collection.connectors.map(item => item.id === id ? updated : item);
      write(indexFile, collection);
      return { connected: true, toolCount: tools.length, connector: publicConnector(updated, secret(id), env) };
    } catch (error) {
      // MCP process output and upstream errors may contain credentials.
      if (['conflict', 'invalid_connector'].includes(error.code)) throw error;
      fail(error.message === 'Connector check timed out' ? error.message : 'The connector could not provide a tool catalog. Check its command, endpoint, and credentials.', 'connection_failed');
    } finally {
      clearTimeout(timer);
      try { await client.close(); } catch {}
      try { await transport?.close(); } catch {}
    }
  }
  return { list, get, save, remove, disconnect, runtimeConfig, previewImport, importConfig, test };
}

function builtinConnectors(env = process.env) {
  const browser = env.GLADOS_SECURITY_REVIEW !== '1' && (env.GLADOS_BROWSER_MCP === '1' || Boolean(env.GLADOS_BROWSER_MCP_COMMAND || env.GLADOS_BROWSER_MCP_ARGS || env.GLADOS_BROWSER_MCP_ARGS_JSON));
  return [
    { id: 'blackboard', name: 'Blackboard', description: 'Shared tasks, findings, and assessment state.', type: 'stdio', enabled: true, available: true },
    { id: 'watchdog', name: 'Watchdog', description: 'Scope, health, and dispatch checks.', type: 'stdio', enabled: true, available: true },
    { id: 'glados-ops', name: 'GLaDOS tools', description: 'Operational tools, evidence, and desktop controls.', type: 'stdio', enabled: env.GLADOS_SECURITY_REVIEW !== '1', available: env.GLADOS_SECURITY_REVIEW !== '1' },
    { id: 'browser', name: 'Browser', description: 'Agent browser tools when enabled for the current runtime.', type: 'stdio', enabled: Boolean(browser), available: Boolean(browser) },
  ].map(row => ({ source: 'builtin', builtIn: true, disconnectable: false, serverName: row.id, tools: [], requiredEnv: [], status: row.available ? 'ready' : 'not connected', ...row }));
}

function integrationConnectors(env = process.env) {
  let configured = false;
  let available = false;
  try {
    configured = Boolean(loadClippyToken({ ...env, GLADOS_CLIPPY_MCP: '1', GLADOS_SECURITY_REVIEW: '0' }));
    available = Boolean(loadClippyToken(env));
  } catch {}
  return [{
    id: 'clippy', name: 'Clippy MCP', description: 'Security findings, engagement repositories, and assessment intelligence.',
    source: 'integration', builtIn: false, disconnectable: true, serverName: 'clippy', type: 'http', url: CLIPPY_URL,
    configured, hasCredentials: configured, enabled: available, available, tools: [...READ_TOOLS].sort(), requiredEnv: [],
    status: available ? 'ready' : configured ? 'disabled by runtime' : 'not connected',
  }];
}

function connectorCatalog(env = process.env) { return { connectors: [...builtinConnectors(env), ...integrationConnectors(env), ...createConnectorStore({ env }).list()] }; }
function connectorRuntimeServers(env = process.env) {
  if (env.GLADOS_SECURITY_REVIEW === '1') return {};
  const store = createConnectorStore({ env });
  return Object.fromEntries(store.list().filter(row => row.available).map(row => [row.serverName, store.runtimeConfig(row.id)]));
}
function connectorToolNames(env = process.env) { return Object.fromEntries(createConnectorStore({ env }).list().map(row => [row.serverName, row.tools])); }

module.exports = { createConnectorStore, connectorCatalog, connectorRuntimeServers, connectorToolNames, normalizeConnector };
