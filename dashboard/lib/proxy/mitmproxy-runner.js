const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { mitmCaPaths, checkMitmCaPermissions } = require('./mitm-ca');

function proxyBackendConfig(env = process.env) {
  const ca = mitmCaPaths(env);
  const defaultBin = [
    '/opt/homebrew/bin/mitmdump',
    '/usr/local/bin/mitmdump',
  ].find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  }) || 'mitmdump';
  return {
    backend: env.GLADOS_PROXY_BACKEND || 'mitmproxy',
    shadow: /^(1|true|yes)$/i.test(String(env.GLADOS_PROXY_SHADOW || '')),
    listenHost: env.GLADOS_MITM_LISTEN_HOST || '127.0.0.1',
    listenPort: Number(env.GLADOS_MITM_LISTEN_PORT || 18080),
    trafficDir: ca.trafficDir,
    trafficJsonl: env.GLADOS_PROXY_TRAFFIC_JSONL || path.join(ca.trafficDir, 'proxy-events.jsonl'),
    bodyLimit: Math.max(0, Number(env.GLADOS_PROXY_BODY_LIMIT || 262144)),
    maxJsonlBytes: Math.max(1024 * 1024, Number(env.GLADOS_PROXY_MAX_JSONL_BYTES || 64 * 1024 * 1024)),
    retentionDays: Math.max(1, Number(env.GLADOS_PROXY_RETENTION_DAYS || 14)),
    retentionMaxFiles: Math.max(1, Number(env.GLADOS_PROXY_RETENTION_MAX_FILES || 40)),
    retentionMaxBytes: Math.max(1024 * 1024, Number(env.GLADOS_PROXY_RETENTION_MAX_BYTES || 1024 * 1024 * 1024)),
    rawFlows: /^(1|true|yes)$/i.test(String(env.GLADOS_PROXY_RAW_FLOWS || '')),
    mitmproxyBin: env.GLADOS_MITMPROXY_BIN || defaultBin,
    mitmproxyAddon: env.GLADOS_MITMPROXY_ADDON || path.join(__dirname, 'mitmproxy-glados-addon.py'),
    mitmproxyConfDir: path.join(ca.secretsDir, 'mitmproxy'),
  };
}

function flowFile(config = proxyBackendConfig()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(config.trafficDir, `mitmproxy-${stamp}.flows`);
}

function buildMitmproxyArgs(config = proxyBackendConfig(), outFile = flowFile(config)) {
  const args = [
    '--listen-host', config.listenHost,
    '--listen-port', String(config.listenPort),
    '--set', `confdir=${config.mitmproxyConfDir}`,
    '--set', 'flow_detail=0',
    '--set', 'ssl_insecure=false',
    '-s', config.mitmproxyAddon,
  ];
  if (config.rawFlows) args.push('-w', outFile);
  return args;
}

function retainedTrafficFiles(config = proxyBackendConfig()) {
  try {
    return fs.readdirSync(config.trafficDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(config.trafficDir, entry.name))
      .filter(file => file !== config.trafficJsonl && /(?:\.flows|proxy-events-.+\.jsonl)$/i.test(file));
  } catch {
    return [];
  }
}

function pruneTrafficFiles(config = proxyBackendConfig(), now = Date.now()) {
  fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.trafficDir, 0o700);
  const cutoff = now - config.retentionDays * 86400000;
  const removed = [];
  let rows = retainedTrafficFiles(config).map(file => {
    try { return { file, ...fs.statSync(file) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const row of rows.filter(row => row.mtimeMs < cutoff)) {
    try { fs.rmSync(row.file, { force: true }); removed.push(row.file); } catch {}
  }
  rows = rows.filter(row => !removed.includes(row.file));
  for (const row of rows.slice(config.retentionMaxFiles)) {
    try { fs.rmSync(row.file, { force: true }); removed.push(row.file); } catch {}
  }
  rows = rows.filter(row => !removed.includes(row.file));
  let total = rows.reduce((sum, row) => sum + row.size, 0);
  for (const row of [...rows].reverse()) {
    if (total <= config.retentionMaxBytes) break;
    try { fs.rmSync(row.file, { force: true }); removed.push(row.file); total -= row.size; } catch {}
  }
  return { removed, retainedBytes: total };
}

function prepareMitmproxyCa(config = proxyBackendConfig(), env = process.env) {
  const ca = mitmCaPaths(env);
  if (!fs.existsSync(ca.key) || !fs.existsSync(ca.cert)) {
    throw new Error(`GLaDOS MITM CA is missing; run scripts/glados-ca.sh generate before starting mitmproxy`);
  }
  fs.mkdirSync(config.mitmproxyConfDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.mitmproxyConfDir, 0o700);
  const combined = path.join(config.mitmproxyConfDir, 'mitmproxy-ca.pem');
  const body = `${fs.readFileSync(ca.key, 'utf8').trim()}\n${fs.readFileSync(ca.cert, 'utf8').trim()}\n`;
  fs.writeFileSync(combined, body, { mode: 0o600 });
  fs.chmodSync(combined, 0o600);
  return combined;
}

function startMitmproxy(config = proxyBackendConfig()) {
  const caCheck = checkMitmCaPermissions(process.env);
  if (!caCheck.ok) throw new Error(caCheck.issues.join('; '));
  fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.trafficDir, 0o700);
  pruneTrafficFiles(config);
  prepareMitmproxyCa(config, process.env);
  const outFile = flowFile(config);
  const args = buildMitmproxyArgs(config, outFile);
  const child = cp.spawn(config.mitmproxyBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GLADOS_PROXY_TRAFFIC_JSONL: config.trafficJsonl,
      GLADOS_PROXY_BODY_LIMIT: String(config.bodyLimit),
      GLADOS_PROXY_MAX_JSONL_BYTES: String(config.maxJsonlBytes),
      GLADOS_PROXY_RETENTION_DAYS: String(config.retentionDays),
      GLADOS_PROXY_RETENTION_MAX_FILES: String(config.retentionMaxFiles),
      GLADOS_PROXY_RETENTION_MAX_BYTES: String(config.retentionMaxBytes),
    },
  });
  return { child, args, flowFile: outFile, config };
}

function shadowDiffSummary(primaryRows, shadowRows) {
  const primary = Array.isArray(primaryRows) ? primaryRows : [];
  const shadow = Array.isArray(shadowRows) ? shadowRows : [];
  const key = row => [
    row.agentTag || row.agent || '',
    row.method || '',
    row.url || row.request?.url || '',
    row.status || row.response?.status || '',
  ].join('\0');
  const shadowKeys = new Set(shadow.map(key));
  const missingInShadow = primary.filter(row => !shadowKeys.has(key(row)));
  return {
    ok: missingInShadow.length === 0,
    primaryCount: primary.length,
    shadowCount: shadow.length,
    missingInShadow,
  };
}

module.exports = {
  proxyBackendConfig,
  flowFile,
  buildMitmproxyArgs,
  prepareMitmproxyCa,
  retainedTrafficFiles,
  pruneTrafficFiles,
  startMitmproxy,
  shadowDiffSummary,
};
