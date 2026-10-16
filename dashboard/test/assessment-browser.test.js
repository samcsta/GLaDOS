const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { AssessmentBrowserManager, assessmentBrowserPaths, readAssessmentBrowserManifest,
  readBrowserManifest, operatorCaSpki, resolveBrowserExecutable } = require('../lib/proxy/assessment-browser');

let certificate;
test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-browser-ca-'));
  try {
    const result = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.pem'), '-subj', '/CN=Test Proxy CA/',
      '-addext', 'basicConstraints=critical,CA:TRUE'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    certificate = fs.readFileSync(path.join(dir, 'ca.pem'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-managed-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { GLADOS_RUNTIME_DIR: root };
  fs.mkdirSync(path.join(root, 'secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'secrets', 'glados-mitm-ca.pem'), certificate, { mode: 0o600 });
  const launches = [], proxies = [], waits = [];
  let port = 34500;
  const chromium = { async launchPersistentContext(profile, options) {
    const context = new EventEmitter();
    const page = { focused: 0, async bringToFront() { this.focused++; } };
    context.pages = () => [page];
    context.close = async () => { context.closed = true; context.emit('close'); };
    launches.push({ profile, options, context, page });
    return context;
  } };
  const sessionProxies = { async ensure(sessionId) {
    proxies.push(sessionId);
    return { sessionId, proxyUrl: `http://127.0.0.1:${sessionId === 'one' ? 19001 : 19002}`, health: { healthy: true } };
  } };
  const manager = new AssessmentBrowserManager({ env, chromium, sessionProxies,
    allocatePort: async () => ++port, waitReady: async endpoint => waits.push(endpoint),
    resolveExecutable: () => '/test/chrome', ...overrides });
  t.after(() => manager.stopAll());
  return { root, env, manager, launches, proxies, waits };
}

test('the visible browser and MCP share a persistent context scoped to both session and agent', async t => {
  const f = fixture(t);
  const first = await f.manager.ensure('one', 'webapp-recon', { focus: true });
  const reused = await f.manager.ensure('one', 'webapp-recon');
  const agent = await f.manager.ensure('one', 'webapp-vuln');
  const session = await f.manager.ensure('two', 'webapp-recon');
  assert.equal(first.engine, 'Playwright Chromium');
  assert.equal(first.proxyUrl, 'http://127.0.0.1:19001');
  assert.equal(reused.reused, true);
  assert.equal(first.cdpEndpoint, reused.cdpEndpoint);
  assert.equal(f.launches.length, 3);
  assert.equal(f.launches[0].page.focused, 1);
  assert.equal(new Set([first.cdpPort, agent.cdpPort, session.cdpPort]).size, 3);
  assert.equal(new Set(f.launches.map(row => row.profile)).size, 3);
  assert.equal(f.manager.describe('one').length, 2);
  assert.equal(f.manager.describe('two').length, 1);
  const config = f.launches[0].options;
  assert.equal(config.headless, false);
  assert.equal(config.chromiumSandbox, true);
  assert.equal(config.viewport, null);
  assert.equal(config.ignoreHTTPSErrors, false);
  assert.deepEqual(config.proxy, { server: first.proxyUrl, bypass: '<-loopback>' });
  assert.deepEqual(config.extraHTTPHeaders, { 'X-GLaDOS-Agent': 'webapp-recon', 'X-GLaDOS-Session': 'one', 'X-GLaDOS-Transport': 'browser-mcp' });
  assert.ok(config.args.includes(`--remote-debugging-port=${first.cdpPort}`));
  assert.ok(config.args.includes('--remote-debugging-address=127.0.0.1'));
  const expectedPin = crypto.createHash('sha256').update(new crypto.X509Certificate(certificate).publicKey.export({ format: 'der', type: 'spki' })).digest('base64');
  assert.equal(operatorCaSpki(f.env), expectedPin);
  assert.ok(config.args.includes(`--ignore-certificate-errors-spki-list=${expectedPin}`));
  assert.ok(!config.args.includes('--ignore-certificate-errors'));
  assert.ok(!config.args.some(arg => /^https?:\/\//.test(arg)));
});

test('manifests and profiles are private, contain only connection metadata, and vanish when the browser closes', async t => {
  const f = fixture(t);
  const descriptor = await f.manager.ensure('../../one', '../../agent');
  const locations = assessmentBrowserPaths('../../one', '../../agent', f.env);
  assert.ok(locations.profile.startsWith(path.join(f.root, 'browser-mcp', 'sessions') + path.sep));
  const manifest = readAssessmentBrowserManifest('../../one', '../../agent', f.env);
  assert.equal(manifest.cdpPort, descriptor.cdpPort);
  assert.deepEqual(readBrowserManifest(f.root, '../../one', '../../agent'), manifest);
  assert.ok(!/PRIVATE KEY|secret|token|cookie|password/i.test(fs.readFileSync(locations.manifest, 'utf8')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(locations.manifest).mode & 0o777, 0o600);
    assert.equal(fs.statSync(locations.profile).mode & 0o777, 0o700);
    assert.equal(fs.statSync(locations.managedDir).mode & 0o777, 0o700);
  }
  await f.launches[0].context.close();
  assert.equal(f.manager.describe('../../one').length, 0);
  assert.equal(readAssessmentBrowserManifest('../../one', '../../agent', f.env), null);
  assert.equal(fs.existsSync(locations.profile), true);
});

test('concurrent callers launch once; stopping a session closes only its browsers and clears manifests', async t => {
  const f = fixture(t);
  await Promise.all([f.manager.ensure('one', 'agent'), f.manager.ensure('one', 'agent')]);
  assert.equal(f.launches.length, 1);
  await f.manager.ensure('two', 'agent');
  await f.manager.stopSession('one');
  assert.equal(f.launches[0].context.closed, true);
  assert.equal(f.launches[1].context.closed, undefined);
  assert.equal(readAssessmentBrowserManifest('one', 'agent', f.env), null);
  assert.equal(f.manager.describe('two').length, 1);
  await f.manager.stopAll();
  assert.equal(f.launches[1].context.closed, true);
});

test('a failed listener, missing CA, or unreachable CDP does not leave a browser or usable manifest', async t => {
  const unhealthy = fixture(t, { sessionProxies: { ensure: async sessionId => ({ sessionId, proxyUrl: 'http://127.0.0.1:19001', health: { healthy: false } }) } });
  await assert.rejects(unhealthy.manager.ensure('one', 'agent'), /healthy dedicated session proxy/);
  assert.equal(unhealthy.launches.length, 0);
  const missing = fixture(t);
  fs.rmSync(path.join(missing.root, 'secrets', 'glados-mitm-ca.pem'));
  await assert.rejects(missing.manager.ensure('one', 'agent'), /CA is unavailable/);
  assert.equal(missing.launches.length, 0);
  const failed = fixture(t, { waitReady: async () => { throw new Error('CDP unavailable'); } });
  await assert.rejects(failed.manager.ensure('one', 'agent'), /CDP unavailable/);
  assert.equal(failed.launches[0].context.closed, true);
  assert.equal(readAssessmentBrowserManifest('one', 'agent', failed.env), null);
  assert.equal(failed.manager.describe('one').length, 0);
});

test('a listener port change replaces the old browser instead of silently keeping its old proxy', async t => {
  let port = 19001;
  const f = fixture(t, { sessionProxies: { ensure: async sessionId => ({ sessionId, proxyUrl: `http://127.0.0.1:${port}`, health: { healthy: true } }) } });
  await f.manager.ensure('one', 'agent');
  port = 19002;
  const replacement = await f.manager.ensure('one', 'agent');
  assert.equal(f.launches[0].context.closed, true);
  assert.equal(f.launches.length, 2);
  assert.equal(replacement.proxyUrl, 'http://127.0.0.1:19002');
  assert.equal(readAssessmentBrowserManifest('one', 'agent', f.env).cdpPort, replacement.cdpPort);
});

test('untrusted, foreign, and stale manifest files cannot supply an auth-helper endpoint', async t => {
  const f = fixture(t);
  await f.manager.ensure('one', 'agent');
  const { manifest } = assessmentBrowserPaths('one', 'agent', f.env);
  const original = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const patch of [{ sessionId: 'two' }, { agentId: 'other' }, { cdpEndpoint: 'http://evil.example:1234' },
    { status: 'stopped' }, { managerPid: 2147483647 }, { cdpPort: 0 }]) {
    fs.writeFileSync(manifest, JSON.stringify({ ...original, ...patch }), { mode: 0o600 });
    assert.equal(readAssessmentBrowserManifest('one', 'agent', f.env), null);
  }
  fs.writeFileSync(manifest, JSON.stringify(original), { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(manifest, 0o644);
    assert.equal(readAssessmentBrowserManifest('one', 'agent', f.env), null);
  }
});

test('browser discovery honors explicit Chrome, installed Chrome, bundled Chromium, then gives an actionable error', t => {
  const f = fixture(t);
  const bundled = path.join(f.root, 'bundled-chromium');
  fs.writeFileSync(bundled, '', { mode: 0o700 });
  const chromium = { executablePath: () => bundled };
  assert.equal(resolveBrowserExecutable(chromium, { GLADOS_BROWSER_EXECUTABLE_PATH: bundled }, 'linux'), bundled);
  assert.throws(() => resolveBrowserExecutable(chromium, { GLADOS_BROWSER_EXECUTABLE_PATH: '/missing/chrome' }, 'linux'), /does not name an executable/);
  const installed = path.join(f.root, 'ChromeRoot', 'Google', 'Chrome', 'Application', 'chrome.exe');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '', { mode: 0o700 });
  assert.equal(resolveBrowserExecutable(chromium, { PROGRAMFILES: path.join(f.root, 'ChromeRoot') }, 'win32'), installed);
  assert.equal(resolveBrowserExecutable(chromium, {}, 'win32'), bundled);
  fs.rmSync(bundled);
  assert.throws(() => resolveBrowserExecutable(chromium, {}, 'win32'), /Install Google Chrome.*npx playwright install chromium/);
});
