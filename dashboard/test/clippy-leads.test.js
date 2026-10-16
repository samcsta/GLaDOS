const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { createClippyService, parseFinding } = require('../lib/clippy-intel');
const { createClippyRouter } = require('../routes/clippy');
const { candidateFromDocument, reportCheck, VERIFY_MS } = require('../lib/clippy-leads');

const hit = { path: 'engagement/full/findings/F-1.md', repo: 'engagement' };
const doc = (extra = '') => ({ content: `# Object access control bypass\n\n| Severity | High |\n| Category | Access control |\n| Target URL | https://app.example.test/api/accounts?token=DO_NOT_STORE |\n${extra}\n## Proof of concept\nTwo permitted test accounts can reproduce the documented cross-account response. The source contains captured request and response evidence.\n`, total_lines: 10 });
const result = value => ({ structuredContent: Array.isArray(value) ? { result: value } : value });
function fixture({ document = doc(), projects = [], error, size = 1, ...options } = {}) {
  const calls = [];
  const client = { close: async () => {}, listTools: async () => ({ tools: ['search', 'read', 'list_repos', 'list_files', 'projects_search'].map(name => ({ name })) }), callTool: async ({ name, arguments: args }, _schema, request) => {
    calls.push({ name, args });
    if (error) return error(name, args, request);
    if (name === 'search') return result(Array.from({ length: size }, (_, i) => ({ ...hit, path: `engagement/full/findings/F-${i + 1}.md` })));
    if (name === 'read') return result(typeof document === 'function' ? document(args) : document);
    if (name === 'projects_search') return result({ projects, total_matched: projects.length, cache_age_seconds: 30 });
    throw new Error('Unexpected tool');
  } };
  const service = createClippyService({ client, ...options });
  return { calls, service, client };
}
async function search(service) { await service.searchLeads(); return service.waitForLeads(); }
function check(candidate, extra = {}) { return { noReport: true, scope: candidate.scope || candidate.domain, evidenceDigest: candidate.evidenceDigest, matchDigest: candidate.reportCoverage.matchDigest, sourceUrl: 'https://dradis.example.test/projects?search=app', notes: 'Checked the exact domain, application aliases, and the full scoped project/report inventory in Dradis.', ...extra }; }

test('bounded lead discovery reads remote sources without a global inventory and never promotes cached absence', async () => {
  const { calls, service } = fixture();
  const snapshot = await search(service);
  assert.equal(snapshot.leads.length, 0);
  assert.equal(snapshot.review.length, 1);
  const candidate = snapshot.review[0];
  assert.equal(candidate.domain, 'app.example.test');
  assert.equal(candidate.reportCoverage.status, 'needs_verification');
  assert.match(candidate.nextStep, /api\/accounts/);
  assert.ok(!JSON.stringify(candidate).includes('DO_NOT_STORE'));
  assert.deepEqual(candidate.evidence[0].path, hit.path);
  assert.ok(!calls.some(call => call.name === 'list_repos' || call.name === 'list_files'));
  assert.equal((await service.indexStatus()).index.calls, 0);
});

test('ready shortlist requires explicit current analyst check and expires after 24 hours', async () => {
  let time = Date.parse('2026-10-15T14:00:00Z');
  const { service } = fixture({ leadOptions: { now: () => time } });
  const candidate = (await search(service)).review[0];
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { noReport: false })), { code: 'invalid_input' });
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { scope: 'other.example.test' })), { code: 'invalid_input' });
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { sourceUrl: 'https://unrelated.example.test/' })), { code: 'invalid_input' });
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { evidenceDigest: 'old' })), { code: 'invalid_input' });
  const verified = await service.verifyLead(candidate.id, check(candidate));
  assert.equal(verified.leads.length, 1);
  assert.equal(verified.leads[0].reportCoverage.kind, 'analyst_attestation');
  assert.match(verified.leads[0].reportCoverage.label, /Analyst checked/);
  time += VERIFY_MS + 1;
  const expired = await service.leads();
  assert.equal(expired.leads.length, 0);
  assert.equal(expired.review[0].reportCoverage.status, 'stale');
});

test('both real Dradis status variants block recommendations and even open project matches prevent attestation', async () => {
  for (const status of ['Delivered', 'Closed', 'Report Delivered', 'Report Closed', 'Draft', 'Review', 'Open']) {
    const projects = [{ project_id: 1, name: 'Possible domain match', status, project_url: 'https://dradis.example.test/projects/1' }];
    const { service } = fixture({ projects }); const snapshot = await search(service);
    assert.equal(snapshot.leads.length, 0);
    assert.equal(snapshot.review[0].reportCoverage.status, status === 'Open' ? 'needs_verification' : 'reported');
    await assert.rejects(service.verifyLead(snapshot.review[0].id, check(snapshot.review[0])), error => error.status === 409);
  }
  assert.equal(reportCheck({ projects: [], total_matched: 100 }, new Date().toISOString()).partial, true);
});

test('a newly found report invalidates a previously checked lead', async () => {
  const { service, client } = fixture(); const candidate = (await search(service)).review[0];
  assert.equal((await service.verifyLead(candidate.id, check(candidate))).leads.length, 1);
  const original = client.callTool;
  client.callTool = async (request, ...rest) => request.name === 'projects_search' ? result({ projects: [{ project_id: 1, name: 'Report match', status: 'Delivered' }], total_matched: 1 }) : original(request, ...rest);
  const refreshed = await search(service);
  assert.equal(refreshed.leads.length, 0);
  assert.equal(refreshed.review[0].reportCoverage.status, 'reported');
});

test('changed evidence and lookup failures invalidate the previous coverage receipt', async () => {
  for (const change of ['document', 'lookup']) {
    const { service, client } = fixture(); const candidate = (await search(service)).review[0];
    await service.verifyLead(candidate.id, check(candidate)); const original = client.callTool;
    client.callTool = async (request, ...rest) => {
      if (change === 'document' && request.name === 'read') return result(doc('Additional current evidence.'));
      if (change === 'lookup' && request.name === 'projects_search') throw new Error('private upstream detail');
      return original(request, ...rest);
    };
    const refreshed = await search(service);
    assert.equal(refreshed.leads.length, 0); assert.equal(refreshed.review[0].reportCoverage.status, 'needs_verification');
    assert.ok(!JSON.stringify(refreshed).includes('private upstream detail'));
  }
});

test('new report evidence on another source for the same domain withholds every earlier lead', async () => {
  const { service, client } = fixture(); const first = (await search(service)).review[0];
  await service.verifyLead(first.id, check(first));
  const original = client.callTool;
  client.callTool = async (request, ...rest) => {
    if (request.name === 'search') return result([{ ...hit, path: 'other/findings/new.md', repo: 'other' }]);
    if (request.name === 'projects_search') return result({ projects: [{ project_id: 1, name: 'Report', status: 'Delivered' }], total_matched: 1 });
    return original(request, ...rest);
  };
  const refreshed = await search(service);
  assert.equal(refreshed.leads.length, 0);
  assert.equal(refreshed.review.length, 2);
  assert.ok(refreshed.review.every(item => item.reportCoverage.status === 'reported'));
});

test('source retirement or failed refresh prevents an old attestation from retaining readiness', async () => {
  for (const mode of ['fixed', 'unavailable']) {
    const { service, client } = fixture(); const first = (await search(service)).review[0];
    await service.verifyLead(first.id, check(first)); const original = client.callTool;
    client.callTool = async (request, ...rest) => {
      if (request.name === 'read') { if (mode === 'unavailable') throw new Error('source unavailable'); return result(doc('| Status | Fixed |')); }
      return original(request, ...rest);
    };
    const refreshed = await search(service);
    assert.equal(refreshed.leads.length, 0);
    assert.equal(refreshed.review[0].reportCoverage.status, 'needs_verification');
  }
});

test('weak, remediated, targetless, and reproduction-free documents are not candidate leads', () => {
  for (const content of [doc().content.replace('High', 'Low'), doc().content.replace('Target URL', 'Unrelated reference'), doc().content.replace('## Proof of concept', '## Remediation'), doc('| Status | Fixed |').content]) {
    assert.equal(candidateFromDocument(hit, { content }, parseFinding), null);
  }
});

test('search has explicit document/call limits and a deadline even if remote ignores cancellation', async () => {
  const { service, calls } = fixture({ size: 50, document: { content: '# Missing evidence' } });
  const snapshot = await search(service);
  assert.equal(snapshot.search.examined, 18);
  assert.ok(snapshot.search.calls <= 36); assert.ok(calls.length <= 36);
  let release; let entered; const reading = new Promise(resolve => { entered = resolve; });
  const stalled = fixture({ leadOptions: { durationMs: 25 }, error: async () => { entered(); await new Promise(resolve => { release = resolve; }); return result([]); } });
  await stalled.service.searchLeads(); await reading;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await stalled.service.leads()).search.state, 'paused');
  release(); assert.equal((await stalled.service.waitForLeads()).review.length, 0);
});

test('saved leads persist per account without source bodies or credentials and resume without indexing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-leads-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const leadsPath = path.join(directory, 'leads.json'); const { client } = fixture();
  const opts = { leadsPath, indexPath: null, tokenProvider: () => 'private-key-a', clientFactory: async () => client };
  const service = createClippyService(opts); const candidate = (await search(service)).review[0]; await service.saveLead(candidate.id, { saved: true }); await service.close();
  const stored = fs.readFileSync(leadsPath, 'utf8'); assert.ok(!stored.includes('private-key-a')); assert.ok(!stored.includes('Two permitted test accounts')); assert.ok(!stored.includes('DO_NOT_STORE'));
  const reopened = createClippyService(opts); assert.equal((await reopened.leads()).review[0].saved, true); await reopened.close();
  const rotated = createClippyService({ ...opts, tokenProvider: () => 'private-key-b' }); assert.equal((await rotated.leads()).review.length, 0); await rotated.close();
});

test('lead HTTP routes preserve conflict status, no-store, and explicit analyst verification', async t => {
  const { service } = fixture();
  const app = express(); app.use('/api/clippy', createClippyRouter({ service }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/clippy/leads`;
  const request = async (suffix = '', body) => fetch(base + suffix, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const initial = await request(); assert.equal(initial.headers.get('cache-control'), 'no-store'); assert.equal((await initial.json()).leads.length, 0);
  assert.equal((await request('/search', {})).status, 200); await service.waitForLeads();
  const candidate = (await (await request()).json()).review[0];
  assert.equal((await request(`/${candidate.id}/coverage`, check(candidate, { noReport: false }))).status, 400);
  const verified = await request(`/${candidate.id}/coverage`, check(candidate)); assert.equal(verified.status, 200); assert.equal((await verified.json()).leads.length, 1);
  const saved = await request(`/${candidate.id}/save`, { saved: true }); assert.equal((await saved.json()).leads[0].saved, true);
  assert.equal((await request('/missing/save', { saved: true })).status, 404);
});

test('failed analyst re-verification withholds all earlier readiness', async () => {
  const { service, client } = fixture(); const first = (await search(service)).review[0];
  await service.verifyLead(first.id, check(first)); const original = client.callTool;
  client.callTool = async (request, ...rest) => { if (request.name === 'projects_search') throw new Error('unavailable'); return original(request, ...rest); };
  await assert.rejects(service.verifyLead(first.id, check(first)), error => error.status === 409);
  assert.equal((await service.leads()).leads.length, 0);
});

const commit = '672c143dff6d5331af110e2611fd5f969f646f6f';
const sourceDoc = (repository = 'org/deployment_library', extra = '') => ({ content: `# SC-002-01 — Shell interpolation in build agent\n\n- **Severity:** Critical (9/12)\n- **Canonical repository:** \`${repository}\`\n${extra}\n## Verbatim evidence\nThe captured source shows a user-controlled branch name interpolated into a shell command on a privileged build agent.\n## Reproduction / trace\nFollow the documented SCM input through the library method into the shell argument; deployment access remains unverified.\n`, truncated: false });
const sourceManifest = (repository = 'org/deployment_library', sha = commit) => ({ content: JSON.stringify({ assessment_id: 'historical-review', verified_at: '2026-08-31T08:42:03Z', repositories: [{ full_name: repository, inspected_sha: sha, resolved_sha: sha }] }), truncated: false });

test('cited source findings become review candidates with exact repository and immutable manifest identity', async () => {
  const sourcePath = 'gh-example/sca-opus-v2/findings/critical/SC-002-01.md';
  const { service, calls } = fixture({ document: args => args.path.endsWith('/source-manifest.json') ? sourceManifest() : sourceDoc() });
  await service.leadsFromSources({ paths: [sourcePath] }); const snapshot = await service.waitForLeads();
  assert.equal(snapshot.leads.length, 0); assert.equal(snapshot.review.length, 1);
  const candidate = snapshot.review[0];
  assert.equal(candidate.targetKind, 'source'); assert.equal(candidate.domain, null);
  assert.equal(candidate.repository, 'org/deployment_library'); assert.equal(candidate.commit, commit);
  assert.equal(candidate.scope, `org/deployment_library@${commit}`);
  assert.equal(candidate.evidence[1].path, 'gh-example/sca-opus-v2/source-manifest.json');
  assert.equal(candidate.evidenceDate, '2026-08-31T08:42:03Z');
  assert.ok(calls.every(call => ['read', 'projects_search'].includes(call.name)));
  assert.deepEqual(calls.filter(call => call.name === 'projects_search').map(call => call.args.query), ['org/deployment_library', 'deployment_library']);
  assert.equal((await service.verifyLead(candidate.id, check(candidate))).leads.length, 1);
});

test('source identity must be explicit, unambiguous and complete', () => {
  const direct = sourceDoc('org/library', `- **Commit:** ${commit}`);
  const candidate = candidateFromDocument(hit, direct, parseFinding);
  assert.equal(candidate.repository, 'org/library'); assert.equal(candidate.evidence.length, 1);
  assert.equal(candidateFromDocument(hit, sourceDoc(), parseFinding), null);
  assert.equal(candidateFromDocument(hit, sourceDoc(), parseFinding, sourceManifest('other/repo')), null);
  assert.equal(candidateFromDocument(hit, sourceDoc(), parseFinding, { ...sourceManifest(), truncated: true }), null);
  assert.equal(candidateFromDocument(hit, { ...direct, truncated: true }, parseFinding), null);
  const ambiguous = { content: JSON.stringify({ repositories: [{ full_name: 'org/deployment_library', inspected_sha: commit }, { full_name: 'org/deployment_library', inspected_sha: 'a'.repeat(40) }] }) };
  assert.equal(candidateFromDocument(hit, sourceDoc(), parseFinding, ambiguous), null);
});

test('source identity refresh invalidates receipts without contaminating other null-domain source candidates', async () => {
  let changed = false;
  const a = 'eng-a/full/findings/A.md'; const b = 'eng-b/full/findings/B.md';
  const { service } = fixture({ document: args => {
    const repo = args.path.startsWith('eng-a/') ? 'org/library-a' : 'org/library-b';
    return args.path.endsWith('source-manifest.json') ? sourceManifest(repo, changed && repo.endsWith('-a') ? 'b'.repeat(40) : commit) : sourceDoc(repo);
  } });
  await service.leadsFromSources({ paths: [a, b] });
  for (const candidate of (await service.waitForLeads()).review) await service.verifyLead(candidate.id, check(candidate));
  assert.equal((await service.leads()).leads.length, 2);
  changed = true;
  await service.leadsFromSources({ paths: [a] }); const refreshed = await service.waitForLeads();
  assert.equal(refreshed.leads.length, 1); assert.equal(refreshed.leads[0].repository, 'org/library-b');
  assert.ok(refreshed.review.filter(row => row.repository === 'org/library-a').every(row => row.reportCoverage.status !== 'no_report_verified'));
});

test('manual Dradis check resolves every fresh possible match explicitly and binds the match set', async () => {
  const projects = [{ project_id: 8, name: 'Similar application, different scope', status: 'Delivered', project_url: 'https://dradis.example.test/projects/8' }];
  const { service, client } = fixture({ projects }); let candidate = (await search(service)).review[0];
  const dispositions = [{ matchId: candidate.reportCoverage.projects[0].matchId, disposition: 'unrelated', notes: 'Opened this project and compared exact assets, aliases and finding identifiers; its scope belongs to another application.' }];
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { matchDigest: 'stale', projectDispositions: dispositions })), error => error.status === 409);
  candidate = (await service.leads()).review[0];
  const verified = await service.verifyLead(candidate.id, check(candidate, { projectDispositions: dispositions }));
  assert.equal(verified.leads.length, 1); assert.equal(verified.leads[0].reportCoverage.projects.length, 1);
  assert.equal((await search(service)).leads.length, 1);
  const original = client.callTool;
  client.callTool = async (request, ...rest) => request.name === 'projects_search' ? result({ projects: [...projects, { project_id: 9, name: 'New possible match', status: 'Draft' }], total_matched: 2 }) : original(request, ...rest);
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { projectDispositions: dispositions })), error => error.status === 409);
  assert.equal((await service.leads()).leads.length, 0);
});

test('tied and unknown project dispositions retain audit notes and prevent readiness', async () => {
  for (const disposition of ['tied', 'unknown']) {
    const { service } = fixture({ projects: [{ project_id: 5, name: 'Possible match', status: 'Delivered' }] });
    const candidate = (await search(service)).review[0];
    await assert.rejects(service.verifyLead(candidate.id, check(candidate, { projectDispositions: [{ matchId: '5', disposition, notes: 'Compared the project scope and target finding identifiers during a direct Dradis check.' }] })), error => error.status === 409);
    const current = (await service.leads()).review[0];
    assert.equal(current.reportCoverage.projectDispositions[0].disposition, disposition);
    assert.equal(current.reportCoverage.confirmedTie, disposition === 'tied');
  }
});

test('relationship-only checks refresh sources, record tied or unknown without a negative attestation, and reject empty decisions', async () => {
  for (const disposition of ['tied', 'unknown']) {
    const { service, calls } = fixture({ projects: [{ project_id: 5, name: 'Possible project', status: 'Delivered' }] });
    const candidate = (await search(service)).review[0]; const before = calls.length;
    const current = await service.verifyLead(candidate.id, check(candidate, { noReport: false, projectDispositions: [{ matchId: '5', disposition, notes: 'Opened the exact project and compared the documented assets, aliases and source finding identifiers.' }] }));
    assert.equal(current.leads.length, 0); assert.equal(current.review[0].reportCoverage.kind, 'analyst_observation');
    assert.equal(current.review[0].reportCoverage.confirmedTie, disposition === 'tied');
    assert.deepEqual(calls.slice(before).map(row => row.name), ['read', 'projects_search']);
  }
  const { service } = fixture({ projects: [{ project_id: 5, name: 'Possible project', status: 'Delivered' }] });
  const candidate = (await search(service)).review[0];
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { noReport: false, projectDispositions: [{ matchId: '5', disposition: 'unrelated', notes: 'Opened the exact project and confirmed it belongs to a completely different application.' }] })), error => error.status === 400);
});

test('relationship observations can record a partial match feed but it cannot create readiness', async () => {
  const { service, client } = fixture({ projects: [{ project_id: 5, name: 'Possible project', status: 'Draft' }] });
  const original = client.callTool;
  client.callTool = async (request, ...rest) => request.name === 'projects_search' ? result({ projects: [{ project_id: 5, name: 'Possible project', status: 'Draft' }], total_matched: 100 }) : original(request, ...rest);
  const candidate = (await search(service)).review[0];
  assert.equal(candidate.reportCoverage.partial, true);
  const current = await service.verifyLead(candidate.id, check(candidate, { noReport: false, projectDispositions: [{ matchId: '5', disposition: 'unknown', notes: 'This visible project still needs its detailed target scope compared; the remaining feed is incomplete.' }] }));
  assert.equal(current.leads.length, 0); assert.equal(current.review[0].reportCoverage.partial, true);
  assert.equal(current.review[0].reportCoverage.kind, 'analyst_observation');
});

test('confirmed tied reports survive cached omissions and retain bounded review history', async () => {
  const { service, client } = fixture({ projects: [{ project_id: 5, name: 'Known tied report', status: 'Delivered' }] });
  const candidate = (await search(service)).review[0];
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { projectDispositions: [{ matchId: '5', disposition: 'tied', notes: 'Opened the report and confirmed the exact target and source finding identifiers are covered.' }] })), error => error.status === 409);
  const original = client.callTool;
  client.callTool = async (request, ...rest) => request.name === 'projects_search' ? result({ projects: [], total_matched: 0 }) : original(request, ...rest);
  const refreshed = await search(service);
  assert.equal(refreshed.leads.length, 0);
  assert.equal(refreshed.review[0].reportCoverage.confirmedTie, true);
  assert.equal(refreshed.review[0].reportCoverage.projects[0].matchId, '5');
  assert.ok(refreshed.review[0].reportCheckHistory.some(row => row.projectDispositions?.some(row => row.disposition === 'tied')));
});

test('a tied disposition supersedes an in-flight negative verification for the same exact target', async () => {
  const projects = [{ project_id: 5, name: 'Possible report', status: 'Delivered' }];
  const { service, client } = fixture({ projects }); const candidate = (await search(service)).review[0];
  const notes = 'Opened the project and reviewed its exact assets and source finding identifiers directly in Dradis.';
  let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const original = client.callTool;
  client.callTool = async (request, ...rest) => {
    if (request.name === 'projects_search') { enter(); await new Promise(resolve => { release = resolve; }); return result({ projects, total_matched: 1 }); }
    return original(request, ...rest);
  };
  const pending = service.verifyLead(candidate.id, check(candidate, { projectDispositions: [{ matchId: '5', disposition: 'unrelated', notes }] })).then(() => null, error => error);
  await entered;
  await assert.rejects(service.verifyLead(candidate.id, check(candidate, { projectDispositions: [{ matchId: '5', disposition: 'tied', notes }] })), error => error.status === 409);
  release(); assert.equal((await pending).status, 409);
  const current = await service.leads(); assert.equal(current.leads.length, 0); assert.equal(current.review[0].reportCoverage.confirmedTie, true);
});

test('receipts preserve a DradisTab target filter while stripping other URL parameters', async () => {
  const { service } = fixture(); const candidate = (await search(service)).review[0];
  const current = await service.verifyLead(candidate.id, check(candidate, { sourceUrl: 'https://dradistab.example.test/?filter=app.example.test&token=DO_NOT_STORE' }));
  assert.equal(current.leads[0].reportCoverage.sourceUrl, 'https://dradistab.example.test/?filter=app.example.test');
  assert.ok(!JSON.stringify(current).includes('DO_NOT_STORE'));
});

test('broad source discovery balances critical and high queues inside the document budget', async () => {
  const { service, calls, client } = fixture({ document: { content: '# No evidence' } });
  const original = client.callTool;
  client.callTool = async (request, ...rest) => {
    if (request.name === 'search') { calls.push({ name: request.name, args: request.arguments }); return result(Array.from({ length: 30 }, (_, index) => ({ path: `repo/${request.arguments.query}/findings/F-${index}.md`, repo: 'repo' }))); }
    return original(request, ...rest);
  };
  const snapshot = await search(service);
  assert.equal(snapshot.search.examined, 18);
  const reads = calls.filter(row => row.name === 'read');
  assert.equal(reads.filter(row => row.args.path.includes('/critical/')).length, 9);
  assert.equal(reads.filter(row => row.args.path.includes('/high/')).length, 9);
});

test('from-sources route rejects unsafe or excessive inputs and imports at most six cited findings', async t => {
  const { service, calls } = fixture();
  const app = express(); app.use('/api/clippy', createClippyRouter({ service }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/clippy/leads/from-sources`;
  const post = body => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const paths of [[], Array(7).fill(hit.path), ['../repo/findings/F.md'], ['https://target.example/findings/F.md'], ['repo/source-manifest.json']]) assert.equal((await post({ paths })).status, 400);
  assert.equal(calls.length, 0);
  const response = await post({ paths: [hit.path, 'engagement/full/findings/F-2.markdown'] }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await service.waitForLeads(); assert.equal(snapshot.search.mode, 'sources'); assert.equal(snapshot.review.length, 2);
  assert.ok(calls.every(call => ['read', 'projects_search'].includes(call.name)));
});
