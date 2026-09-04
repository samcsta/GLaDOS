const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CA_COMMON_NAME = 'GLaDOS Operator MITM CA';

function commandPath(command, env = process.env, platform = process.platform) {
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

function runtimeDir(env = process.env) {
  return path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
}

function secretsDir(env = process.env) {
  return path.join(runtimeDir(env), 'secrets');
}

function trafficDir(env = process.env) {
  return path.join(runtimeDir(env), 'traffic');
}

function mitmCaPaths(env = process.env) {
  const dir = secretsDir(env);
  return {
    secretsDir: dir,
    trafficDir: trafficDir(env),
    key: path.join(dir, 'glados-mitm-ca.key'),
    cert: path.join(dir, 'glados-mitm-ca.pem'),
    serial: path.join(dir, 'glados-mitm-ca.srl'),
  };
}

function modeOwnerOnly(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (process.platform === 'win32') return true;
  return (stat.mode & 0o077) === 0;
}

function checkMitmCaPermissions(env = process.env) {
  const paths = mitmCaPaths(env);
  const issues = [];
  const keyExists = fs.existsSync(paths.key);
  if (keyExists && !modeOwnerOnly(paths.key)) {
    issues.push(`${paths.key} must be chmod 600; MITM CA private keys may not be group/world readable`);
  }
  if (process.platform !== 'win32' && fs.existsSync(paths.secretsDir)) {
    const stat = fs.statSync(paths.secretsDir);
    if ((stat.mode & 0o077) !== 0) issues.push(`${paths.secretsDir} must be chmod 700`);
  }
  return {
    ok: issues.length === 0,
    keyExists,
    paths,
    issues,
  };
}

function run(command, args, { env = process.env, spawnSync = cp.spawnSync } = {}) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || `exit status ${result.status}`).trim();
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
  return result;
}

function ensureMitmCa({ env = process.env, spawnSync = cp.spawnSync, hostname = os.hostname() } = {}) {
  const paths = mitmCaPaths(env);
  fs.mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(paths.secretsDir, 0o700); } catch {}
  const keyExists = fs.existsSync(paths.key);
  const certExists = fs.existsSync(paths.cert);
  if (keyExists !== certExists) {
    throw new Error(`GLaDOS MITM CA is incomplete under ${paths.secretsDir}; rotate or restore the matching key and certificate`);
  }
  if (keyExists) return paths;

  const openssl = commandPath('openssl', env) || 'openssl';
  const subjectHost = String(hostname || 'workstation').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  run(openssl, [
    'req', '-x509', '-newkey', 'rsa:4096', '-sha256', '-days', '825', '-nodes',
    '-keyout', paths.key,
    '-out', paths.cert,
    '-subj', `/CN=${CA_COMMON_NAME} ${subjectHost}/O=GLaDOS Local/`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash',
  ], { env, spawnSync });
  try { fs.chmodSync(paths.key, 0o600); } catch {}
  try { fs.chmodSync(paths.cert, 0o644); } catch {}
  return paths;
}

function linuxTrustTarget() {
  if (fs.existsSync('/etc/pki/ca-trust/source/anchors')) {
    return '/etc/pki/ca-trust/source/anchors/glados-operator-mitm-ca.crt';
  }
  return '/usr/local/share/ca-certificates/glados-operator-mitm-ca.crt';
}

function mitmCaTrusted({ env = process.env, platform = process.platform, spawnSync = cp.spawnSync } = {}) {
  const paths = mitmCaPaths(env);
  if (!fs.existsSync(paths.cert)) return false;
  if (platform === 'darwin') {
    const result = spawnSync('/usr/bin/security', ['verify-cert', '-c', paths.cert], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0;
  }
  if (platform === 'linux') return fs.existsSync(linuxTrustTarget());
  if (platform === 'win32') {
    let fingerprint;
    try { fingerprint = new (require('node:crypto').X509Certificate)(fs.readFileSync(paths.cert)).fingerprint.replaceAll(':', ''); }
    catch { return false; }
    const certutil = commandPath('certutil', env, platform) || 'certutil.exe';
    const result = spawnSync(certutil, ['-user', '-store', 'Root', fingerprint], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return result.status === 0;
  }
  return false;
}

function trustMitmCa({ env = process.env, platform = process.platform, spawnSync = cp.spawnSync } = {}) {
  const paths = ensureMitmCa({ env, spawnSync });
  if (platform === 'darwin') {
    run('/usr/bin/security', [
      'add-trusted-cert', '-d', '-r', 'trustRoot',
      '-k', path.join(env.HOME || os.homedir(), 'Library', 'Keychains', 'login.keychain-db'), paths.cert,
    ], { env, spawnSync });
  } else if (platform === 'linux') {
    const target = linuxTrustTarget();
    run(commandPath('sudo', env) || 'sudo', ['install', '-m', '0644', paths.cert, target], { env, spawnSync });
    if (target.startsWith('/etc/pki/')) {
      run(commandPath('sudo', env) || 'sudo', [commandPath('update-ca-trust', env) || 'update-ca-trust', 'extract'], { env, spawnSync });
    } else {
      run(commandPath('sudo', env) || 'sudo', [commandPath('update-ca-certificates', env) || 'update-ca-certificates'], { env, spawnSync });
    }
  } else if (platform === 'win32') {
    run(commandPath('certutil', env, platform) || 'certutil.exe', ['-user', '-addstore', 'Root', paths.cert], { env, spawnSync });
  } else {
    throw new Error(`automatic CA trust is unsupported on ${platform}`);
  }
  return paths;
}

module.exports = {
  CA_COMMON_NAME,
  mitmCaPaths,
  checkMitmCaPermissions,
  commandPath,
  ensureMitmCa,
  linuxTrustTarget,
  mitmCaTrusted,
  modeOwnerOnly,
  trustMitmCa,
};
