const test = require('node:test');
const assert = require('node:assert/strict');
const { createClippyService } = require('../lib/clippy-intel');
const sourcePath = 'assessment/full-assessment/findings/F-001-authentication.md';
const otherPath = 'unrelated/full/findings/F-002.md';
const document = {
  content: '# F-001 — Missing API authentication\n\n**Criticality:** critical\n| Target URL | https://qa.example.test/api/check |\n| Affected URL | https://www.example.test/api/check |\n\n## Severity: CRITICAL (9/12)\n\n## Evidence\nThe historical assessment records that an approved benign test request reached application logic. Current deployment and data access remain unverified.\n',
  total_lines: 12,
};
const otherDocument = { content: '# A different historical finding\n| Severity | High |\n| Target URL | https://elsewhere.example.test/check |\n## Evidence\nA separate assessment records an approved benign test result for an unrelated application. Current conditions are unverified.\n', total_lines: 6 };
const result = value => ({ structuredContent: Array.isArray(value) ? { result: value } : value });
function fixture({ sourceDocument = document } = {}) {
  const calls = []; let noHits = false;
  const client = {
    close: async () => {}, listTools: async () => ({ tools: ['search','read','list_repos','list_files','projects_search'].map(name => ({name})) }),
    callTool: async ({name,arguments:args}) => {
      calls.push({name,args});
      if (name === 'search') {
        if (noHits || args.query.includes('exampel') || args.query.includes('attacker.test')) return result([]);
        return result([{path:sourcePath,repo:'assessment'},{path:otherPath,repo:'unrelated'}]);
      }
      if (name === 'read') return result(args.path === sourcePath ? sourceDocument : otherDocument);
      if (name === 'projects_search') return result({projects:[],total_matched:0});
      throw new Error('Unexpected tool');
    },
  };
  return {calls, service:createClippyService({client}), hideSearchResults:()=>{noHits=true;}};
}
async function search(service, query='') { await service.searchLeads({query}); return service.waitForLeads(); }
function receipt(candidate) { return {noReport:true,scope:candidate.scope,evidenceDigest:candidate.evidenceDigest,matchDigest:candidate.reportCoverage.matchDigest,sourceUrl:'https://dradis.example.test/projects',notes:'Directly checked the exact target, documented aliases and finding identifiers against the complete scoped Dradis inventory.'}; }

test('a misspelled focus hides unrelated history, offers a source-backed correction, and preserves the collection', async () => {
  const {service} = fixture();
  assert.equal((await search(service)).review.length,2);
  const typo = await search(service,'www.exampel.test');
  assert.equal(typo.leads.length,0); assert.equal(typo.review.length,0);
  assert.equal(typo.search.examined,0); assert.match(typo.search.reason,/hostname spelling/);
  assert.deepEqual(typo.suggestions,['www.example.test']);
  assert.equal(typo.retainedElsewhere,2);
  assert.equal((await service.leads({query:''})).review.length,2);
});

test('domain search chooses the requested declared endpoint and checks documented target aliases', async () => {
  const {service,calls} = fixture();
  const found = await search(service,'www.example.test');
  assert.equal(found.leads.length,0); assert.equal(found.review.length,1);
  const candidate = found.review[0];
  assert.equal(candidate.domain,'www.example.test');
  assert.equal(candidate.scope,'www.example.test');
  assert.equal(candidate.endpoint,'https://www.example.test/api/check');
  assert.deepEqual(candidate.targetDomains,['qa.example.test','www.example.test']);
  assert.equal(candidate.severity,'critical');
  assert.equal(candidate.reportCoverage.status,'needs_verification');
  assert.ok(calls.some(call => call.name==='projects_search' && call.args.query==='qa.example.test'));
  assert.ok(calls.some(call => call.name==='projects_search' && call.args.query==='www.example.test'));
  assert.ok(!calls.some(call => call.name==='list_repos'||call.name==='list_files'));
  assert.equal((await service.leads({query:'www.example.test.attacker.test'})).review.length,0);
});

test('a letter moved two positions offers only a known hostname without silently changing the search', async () => {
  const {service} = fixture({sourceDocument:{...document,content:document.content.replaceAll('www.example.test','www.compgenie.test')}});
  await search(service,'www.compgenie.test');
  const typo=await service.leads({query:'www.compengie.test'});
  assert.deepEqual(typo.suggestions,['www.compgenie.test']);
  assert.equal(typo.review.length,0); assert.equal(typo.query,'www.compengie.test');
  assert.deepEqual((await service.leads({query:'www.different.test'})).suggestions,[]);
});

test('an alias never inherits another hostname’s verified Dradis receipt', async () => {
  const {service} = fixture();
  const qa=(await search(service,'qa.example.test')).review[0];
  await service.verifyLead(qa.id,receipt(qa));
  const related=await service.leads({query:'www.example.test'});
  assert.equal(related.leads.length,0); assert.equal(related.review.length,1);
  assert.equal(related.review[0].relatedTarget,'www.example.test');
  const prod=(await search(service,'www.example.test')).review[0];
  assert.equal(prod.domain,'www.example.test'); assert.notEqual(prod.id,qa.id);
  assert.equal(prod.reportCoverage.status,'needs_verification');
  const verified=await service.verifyLead(prod.id,receipt(prod));
  assert.equal(verified.leads.length,1); assert.equal(verified.leads[0].domain,'www.example.test');
  assert.equal((await service.leads({query:'qa.example.test'})).leads[0].domain,'qa.example.test');
});

test('URL focus uses the hostname for source search and matching instead of searching the whole URL', async () => {
  const {service,calls}=fixture();
  const found=await search(service,'https://www.example.test/api/check');
  assert.equal(found.review.length,1); assert.equal(found.review[0].domain,'www.example.test');
  const searches=calls.filter(call=>call.name==='search');
  assert.ok(searches.every(call=>call.args.query.includes('"www.example.test"')&&!call.args.query.includes('https:')));
});

test('matching saved evidence is labelled as retained when the current pass finds no new source', async () => {
  const {service,hideSearchResults}=fixture();
  await search(service,'www.example.test');
  hideSearchResults();
  const retained = await search(service,'www.example.test');
  assert.equal(retained.review.length,1); assert.equal(retained.search.found,0);
  assert.match(retained.search.reason,/Matching evidence from earlier searches/);
  // A query filter is independent of the remote search; it cannot erase stored evidence.
  const filtered=await service.leads({query:'authentication'});
  assert.equal(filtered.review.length,1); assert.equal(filtered.review[0].domain,'www.example.test');
  await assert.rejects(service.leads({query:123}),error=>error.code==='invalid_input');
});
