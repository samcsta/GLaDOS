const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const EXPECTED_VERSION = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();

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

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    GLADOS_RUNTIME_DIR: runtime,
    BLACKBOARD_DB: path.join(runtime, 'blackboard', 'blackboard.db'),
    WATCHDOG_DB: path.join(runtime, 'watchdog', 'watchdog.db'),
    GLADOS_CONTROLLER_WORKER: '0',
    GLADOS_LITELLM_USAGE_DISABLED: '1',
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
    const staleAtlas = path.join(srv.runtime, 'workspaces', 'agents', 'atlas');
    fs.mkdirSync(staleAtlas, { recursive: true });
    fs.writeFileSync(path.join(staleAtlas, 'agent.json'), JSON.stringify({ id: 'atlas', enabled: true }));
    const settingsAgents = await request(srv.port, 'GET', '/api/settings/agents');
    assert.equal(settingsAgents.status, 200);
    assert.equal(settingsAgents.json.agents.some(agent => agent.id === 'atlas'), false, 'stale removed workspaces must not reappear in Settings');
    const atlasDetails = await request(srv.port, 'GET', '/api/agents/atlas/details');
    assert.equal(atlasDetails.status, 404);

    const help = await slashRun(srv.port, '/help');
    assert.equal(help.ok, true);
    assert.match(help.events.at(-1).text, /\/goal <target>/);

    const unknownDirectChat = await request(srv.port, 'POST', '/api/chat/not-an-agent', { message: 'hello' });
    assert.equal(unknownDirectChat.status, 404);
    assert.equal(unknownDirectChat.json.error, 'agent not found');

    const emptyDirectChat = await request(srv.port, 'POST', '/api/chat/webapp-recon', { message: '' });
    assert.equal(emptyDirectChat.status, 400);
    assert.equal(emptyDirectChat.json.error, 'message required');

    const goal = await slashRun(srv.port, '/goal example.com');
    assert.equal(goal.ok, true);
    assert.match(goal.events.at(-1).text, /DradisTab/);
    assert.match(goal.events.at(-1).text, /DomainsAI/);

    const overviewDb = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'));
    try {
      overviewDb.prepare(`INSERT INTO engagements (id, target_name, scope, status) VALUES (?, ?, ?, 'active')`)
        .run('overview-test', 'example.com', JSON.stringify({ include: ['example.com'], exclude: ['admin.example.com'] }));
      overviewDb.prepare(`INSERT INTO plans (id, engagement_id, version, state, plan_json) VALUES (?, ?, 1, 'pending_approval', ?)`)
        .run('overview-plan', 'overview-test', JSON.stringify({ vectors: [] }));
      overviewDb.prepare(`INSERT INTO tasks (engagement_id, assigned_to, task_type, target, status) VALUES (?, ?, ?, ?, ?)`)
        .run('overview-test', 'webapp-recon', 'recon', 'example.com', 'running');
      overviewDb.prepare(`
        INSERT INTO findings (engagement_id, target_url, finding_type, affected_component, severity, title, discovered_by, validation_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('overview-test', 'https://example.com', 'header', '/', 'high', 'Test finding', 'webapp-recon', 'pending');
      overviewDb.prepare(`
        INSERT INTO dashboard_transcript_events (engagement_id, agent_id, kind, event_json, ts)
        VALUES ('overview-test', ?, 'result', ?, datetime('now'))
      `).run('webapp-recon', JSON.stringify({ costUsd: 0.25, usage: { input_tokens: 100, output_tokens: 25 } }));
    } finally {
      overviewDb.close();
    }
    const overview = await request(srv.port, 'GET', '/api/overview');
    assert.equal(overview.status, 200, overview.raw);
    assert.equal(overview.json.version, EXPECTED_VERSION);
    assert.equal(overview.json.engagement.target, 'example.com');
    assert.equal(overview.json.phase, 'Awaiting approval');
    assert.equal(overview.json.pendingApprovals, 1);
    assert.equal(overview.json.findings.high, 1);
    assert.equal(overview.json.tasks.running, 1);
    assert.equal(overview.json.assessmentMetrics.metering.costUsd, 0.25);
    assert.equal(overview.json.assessmentMetrics.metering.tokens.totalTokens, 125);
    assert.equal(Array.isArray(overview.json.agents), true);
    assert.equal(overview.json.agents.some(agent => agent.id === 'atlas'), false);
    assert.equal(typeof overview.json.fullAccess.enabled, 'boolean');
    assert.equal(overview.json.fullAccess.available, false);
    assert.equal(overview.json.llmUsage.available, false);
    assert.equal(overview.json.llmUsage.reason, 'disabled');

    const trafficDir = path.join(srv.runtime, 'traffic');
    const trafficFile = path.join(trafficDir, 'proxy-events.jsonl');
    fs.mkdirSync(trafficDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(trafficFile, `${JSON.stringify({ id: 1, ts: Date.now(), method: 'GET', url: 'https://example.com', status: 200 })}\n`, { mode: 0o600 });
    const runtimeRefresh = await request(srv.port, 'POST', '/api/gateway/restart');
    assert.equal(runtimeRefresh.status, 200, runtimeRefresh.raw);
    assert.equal(runtimeRefresh.json.ok, true);
    assert.equal(runtimeRefresh.json.plansReset, false);
    assert.equal(runtimeRefresh.json.blackboardReset, false);
    assert.equal(runtimeRefresh.json.proxyReset, false);
    assert.equal(runtimeRefresh.json.blackboard.preserved, true);
    assert.match(fs.readFileSync(trafficFile, 'utf8'), /example\.com/);
    const refreshedPlans = await request(srv.port, 'GET', '/api/plans');
    assert.equal(refreshedPlans.json.plans.length, 1);
    const refreshedProxy = await request(srv.port, 'GET', '/api/proxy/history');
    assert.equal(refreshedProxy.json.length, 1);

    const preservedDb = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'), { readonly: true });
    try {
      assert.equal(preservedDb.prepare("SELECT COUNT(*) AS n FROM engagements").get().n >= 1, true);
      assert.equal(preservedDb.prepare("SELECT COUNT(*) AS n FROM findings").get().n, 1);
      assert.equal(preservedDb.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
      assert.equal(preservedDb.prepare("SELECT COUNT(*) AS n FROM dashboard_transcript_events").get().n > 0, true);
    } finally {
      preservedDb.close();
    }

    const usage = await slashRun(srv.port, '/investigate');
    assert.equal(usage.ok, true);
    assert.match(usage.events.at(-1).text, /Ready\. The local ROE/);

    const removedRps = await slashRun(srv.port, '/rps');
    assert.equal(removedRps.ok, false);
    assert.match(removedRps.events.at(-1).text, /unknown command: \/rps/);

    const gladosStatus = path.join(srv.runtime, 'workspaces', 'agents', 'glados', 'AGENT-STATUS.md');
    fs.mkdirSync(path.dirname(gladosStatus), { recursive: true });
    fs.writeFileSync(gladosStatus, '# AGENT-STATUS.md\n\nPrior engagement report package exists.\n');
    const isolatedSession = await request(srv.port, 'POST', '/api/investigation-sessions', {
      name: 'Fresh blind test', metadata: { unassigned: true },
    });
    assert.equal(isolatedSession.status, 201);
    assert.ok(isolatedSession.json.agentStatusReset.reset > 0);
    assert.doesNotMatch(fs.readFileSync(gladosStatus, 'utf8'), /Prior engagement report package exists/);
    assert.match(fs.readFileSync(gladosStatus, 'utf8'), /GLaDOS is idle/);

    const localRepo = path.join(srv.root, 'repo');
    fs.mkdirSync(localRepo);
    cp.execFileSync('git', ['init', '-q', localRepo]);
    fs.writeFileSync(path.join(localRepo, 'main.go'), 'package main\nfunc main() {}\n');
    cp.execFileSync('git', ['-C', localRepo, 'add', '.']);
    cp.execFileSync('git', ['-C', localRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const review = await slashRun(srv.port, `/security-review ${localRepo}`);
    assert.equal(review.ok, true);
    assert.match(review.events.at(-1).text, /Queued expedited source-code security review/);
    const reviewDb = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'), { readonly: true });
    try {
      const engagement = reviewDb.prepare("SELECT id FROM engagements WHERE target_name=? ORDER BY id DESC LIMIT 1").get(localRepo);
      const run = JSON.parse(fs.readFileSync(path.join(srv.runtime, 'investigations', engagement.id, 'security-review', 'run.json'), 'utf8'));
      const settings = settingsAgents.json.agents;
      assert.equal(run.modelPolicy.expectedModels['source-code-primary'], settings.find(agent => agent.id === 'source-code').model);
      assert.equal(run.modelPolicy.expectedModels['source-review-validator'], settings.find(agent => agent.id === 'source-review-validator').model);
      assert.equal(run.modelPolicy.expectedModels.coordinator, settings.find(agent => agent.id === 'glados').model);
      assert.deepEqual(run.modelPolicy.allowedModels.sort(), [...new Set(Object.values(run.modelPolicy.expectedModels))].sort());
    } finally {
      reviewDb.close();
    }

    const status = await slashRun(srv.port, '/status');
    assert.equal(status.ok, true);
    assert.match(status.events.at(-1).text, /Goals:/);

    const halt = await slashRun(srv.port, '/halt webapp-vuln');
    assert.equal(halt.ok, true);
    assert.match(halt.events.at(-1).text, /"agentId": "webapp-vuln"/);

    const haltDb = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'), { readonly: true });
    try {
      const notices = haltDb.prepare(`
        SELECT agent_id, kind, text
        FROM dashboard_transcript_events
        WHERE kind = 'operator-event' AND text LIKE '%Operator halted webapp-vuln%'
        ORDER BY id ASC
      `).all();
      assert.deepEqual(notices.map(row => row.agent_id), ['webapp-vuln', 'glados']);
    } finally {
      haltDb.close();
    }

    const resume = await slashRun(srv.port, '/resume webapp-vuln');
    assert.equal(resume.ok, true);
    assert.match(resume.events.at(-1).text, /"agentId": "webapp-vuln"/);

    const resumeDb = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'), { readonly: true });
    try {
      const notices = resumeDb.prepare(`
        SELECT agent_id, kind, text
        FROM dashboard_transcript_events
        WHERE kind = 'operator-event' AND text LIKE '%Operator resumed webapp-vuln%'
        ORDER BY id ASC
      `).all();
      assert.deepEqual(notices.map(row => row.agent_id), ['webapp-vuln', 'glados']);
      assert.equal(notices.every(row => /halt gate/i.test(row.text)), true);
    } finally {
      resumeDb.close();
    }

    const removedHaltAll = await slashRun(srv.port, '/halt-all');
    assert.equal(removedHaltAll.ok, false);
    assert.match(removedHaltAll.events.at(-1).text, /unknown command: \/halt-all/);

    const db = new Database(path.join(srv.runtime, 'blackboard', 'blackboard.db'), { readonly: true });
    try {
      const goals = db.prepare('SELECT type, target, status FROM controller_goals ORDER BY created_at ASC').all();
      assert.equal(goals.some(g => g.type === 'webapp_goal' && g.target === 'example.com'), true, 'runtime refresh preserves prior engagement/controller rows');
      assert.equal(goals.some(g => g.type === 'security_review' && g.target === localRepo), true);
      const jobs = db.prepare('SELECT agent_id, job_type, target, status FROM controller_jobs').all();
      assert.deepEqual(jobs.map(j => [j.agent_id, j.job_type, j.target, j.status]), [
        ['glados', 'security_review_workflow_v3', localRepo, 'queued'],
      ]);
      const controllerStatus = await request(srv.port, 'GET', '/api/controller/status');
      assert.equal(controllerStatus.status, 200, controllerStatus.raw);
      assert.equal(controllerStatus.json.securityReviews.length, 1);
      assert.equal(controllerStatus.json.securityReviews[0].progress.phase, 'Queued');
      assert.equal(controllerStatus.json.securityReviews[0].progress.percent, 0);
    } finally {
      db.close();
    }
  } finally {
    await srv.stop();
  }
});
