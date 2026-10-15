const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClippyService, parseFinding } = require('../lib/clippy-intel');
const result = data => ({ structuredContent: Array.isArray(data) ? { result: data } : data });
function fixtureClient({ size = 130, reportResult, gate } = {}) {
  const files = Array.from({ length: size }, (_, index) => ({ repo: index < 100 ? 'repo-a' : 'repo-b', path: `${index < 100 ? 'repo-a' : 'repo-b'}/full/findings/F-${index}.md` }));
  const calls = [];
  return { calls, files, close: async () => {}, listTools: async () => ({ tools: ['search', 'read', 'list_repos', 'list_files', 'projects_search'].map(name => ({ name })) }), callTool: async (request, _schema, options) => {
    const { name, arguments: args } = request; calls.push(request);
    if (name === 'list_repos') return result([{ name: 'repo-a', files: 100 }, { name: 'repo-b', files: size - 100 }]);
    if (name === 'search') return result(files.slice(0, Math.min(size, args.limit)));
    if (name === 'list_files') return result(files.filter(file => file.repo === args.repo));
    if (name === 'projects_search') return result(reportResult || { projects: [], total_matched: 0, cache_age_seconds: 600 });
    if (gate) await gate(options.signal);
    return result({ content: `1: # Finding ${path.basename(args.path)}\n2: | Severity | Critical |\n3: | Target URL | https://app.example.test/account |\n4: | Category | Access control |\n5: PRIVATE_FULL_DOCUMENT_BODY_NOT_INDEXED`, total_lines: 5 });
  } };
}

test('explicit bounded inventory discovers beyond the capped FTS page and paginates all parsed findings', async () => {
  const client = fixtureClient(); const service = createClippyService({ client });
  assert.equal((await service.syncIndex({ maxCalls: 200 })).index.running, true);
  const complete = await service.waitForIndex();
  assert.equal(complete.findings, 130); assert.equal(complete.metadataLoaded, 130); assert.equal(complete.complete, true);
  assert.ok(client.calls.filter(call => call.name === 'search').every(call => call.arguments.limit === 100));
  assert.equal(client.calls.filter(call => call.name === 'list_files').length, 2);
  const page = await service.findings({ offset: 100, severity: 'critical' });
  assert.equal(page.total, 130); assert.equal(page.findings.length, 25); assert.equal(page.counts.critical, 130);
  assert.equal(page.hasMore, true); assert.equal(page.partial, false);
  assert.equal((await service.findings({ offset: 125 })).findings.length, 5);
  const opportunities = await service.opportunities();
  assert.equal(opportunities.total, 1); assert.equal(opportunities.opportunities[0].domain, 'app.example.test');
  assert.equal(opportunities.opportunities[0].counts.critical, 130);
  assert.equal(opportunities.opportunities[0].reportCoverage.status, 'unknown');
  assert.equal(opportunities.opportunities[0].findings.length, 10);
});

test('bounded jobs resume persisted metadata and isolate credentials without storing document bodies', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-index-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const indexPath = path.join(directory, 'index.json'); const client = fixtureClient({ size: 3 });
  const options = { indexPath, tokenProvider: () => 'secret-bearer-token', clientFactory: async () => client };
  const first = createClippyService(options); await first.syncIndex({ maxCalls: 2 });
  const paused = await first.waitForIndex(); assert.equal(paused.state, 'paused'); assert.ok(paused.calls <= 2); await first.close();
  const resumed = createClippyService(options); assert.equal((await resumed.indexStatus()).index.calls, paused.calls);
  await resumed.syncIndex({ maxCalls: 20 }); assert.equal((await resumed.waitForIndex()).complete, true);
  const serialized = fs.readFileSync(indexPath, 'utf8'); assert.ok(!serialized.includes('secret-bearer-token')); assert.ok(!serialized.includes('PRIVATE_FULL_DOCUMENT_BODY_NOT_INDEXED'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  await resumed.close();
  const other = createClippyService({ ...options, tokenProvider: () => 'different-account' }); assert.equal((await other.indexStatus()).index.findings, 0); await other.close();
});

test('file enumeration includes findings without searchable severity and marks saturated inventories incomplete', async () => {
  const client = fixtureClient({ size: 500 }); const original = client.callTool;
  client.callTool = async (request, ...rest) => {
    if (request.name === 'list_repos') return result([{ name: 'repo-a', files: 500 }]);
    if (request.name === 'list_files') return result(Array.from({ length: 500 }, (_, number) => ({ path: `repo-a/findings/no-severity-${number}.md`, repo: 'repo-a' })));
    if (request.name === 'read') return result({ content: '1: # Finding without a severity field\n2: Target: https://old.example.test' });
    return original(request, ...rest);
  };
  const service = createClippyService({ client }); await service.syncIndex({ maxCalls: 10 }); const index = await service.waitForIndex();
  assert.equal(index.findings, 500); assert.equal(index.saturatedRepos, 1); assert.equal(index.complete, false);
  assert.ok((await service.findings({ severity: 'unknown' })).findings.length > 0);
});

test('cancelling prevents late upstream reads from populating metadata', async () => {
  let release; let reading; const enteredRead = new Promise(resolve => { reading = resolve; });
  const client = fixtureClient({ size: 1, gate: async () => { reading(); await new Promise(resolve => { release = resolve; }); } });
  const service = createClippyService({ client }); await service.syncIndex({ maxCalls: 20 }); await enteredRead;
  assert.equal((await service.cancelIndex()).index.state, 'paused'); release();
  const index = await service.waitForIndex(); assert.equal(index.metadataLoaded, 0); assert.equal(index.running, false);
});

test('Dradis coverage distinguishes projects from delivered report evidence and preserves snapshot age', async () => {
  const cases = [
    { projects: [], total_matched: 0, expected: 'no_match' },
    { projects: [{ project_id: 1, name: 'Open project', status: 'Open', project_url: 'https://dradis.example.test/projects/1' }], total_matched: 1, expected: 'in_progress' },
    { projects: [{ project_id: 2, name: 'Delivered report', status: 'Report Delivered', project_url: 'https://dradis.example.test/projects/2' }], total_matched: 1, expected: 'reported' },
  ];
  for (const scenario of cases) {
    const client = fixtureClient({ size: 1, reportResult: { ...scenario, cache_age_seconds: 123 } }); const service = createClippyService({ client });
    await service.syncIndex({ maxCalls: 20 }); await service.waitForIndex();
    const checked = await service.reportCoverage({ domain: 'app.example.test' });
    assert.equal(checked.reportCoverage.status, scenario.expected); assert.equal(checked.reportCoverage.cacheAgeSeconds, 123); assert.match(checked.reportCoverage.note, /absent match is not proof/);
    assert.equal((await service.opportunities({ reportCoverage: 'found' })).total, scenario.expected === 'reported' ? 1 : 0);
    assert.equal((await service.opportunities({ reportCoverage: 'missing' })).total, scenario.expected === 'reported' ? 0 : 1);
    assert.deepEqual(client.calls.find(call => call.name === 'projects_search').arguments, { query: 'app.example.test', limit: 100 });
  }
});

test('target domains come from explicit metadata instead of incidental prose URLs', () => {
  const parsed = parseFinding('repo-a/findings/finding.md', {}, { content: '1: # Example\n2: | **Affected hosts** | https://API.Example.test:8443, auth.example.test |\n3: | Target URL | [Login](https://login.example.test/account) |\n4: See https://reference.unrelated.test' });
  assert.deepEqual(parsed.targets, ['api.example.test', 'auth.example.test', 'login.example.test']); assert.equal(parsed.targetSources[0].line, 2);
});

test('invalid sync budgets and domains are rejected before launching work', async () => {
  const client = fixtureClient(); const service = createClippyService({ client });
  await assert.rejects(service.syncIndex({ maxCalls: 100000 }), { code: 'invalid_input' });
  await assert.rejects(service.reportCoverage({ domain: 'https://not-a-domain.test/path' }), { code: 'invalid_input' }); assert.equal(client.calls.length, 0);
});

test('discovered paths beyond 100 remain browsable while pending metadata is excluded from severity counts', async () => {
  const client = fixtureClient({ size: 400 }); const service = createClippyService({ client });
  await service.syncIndex({ maxCalls: 11 }); const progress = await service.waitForIndex();
  assert.equal(progress.findings, 400); assert.ok(progress.metadataLoaded < 100);
  const page = await service.findings({ offset: 300 });
  assert.equal(page.total, 400); assert.equal(page.totalUnfiltered, 400); assert.equal(page.findings.length, 25);
  assert.ok(page.findings.every(row => row.metadataPending && row.severity === 'unknown' && row.title));
  assert.equal(page.metadataLoaded + page.metadataPending, 400);
  assert.equal(page.counts.unknown, 0); assert.equal(page.counts.critical, page.metadataLoaded);
  assert.equal((await service.findings({ severity: 'unknown' })).total, 0);
});

test('metadata concurrency is capped at six and every lookup consumes the remaining batch budget', async () => {
  let active = 0; let maximum = 0;
  const client = fixtureClient({ size: 130, gate: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; } });
  const service = createClippyService({ client }); await service.syncIndex({ maxCalls: 12 }); const progress = await service.waitForIndex();
  assert.equal(maximum, 6); assert.equal(client.calls.length, 12); assert.equal(progress.calls, 12);
  assert.equal(progress.pauseReason, 'call_budget'); assert.equal(progress.metadataLoaded, client.calls.filter(call => call.name === 'read').length);
});

test('wall time pauses the whole metadata batch and discards aborted results', async () => {
  const client = fixtureClient({ size: 30, gate: signal => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) });
  const service = createClippyService({ client }); await service.syncIndex({ maxCalls: 100, maxDurationMs: 20 });
  const progress = await service.waitForIndex();
  assert.equal(progress.state, 'paused'); assert.equal(progress.pauseReason, 'time_budget'); assert.equal(progress.metadataLoaded, 0);
});

test('cancel then immediate resume cannot let an old batch overwrite the new job state', async () => {
  let releaseOld; let entered; const reading = new Promise(resolve => { entered = resolve; }); let first = true;
  const client = fixtureClient({ size: 1, gate: async () => { if (first) { first = false; entered(); await new Promise(resolve => { releaseOld = resolve; }); } } });
  const service = createClippyService({ client }); await service.syncIndex({ maxCalls: 20 }); await reading;
  await service.cancelIndex(); await service.syncIndex({ maxCalls: 20 });
  assert.equal((await service.waitForIndex()).state, 'complete'); releaseOld(); await new Promise(resolve => setImmediate(resolve));
  const status = (await service.indexStatus()).index; assert.equal(status.state, 'complete'); assert.equal(status.metadataLoaded, 1);
});
