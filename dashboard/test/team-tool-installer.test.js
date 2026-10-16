const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTsharkInstaller, discoverTsharkSync, discoverTsharkAsync, applyTsharkEnvironment, installPlan, runCommand } = require('../lib/team-tool-installer');

function fixture(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-team-tools-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return { runtimeDir, env: { HOME: runtimeDir, PATH: '/usr/bin:/bin' } };
}
const absent = () => ({ id: 'tshark', installed: false, available: false, path: null, version: null, manager: null });
const detected = filename => ({ id: 'tshark', installed: true, available: true, path: filename, version: '4.6.9', manager: 'existing' });
const finder = mapping => name => mapping[name] || null;

test('discovery verifies the version and exposes an explicit path to GUI-launched shells', t => {
  const f = fixture(t);
  const bin = path.join(f.runtimeDir, 'tools with spaces', 'tshark');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "TShark (Wireshark) 4.6.9 (fixture)\\n"\n', { mode: 0o700 });
  const env = { ...f.env, GLADOS_TSHARK_PATH: bin };
  const status = discoverTsharkSync({ ...f, env, refresh: true });
  assert.equal(status.path, bin);
  assert.equal(status.version, '4.6.9');
  const shellEnv = applyTsharkEnvironment(env, f);
  assert.equal(shellEnv.GLADOS_TSHARK_PATH, bin);
  assert.equal(shellEnv.PATH.split(path.delimiter)[0], path.dirname(bin));
  assert.equal(env.PATH, '/usr/bin:/bin', 'caller environment is not mutated');
});

test('constructing or checking an installer never runs a package manager', async t => {
  const f = fixture(t);
  const calls = [];
  const installer = createTsharkInstaller({ ...f, platform: 'darwin', discover: absent, find: finder({ brew: '/opt/homebrew/bin/brew' }), run: async (...args) => calls.push(args) });
  assert.equal((await installer.status()).installed, false);
  assert.equal((await installer.status()).canInstall, true);
  assert.deepEqual(calls, []);
});

test('an already available tool is reused without install or capture setup', async t => {
  const f = fixture(t);
  let calls = 0;
  const tool = path.join(f.runtimeDir, 'tshark');
  const installer = createTsharkInstaller({ ...f, discover: () => detected(tool), run: async () => calls++ });
  assert.equal((await installer.install()).path, tool);
  assert.equal(calls, 0);
});

test('macOS explicitly installs the CLI formula, verifies it, and records only the tool path', async t => {
  const f = fixture(t);
  let available = false;
  const tool = path.join(f.runtimeDir, 'bin', 'tshark');
  const calls = [];
  const events = [];
  const installer = createTsharkInstaller({ ...f, platform: 'darwin', find: finder({ brew: '/opt/homebrew/bin/brew' }), discover: () => available ? detected(tool) : absent(), run: async (command, args, options) => {
    calls.push({ command, args, options }); available = true; return { code: 0 };
  } });
  const answer = await installer.install({ onProgress: event => events.push(event) });
  assert.equal(answer.installed, true);
  assert.equal(answer.manager, 'brew');
  assert.deepEqual(calls[0].args, ['install', '--formula', 'wireshark']);
  assert.equal(calls[0].options.env.NONINTERACTIVE, '1');
  assert.equal(calls[0].options.env.HOMEBREW_NO_AUTO_UPDATE, '1');
  assert.equal(calls[0].options.timeoutMs, 600000);
  assert.deepEqual(events.map(row => row.phase), ['checking', 'installing', 'verifying', 'complete']);
  const filename = path.join(f.runtimeDir, 'tools', 'tshark.json');
  const record = JSON.parse(fs.readFileSync(filename));
  assert.equal(record.path, tool);
  assert.equal(record.manager, 'brew');
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('failed or unverified installations never claim success or write a receipt', async t => {
  for (const exitCode of [1, 0]) {
    const f = fixture(t);
    const installer = createTsharkInstaller({ ...f, platform: 'darwin', find: finder({ brew: '/opt/homebrew/bin/brew' }), discover: absent, run: async () => ({ code: exitCode }) });
    await assert.rejects(installer.install(), error => error.code === (exitCode ? 'INSTALL_FAILED' : 'TSHARK_NOT_FOUND') && /retry/i.test(error.remediation));
    assert.equal(fs.existsSync(path.join(f.runtimeDir, 'tools', 'tshark.json')), false);
  }
});

test('Linux sudo fallback is noninteractive and stops before installation if credentials are unavailable', async t => {
  const f = fixture(t);
  const calls = [];
  const installer = createTsharkInstaller({ ...f, platform: 'linux', getuid: () => 1000, discover: absent,
    find: finder({ 'apt-get': '/usr/bin/apt-get', sudo: '/usr/bin/sudo', timeout: '/usr/bin/timeout' }), run: async (command, args) => { calls.push({ command, args }); return { code: 1 }; } });
  await assert.rejects(installer.install(), error => error.code === 'ADMIN_REQUIRED' && /sudo apt-get install tshark/.test(error.remediation));
  assert.deepEqual(calls, [{ command: '/usr/bin/sudo', args: ['-n', '-v'] }]);
});

test('Linux cached sudo installation passes only fixed argument arrays and no capture group commands', async t => {
  const f = fixture(t);
  let available = false;
  const calls = [];
  const installer = createTsharkInstaller({ ...f, platform: 'linux', getuid: () => 1000, discover: () => available ? detected('/usr/bin/tshark') : absent(),
    find: finder({ 'apt-get': '/usr/bin/apt-get', sudo: '/usr/bin/sudo', timeout: '/usr/bin/timeout' }), run: async (command, args) => { calls.push({ command, args }); if (calls.length === 2) available = true; return { code: 0 }; } });
  assert.equal((await installer.install()).installed, true);
  assert.deepEqual(calls[1], { command: '/usr/bin/sudo', args: ['-n', '--', '/usr/bin/timeout', '--kill-after=5s', '600s', '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'APT_LISTCHANGES_FRONTEND=none', '/usr/bin/apt-get', '-y', '-o', 'DPkg::Lock::Timeout=30', '--no-install-recommends', 'install', 'tshark'] });
  assert.doesNotMatch(JSON.stringify(calls), /usermod|setcap|chmod|ChmodBPF|dumpcap/);
});

test('desktop Linux uses the system authorization dialog without a textual fallback', async t => {
  const f = fixture(t);
  let available = false;
  const calls = [];
  const events = [];
  const installer = createTsharkInstaller({ ...f, env: { ...f.env, WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux', getuid: () => 1000,
    discover: () => available ? detected('/usr/bin/tshark') : absent(), find: finder({ dnf: '/usr/bin/dnf', pkexec: '/usr/bin/pkexec', timeout: '/usr/bin/timeout' }),
    run: async (command, args) => { calls.push({ command, args }); available = true; return { code: 0 }; } });
  await installer.install({ onProgress: row => events.push(row) });
  assert.equal(calls[0].command, '/usr/bin/pkexec');
  assert.deepEqual(calls[0].args, ['--disable-internal-agent', '/usr/bin/timeout', '--kill-after=5s', '600s', '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'APT_LISTCHANGES_FRONTEND=none', '/usr/bin/dnf', '-y', 'install', 'wireshark-cli']);
  assert.ok(events.some(row => row.phase === 'authorizing'));
});

test('cancelled system authorization cannot install the team dependency', async t => {
  const f = fixture(t);
  const installer = createTsharkInstaller({ ...f, env: { ...f.env, DISPLAY: ':0' }, platform: 'linux', getuid: () => 1000, discover: absent,
    find: finder({ 'apt-get': '/usr/bin/apt-get', pkexec: '/usr/bin/pkexec', timeout: '/usr/bin/timeout' }), run: async () => ({ code: 126 }) });
  await assert.rejects(installer.install(), error => error.code === 'ADMIN_REQUIRED' && /cancelled/.test(error.message));
});

test('unsupported platforms and missing managers fail with an actionable route and no download', async t => {
  const f = fixture(t);
  let calls = 0;
  const installer = createTsharkInstaller({ ...f, platform: 'darwin', discover: absent, find: finder({}), run: async () => calls++ });
  await assert.rejects(installer.install(), error => error.code === 'PACKAGE_MANAGER_UNAVAILABLE' && /brew.sh/.test(error.remediation));
  assert.equal(calls, 0);
  assert.equal(installPlan({ env: f.env, platform: 'win32', find: finder({}) }), null);
});

test('duplicate install requests share the same operation', async t => {
  const f = fixture(t);
  let available = false;
  let resume;
  let calls = 0;
  const installer = createTsharkInstaller({ ...f, platform: 'darwin', discover: () => available ? detected('/opt/homebrew/bin/tshark') : absent(), find: finder({ brew: '/opt/homebrew/bin/brew' }), run: async () => { calls++; await new Promise(resolve => { resume = resolve; }); available = true; return { code: 0 }; } });
  const one = installer.install();
  const two = installer.install();
  assert.equal(one, two);
  await new Promise(resolve => setImmediate(resolve));
  resume();
  await one;
  assert.equal(calls, 1);
});

test('installation verifies a slow first launch asynchronously and reuses it without a package manager', async t => {
  const f = fixture(t);
  const bin = path.join(f.runtimeDir, 'tshark');
  fs.writeFileSync(bin, '#!/bin/sh\n/bin/sleep 2.2\nprintf "TShark (Wireshark) 4.6.9 (cold launch fixture)\\n"\n', { mode: 0o700 });
  const env = { ...f.env, GLADOS_TSHARK_PATH: bin };
  let ticks = 0;
  let managers = 0;
  const timer = setInterval(() => ticks++, 20);
  t.after(() => clearInterval(timer));
  const installer = createTsharkInstaller({ ...f, env, find: () => { managers++; return null; } });
  const result = await installer.install();
  assert.equal(result.installed, true);
  assert.equal(result.version, '4.6.9');
  assert.equal(managers, 0);
  assert.ok(ticks > 10, 'the dashboard event loop remains responsive during the probe');
  const record = JSON.parse(fs.readFileSync(path.join(f.runtimeDir, 'tools/tshark.json')));
  assert.equal(record.path, bin);
  assert.equal(record.manager, 'existing');
  assert.equal(installer.environment().GLADOS_TSHARK_PATH, bin);
});

test('asynchronous version verification remains bounded and never accepts an invalid banner', async t => {
  const f = fixture(t);
  const bin = path.join(f.runtimeDir, 'tshark');
  fs.writeFileSync(bin, '#!/bin/sh\n/bin/sleep 1\nprintf "TShark (Wireshark) 4.6.9\\n"\n', { mode: 0o700 });
  const env = { ...f.env, GLADOS_TSHARK_PATH: bin };
  assert.equal((await discoverTsharkAsync({ ...f, env, timeoutMs: 40, candidates: () => [bin] })).installed, false);
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "not a verified packet tool\\n"\n', { mode: 0o700 });
  assert.equal((await discoverTsharkAsync({ ...f, env, timeoutMs: 1000, candidates: () => [bin] })).installed, false);
});

test('a newly installed tool uses the asynchronous verifier before activation', async t => {
  const f = fixture(t);
  const bin = path.join(f.runtimeDir, 'tshark');
  const env = { ...f.env, GLADOS_TSHARK_PATH: bin };
  let installs = 0;
  const installer = createTsharkInstaller({ ...f, env, platform: 'darwin', discover: absent,
    verify: options => discoverTsharkAsync({ ...options, candidates: () => [bin] }),
    find: finder({ brew: '/opt/homebrew/bin/brew' }), run: async () => {
      installs++;
      fs.writeFileSync(bin, '#!/bin/sh\n/bin/sleep 0.1\nprintf "TShark (Wireshark) 4.6.9\\n"\n', { mode: 0o700 });
      return { code: 0 };
    } });
  assert.equal((await installer.install()).version, '4.6.9');
  assert.equal(installs, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtimeDir, 'tools/tshark.json'))).manager, 'brew');
});

test('actual process runner bounds hangs and accepts cancellation without a shell', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, timeoutMs: 50 }), error => error.code === 'INSTALL_TIMEOUT');
  const controller = new AbortController();
  const running = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, error => error.code === 'INSTALL_CANCELLED');
});

test('unsafe or shared tool receipts are rejected before any package-manager action', async t => {
  for (const mode of ['directory-symlink', 'file-symlink', 'shared-file']) {
    const f = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-tool-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const tools = path.join(f.runtimeDir, 'tools');
    if (mode === 'directory-symlink') fs.symlinkSync(outside, tools);
    else {
      fs.mkdirSync(tools, { mode: 0o700 });
      if (mode === 'file-symlink') {
        const target = path.join(outside, 'receipt.json');
        fs.writeFileSync(target, '{}', { mode: 0o600 });
        fs.symlinkSync(target, path.join(tools, 'tshark.json'));
      } else fs.writeFileSync(path.join(tools, 'tshark.json'), '{}', { mode: 0o644 });
    }
    let calls = 0;
    const installer = createTsharkInstaller({ ...f, discover: absent, platform: 'darwin', find: finder({ brew: '/opt/homebrew/bin/brew' }), run: async () => calls++ });
    await assert.rejects(installer.install(), error => error.code === 'UNSAFE_TOOL_STORAGE');
    assert.equal(calls, 0);
  }
});

test('privileged Linux setup ignores package-manager executables from arbitrary PATH locations', () => {
  const result = installPlan({ env: { PATH: '/tmp/untrusted-bin' }, platform: 'linux', find: finder({ 'apt-get': '/tmp/untrusted-bin/apt-get' }) });
  assert.equal(result, null);
});


test('unsafe optional tool storage cannot prevent unrelated SDK shell environments', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-optional-tools-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.runtimeDir, 'tools'));
  const env = { ...f.env, GLADOS_TSHARK_PATH: '/unverified/tshark', ANTHROPIC_AUTH_TOKEN: 'fixture' };
  const applied = applyTsharkEnvironment(env, f);
  assert.equal(applied.PATH, env.PATH);
  assert.equal(applied.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_AUTH_TOKEN);
  assert.equal(applied.GLADOS_TSHARK_PATH, undefined);
  assert.equal(env.GLADOS_TSHARK_PATH, '/unverified/tshark');
  assert.throws(() => discoverTsharkSync({ ...f, env }), error => error.code === 'UNSAFE_TOOL_STORAGE');
});
