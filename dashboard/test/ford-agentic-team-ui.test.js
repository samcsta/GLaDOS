const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const team = extra => ({ id: 'herbie', packageId: 'herbie', name: 'Herbie', agentCount: 14, installed: false, status: 'available', revision: null, dependency: { installed: false, available: false }, ...extra });

function context(extra = {}) {
  const result = vm.createContext({
    escapeHtml,
    state: { agentLibrary: { view: 'built-in', query: '', catalog: { packages: [] }, fordCatalog: null } },
    ...extra,
  });
  vm.runInContext(section('function agentPackageSummary(', 'function agentCollectionCards('), result);
  vm.runInContext(section('function fordTeamAgentRosterMarkup(', 'function wirePackageCollection('), result);
  return result;
}

test('Ford teams have their own installed tabs and are excluded from Custom Agents', () => {
  const ctx = context();
  ctx.state.agentLibrary.catalog.packages = [{ id: 'clippy-intel', name: 'Clippy' }, { id: 'herbie', name: 'Herbie', managedIntegration: true, managedSource: 'herbie.glados-agent.json' }, { id: 'my-agent', name: 'My agent' }];
  ctx.state.agentLibrary.fordCatalog = { teams: [team({ installed: true })] };
  assert.deepEqual(Array.from(ctx.customAgentPackages(ctx.state.agentLibrary.catalog), item => item.id), ['clippy-intel', 'my-agent']);
  let markup = '';
  const tabs = { set innerHTML(value) { markup = value; }, querySelectorAll: () => [] };
  ctx.drawAgentLibraryTabs({ querySelector: () => tabs });
  assert.match(markup, /Herbie Agentic Team/);
  assert.ok(markup.indexOf('GLaDOS Agentic Team') < markup.indexOf('Herbie Agentic Team'));
  assert.ok(markup.indexOf('Herbie Agentic Team') < markup.indexOf('Custom Agents'));
  assert.match(markup, /data-package-count>2</);
  ctx.state.agentLibrary.catalog.packages = [{ id: 'clippy-intel', name: 'Clippy' }];
  ctx.drawAgentLibraryTabs({ querySelector: () => tabs });
  assert.doesNotMatch(markup, /Herbie Agentic Team/);
  ctx.state.agentLibrary.catalog.packages.push({ id: 'herbie', name: 'My own Herbie' });
  ctx.state.agentLibrary.fordCatalog = { teams: [team({ status: 'conflict', installed: false, conflictingPackage: true })] };
  ctx.drawAgentLibraryTabs({ querySelector: () => tabs });
  assert.doesNotMatch(markup, /Herbie Agentic Team/);
  assert.equal(ctx.customAgentPackages(ctx.state.agentLibrary.catalog).length, 2);
});

test('catalog distinguishes optional, pending, failed, installed and future teams', () => {
  const ctx = context();
  assert.match(ctx.fordAgenticTeamCatalogMarkup({ teams: [team()] }), /data-install-ford-team="herbie"[^>]*>Install Herbie/);
  const automatic = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ dependency: { installed: false, canInstall: true, manager: 'brew', remediation: 'Install Homebrew before retrying.' } })] });
  assert.doesNotMatch(automatic, /Install Homebrew before retrying/);
  const missingManager = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ dependency: { installed: false, canInstall: false, remediation: 'Install Homebrew before retrying.' } })] });
  assert.match(missingManager, /Install Homebrew before retrying/);
  const pending = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ status: 'installing', installation: { state: 'installing', message: 'Downloading tshark…' } })] });
  assert.match(pending, /Downloading tshark…/);
  assert.match(pending, /data-install-ford-team="herbie" disabled/);
  const failed = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ status: 'failed', dependency: { installed: false, reason: 'TShark will be installed when you choose Install Herbie.' }, installation: { state: 'failed', error: '<Permission required>', remediation: 'Install Wireshark, then retry.' } })] });
  assert.match(failed, /&lt;Permission required&gt;/);
  assert.match(failed, /Install Wireshark, then retry/);
  assert.match(failed, /Retry installation/);
  assert.doesNotMatch(failed, /TShark will be installed when you choose/);
  assert.doesNotMatch(failed, /data-open-ford-team/);
  const missingTool = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ installed: true, status: 'installed' })] });
  assert.match(missingTool, /Set up tshark/);
  assert.doesNotMatch(missingTool, /data-open-ford-team/);
  const ready = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ installed: true, status: 'installed', dependency: { installed: true } })] });
  assert.match(ready, /14 agents installed/);
  assert.match(ready, /data-open-ford-team="herbie"/);
  const future = ctx.fordAgenticTeamCatalogMarkup({ teams: [{ id: 'jarvis', name: 'Jarvis', comingSoon: true }, { id: 'chappie', name: 'Chappie', status: 'coming-soon' }] });
  assert.equal((future.match(/<button type="button" disabled>Coming soon/g) || []).length, 2);
  assert.doesNotMatch(future, /data-install-ford-team/);
  const conflict = ctx.fordAgenticTeamCatalogMarkup({ teams: [team({ status: 'conflict', conflictingPackage: true, canInstall: false, error: 'A custom package already uses herbie.' })] });
  assert.match(conflict, /A custom package already uses herbie/);
  assert.match(conflict, /disabled>Resolve package conflict/);
  assert.doesNotMatch(conflict, /data-install-ford-team/);
});

test('the Herbie roster exposes every agent directly and preserves inherited models', () => {
  const ctx = context();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates/integrated-teams/herbie.glados-agent.json')));
  const markup = ctx.fordTeamAgentRosterMarkup(manifest, 'coordinator');
  assert.equal((markup.match(/data-ford-roster-agent=/g) || []).length, 14);
  for (const agent of manifest.agents) assert.ok(markup.includes(`data-ford-roster-agent="${agent.id}"`));
  assert.match(markup, /data-ford-roster-agent="coordinator" aria-pressed="true"/);
  assert.match(markup, /Use current model/);
  assert.match(markup, /Coordinator/);
});

function element() {
  return { isConnected: true, innerHTML: '', textContent: '', disabled: false, listeners: {}, classList: { add() {}, remove() {} }, addEventListener(event, handler) { this.listeners[event] = handler; } };
}

function dialogFixture({ succeeds = false, initialRunning = false } = {}) {
  const target = element(), status = element(), closeButton = element();
  target.querySelectorAll = selector => {
    const key = selector.match(/\[([^\]]+)\]/)[1];
    const matches = [...target.innerHTML.matchAll(new RegExp(`${key}="([^"]+)"`, 'g'))];
    const camel = key.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    return matches.map(match => ({ ...element(), dataset: { [camel]: match[1] } }));
  };
  const buttons = new Map();
  const baseQueryAll = target.querySelectorAll;
  target.querySelectorAll = selector => { const result = baseQueryAll(selector); buttons.set(selector, result); return result; };
  const backdrop = element();
  backdrop.querySelector = selector => ({ '[data-ford-team-catalog]': target, '[data-ford-team-status]': status, '[data-ford-teams-close]': closeButton })[selector];
  const requests = [], timers = [];
  let posted = false, loads = 0, draws = 0;
  const idle = team({ revision: 'archived-revision' });
  const running = team({ revision: 'archived-revision', status: 'installing', installation: { state: 'installing', message: 'Setting up tshark…' } });
  const terminal = succeeds ? team({ installed: true, status: 'installed', dependency: { installed: true }, installation: { state: 'installed' } }) : team({ status: 'failed', installation: { state: 'failed', error: 'tshark setup requires system permission.' } });
  const ctx = context({
    document: { createElement: () => backdrop, getElementById: () => ({ appendChild() {} }) },
    setTimeout: handler => { const timer = { handler, cancelled: false }; timers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cancelled = true; },
    prepareCollectionDialog: (_backdrop, { onClose }) => () => { backdrop.isConnected = false; onClose(); },
    fetchJson: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === 'POST') { posted = true; return { ok: true, teams: [running], team: running }; }
      if (url === '/api/agent-packages') return { packages: [{ id: 'herbie', name: 'Herbie' }] };
      return { ok: true, teams: [posted ? terminal : initialRunning ? running : idle] };
    },
    loadAgentTeams: async () => { loads++; }, loadAgents: async () => { loads++; },
    drawAgentsLibrary: () => { draws++; },
    confirmAgentPackageDiscard: async () => true,
  });
  // This isolated dialog test does not need a real Agents pane.
  ctx.drawAgentsLibrary = () => { draws++; };
  ctx.openFordAgenticTeams({ isConnected: true });
  return { ctx, target, status, backdrop, requests, buttons, timers, closeButton, get loads() { return loads; }, get draws() { return draws; } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a failed dependency install does not report success or add a team tab', async () => {
  const fixture = dialogFixture();
  await settle();
  await fixture.buttons.get('[data-install-ford-team]')[0].listeners.click();
  assert.match(fixture.status.textContent, /tshark setup requires system permission/);
  assert.match(fixture.target.innerHTML, /Retry installation/);
  assert.doesNotMatch(fixture.target.innerHTML, /data-open-ford-team/);
  assert.equal(fixture.loads, 0);
  assert.equal(fixture.draws, 0);
  const post = fixture.requests.find(request => request.options.method === 'POST');
  assert.equal(post.url, '/api/ford-rt-teams/herbie/install');
  assert.equal(JSON.parse(post.options.body).expectedRevision, 'archived-revision');
});

test('verified installation refreshes agents and teams before announcing completion', async () => {
  const fixture = dialogFixture({ succeeds: true });
  await settle();
  await fixture.buttons.get('[data-install-ford-team]')[0].listeners.click();
  assert.equal(fixture.loads, 2);
  assert.equal(fixture.draws, 1);
  assert.match(fixture.status.textContent, /Herbie installed/);
  assert.match(fixture.target.innerHTML, /data-open-ford-team="herbie"/);
  assert.equal(fixture.ctx.state.agentLibrary.catalog.packages[0].id, 'herbie');
});

test('closing the catalog cancels further UI polling without cancelling the server install', async () => {
  const fixture = dialogFixture({ initialRunning: true });
  await settle();
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].cancelled, false);
  fixture.closeButton.listeners.click();
  assert.equal(fixture.timers[0].cancelled, true);
  assert.equal(fixture.backdrop.isConnected, false);
  assert.equal(fixture.requests.filter(request => request.options.method === 'DELETE').length, 0);
  assert.equal(fixture.loads, 0);
});
