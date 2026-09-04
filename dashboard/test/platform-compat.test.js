const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { terminalCommand } = require('../lib/terminal');
const { proxyBackendConfig } = require('../lib/proxy/mitmproxy-runner');
const { mitmCaPaths, trustMitmCa } = require('../lib/proxy/mitm-ca');

test('Windows terminals default to PowerShell instead of cmd.exe', () => {
  assert.deepEqual(terminalCommand('win32', {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe',
  }), {
    shell: 'powershell.exe',
    args: ['-NoLogo'],
  });
  assert.deepEqual(terminalCommand('win32', { GLADOS_TERMINAL_SHELL: 'pwsh.exe' }), {
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
  });
});

test('Windows proxy discovery accepts a pipx mitmdump executable on PATH', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-win-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mitmdump = path.join(dir, 'mitmdump.EXE');
  fs.writeFileSync(mitmdump, 'fixture', { mode: 0o755 });
  const config = proxyBackendConfig({
    PATH: dir,
    PATHEXT: '.EXE;.CMD',
    GLADOS_RUNTIME_DIR: path.join(dir, 'runtime'),
  }, 'win32');
  assert.equal(config.mitmproxyBin, mitmdump);
});

test('Windows CA trust targets the current-user Root certificate store', t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-win-ca-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const env = { GLADOS_RUNTIME_DIR: runtime, PATH: '' };
  const ca = mitmCaPaths(env);
  fs.mkdirSync(ca.secretsDir, { recursive: true });
  fs.writeFileSync(ca.key, 'fixture-key');
  fs.writeFileSync(ca.cert, 'fixture-cert');
  const calls = [];
  trustMitmCa({
    env,
    platform: 'win32',
    spawnSync(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls, [{
    command: 'certutil.exe',
    args: ['-user', '-addstore', 'Root', ca.cert],
  }]);
});
