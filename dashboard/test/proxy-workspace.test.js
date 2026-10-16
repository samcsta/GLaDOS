const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const workspace = require('../public/proxy-workspace');

test.beforeEach(() => workspace.clear());

test('session activation remains monotonic after reloads and a backwards clock', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function nextSessionActivationGeneration()'), app.indexOf('async function activateInvestigationSession('));
  const stored = new Map([['glados-dash.activation-generation', '500']]);
  const context = vm.createContext({ state: { sessionActivationGeneration: 0 }, Date: { now: () => 100 },
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } });
  vm.runInContext(source, context);
  assert.equal(context.nextSessionActivationGeneration(), 501);
  context.state.sessionActivationGeneration = 0;
  assert.equal(context.nextSessionActivationGeneration(), 502);
  assert.equal(stored.get('glados-dash.activation-generation'), '502');
});

test('WebSocket previews are bounded while capture truncation stays distinct', () => {
  const row = { type: 'websocket', body: 'a'.repeat(100000), bodyTruncated: false };
  const preview = workspace.previewRow(row);
  assert.equal(preview.body.length, 2048);
  assert.equal(preview.previewTruncated, true);
  assert.equal(preview.bodyTruncated, false);
  assert.equal(row.body.length, 100000);
  assert.match(workspace.hex('AQID', true), /01 02 03/);
  assert.equal(workspace.interceptEnabled({interceptWebsocketServer:true}), true);
  assert.equal(workspace.interceptSettings({interceptWebsocketClient:true}).interceptWebsocketClient, true);
});

test('proxy URLs pin the explicit session and preserve bounded paging parameters', () => {
  assert.throws(() => workspace.apiUrl('history'), /session/i);
  const url = new URL(workspace.apiUrl('history', 'session one/+?', {
    before: 42, since: 0, limit: 500, unused: undefined, empty: '', none: null,
  }), 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/proxy/history');
  assert.equal(url.searchParams.get('session_id'), 'session one/+?');
  assert.equal(url.searchParams.get('before'), '42');
  assert.equal(url.searchParams.get('since'), '0');
  assert.equal(url.searchParams.get('limit'), '500');
  assert.equal(url.searchParams.has('unused'), false);
  assert.equal(url.searchParams.has('empty'), false);
  assert.equal(url.searchParams.has('none'), false);
  const pinned = new URL(workspace.apiUrl('history', 'one', { session_id: 'two' }), 'http://127.0.0.1');
  assert.equal(pinned.searchParams.get('session_id'), 'one', 'optional query parameters cannot change ownership');
});

test('history merging excludes foreign and unassigned records from both retained and incoming rows', () => {
  const current = [
    { id: 1, sessionId: 'one', ts: 100, url: '/old' },
    { id: 2, sessionId: 'two', ts: 200, url: '/foreign' },
    { id: 3, ts: 300, url: '/unassigned' },
  ];
  const incoming = [
    { id: 1, sessionId: 'one', ts: 100, url: '/updated' },
    { id: 1, sessionId: 'two', ts: 100, url: '/spoofed-replacement' },
    { id: 4, sessionId: 'one', ts: 400, url: '/latest' },
    { id: 5, ts: 500, url: '/unassigned-new' },
  ];
  const rows = workspace.mergeRows(current, incoming, 'one');
  assert.deepEqual(rows.map(row => [row.id, row.url]), [[1, '/updated'], [4, '/latest']]);
  assert.equal(current[0].url, '/old', 'merging does not mutate captured source rows');
  assert.deepEqual(workspace.mergeRows(rows, [{ id: 0, sessionId: 'one', ts: 50 }], 'one').map(row => row.id), [0, 1, 4]);
});

test('each session retains independent filters, selections, annotations, details and proxy view', () => {
  const one = workspace.sessionState('one');
  const two = workspace.sessionState('two');
  assert.equal(workspace.sessionState('one'), one);
  assert.notEqual(one, two);
  one.tab = 'http'; one.filter = 'one.example';
  one.selectedIds.add('flow-one');
  one.details.set('flow-one', { requestBody: 'one only' });
  one.annotations['flow-one'] = { notes: 'one note' };
  one.rows.push({ id: 1, sessionId: 'one' });
  assert.equal(two.tab, 'intercept');
  assert.equal(two.filter, '');
  assert.equal(two.selectedIds.size, 0);
  assert.equal(two.details.size, 0);
  assert.deepEqual(two.annotations, {});
  assert.deepEqual(two.rows, []);
  workspace.focus('two', { host: 'two.example', agentId: 'net-recon', ts: 200 });
  assert.equal(two.tab, 'http');
  assert.equal(two.filter, 'two.example');
  assert.equal(one.filter, 'one.example');
  workspace.clear();
  assert.notEqual(workspace.sessionState('one'), one);
  assert.throws(() => workspace.sessionState(''), /session/i);
});

test('history filters combine host search, method, response class and static-resource exclusion', () => {
  const state = workspace.sessionState('one');
  const row = { url: 'https://app.example:8443/api/users?active=1', method: 'POST', status: 201,
    host: 'app.example', mime: 'application/json', agentTag: 'api-expert' };
  assert.equal(workspace.matches(row, state), true);
  state.filter = 'API-EXPERT'; assert.equal(workspace.matches(row, state), true);
  state.filter = 'other.example'; assert.equal(workspace.matches(row, state), false);
  state.filter = 'app.example'; state.method = 'GET'; assert.equal(workspace.matches(row, state), false);
  state.method = 'POST'; state.status = '4'; assert.equal(workspace.matches(row, state), false);
  state.status = '2'; assert.equal(workspace.matches(row, state), true);
  state.hideStatic = true;
  assert.equal(workspace.matches({ ...row, url: 'https://app.example/bundle.js?v=2' }, state), false);
  assert.equal(workspace.matches({ ...row, url: 'https://app.example/api/users' }, state), true);
});

test('URL presentation keeps exact host, port, query, TLS and extension attributes', () => {
  assert.deepEqual(workspace.urlParts('https://app.example:8443/assets/config.JSON?x=1#fragment'), {
    host: 'app.example:8443', path: '/assets/config.JSON?x=1', tls: true, params: true, extension: 'JSON',
  });
  assert.equal(workspace.urlParts('wss://app.example/events').tls, true);
  assert.equal(workspace.urlParts('http://app.example/').tls, false);
  assert.deepEqual(workspace.urlParts('unparseable target'), { host: '', path: 'unparseable target', tls: false, params: false, extension: '' });
});

test('HTTP message transforms preserve capture data and visibly mark truncated bodies', () => {
  const row = { method: 'POST', url: 'https://app.example/api?q=1', status: 201 };
  const detail = { requestHeaders: { Host: 'app.example', Authorization: '[REDACTED]' },
    requestBody: '{"name":"test"}', responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}', responseBodyTruncated: true, statusLine: 'HTTP/2 201 Created' };
  const raw = workspace.rawMessage(detail, row);
  assert.equal(raw, 'POST /api?q=1 HTTP/1.1\r\nHost: app.example\r\nAuthorization: [REDACTED]\r\n\r\n{"name":"test"}');
  assert.match(workspace.pretty(raw), /\n\n\{\n  "name": "test"\n\}/);
  assert.match(workspace.rawMessage(detail, row, true), /^HTTP\/2 201 Created\r\n/);
  assert.match(workspace.rawMessage(detail, row, true), /\[Captured body truncated\]$/);
  assert.equal(workspace.rawMessage(null, row), '');
  assert.equal(workspace.pretty('unstructured text'), 'unstructured text');
  assert.equal(workspace.pretty('HTTP/1.1 200 OK\r\n\r\nplain body'), 'HTTP/1.1 200 OK\r\n\r\nplain body');
  assert.equal(detail.responseBody, '{"ok":true}', 'display transforms leave stored evidence unchanged');
});

test('hex display uses UTF-8 bytes and byte offsets for non-ASCII and control characters', () => {
  assert.equal(workspace.hex(''), '');
  const hex = workspace.hex('A\u0000é');
  assert.match(hex, /^00000000  41 00 c3 a9/);
  assert.match(hex, /A\.\.\.$/);
  const lines = workspace.hex('0123456789abcdefZ').split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^00000010  5a/);
});

test('opening proxy tabs pins distinct investigation IDs and reuses only the matching session tab', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = app.indexOf('async function openProxy(');
  const end = app.indexOf('function openUpdatePane(', start);
  assert.ok(start >= 0 && end > start, 'proxy tab glue must exist');
  const selected = [];
  const state = { currentSessionId: 'one', investigationSessions: [{ id: 'one', name: 'First' }, { id: 'two', name: 'Second' }], openTabs: [] };
  let drafts = 0;
  const context = vm.createContext({ state, setCurrentTab: id => selected.push(id),
    materializeDraftSession: async () => { drafts++; return 'draft-created'; },
    showToast: message => { throw new Error(message); } });
  vm.runInContext(app.slice(start, end), context);
  await context.openProxy();
  state.currentSessionId = 'two';
  await context.openProxy();
  await context.openProxy({ sessionId: 'one' });
  assert.deepEqual(state.openTabs.map(tab => [tab.id, tab.sessionId, tab.sessionName]), [
    ['proxy:one', 'one', 'First'], ['proxy:two', 'two', 'Second'],
  ]);
  assert.deepEqual(selected, ['proxy:one', 'proxy:two', 'proxy:one']);
  assert.equal(state.currentSessionId, 'two', 'opening a pinned proxy does not silently activate another session');
  assert.equal(drafts, 0);
  state.currentSessionId = null;
  await context.openProxy();
  assert.equal(drafts, 1);
  assert.equal(state.openTabs[2].sessionId, 'draft-created');
});
