const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function reviewContext(extra = {}) {
  const context = vm.createContext({
    escapeHtml, clearTimeout, setTimeout,
    clippySeverity: value => value || 'unknown',
    clippyCollection: (result, key) => result[key] || [],
    ...extra,
  });
  vm.runInContext(section('function clippyLeadPrompt(', 'async function openClippyLeadSource('), context);
  return context;
}

test('source-review cards and chat handoff use the assessed repository and commit without inferring a hostname', () => {
  const context = reviewContext();
  const commit = '672c143dff6d5331af110e2611fd5f969f646f6f';
  const item = { id: 'source', domain: null, targetKind: 'source', targetLabel: 'example/deploy', repository: 'example/deploy', commit, scope: `example/deploy@${commit}`, title: '<Historical code finding>', evidenceDate: '2026-08-31', reportCoverage: { status: 'needs_verification' } };
  const card = context.clippyLeadCard(item, 0, { review: true });
  assert.match(card, /Source review · example\/deploy/);
  assert.ok(card.includes(commit));
  assert.match(card, /Deployment and current exploitability unverified/);
  assert.match(card, /Historical evidence date: 2026-08-31/);
  assert.match(card, /&lt;Historical code finding&gt;/);
  assert.doesNotMatch(card, /Target unverified|>null</);
  const prompt = context.clippyLeadPrompt(item);
  assert.match(prompt, /Target kind: Source code review; deployment unverified/);
  assert.ok(prompt.includes(`Exact scope: example/deploy@${commit}`));
  assert.match(prompt, /Do not infer a live hostname/);
  assert.match(prompt, /Clippy MCP cannot establish complete current Dradis coverage/);
});

test('fuzzy report matches can be reviewed while confirmed tied reports stay excluded', () => {
  const context = reviewContext();
  const item = { id: 'network', domain: 'portal.example.test', reportCoverage: { status: 'reported', projects: [{ matchId: 'p-1', name: 'Similar project', status: 'Delivered' }] } };
  const card = context.clippyLeadCard(item, 0, { review: true });
  assert.match(card, /possible Dradis matches need a direct analyst check/);
  assert.match(card, /data-clippy-record-coverage/);
  assert.doesNotMatch(card, /data-clippy-save-lead/);
  assert.equal(context.clippyLeadCollections({ leads: [item] }).ready.length, 0);
  item.reportCoverage.confirmedTie = true;
  assert.match(context.clippyLeadCard(item, 0, { review: true }), /Excluded: an analyst identified a tied Dradis report/);
  assert.doesNotMatch(context.clippyLeadCard(item, 0, { review: true }), /data-clippy-record-coverage/);
  context.openClippyCoverageCheck({}, item); // No document exists: must return before any mutation.
  item.reportCoverage.status = 'no_report_verified';
  assert.equal(context.clippyLeadCollections({ leads: [item] }).ready.length, 0, 'a confirmed tie cannot be promoted by an inconsistent status');
});

test('candidate evidence opens by default when no ready lead exists and preserves an explicit collapse', async () => {
  const content = { isConnected: true, innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const status = { innerHTML: '', querySelector: () => null };
  const elements = { '[data-clippy-leads-content]': content, '[data-clippy-lead-status]': status, '[data-clippy-find-leads]': {} };
  const result = { leads: [], review: [{ id: 'candidate', targetKind: 'source', targetLabel: 'example/deploy', commit: 'a'.repeat(40), reportCoverage: { status: 'needs_verification' } }], search: { state: 'idle' } };
  const context = reviewContext({
    state: { clippyDashboard: { view: 'leads' } },
    clippyViewAlive: () => true, clippyRead: async () => result,
    wireClippyAgentButton() {}, clippyEmpty: () => '<div class="clippy-empty">Empty</div>',
  });
  const view = { wrap: { querySelector: selector => elements[selector] } };
  await context.loadClippyLeads(view);
  assert.match(content.innerHTML, /data-clippy-review-list open/);
  assert.match(content.innerHTML, /Evidence to review/);
  assert.match(content.innerHTML, /No verified ready leads yet/);
  assert.doesNotMatch(content.innerHTML, /class="clippy-empty"/);
  view.reviewExpanded = false;
  result.review[0].why = 'Updated evidence';
  await context.loadClippyLeads(view);
  assert.match(content.innerHTML, /data-clippy-review-list>/);
  assert.doesNotMatch(content.innerHTML, /data-clippy-review-list open/);
});

function coverageFixture(item, { fail = false } = {}) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', checked: false, disabled: false, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(selector);
  };
  const backdrop = { isConnected: true, innerHTML: '', querySelector: element };
  const requests = [];
  let refreshed = 0;
  let closed = 0;
  const context = reviewContext({
    document: { createElement: () => backdrop, getElementById: () => ({ appendChild() {} }) },
    prepareCollectionDialog: (_backdrop, { onClose }) => () => { closed++; onClose(); },
    packageApi: async (...args) => { requests.push(args); if (fail) throw new Error('Matching projects changed.'); return {}; },
  });
  context.loadClippyLeads = async () => { refreshed++; };
  context.openClippyCoverageCheck({}, item);
  return { context, backdrop, requests, element, get refreshed() { return refreshed; }, get closed() { return closed; } };
}

function fillCoverage(fixture, count) {
  fixture.element('[data-clippy-coverage-url]').value = 'https://dradis.example.test/projects';
  fixture.element('[data-clippy-coverage-notes]').value = 'Checked exact repository, commit, source IDs and complete project report inventory.';
  fixture.element('[data-clippy-coverage-confirm]').checked = true;
  for (let index = 0; index < count; index++) {
    fixture.element(`[data-clippy-project-disposition="${index}"]`).value = 'unrelated';
    fixture.element(`[data-clippy-project-notes="${index}"]`).value = `Project ${index} covers a different target and unrelated finding identifiers.`;
  }
}

const coverageItem = () => ({
  id: 'candidate', targetKind: 'source', repository: 'example/deploy', scope: `example/deploy@${'a'.repeat(40)}`, evidenceDigest: 'evidence-current',
  reportCoverage: { status: 'reported', matchDigest: 'matches-current', projects: [{ matchId: 'project-1', name: '<Possible project>', status: 'Delivered' }, { matchId: 'project-2', name: 'Another project', status: 'Draft' }] },
});

test('every possible match requires an explicit unrelated disposition and supporting notes before a receipt', async () => {
  const fixture = coverageFixture(coverageItem());
  assert.match(fixture.backdrop.innerHTML, /Clippy MCP does not provide complete current Dradis report coverage/);
  assert.match(fixture.backdrop.innerHTML, /href="https:\/\/dradistab\.redteamstuff\.com\/\?filter=deploy"/);
  assert.match(fixture.backdrop.innerHTML, /data-clippy-coverage-url value="https:\/\/dradistab\.redteamstuff\.com\/\?filter=deploy"/);
  assert.doesNotMatch(fixture.backdrop.innerHTML, /filter=deploy%40|data-clippy-coverage-confirm checked/);
  assert.match(fixture.backdrop.innerHTML, /&lt;Possible project&gt;/);
  assert.equal((fixture.backdrop.innerHTML.match(/value="" selected>Choose after checking Dradis/g) || []).length, 2);
  assert.doesNotMatch(fixture.backdrop.innerHTML, /value="unrelated" selected/);
  const form = fixture.element('[data-clippy-coverage-form]');
  fixture.element('[data-clippy-coverage-confirm]').checked = true;
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(fixture.requests.length, 0);
  fillCoverage(fixture, 2);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(fixture.requests.length, 1);
  const [method, route, payload] = fixture.requests[0];
  assert.equal(method, 'POST');
  assert.equal(route, '/api/clippy/leads/candidate/coverage');
  assert.equal(payload.scope, `example/deploy@${'a'.repeat(40)}`);
  assert.equal(payload.matchDigest, 'matches-current');
  assert.equal(payload.evidenceDigest, 'evidence-current');
  assert.deepEqual(Array.from(payload.projectDispositions, row => ({ ...row })), [
    { matchId: 'project-1', disposition: 'unrelated', notes: 'Project 0 covers a different target and unrelated finding identifiers.' },
    { matchId: 'project-2', disposition: 'unrelated', notes: 'Project 1 covers a different target and unrelated finding identifiers.' },
  ]);
  assert.equal(fixture.refreshed, 1);
  assert.equal(fixture.closed, 1);
});

test('tied and unknown relationships can be saved without making a negative report attestation', async () => {
  for (const disposition of ['tied', 'unknown']) {
    const fixture = coverageFixture(coverageItem());
    fillCoverage(fixture, 2);
    fixture.element('[data-clippy-project-disposition="1"]').value = disposition;
    fixture.element('[data-clippy-project-notes="1"]').value = 'Checked the exact project scope and retained the observed report relationship.';
    const form = fixture.element('[data-clippy-coverage-form]');
    form.listeners.change();
    assert.equal(fixture.element('[type="submit"]').textContent, 'Record relationship');
    assert.equal(fixture.element('[data-clippy-coverage-confirm]').checked, false);
    assert.equal(fixture.element('[data-clippy-coverage-confirm]').disabled, true);
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(fixture.requests.length, 1);
    const payload = fixture.requests[0][2];
    assert.equal(payload.noReport, false);
    assert.equal(payload.projectDispositions[1].disposition, disposition);
    assert.equal(fixture.refreshed, 1);
    assert.equal(fixture.closed, 1);
  }
});

test('changing an excluded relationship to unrelated requires a new explicit no-report confirmation', async () => {
  const fixture = coverageFixture(coverageItem());
  fillCoverage(fixture, 2);
  const form = fixture.element('[data-clippy-coverage-form]');
  fixture.element('[data-clippy-project-disposition="1"]').value = 'tied';
  form.listeners.change();
  fixture.element('[data-clippy-project-disposition="1"]').value = 'unrelated';
  form.listeners.change();
  assert.equal(fixture.element('[type="submit"]').textContent, 'Record check');
  assert.equal(fixture.element('[data-clippy-coverage-confirm]').disabled, false);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(fixture.requests.length, 0);
  fixture.element('[data-clippy-coverage-confirm]').checked = true;
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(fixture.requests[0][2].noReport, true);
});

test('incomplete matching inventory cannot record a verified receipt', async () => {
  const item = coverageItem();
  item.reportCoverage.partial = true;
  const fixture = coverageFixture(item);
  fillCoverage(fixture, 2);
  await fixture.element('[data-clippy-coverage-form]').listeners.submit({ preventDefault() {} });
  assert.equal(fixture.requests.length, 0);
  assert.match(fixture.backdrop.innerHTML, /matching inventory can be rechecked completely/);
});

test('an incomplete feed can retain a known relationship while withholding readiness', async () => {
  const item = coverageItem();
  item.reportCoverage.partial = true;
  const fixture = coverageFixture(item);
  fillCoverage(fixture, 2);
  fixture.element('[data-clippy-project-disposition="1"]').value = 'unknown';
  await fixture.element('[data-clippy-coverage-form]').listeners.submit({ preventDefault() {} });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0][2].noReport, false);
  assert.equal(fixture.requests[0][2].projectDispositions[1].disposition, 'unknown');
});

test('a changed match set refreshes the review collection and asks for the current check to be reopened', async () => {
  const fixture = coverageFixture(coverageItem(), { fail: true });
  fillCoverage(fixture, 2);
  await fixture.element('[data-clippy-coverage-form]').listeners.submit({ preventDefault() {} });
  assert.equal(fixture.refreshed, 1);
  assert.equal(fixture.closed, 0);
  assert.match(fixture.element('[data-clippy-coverage-status]').textContent, /Matching projects changed.*Close and reopen/);
  assert.equal(fixture.element('[type="submit"]').disabled, true);
});

test('focused results offer explicit source-backed spelling choices and hide unrelated history', async () => {
  const content={isConnected:true,innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
  const suggestion={dataset:{clippySuggestedDomain:'www.example.test'},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}};
  const clear={listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}};
  const status={innerHTML:'',querySelector:selector=>selector==='[data-clippy-clear-lead-focus]'?clear:null,querySelectorAll:()=>[suggestion]};
  const input={value:'www.exampel.test'}; let submitted=0;
  const fields={'[data-clippy-leads-content]':content,'[data-clippy-lead-status]':status,'[data-clippy-find-leads]':{},'[data-clippy-lead-query]':input,'[data-clippy-lead-search]':{requestSubmit(){submitted++;}}};
  const reads=[];
  const context=reviewContext({state:{clippyDashboard:{view:'leads',leadQuery:input.value}},clippyViewAlive:()=>true,
    clippyRead:async(_view,url)=>{reads.push(url);return{leads:[],review:[],query:'www.exampel.test',suggestions:['www.example.test'],retainedElsewhere:2,search:{state:'complete',reason:'No finding documents matched.'}};},
    wireClippyAgentButton(){},clippyEmpty:()=>'<div>Nothing matched this search</div>',
  });
  const view={wrap:{querySelector:selector=>fields[selector]}};
  await context.loadClippyLeads(view);
  assert.equal(reads[0],'/leads?query=www.exampel.test');
  assert.match(status.innerHTML,/Similar hostname found in source evidence/);
  assert.match(status.innerHTML,/Search www.example.test/);
  assert.match(status.innerHTML,/2 earlier candidates outside this search are hidden/);
  assert.equal(context.state.clippyDashboard.leadQuery,'www.exampel.test');
  assert.equal(submitted,0,'A spelling correction must not run silently');
  suggestion.listeners.click();
  assert.equal(context.state.clippyDashboard.leadQuery,'www.example.test');
  assert.equal(input.value,'www.example.test'); assert.equal(submitted,1);
});

test('a related hostname card cannot promote or attest another hostname’s report receipt', () => {
  const context=reviewContext();
  const item={id:'qa',domain:'qa.example.test',scope:'qa.example.test',relatedTarget:'www.example.test',reportCoverage:{status:'no_report_verified',kind:'analyst_attestation'}};
  assert.equal(context.clippyLeadCollections({leads:[item]}).ready.length,0);
  const card=context.clippyLeadCard(item,0,{review:true});
  assert.match(card,/This source also lists www.example.test/);
  assert.match(card,/exact scope is qa.example.test/);
  assert.doesNotMatch(card,/data-clippy-record-coverage/);
});
