const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkMitmCaPermissions, mitmCaPaths } = require('../lib/proxy/mitm-ca');
const { buildMitmproxyArgs, prepareMitmproxyCa, proxyBackendConfig, pruneTrafficFiles, shadowDiffSummary } = require('../lib/proxy/mitmproxy-runner');
const { proxyHistory, proxyDetail, proxyMetrics, proxyHealth } = require('../lib/proxy/native-store');
const { ownerOnlyModeOk, readFallbackSecret, llmSecretPath } = require('../lib/secrets/llm-secrets');
const gladosLocal = require('../../scripts/lib/glados-local');

function tempRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glados-secrets-test-'));
}

test('MITM CA permission check fails closed on world-readable private key', () => {
  const dir = tempRuntime();
  const env = { GLADOS_RUNTIME_DIR: dir };
  const paths = mitmCaPaths(env);
  fs.mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.key, 'private', { mode: 0o644 });
  fs.chmodSync(paths.key, 0o644);
  const result = checkMitmCaPermissions(env);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /chmod 600/);
});

test('LLM fallback secret refuses insecure file modes', () => {
  const dir = tempRuntime();
  const env = { GLADOS_RUNTIME_DIR: dir };
  const file = llmSecretPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ token: 'secret' }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.equal(ownerOnlyModeOk(file), false);
  assert.throws(() => readFallbackSecret(env), /chmod 600/);
});

test('mitmproxy runner builds supervised shadow backend arguments', () => {
  const dir = tempRuntime();
  const config = proxyBackendConfig({
    GLADOS_RUNTIME_DIR: dir,
    GLADOS_PROXY_BACKEND: 'mitmproxy',
    GLADOS_PROXY_SHADOW: '1',
    GLADOS_PROXY_RAW_FLOWS: '1',
    GLADOS_MITM_LISTEN_PORT: '19090',
  });
  const args = buildMitmproxyArgs(config, path.join(config.trafficDir, 'test.flows'));
  assert.equal(config.backend, 'mitmproxy');
  assert.equal(config.shadow, true);
  assert.ok(args.includes('--listen-port'));
  assert.ok(args.includes('19090'));
  assert.ok(args.includes('-s'));
  assert.ok(args.some(arg => arg.endsWith('mitmproxy-glados-addon.py')));
  assert.ok(args.includes('-w'));
  assert.equal('burpProxy' in config, false);
  assert.equal('burpExtApi' in config, false);
});

test('proxy retention removes expired and over-budget archives without deleting the active store', () => {
  const dir = tempRuntime();
  const config = proxyBackendConfig({
    GLADOS_RUNTIME_DIR: dir,
    GLADOS_PROXY_RETENTION_DAYS: '1',
    GLADOS_PROXY_RETENTION_MAX_FILES: '2',
    GLADOS_PROXY_RETENTION_MAX_BYTES: String(1024 * 1024),
  });
  fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.trafficJsonl, 'active\n', { mode: 0o600 });
  const old = path.join(config.trafficDir, 'proxy-events-old.jsonl');
  const freshA = path.join(config.trafficDir, 'proxy-events-a.jsonl');
  const freshB = path.join(config.trafficDir, 'proxy-events-b.jsonl');
  const freshC = path.join(config.trafficDir, 'mitmproxy-c.flows');
  for (const file of [old, freshA, freshB, freshC]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  const stale = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(old, stale, stale);
  const result = pruneTrafficFiles(config);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(config.trafficJsonl), true);
  assert.equal(result.removed.length, 2);
});

test('mitmproxy addon strips attribution upstream and redacts captured secrets', () => {
  const dir = tempRuntime();
  const traffic = path.join(dir, 'proxy-events.jsonl');
  const addon = path.resolve(__dirname, '..', 'lib', 'proxy', 'mitmproxy-glados-addon.py');
  const script = String.raw`
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('addon', sys.argv[1])
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
req = SimpleNamespace(
  method='POST', pretty_url='https://target.test/login', host='target.test', path='/login', http_version='1.1',
  headers={'X-GLaDOS-Agent':'webapp-recon','X-GLaDOS-Transport':'browser-mcp','Authorization':'Bearer secret','Content-Type':'application/json'},
  raw_content=b'{"username":"operator","password":"swordfish","token":"abc"}'
)
resp = SimpleNamespace(status_code=401, http_version='1.1', reason='Unauthorized', headers={'Set-Cookie':'session=secret','Content-Type':'application/json'}, raw_content=b'{"refresh_token":"def","ok":false}')
flow = SimpleNamespace(request=req, response=resp, metadata={}, error=None)
addon.request(flow)
addon.response(flow)
print(json.dumps({'headers': req.headers, 'event': json.loads(open(sys.argv[2]).readline())}))
`;
  const result = require('node:child_process').spawnSync('python3', ['-c', script, addon, traffic], {
    env: { ...process.env, GLADOS_PROXY_TRAFFIC_JSONL: traffic },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal('X-GLaDOS-Agent' in parsed.headers, false);
  assert.equal('X-GLaDOS-Transport' in parsed.headers, false);
  assert.equal(parsed.event.agentTag, 'webapp-recon');
  assert.equal(parsed.event.request.headers.Authorization, '[REDACTED]');
  assert.equal(parsed.event.response.headers['Set-Cookie'], '[REDACTED]');
  assert.deepEqual(JSON.parse(parsed.event.request.body), { username: 'operator', password: '[REDACTED]', token: '[REDACTED]' });
  assert.deepEqual(JSON.parse(parsed.event.response.body), { refresh_token: '[REDACTED]', ok: false });
});

test('mitmproxy uses the GLaDOS CA material with owner-only permissions', () => {
  const dir = tempRuntime();
  const env = { GLADOS_RUNTIME_DIR: dir };
  const paths = mitmCaPaths(env);
  fs.mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.key, 'KEY', { mode: 0o600 });
  fs.writeFileSync(paths.cert, 'CERT', { mode: 0o644 });
  fs.chmodSync(paths.key, 0o600);
  const config = proxyBackendConfig({ ...env, GLADOS_PROXY_BACKEND: 'mitmproxy' });
  const combined = prepareMitmproxyCa(config, env);
  assert.equal(fs.readFileSync(combined, 'utf8'), 'KEY\nCERT\n');
  assert.equal(ownerOnlyModeOk(combined), true);
});

test('MITM CA rotation preserves owner-only keys and archives the previous operator key', () => {
  const dir = tempRuntime();
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'glados-ca.sh');
  const env = { ...process.env, GLADOS_RUNTIME_DIR: dir };
  const generate = require('node:child_process').spawnSync(script, ['generate'], { env, encoding: 'utf8' });
  assert.equal(generate.status, 0, generate.stderr);
  const rotate = require('node:child_process').spawnSync(script, ['rotate'], { env, encoding: 'utf8' });
  assert.equal(rotate.status, 0, rotate.stderr);

  const secrets = path.join(dir, 'secrets');
  const currentKey = path.join(secrets, 'glados-mitm-ca.key');
  const archivedKeys = fs.readdirSync(secrets).filter(name => /^glados-mitm-ca\.key\.rotated-/.test(name));
  assert.equal(fs.statSync(currentKey).mode & 0o777, 0o600);
  assert.equal(archivedKeys.length, 1);
  assert.equal(fs.statSync(path.join(secrets, archivedKeys[0])).mode & 0o777, 0o600);
});

test('proxy shadow diff compares stable per-agent request identity', () => {
  const primary = [{ agentTag: 'webapp-recon', method: 'GET', url: 'https://target.test/', status: 200 }];
  assert.equal(shadowDiffSummary(primary, primary).ok, true);
  assert.equal(shadowDiffSummary(primary, []).ok, false);
});

test('native proxy store serves history, detail, metrics, and health', () => {
  const dir = tempRuntime();
  const config = proxyBackendConfig({ GLADOS_RUNTIME_DIR: dir });
  const event = {
    id: 101,
    ts: Date.now(),
    method: 'POST',
    url: 'https://target.test/api',
    status: 201,
    agentTag: 'webapp-vuln',
    request: {
      line: 'POST /api HTTP/1.1',
      headers: { 'X-GLaDOS-Agent': 'webapp-vuln' },
      body: '{"x":1}',
      bodyLen: 7,
    },
    response: {
      line: 'HTTP/1.1 201 Created',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      bodyLen: 11,
    },
  };
  fs.mkdirSync(config.trafficDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.trafficJsonl, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  assert.deepEqual(proxyHistory({ config, limit: 10 }).map(r => r.agentTag), ['webapp-vuln']);
  assert.equal(proxyDetail(101, config).requestBody, '{"x":1}');
  const metrics = proxyMetrics({ config, windowSec: 10 });
  assert.equal(metrics.rps > 0, true);
  assert.equal(metrics.agents[0].agent, 'webapp-vuln');
  assert.equal(proxyHealth(config).healthy, true);
});

test('v4 update paths preserve runtime data and have no legacy config or token payload', () => {
  const dir = tempRuntime();
  const oldRuntime = process.env.GLADOS_RUNTIME_DIR;
  process.env.GLADOS_RUNTIME_DIR = dir;
  const paths = gladosLocal.localPaths();
  if (oldRuntime == null) delete process.env.GLADOS_RUNTIME_DIR;
  else process.env.GLADOS_RUNTIME_DIR = oldRuntime;
  assert.equal(Object.keys(paths).some(key => /openclaw/i.test(key)), false);

  const sources = [
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'update.sh'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'update-runner.js'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'desktop', 'main.cjs'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(sources, /ANTHROPIC_AUTH_TOKEN|LLMAPI_API_KEY|glados-mitm-ca\.key/);
  assert.doesNotMatch(sources, /rm\s+-rf\s+[^\n]*\.glados|fs\.(?:rm|rmdir)Sync\([^\n]*GLADOS_RUNTIME_DIR/);
});
