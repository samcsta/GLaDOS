const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createClippyService, parseFinding, findingId, unwrapToolResult, boundedFetch } = require('../lib/clippy-intel');
const { createClippyRouter } = require('../routes/clippy');

function structured(data) { return { isError: false, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }; }
function list(rows) { return structured({ result: rows }); }
function clientWith(handler) {
  const calls = [];
  return {
    calls,
    listTools: async () => ({ tools: ['search', 'read', 'list_repos', 'list_files'].map(name => ({ name })) }),
    callTool: async (request, _schema, options) => { calls.push(request); return handler(request.name, request.arguments, options); },
  };
}
function numbered(content) { return content.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n'); }
function findingDoc(number, level = 'High') {
  return { content: numbered(`# F-${number} — Example <script>alert(1)</script>\n\n| Field | Value |\n|---|---|\n| **Severity** | **${level}** (CVSS 8.1) |\n| Category | Access control |\n\nEvidence`), total_lines: 8, truncated: false, is_text: true };
}

test('unwraps actual Python MCP result wrappers and text-only equivalents', () => {
  assert.deepEqual(unwrapToolResult(list([{ name: 'repo-a' }])), [{ name: 'repo-a' }]);
  assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: '{"result":[]}' }] }), []);
  assert.deepEqual(unwrapToolResult(structured({ path: 'repo/file.md', content: '' })), { path: 'repo/file.md', content: '' });
  assert.throws(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'private bearer value' }] }), error => !error.message.includes('private'));
  assert.throws(() => unwrapToolResult({ content: [{ type: 'text', text: 'not JSON' }] }), { code: 'invalid_response' });
});

test('parses severity from actual numbered Markdown fields without guessing from snippets', () => {
  const row = parseFinding('repo-a/full/findings/CWE-79/F-1.md', { snippet: 'critical exploit' }, findingDoc(1, 'Medium'));
  assert.equal(row.severity, 'medium');
  assert.equal(row.category, 'Access control');
  assert.equal(row.title, 'F-1 — Example <script>alert(1)</script>');
  assert.ok(!row.content.startsWith('1:'));
  assert.equal(parseFinding('repo-a/findings/F-2.md', { snippet: 'critical' }).severity, 'unknown');
});

test('loads only a visible page, caches headers, and reports scoped counts and upstream pagination', async () => {
  const hits = Array.from({ length: 60 }, (_, index) => ({ path: `repo-a/full/findings/CWE-79/F-${index}.md`, repo: 'repo-a', snippet: 'Severity…', line: 4 }));
  const client = clientWith((name, args) => name === 'search' ? list(hits) : structured(findingDoc(args.path.endsWith('F-0.md') ? 0 : 1, args.path.endsWith('F-0.md') ? 'Low' : 'High')));
  const service = createClippyService({ client });
  const first = await service.findings();
  assert.equal(first.findings.length, 25);
  assert.equal(first.counts.high, 24);
  assert.equal(first.counts.low, 1);
  assert.equal(first.countsScope, 'loaded_matches');
  assert.equal(first.partial, true);
  assert.equal(first.indexedMatches, 60);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 25);
  assert.equal(client.calls.filter(call => call.name === 'read').length, 25);
  await service.findings();
  assert.equal(client.calls.filter(call => call.name === 'read').length, 25);
  const second = await service.findings({ offset: 25 });
  assert.equal(second.sampled, 50);
  assert.equal(client.calls.filter(call => call.name === 'read').length, 50);
  assert.equal(client.calls.filter(call => call.name === 'search').length, 1);
});

test('severity filters narrow FTS but include only parsed matching severity from the visible page', async () => {
  const hits = [
    { path: 'repo-a/findings/F-1.md', repo: 'repo-a', snippet: 'critical' },
    { path: 'repo-a/findings/F-2.md', repo: 'repo-a', snippet: 'critical' },
    { path: 'repo-a/findings/F-3.md', repo: 'repo-a', snippet: 'critical' },
  ];
  const client = clientWith((name, args) => name === 'search' ? list(hits) : structured(args.path.endsWith('F-1.md') ? findingDoc(1, 'Critical') : args.path.endsWith('F-2.md') ? findingDoc(2, 'Low') : { content: '1: # Finding with no severity' }));
  const result = await createClippyService({ client }).findings({ severity: 'critical', q: 'login "quoted"' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'critical');
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.counts.low, 1);
  assert.equal(client.calls[0].arguments.query, '"login ""quoted""" AND critical');
  assert.equal(client.calls.filter(call => call.name === 'read').length, 3);
});

test('lists engagement repos and bounds file browsing without using fetch or writing tools', async () => {
  const client = clientWith((name, args) => name === 'list_repos'
    ? list([{ name: 'repo-a', files: 501 }, { name: 'other', files: 1 }])
    : name === 'list_files'
      ? list(Array.from({ length: 500 }, (_, i) => ({ path: `${args.repo}/file-${i}.md`, is_text: true })))
      : structured({ ...findingDoc(1), path: args.path, repo: 'repo-a', offset: args.offset, limit: args.limit }));
  const service = createClippyService({ client });
  assert.equal((await service.repos({ q: 'repo' })).repos[0].id, 'repo-a');
  assert.equal((await service.files({ repo: 'repo-a' })).partial, true);
  const file = await service.file({ repo: 'repo-a', path: 'repo-a/findings/F-1.md', offset: '21', limit: '30' });
  assert.equal(file.offset, 21);
  assert.equal(file.lineNumbered, true);
  assert.equal((await service.finding({ id: findingId('repo-a/findings/F-1.md') })).finding.severity, 'high');
  assert.deepEqual(new Set(client.calls.map(call => call.name)), new Set(['list_repos', 'list_files', 'read']));
  await assert.rejects(service.file({ repo: 'repo-a', path: 'repo-b/secret.md' }), { code: 'invalid_input' });
  await assert.rejects(service.file({ repo: 'repo-a', path: 'repo-a/../secret.md' }), { code: 'invalid_input' });
  await assert.rejects(service.file({ repo: 'repo-a', path: 'repo-a/file.md', offset: '-2' }), { code: 'invalid_input' });
  await assert.rejects(service.finding({ id: findingId('repo-a') }), { code: 'invalid_input' });
});

test('disconnected keys and upstream errors never expose credential or upstream body', async () => {
  const disconnected = createClippyService({ tokenProvider: () => null });
  assert.equal((await disconnected.status()).status, 'disconnected');
  await assert.rejects(disconnected.repos(), { code: 'not_connected' });
  const client = clientWith(() => { throw new Error('Authorization: Bearer SUPER_PRIVATE body actual finding'); });
  await assert.rejects(createClippyService({ client }).repos(), error => error.code === 'upstream_error' && !/SUPER_PRIVATE|actual finding/.test(error.message));
});

test('disconnect invalidates memory-cached findings and closes the MCP connection', async () => {
  let token = 'test-token'; let closed = 0;
  const client = clientWith(() => list([{ name: 'repo-a' }]));
  client.close = async () => { closed++; };
  const service = createClippyService({ tokenProvider: () => token, clientFactory: async () => client });
  await service.repos(); token = null;
  await assert.rejects(service.repos(), { code: 'not_connected' });
  assert.equal(closed, 1);
});

test('bounded HTTP responses reject oversized bodies including streamed bodies', async () => {
  const large = boundedFetch(async () => new Response('too many bytes', { headers: { 'content-length': '14' } }), 1000, 5);
  await assert.rejects(large('https://example.invalid'), { code: 'response_too_large' });
  const streamed = boundedFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('123456')); controller.close(); } })), 1000, 5);
  const response = await streamed('https://example.invalid');
  await assert.rejects(response.text(), { code: 'response_too_large' });
});

test('router returns real empty collections and sanitized errors with no-store', async t => {
  const app = express();
  const client = clientWith(() => list([]));
  app.use('/api/clippy', createClippyRouter({ service: createClippyService({ client }), agentInfo: () => ({ agentId: 'clippy-test' }) }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/clippy`;
  const status = await fetch(`${base}/status`);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await status.json()).connected, true);
  assert.equal((await (await fetch(`${base}/repos`)).json()).repos.length, 0);
  const invalid = await fetch(`${base}/findings?severity=invalid`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'invalid_input');
});

test('concurrent first requests share a single initialized MCP client', async () => {
  let release; let factoryCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const client = clientWith(() => list([{ name: 'repo-a' }]));
  const service = createClippyService({ tokenProvider: () => 'first-key', clientFactory: async () => { factoryCalls++; await gate; return client; } });
  const requests = [service.repos(), service.repos(), service.status()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(factoryCalls, 1);
  release();
  const results = await Promise.all(requests);
  assert.equal(results[0].repos.length, 1);
  assert.equal(results[2].connected, true);
  await service.close();
});

test('key rotation discards and closes a pending client instead of resurrecting it', async () => {
  let token = 'first-key'; let releaseOld; let oldClosed = 0; let newClosed = 0;
  const oldClient = clientWith(() => list([{ name: 'obsolete-repo' }]));
  oldClient.close = async () => { oldClosed++; };
  const newClient = clientWith(() => list([{ name: 'current-repo' }]));
  newClient.close = async () => { newClosed++; };
  const service = createClippyService({ tokenProvider: () => token, clientFactory: async key => {
    if (key === 'first-key') { await new Promise(resolve => { releaseOld = resolve; }); return oldClient; }
    return newClient;
  } });
  const oldRequest = service.repos();
  // Observe rejection immediately so the intentionally discarded request cannot
  // become an unhandled promise while the new-key request completes.
  const oldFailure = assert.rejects(oldRequest, { code: 'connection_changed' });
  await new Promise(resolve => setImmediate(resolve));
  token = 'second-key';
  assert.equal((await service.repos()).repos[0].name, 'current-repo');
  releaseOld();
  await oldFailure;
  assert.equal(oldClosed, 1);
  assert.equal(oldClient.calls.length, 0);
  assert.equal((await service.repos()).repos[0].name, 'current-repo');
  await service.close();
  assert.equal(newClosed, 1);
});

test('disconnect during initialization closes the discarded client and keeps the service disconnected', async () => {
  let token = 'first-key'; let release; let closed = 0;
  const client = clientWith(() => list([{ name: 'repo-a' }]));
  client.close = async () => { closed++; };
  const service = createClippyService({ tokenProvider: () => token, clientFactory: async () => { await new Promise(resolve => { release = resolve; }); return client; } });
  const pending = service.repos();
  const discarded = assert.rejects(pending, { code: 'connection_changed' });
  await new Promise(resolve => setImmediate(resolve));
  token = null;
  assert.equal((await service.status()).status, 'disconnected');
  release(); await discarded;
  assert.equal(closed, 1);
  assert.equal(client.calls.length, 0);
  await assert.rejects(service.repos(), { code: 'not_connected' });
});
