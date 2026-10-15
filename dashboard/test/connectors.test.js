const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createConnectorStore, connectorCatalog, connectorRuntimeServers, connectorToolNames } = require('../lib/connectors');
const { saveClippyToken, loadClippyToken, secretPath: clippySecretPath } = require('../lib/secrets/clippy-mcp');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-connector-test-'));
  const env = { GLADOS_RUNTIME_DIR: root, GLADOS_CLIPPY_MCP: '0' };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env, store: createConnectorStore({ env }) };
}

test('connector collection survives reload and exposes credential names without values', t => {
  const { root, env, store } = fixture(t);
  const row = store.save({ id: 'inventory', name: 'Inventory', type: 'http', url: 'https://inventory.example/mcp?token=url-private', headers: { Authorization: 'Bearer header-private' }, env: { PRIVATE_KEY: 'env-private' }, tools: ['read', 'search'], enabled: true });
  assert.equal(row.available, true);
  assert.equal(JSON.stringify(row).includes('url-private'), false);
  assert.equal(JSON.stringify(row).includes('header-private'), false);
  assert.equal(JSON.stringify(row).includes('env-private'), false);
  assert.deepEqual(row.configuredHeaders, ['Authorization']);
  assert.deepEqual(row.configuredEnv, ['PRIVATE_KEY']);
  assert.equal(fs.readFileSync(path.join(root, 'connectors/collection.json'), 'utf8').includes('url-private'), false);
  const reloaded = createConnectorStore({ env });
  assert.equal(reloaded.get('inventory').revision, row.revision);
  const servers = connectorRuntimeServers(env);
  assert.equal(servers['user-inventory'].headers.Authorization, 'Bearer header-private');
  assert.match(servers['user-inventory'].url, /url-private/);
  assert.deepEqual(connectorToolNames(env)['user-inventory'], ['read', 'search']);
  const savedAgain = store.save({ ...row, name: 'Renamed inventory' }, { expectedRevision: row.revision });
  assert.equal(savedAgain.name, 'Renamed inventory');
  assert.match(store.runtimeConfig('inventory').url, /url-private/);
  assert.throws(() => store.save({ ...savedAgain, url: savedAgain.url.replace('/mcp', '/changed') }, { expectedRevision: savedAgain.revision }), /Re-enter private URL/);
  for (const file of ['connectors/collection.json', 'secrets/connectors/inventory.json']) {
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, file)).mode & 0o077, 0);
  }
});

test('MCP config import previews requirements and processes without enabling or overwriting connectors', t => {
  const { root, store, env } = fixture(t);
  const config = { mcpServers: {
    team: { command: 'node', args: ['/operator/team-mcp.js'], env: { TOKEN: 'hidden' }, tools: ['inspect'], enabled: true },
    docs: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer hidden' }, tools: ['read'] },
  } };
  const preview = store.previewImport({ config });
  assert.equal(preview.connectors.length, 2);
  assert.equal(preview.requiresActivation, true);
  assert.deepEqual(preview.executableProcesses.map(row => row.command), ['node']);
  assert.equal(JSON.stringify(preview).includes('hidden'), false);
  assert.equal(fs.existsSync(path.join(root, 'connectors')), false);
  const imported = store.importConfig({ config });
  assert.equal(imported.every(row => row.enabled === false), true);
  assert.deepEqual(connectorRuntimeServers(env), {});
  const before = fs.readFileSync(path.join(root, 'connectors/collection.json'), 'utf8');
  assert.throws(() => store.importConfig({ config }), /already exist/);
  assert.equal(fs.readFileSync(path.join(root, 'connectors/collection.json'), 'utf8'), before);
  assert.throws(() => store.importConfig({ mcpServers: { one: { id: 'duplicate', command: 'node' }, two: { id: 'duplicate', command: 'node' } } }), /duplicate connector/);
  assert.equal(fs.readFileSync(path.join(root, 'connectors/collection.json'), 'utf8'), before);
});

test('environment references are resolved at use time and missing values prevent mounting', t => {
  const { env, store } = fixture(t);
  store.save({ id: 'catalog', type: 'http', url: 'https://catalog.example/mcp?key=${CATALOG_KEY}', headers: { Authorization: 'Bearer ${CATALOG_KEY}' }, tools: ['lookup'], enabled: true });
  assert.deepEqual(store.get('catalog').missingEnv, ['CATALOG_KEY']);
  assert.deepEqual(connectorRuntimeServers(env), {});
  env.CATALOG_KEY = 'value/with&symbols';
  assert.equal(store.get('catalog').available, true);
  assert.equal(store.runtimeConfig('catalog').headers.Authorization, 'Bearer value/with&symbols');
  assert.match(store.runtimeConfig('catalog').url, /value%2Fwith%26symbols/);
  assert.deepEqual(connectorRuntimeServers({ ...env, GLADOS_SECURITY_REVIEW: '1' }), {});
});

test('connector edits reject stale revisions, and removal preserves a recoverable disabled record', t => {
  const { store } = fixture(t);
  const first = store.save({ id: 'notes', type: 'http', url: 'https://notes.example/mcp', tools: ['read'] });
  const second = store.save({ id: first.id, name: 'Updated notes' }, { expectedRevision: first.revision });
  assert.throws(() => store.save({ id: first.id, name: 'Unversioned write' }), /changed/);
  assert.throws(() => store.remove(first.id), /changed/);
  assert.throws(() => store.save({ id: first.id, name: 'Stale write' }, { expectedRevision: first.revision }), /changed/);
  const removed = store.remove(first.id, { expectedRevision: second.revision });
  assert.equal(removed.archived, true);
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ includeArchived: true })[0].enabled, false);
  assert.throws(() => store.save({ id: first.id, name: 'Replacement' }), /archived/);
});

test('connection check only discovers tools, closes transport, and does not widen an enabled allowlist', async t => {
  const { store } = fixture(t);
  store.save({ id: 'searcher', command: 'node', args: ['/operator/searcher.js'] });
  let closed = 0;
  let pages = 0;
  const clientFactory = () => ({
    client: {
      connect: async () => {},
      listTools: async () => ++pages === 1 ? { tools: [{ name: 'search' }], nextCursor: 'page2' } : { tools: [{ name: 'read' }] },
      close: async () => { closed++; },
    },
    transport: { close: async () => { closed++; } },
  });
  const checked = await store.test('searcher', { clientFactory });
  assert.equal(checked.connected, true);
  assert.equal(checked.toolCount, 2);
  assert.equal(checked.connector.enabled, false);
  assert.deepEqual(checked.connector.tools, ['read', 'search']);
  assert.equal(closed, 2);
  const active = store.save({ id: 'searcher', enabled: true, tools: ['read'] }, { expectedRevision: checked.connector.revision });
  pages = 0;
  const rechecked = await store.test('searcher', { clientFactory });
  assert.deepEqual(rechecked.connector.tools, ['read']);
  assert.deepEqual(rechecked.connector.knownTools, ['read', 'search']);
  assert.notEqual(rechecked.connector.revision, active.revision);
});

test('connection errors do not disclose upstream credentials and still clean up', async t => {
  const { store } = fixture(t);
  store.save({ id: 'broken', url: 'https://broken.example/mcp', headers: { Authorization: 'Bearer super-secret' } });
  let closed = false;
  await assert.rejects(store.test('broken', { clientFactory: () => ({ client: { connect: async () => { throw new Error('Remote rejected Bearer super-secret'); }, close: async () => { closed = true; } }, transport: { close: async () => {} } }) }), error => !error.message.includes('super-secret') && /tool catalog/.test(error.message));
  assert.equal(closed, true);
});

test('connector collection rejects traversal, built-in collisions, wildcards, and storage symlinks', t => {
  const { root, store } = fixture(t);
  for (const id of ['../escape', 'clippy', 'browser-glados', '__proto__']) assert.throws(() => store.save({ id, url: 'https://example.test/mcp' }));
  assert.throws(() => store.save({ id: 'bad', url: 'https://user:password@example.test/mcp' }), /embedded login/);
  assert.throws(() => store.save({ id: 'bad', command: 'node --execute', tools: [] }), /executable/);
  assert.throws(() => store.save({ id: 'bad', command: 'node', tools: ['*'] }), /tool name/);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'connectors'));
  assert.throws(() => store.save({ id: 'safe', command: 'node' }), /symlinks/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('built-in connectors and optional integrations have distinct ownership metadata', t => {
  const { env, store } = fixture(t);
  store.save({ id: 'custom', url: 'https://example.test/mcp', tools: ['read'] });
  const catalog = connectorCatalog(env).connectors;
  assert.equal(catalog.find(row => row.id === 'clippy').source, 'integration');
  assert.equal(catalog.find(row => row.id === 'clippy').builtIn, false);
  assert.equal(catalog.find(row => row.id === 'clippy').disconnectable, true);
  assert.equal(catalog.find(row => row.id === 'clippy').available, false);
  assert.equal(catalog.find(row => row.id === 'blackboard').builtIn, true);
  assert.equal(catalog.find(row => row.id === 'blackboard').disconnectable, false);
  assert.equal(catalog.find(row => row.id === 'custom').source, 'custom');
  assert.equal(catalog.find(row => row.id === 'custom').builtIn, false);
  assert.equal(catalog.find(row => row.id === 'custom').disconnectable, true);
  assert.equal(catalog.find(row => row.id === 'custom').status, 'disabled');
});

test('disconnect disables custom runtime mounts, clears secrets, and protects revisions', t => {
  const { env, root, store } = fixture(t);
  const row = store.save({ id: 'inventory', url: 'https://inventory.example/mcp?token=query-secret', headers: { Authorization: 'Bearer header-secret' }, env: { INVENTORY_KEY: 'env-secret' }, tools: ['read'], enabled: true });
  assert.ok(connectorRuntimeServers(env)['user-inventory']);
  assert.throws(() => store.disconnect(row.id), /changed/);
  assert.throws(() => store.disconnect(row.id, { expectedRevision: 'stale' }), /changed/);
  assert.ok(fs.existsSync(path.join(root, 'secrets/connectors/inventory.json')));
  const disconnected = store.disconnect(row.id, { expectedRevision: row.revision });
  assert.equal(disconnected.enabled, false);
  assert.equal(disconnected.available, false);
  assert.equal(disconnected.hasCredentials, false);
  assert.equal(disconnected.status, 'not connected');
  assert.deepEqual(disconnected.configuredHeaders, []);
  assert.deepEqual(disconnected.configuredEnv, []);
  assert.notEqual(disconnected.revision, row.revision);
  assert.equal(fs.existsSync(path.join(root, 'secrets/connectors/inventory.json')), false);
  assert.equal(store.runtimeConfig(row.id), null);
  assert.deepEqual(connectorRuntimeServers(env), {});
  assert.equal(createConnectorStore({ env }).get(row.id).disconnected, true);
  assert.equal(/query-secret|header-secret|env-secret/.test(JSON.stringify(connectorCatalog(env))), false);
  assert.throws(() => store.save({ id: row.id, enabled: true }, { expectedRevision: disconnected.revision }), /Re-enter private URL/);
  const reconnected = store.save({ id: row.id, enabled: true, url: 'https://inventory.example/mcp?token=new-secret', headers: { Authorization: 'Bearer replacement-secret' } }, { expectedRevision: disconnected.revision });
  assert.equal(reconnected.available, true);
  assert.equal(store.runtimeConfig(row.id).headers.Authorization, 'Bearer replacement-secret');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'secrets/connectors/inventory.json')).mode & 0o077, 0);
});

test('disconnect clears imported process secrets and requires hidden arguments to be re-entered', async t => {
  const { root, store } = fixture(t);
  const [row] = store.importConfig({ mcpServers: { process: { command: 'node', args: ['/server.js', '--token', 'process-secret'], env: { PRIVATE_TOKEN: 'env-secret' }, tools: ['read'] } } });
  const disconnected = store.disconnect(row.id, { expectedRevision: row.revision });
  assert.equal(disconnected.source, 'imported');
  assert.equal(disconnected.hasCredentials, false);
  assert.equal(fs.existsSync(path.join(root, 'secrets/connectors/process.json')), false);
  assert.throws(() => store.save({ id: row.id, enabled: true }, { expectedRevision: disconnected.revision }), /Re-enter hidden argument/);
  await assert.rejects(store.test(row.id), /Reconnect this connector/);
  const connected = store.save({ id: row.id, enabled: true, args: ['/server.js', '--token', 'replacement-secret'] }, { expectedRevision: disconnected.revision });
  assert.equal(connected.available, true);
  assert.deepEqual(store.runtimeConfig(row.id).args, ['/server.js', '--token', 'replacement-secret']);
});

test('Clippy disconnect deletes its saved key even when disabled and cannot disconnect built-ins', t => {
  const { env, store } = fixture(t);
  saveClippyToken('clippy-test-secret', env);
  const disabled = connectorCatalog(env).connectors.find(row => row.id === 'clippy');
  assert.equal(disabled.configured, true);
  assert.equal(disabled.available, false);
  assert.equal(disabled.status, 'disabled by runtime');
  assert.equal(JSON.stringify(disabled).includes('clippy-test-secret'), false);
  env.GLADOS_CLIPPY_MCP = '1';
  assert.equal(connectorCatalog(env).connectors.find(row => row.id === 'clippy').available, true);
  env.GLADOS_CLIPPY_MCP = '0';
  const disconnected = store.disconnect('clippy');
  assert.equal(disconnected.configured, false);
  assert.equal(disconnected.available, false);
  assert.equal(fs.existsSync(clippySecretPath(env)), false);
  assert.equal(loadClippyToken({ ...env, GLADOS_CLIPPY_MCP: '1' }), null);
  for (const id of ['blackboard', 'watchdog', 'glados-ops', 'browser', 'browser-glados']) {
    assert.throws(() => store.disconnect(id), /Built-in connectors cannot be disconnected/);
  }
});

test('literal MCP argument credentials stay private through preview, save, edit, and runtime use', t => {
  const { store, root } = fixture(t);
  const args = ['/operator/server.js', '--token', 'argument-private', '--api-key=inline-private', 'https://mcp.example/?key=url-private'];
  const payload = { mcpServers: { remote: { command: 'node', args, tools: ['read'] } } };
  const preview = store.previewImport(payload);
  for (const secret of ['argument-private', 'inline-private', 'url-private']) assert.equal(JSON.stringify(preview).includes(secret), false);
  const saved = store.importConfig(payload)[0];
  for (const secret of ['argument-private', 'inline-private', 'url-private']) assert.equal(JSON.stringify(store.get('remote')).includes(secret), false);
  const metadata = fs.readFileSync(path.join(root, 'connectors/collection.json'), 'utf8');
  assert.equal(metadata.includes('argument-private'), false);
  const edited = store.save({ ...saved, enabled: true, name: 'Renamed remote' }, { expectedRevision: saved.revision });
  assert.equal(edited.name, 'Renamed remote');
  assert.deepEqual(store.runtimeConfig('remote').args, args);
  assert.throws(() => store.save({ ...edited, args: [...edited.args].reverse() }, { expectedRevision: edited.revision }), /Re-enter any hidden argument/);
});

test('HTTP connector check completes the real MCP handshake and lists tools without calling them', async t => {
  const { store } = fixture(t);
  const requests = [];
  const mcp = new Server({ name: 'local-connector-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'inspect_text', description: 'Inspect supplied text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'local-test-session', enableJsonResponse: true });
  await mcp.connect(transport);
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: body?.method, authorization: req.headers.authorization });
      await transport.handleRequest(req, res, body);
    } catch { if (!res.writableEnded) { res.statusCode = 500; res.end(); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await mcp.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  store.save({ id: 'local-inspector', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer synthetic-test-token' } });
  const result = await store.test('local-inspector');
  assert.equal(result.connected, true);
  assert.deepEqual(result.connector.tools, ['inspect_text']);
  assert.equal(result.connector.enabled, false);
  assert.ok(requests.some(request => request.method === 'initialize'));
  assert.ok(requests.some(request => request.method === 'tools/list'));
  assert.equal(requests.some(request => request.method === 'tools/call'), false);
  assert.equal(requests.every(request => request.authorization === 'Bearer synthetic-test-token'), true);
  assert.equal(JSON.stringify(result).includes('synthetic-test-token'), false);
});
