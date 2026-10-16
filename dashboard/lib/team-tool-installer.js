'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2000;
const INSTALL_PROBE_TIMEOUT_MS = 30000;
const discoveryCache = new Map();

function runtimeRoot(runtimeDir, env) {
  return runtimeDir || env.GLADOS_RUNTIME_DIR || path.join(env.HOME || os.homedir(), '.glados');
}
function isExecutable(filename) {
  if (!filename || !path.isAbsolute(filename)) return false;
  try { return fs.statSync(filename).isFile() && (fs.accessSync(filename, fs.constants.X_OK), true); } catch { return false; }
}
function pathExecutables(name, env) {
  return String(env.PATH || '').split(path.delimiter).filter(p => p && path.isAbsolute(p)).map(p => path.join(p, name));
}
function findExecutable(name, env, preferred = []) {
  return [...new Set([...preferred, ...pathExecutables(name, env)])].find(isExecutable) || null;
}
function validateToolStorage(runtimeDir, env) {
  const root = path.resolve(runtimeRoot(runtimeDir, env));
  const file = path.join(root, 'tools', 'tshark.json');
  for (const [index, item] of [root, path.dirname(file), file].entries()) {
    let stat;
    try { stat = fs.lstatSync(item); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || (index < 2 ? !stat.isDirectory() : !stat.isFile())
      || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== 'win32' && (stat.mode & (index < 2 ? 0o022 : 0o077)))
      || (index === 2 && stat.size > 16384)) {
      throw installError('UNSAFE_TOOL_STORAGE', 'TShark tool storage must use real, owner-controlled directories and an owner-only file.', 'Check permissions and remove symlinks in the GLaDOS runtime tools directory, then retry Install Herbie.');
    }
  }
  return file;
}
function savedRecord(runtimeDir, env) {
  const filename = validateToolStorage(runtimeDir, env);
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && stat.mode & 0o077)) return null;
    const row = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return row && typeof row.path === 'string' && path.isAbsolute(row.path) ? row : null;
  } catch (error) { if (error.code === 'ELOOP') throw installError('UNSAFE_TOOL_STORAGE', 'TShark tool storage cannot contain symlinks.'); return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeRecord(runtimeDir, env, record) {
  const filename = validateToolStorage(runtimeDir, env);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  validateToolStorage(runtimeDir, env);
  const temporary = path.join(path.dirname(filename), `.tshark-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    validateToolStorage(runtimeDir, env);
    fs.renameSync(temporary, filename);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function tsharkCandidates({ runtimeDir, env, platform }) {
  const stored = savedRecord(runtimeDir, env);
  const candidates = [env.GLADOS_TSHARK_PATH, stored?.path];
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin/tshark', '/usr/local/bin/tshark',
    '/Applications/Wireshark.app/Contents/MacOS/tshark', path.join(env.HOME || os.homedir(), 'Applications/Wireshark.app/Contents/MacOS/tshark'));
  candidates.push('/usr/bin/tshark', '/bin/tshark', '/usr/local/bin/tshark', ...pathExecutables('tshark', env));
  return [...new Set(candidates.filter(p => typeof p === 'string' && path.isAbsolute(p)))];
}
function tsharkVersion(output) {
  const firstLine = String(output || '').split(/\r?\n/, 1)[0].trim();
  return firstLine.match(/^TShark\s+\(Wireshark\)\s+(\d+\.\d+(?:\.\d+)?(?:[-\w.]*)?)/i)?.[1] || null;
}
function probeTshark(filename, env) {
  if (!isExecutable(filename)) return null;
  const result = spawnSync(filename, ['--version'], { env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const version = tsharkVersion(result.stdout);
  return version ? { path: filename, version } : null;
}

// Fresh Homebrew binaries can take longer than the lightweight status probe on
// their first macOS launch. Installation verification must wait asynchronously
// without blocking the dashboard or other model turns.
async function discoverTsharkAsync({ runtimeDir, env = process.env, platform = process.platform,
  timeoutMs = INSTALL_PROBE_TIMEOUT_MS, signal, candidates = tsharkCandidates } = {}) {
  const deadline = Date.now() + timeoutMs;
  const stored = savedRecord(runtimeDir, env);
  for (const filename of candidates({ runtimeDir, env, platform })) {
    if (signal?.aborted) throw installError('INSTALL_CANCELLED', 'TShark setup was cancelled.');
    if (!isExecutable(filename)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const version = await new Promise(resolve => {
      let child;
      let timer;
      let output = '';
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      };
      const stop = () => { try { child?.kill('SIGKILL'); } catch {} finish(null); };
      const cancel = stop;
      try { child = spawn(filename, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
      catch { finish(null); return; }
      timer = setTimeout(stop, remaining);
      signal?.addEventListener('abort', cancel, { once: true });
      child.stdout.on('data', data => { output += data.toString(); if (Buffer.byteLength(output) > 32768) stop(); });
      child.once('error', () => finish(null));
      child.once('close', code => finish(code === 0 ? tsharkVersion(output) : null));
      if (signal?.aborted) stop();
    });
    if (signal?.aborted) throw installError('INSTALL_CANCELLED', 'TShark setup was cancelled.');
    if (version) {
      const result = { id: 'tshark', installed: true, available: true, path: filename, version,
        manager: stored?.path === filename ? stored.manager || 'existing' : 'existing' };
      for (const recordedPath of new Set([stored?.path, filename])) {
        const key = JSON.stringify([runtimeRoot(runtimeDir, env), platform, env.HOME, env.PATH, env.GLADOS_TSHARK_PATH, recordedPath]);
        discoveryCache.set(key, { result, until: Date.now() + 30000 });
      }
      if (discoveryCache.size > 100) discoveryCache.delete(discoveryCache.keys().next().value);
      return { ...result };
    }
  }
  return { id: 'tshark', installed: false, available: false, path: null, version: null, manager: null };
}

// Discovery is read-only: no installation, capture, interface listing, or sudo.
function discoverTsharkSync({ runtimeDir, env = process.env, platform = process.platform, refresh = false } = {}) {
  const stored = savedRecord(runtimeDir, env);
  const key = JSON.stringify([runtimeRoot(runtimeDir, env), platform, env.HOME, env.PATH, env.GLADOS_TSHARK_PATH, stored?.path]);
  const cached = discoveryCache.get(key);
  if (!refresh && cached && Date.now() < cached.until && (!cached.result.path || isExecutable(cached.result.path))) return { ...cached.result };
  let found = null;
  // Only existing executables are probed; common GUI launch environments omit Homebrew.
  for (const candidate of tsharkCandidates({ runtimeDir, env, platform })) {
    found = probeTshark(candidate, env);
    if (found) break;
  }
  const result = { id: 'tshark', installed: !!found, available: !!found, path: found?.path || null, version: found?.version || null,
    manager: found && stored?.path === found.path ? stored.manager || 'existing' : found ? 'existing' : null };
  discoveryCache.set(key, { result, until: Date.now() + (found ? 30000 : 3000) });
  // Keep tests and many temporary runtime roots from retaining unbounded entries.
  if (discoveryCache.size > 100) discoveryCache.delete(discoveryCache.keys().next().value);
  return { ...result };
}
function applyTsharkEnvironment(env = process.env, { runtimeDir, platform = process.platform } = {}) {
  const next = { ...env };
  let found;
  try { found = discoverTsharkSync({ runtimeDir, platform, env }); }
  catch {
    // Optional-team storage cannot prevent unrelated GLaDOS/Clippy turns.
    // Never trust a saved executable from unsafe storage; explicit install and
    // status still report that error so the operator can repair it.
    delete next.GLADOS_TSHARK_PATH;
    return next;
  }
  if (found.installed) {
    next.GLADOS_TSHARK_PATH = found.path;
    const directory = path.dirname(found.path);
    next.PATH = [directory, ...String(env.PATH || '').split(path.delimiter).filter(p => p && p !== directory)].join(path.delimiter);
  } else delete next.GLADOS_TSHARK_PATH;
  return next;
}
function installError(code, message, remediation = null) {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}
function safeProgress(callback, value) { if (typeof callback === 'function') { try { callback(value); } catch {} } }

function runCommand(command, args, { env, timeoutMs = INSTALL_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(installError('INSTALL_CANCELLED', 'TShark setup was cancelled.'));
    let child;
    let settled = false;
    let timer;
    let killTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // If termination has begun, retain the short hard-kill timer for descendants.
      if (!error) clearTimeout(killTimer);
      if (error) reject(error); else resolve(value);
    };
    const stop = error => {
      if (settled) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, 1000);
      killTimer.unref();
      finish(error);
    };
    const cancel = () => stop(installError('INSTALL_CANCELLED', 'TShark setup was cancelled.'));
    try {
      // Argument arrays only. No shell, stdin, password prompt, downloaded script, or output streaming.
      child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch { return finish(installError('INSTALL_FAILED', 'The package manager could not be started.')); }
    child.once('error', () => finish(installError('INSTALL_FAILED', 'The package manager could not be started.')));
    child.once('close', (code, signalName) => finish(null, { code, signal: signalName }));
    timer = setTimeout(() => stop(installError('INSTALL_TIMEOUT', 'TShark setup exceeded the 10-minute limit. Check the package manager state before retrying.')), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function installPlan({ env, platform, find = findExecutable }) {
  const manager = (id, preferred, args, packageName, remediation) => {
    const command = find(id, env, preferred);
    const systemOnly = platform === 'linux' && id !== 'brew';
    return command && (!systemOnly || preferred.includes(command)) ? { manager: id, command, args, packageName, remediation } : null;
  };
  if (platform === 'darwin') {
    return manager('brew', ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'], ['install', '--formula', 'wireshark'], 'wireshark',
      'Run brew install --formula wireshark in a terminal, then retry Install Herbie.');
  }
  if (platform === 'linux') {
    // Existing Homebrew supports an unprivileged install; prefer it when present.
    const brew = manager('brew', ['/home/linuxbrew/.linuxbrew/bin/brew'], ['install', '--formula', 'wireshark'], 'wireshark', 'Run brew install --formula wireshark in a terminal, then retry Install Herbie.');
    if (brew) return brew;
    return manager('apt-get', ['/usr/bin/apt-get'], ['-y', '-o', 'DPkg::Lock::Timeout=30', '--no-install-recommends', 'install', 'tshark'], 'tshark', 'Run sudo apt-get install tshark in a terminal, then retry Install Herbie.')
      || manager('dnf', ['/usr/bin/dnf'], ['-y', 'install', 'wireshark-cli'], 'wireshark-cli', 'Run sudo dnf install wireshark-cli in a terminal, then retry Install Herbie.')
      || manager('yum', ['/usr/bin/yum'], ['-y', 'install', 'wireshark-cli'], 'wireshark-cli', 'Run sudo yum install wireshark-cli in a terminal, then retry Install Herbie.')
      || manager('zypper', ['/usr/bin/zypper'], ['--non-interactive', 'install', '--no-recommends', 'wireshark'], 'wireshark', 'Run sudo zypper install wireshark in a terminal, then retry Install Herbie.')
      || manager('pacman', ['/usr/bin/pacman'], ['--noconfirm', '-S', '--needed', 'wireshark-cli'], 'wireshark-cli', 'Run sudo pacman -S wireshark-cli in a terminal, then retry Install Herbie.');
  }
  return null;
}

function createTsharkInstaller({ runtimeDir, env = process.env, platform = process.platform, getuid = process.getuid?.bind(process),
  discover = discoverTsharkSync, verify = discover === discoverTsharkSync ? discoverTsharkAsync : async options => discover(options),
  find = findExecutable, run = runCommand, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  let pending = null;
  const check = refresh => discover({ runtimeDir, env, platform, refresh });
  const status = async () => {
    const current = check(false);
    if (current.installed) return current;
    const plan = installPlan({ env, platform, find });
    return { ...current, manager: plan?.manager || null, canInstall: !!plan,
      reason: plan ? 'TShark will be installed when you choose Install Herbie.' : 'No supported package manager was found.',
      remediation: plan?.remediation || (platform === 'darwin' ? 'Install Homebrew from https://brew.sh or the official Wireshark app, then retry Install Herbie.' : 'Install TShark using your distribution package manager, then retry Install Herbie.') };
  };
  const install = ({ onProgress, signal } = {}) => {
    if (pending) return pending;
    pending = (async () => {
      safeProgress(onProgress, { phase: 'checking', message: 'Checking for TShark.' });
      if (signal?.aborted) throw installError('INSTALL_CANCELLED', 'TShark setup was cancelled.');
      validateToolStorage(runtimeDir, env);
      const current = await verify({ runtimeDir, env, platform, refresh: true, signal });
      if (current.installed) {
        writeRecord(runtimeDir, env, { path: current.path, version: current.version, manager: current.manager || 'existing', installedAt: new Date().toISOString() });
        safeProgress(onProgress, { phase: 'complete', message: `TShark ${current.version} is already available.` });
        return current;
      }
      const plan = installPlan({ env, platform, find });
      if (!plan) {
        const details = await status();
        throw installError('PACKAGE_MANAGER_UNAVAILABLE', details.reason, details.remediation);
      }
      const childEnv = { ...env, CI: '1', NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ANALYTICS: '1',
        DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none', SUDO_ASKPASS: '/usr/bin/false' };
      let command = plan.command;
      let args = plan.args;
      let graphicalAuthorization = false;
      if (plan.manager !== 'brew' && getuid?.() !== 0) {
        const systemTool = (name, paths) => { const found = find(name, env, paths); return paths.includes(found) ? found : null; };
        const pkexec = systemTool('pkexec', ['/usr/bin/pkexec', '/bin/pkexec']);
        const desktopSession = !!(env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_SESSION_ID);
        const timeout = systemTool('timeout', ['/usr/bin/timeout', '/bin/timeout']);
        if (!timeout) throw installError('ADMIN_REQUIRED', 'Automatic administrator setup requires the system timeout utility.', plan.remediation);
        // The privileged process also has its own limit, since an unprivileged
        // UI cannot always signal a package-manager child after elevation.
        const fixedEnv = [timeout, '--kill-after=5s', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'APT_LISTCHANGES_FRONTEND=none', plan.command, ...plan.args];
        if (pkexec && desktopSession) {
          graphicalAuthorization = true;
          command = pkexec;
          // Use only the desktop's existing authorization agent. Never a hidden textual prompt.
          args = ['--disable-internal-agent', ...fixedEnv];
          safeProgress(onProgress, { phase: 'authorizing', manager: plan.manager, message: 'Approve the system administrator dialog to install TShark.' });
        } else {
          const sudo = systemTool('sudo', ['/usr/bin/sudo', '/bin/sudo']);
          if (!sudo) throw installError('ADMIN_REQUIRED', 'TShark setup needs administrator installation in a terminal.', plan.remediation);
          const probe = await run(sudo, ['-n', '-v'], { env: childEnv, timeoutMs: 5000, signal });
          if (probe.code !== 0) throw installError('ADMIN_REQUIRED', 'Administrator access is needed. GLaDOS does not request or store your password.', plan.remediation);
          // Explicit env assignment survives sudo env_reset. Variables are fixed literals.
          command = sudo;
          args = ['-n', '--', ...fixedEnv];
        }
      }
      safeProgress(onProgress, { phase: 'installing', manager: plan.manager, message: `Installing TShark through ${plan.manager}. This can take several minutes.` });
      let result;
      try { result = await run(command, args, { env: childEnv, timeoutMs, signal }); }
      catch (error) { if (!error.remediation) error.remediation = plan.remediation; throw error; }
      if (result.code === 124) throw installError('INSTALL_TIMEOUT', 'The package manager exceeded the TShark setup time limit.', plan.remediation);
      if (graphicalAuthorization && [126, 127].includes(result.code)) throw installError('ADMIN_REQUIRED', result.code === 126 ? 'System authorization was cancelled. Herbie was not installed.' : 'The desktop could not authorize TShark setup.', plan.remediation);
      if (result.code !== 0) throw installError('INSTALL_FAILED', `TShark installation through ${plan.manager} did not complete.`, plan.remediation);
      safeProgress(onProgress, { phase: 'verifying', manager: plan.manager, message: 'Verifying the installed TShark executable.' });
      const verified = await verify({ runtimeDir, env, platform, refresh: true, signal });
      if (!verified.installed) throw installError('TSHARK_NOT_FOUND', 'The package manager finished, but TShark did not return a valid version within 30 seconds.', 'Run tshark --version in a terminal to check the installation, then retry Install Herbie. GLaDOS will reuse a working installation.');
      const record = { path: verified.path, version: verified.version, manager: plan.manager, installedAt: new Date().toISOString() };
      writeRecord(runtimeDir, env, record);
      const answer = { ...verified, manager: plan.manager };
      safeProgress(onProgress, { phase: 'complete', message: `TShark ${answer.version} is ready.`, manager: plan.manager });
      return answer;
    })().finally(() => { pending = null; });
    return pending;
  };
  return { status, install, environment: () => applyTsharkEnvironment(env, { runtimeDir, platform }) };
}

module.exports = { createTsharkInstaller, discoverTsharkSync, discoverTsharkAsync, applyTsharkEnvironment, INSTALL_TIMEOUT_MS,
  // Export small pure/process helpers for isolated contract tests; no installer runs on import.
  installPlan, runCommand };
