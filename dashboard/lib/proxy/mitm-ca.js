const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  return (stat.mode & 0o077) === 0;
}

function checkMitmCaPermissions(env = process.env) {
  const paths = mitmCaPaths(env);
  const issues = [];
  const keyExists = fs.existsSync(paths.key);
  if (keyExists && !modeOwnerOnly(paths.key)) {
    issues.push(`${paths.key} must be chmod 600; MITM CA private keys may not be group/world readable`);
  }
  if (fs.existsSync(paths.secretsDir)) {
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

module.exports = {
  mitmCaPaths,
  checkMitmCaPermissions,
  modeOwnerOnly,
};
