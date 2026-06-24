const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await request(port, 'GET', '/api/healthz');
      if (res.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}

function request(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-slash-api-'));
  const runtime = path.join(root, 'runtime');
  const openclawHome = path.join(root, 'openclaw');
  const burpGate = path.join(root, 'burp-gate.sh');
  fs.mkdirSync(path.join(openclawHome, 'agents', 'glados', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(openclawHome, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(openclawHome, 'agents', 'glados', 'sessions', 'sessions.json'), '{}\n');
  fs.writeFileSync(path.join(openclawHome, 'logs', 'raw-stream.jsonl'), '');
  fs.writeFileSync(path.join(openclawHome, 'openclaw.json'), JSON.stringify({
    agents: {
      list: [
        { id: 'glados', name: 'glados', model: 'test' },
        { id: 'webapp-vuln', name: 'webapp-vuln', model: 'test' },
        { id: 'source-code', name: 'source-code', model: 'test' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(burpGate, '#!/usr/bin/env bash\necho "stub burp-gate $*"\n');
  fs.chmodSync(burpGate, 0o755);

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    GLADOS_RUNTIME_DIR: runtime,
    BLACKBOARD_DB: path.join(runtime, 'blackboard', 'blackboard.db'),
    WATCHDOG_DB: path.join(runtime, 'watchdog', 'watchdog.db'),
    OPENCLAW_HOME: openclawHome,
    BURP_GATE_SH: burpGate,
    GLADOS_CONTROLLER_WORKER: '0',
  };
  const child = cp.spawn(process.execPath, ['dashboard/server.js'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  await waitForHealth(port, child);
  return {
    root,
    runtime,
    openclawHome,
    port,
    child,
    env,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    },
  };
}

async function slashRun(port, command) {
  const res = await request(port, 'POST', '/api/slash/run', { command });
  assert.equal(res.status < 500, true, res.raw);
  return res.json;
}

test('POST /api/slash/run executes workflow and safety commands through server wiring', async () => {
  const srv = await startServer();
  try {
    const help = await slashRun(srv.port, '/help');
    assert.equal(help.ok, true);
    assert.match(help.events.at(-1).text, /\/goal <target>/);

    const goal = await slashRun(srv.port, '/goal example.com');
    assert.equal(goal.ok, true);
    assert.match(goal.events.at(-1).text, /DradisTab/);
    assert.match(goal.events.at(-1).text, /DomainsAI/);

    const usage = await slashRun(srv.port, '/investigate');
    assert.equal(usage.ok, true);
    assert.match(usage.events.at(-1).text, /usage: \/investigate <url-or-domain>/);
    assert.doesNotMatch(usage.events.at(-1).text, /Ready\. The local ROE/);

    const localRepo = path.join(srv.root, 'repo');
    fs.mkdirSync(localRepo);
    const review = await slashRun(srv.port, `/security-review ${localRepo}`);
    assert.equal(review.ok, true);
    assert.match(review.events.at(-1).text, /Queued source-code security review/);

    const status = await slashRun(srv.port, '/status');
    assert.equal(status.ok, true);
    assert.match(status.events.at(-1).text, /Goals:/);

    const halt = await slashRun(srv.port, '/halt webapp-vuln');
    assert.equal(halt.ok, true);
    assert.match(halt.events.at(-1).text, /"agentId": "webapp-vuln"/);

    const haltAll = await slashRun(srv.port, '/halt-all');
    assert.equal(haltAll.ok, true);
    assert.match(haltAll.events.at(-1).text, /"haltedAgents"/);

    const db = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'), { readonly: true });
    try {
      const goals = db.prepare('SELECT type, target, status FROM controller_goals ORDER BY created_at ASC').all();
      assert.equal(goals.some(g => g.type === 'webapp_goal' && g.target === 'example.com'), true);
      assert.equal(goals.some(g => g.type === 'security_review' && g.target === localRepo), true);
      const jobs = db.prepare('SELECT agent_id, job_type, target, status FROM controller_jobs').all();
      assert.deepEqual(jobs.map(j => [j.agent_id, j.job_type, j.target, j.status]), [
        ['source-code', 'security_review_local_path', localRepo, 'queued'],
      ]);
    } finally {
      db.close();
    }
  } finally {
    await srv.stop();
  }
});
