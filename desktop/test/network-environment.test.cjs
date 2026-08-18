const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  appendNodeOptions,
  mergeNoProxy,
  proxyUrlFromPacResult,
  systemNetworkEnvironment,
} = require('../lib/network-environment.cjs');

test('dashboard Node processes use the macOS trust store and environment proxy support', async () => {
  const env = await systemNetworkEnvironment({
    env: { NODE_OPTIONS: '--trace-warnings', NO_PROXY: 'internal.example.test' },
    url: 'https://gateway.example.test',
    resolveProxy: async () => 'PROXY proxy.example.test:8080; DIRECT',
  });
  assert.equal(env.NODE_OPTIONS, '--trace-warnings --use-system-ca --use-env-proxy');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example.test:8080');
  assert.equal(env.HTTP_PROXY, 'http://proxy.example.test:8080');
  assert.equal(env.NO_PROXY, 'internal.example.test,127.0.0.1,localhost,::1');
});

test('explicit proxy configuration wins and required flags are not duplicated', async () => {
  let resolved = false;
  const env = await systemNetworkEnvironment({
    env: {
      HTTPS_PROXY: 'http://explicit.example.test:3128',
      NODE_OPTIONS: '--use-system-ca --use-env-proxy',
      no_proxy: 'localhost',
    },
    url: 'https://gateway.example.test',
    resolveProxy: async () => { resolved = true; return 'DIRECT'; },
  });
  assert.equal(resolved, false);
  assert.equal(env.NODE_OPTIONS, '--use-system-ca --use-env-proxy');
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('PAC proxy directives and bypass helpers are normalized safely', () => {
  assert.equal(proxyUrlFromPacResult('DIRECT'), null);
  assert.equal(proxyUrlFromPacResult('HTTPS secure-proxy.test:8443; DIRECT'), 'https://secure-proxy.test:8443');
  assert.equal(proxyUrlFromPacResult('SOCKS5 socks.test:1080'), 'socks5://socks.test:1080');
  assert.equal(appendNodeOptions(''), '--use-system-ca --use-env-proxy');
  assert.equal(mergeNoProxy('127.0.0.1'), '127.0.0.1,localhost,::1');
});

test('desktop setup verification uses Electron networking and exports resolved proxy settings to the dashboard', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /session\.defaultSession\.resolveProxy/);
  assert.match(main, /fetchImpl:\s*\(url, options\) => net\.fetch\(url, options\)/);
  assert.match(main, /\.\.\.dashboardNetworkEnv/);
});

test('desktop supervises unexpected dashboard exits with bounded restart backoff and durable logs', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /function scheduleDashboardRestart/);
  assert.match(main, /Math\.min\(30_000/);
  assert.match(main, /dashboardRestartTimer/);
  assert.match(main, /dashboard\.log/);
  assert.match(main, /if \(unexpected\) scheduleDashboardRestart/);
  assert.match(main, /restarting: true/);
  assert.match(main, /dashboardOrigin = new URL\(url\)\.origin;[\s\S]*mainWindow\.loadURL\(url\)/);
  assert.match(main, /if \(retryError\) scheduleDashboardRestart\(\{ error: retryError \}\)/);
  assert.match(main, /dashboard exited before startup completed/);
});

test('desktop exposes a loopback dashboard health fallback independent of renderer networking', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
  assert.match(main, /desktop:dashboard:health/);
  assert.match(main, /dashboardJson\('\/api\/health\/proxy', \{ timeoutMs: 5000 \}\)/);
  assert.match(preload, /getDashboardHealth/);
  assert.match(preload, /ipcRenderer\.invoke\('desktop:dashboard:health'\)/);
});
