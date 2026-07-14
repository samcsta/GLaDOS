const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
  assembleAgentPrompt,
  decideToolUse,
  loadPolicy,
  mapSdkMessageToEvents,
  mountedToolsForAgent,
  streamAgentTurn,
} = require('../lib/harness/agent-sdk');
const { proxyBackendConfig } = require('../lib/proxy/mitmproxy-runner');

const ROOT = path.resolve(__dirname, '..', '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function recordedMessages(fixture) {
  return fixture.turn?.recordedSdkMessages
    || fixture.recordedSdkMessages
    || fixture.cases?.flatMap(entry => entry.recordedSdkMessages || [])
    || [];
}

function normalizeEvent(ev) {
  const out = {};
  for (const key of ['agentId', 'kind', 'toolName', 'toolCallId', 'toolInput', 'isError']) {
    if (ev[key] !== undefined) out[key] = ev[key];
  }
  if (ev.text !== undefined && ev.kind !== 'tool-call') out.text = ev.text;
  if (ev.parentToolUseId) out.parentToolUseId = ev.parentToolUseId;
  if (Array.isArray(ev.permissionDenials) && ev.permissionDenials.length) out.permissionDenials = ev.permissionDenials;
  return out;
}

function mapRecorded(agentId, messages) {
  const context = { subagentByParentToolUseId: new Map() };
  return messages.flatMap(message => mapSdkMessageToEvents(agentId, message, context)).map(normalizeEvent);
}

async function streamRecorded(agentId, messages) {
  async function* fakeQuery() {
    for (const message of messages) yield message;
  }
  const events = await streamAgentTurn({
    agentId,
    prompt: 'fixture replay',
    store: false,
    queryImpl: () => fakeQuery(),
    options: { sdkOptions: { includePartialMessages: true }, haltPollMs: 0 },
  });
  return events.map(normalizeEvent);
}

test('v4 fixtures include single-agent, proxy, and full subagent-chain parity data', () => {
  const single = readJson('test/fixtures/v4/golden-single-agent.json');
  const chain = readJson('test/fixtures/v4/golden-subagent-chain.json');
  const proxy = readJson('test/fixtures/v4/proxy-history.json');
  const negative = readJson('test/fixtures/v4/golden-negative-events.json');
  assert.equal(single.sourceVersion, 'v3.6.0');
  assert.equal(chain.sourceVersion, 'v3.6.0');
  assert.equal(negative.sourceVersion, 'v3.6.0');
  for (const fixture of [single, chain, negative]) {
    assert.equal(fixture.recording.kind, 'recorded-sdk-messages');
    assert.equal(fixture.recording.sdkVersion, '0.3.207');
    assert.equal(
      crypto.createHash('sha256').update(JSON.stringify(recordedMessages(fixture))).digest('hex'),
      fixture.recording.sha256,
      `${fixture.fixture} recording must be tamper-evident`
    );
  }
  assert.deepEqual(chain.chain.map(step => step.agentId), ['webapp-recon', 'webapp-vuln', 'webapp-validator']);
  assert.equal(chain.chain[1].handoff_from_tool_use_id, chain.chain[0].tool_use_id);
  assert.equal(chain.chain[2].handoff_from_tool_use_id, chain.chain[1].tool_use_id);
  assert.equal(chain.chain.every(step => step.response_parent_tool_use_id === step.tool_use_id), true);
  assert.deepEqual(
    chain.expectedEvents.filter(event => event.kind === 'tool-call').map(event => event.agentId),
    ['glados', 'glados', 'glados'],
    'only GLaDOS may dispatch specialists in the parity chain'
  );
  assert.ok(proxy.rows.some(row => row.agentTag === 'webapp-vuln'));
  assert.ok(negative.cases.some(c => c.name === 'disabled-task-dispatch'));
});

test('golden fixtures structurally match SDK stream mapping and prompt assembly', async () => {
  const single = readJson('test/fixtures/v4/golden-single-agent.json');
  const chain = readJson('test/fixtures/v4/golden-subagent-chain.json');
  const negative = readJson('test/fixtures/v4/golden-negative-events.json');

  assert.deepEqual(assembleAgentPrompt('glados').files, single.turn.assembledPromptFiles);
  assert.deepEqual(assembleAgentPrompt('glados').files, chain.assembledPromptFiles);

  assert.deepEqual(
    mapRecorded(single.agentId, single.turn.recordedSdkMessages),
    single.turn.expectedEvents.map(normalizeEvent)
  );

  assert.deepEqual(
    await streamRecorded('glados', chain.recordedSdkMessages),
    chain.expectedEvents.map(normalizeEvent)
  );

  const disabled = negative.cases.find(c => c.name === 'disabled-task-dispatch');
  assert.deepEqual(
    await streamRecorded(disabled.agentId, disabled.recordedSdkMessages),
    disabled.expectedEvents.map(normalizeEvent)
  );

  const halt = negative.cases.find(c => c.name === 'halt-abort');
  const haltRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-halt-fixture-'));
  const haltScript = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const dir = path.join(process.env.GLADOS_RUNTIME_DIR, 'halts')",
    "fs.mkdirSync(dir, { recursive: true, mode: 0o700 })",
    `fs.writeFileSync(path.join(dir, '${halt.agentId}.json'), JSON.stringify({ agentId: '${halt.agentId}', reason: 'golden halt', initiator: 'test' }), { mode: 0o600 })`,
    "const { decideToolUse } = require('./dashboard/lib/harness/agent-sdk')",
    `process.stdout.write(JSON.stringify(decideToolUse(${JSON.stringify({ agentId: halt.agentId, toolName: halt.toolName, input: halt.toolInput })})))`,
  ].join(';');
  const halted = require('node:child_process').spawnSync(process.execPath, ['-e', haltScript], {
    cwd: ROOT,
    env: { ...process.env, GLADOS_RUNTIME_DIR: haltRuntime, BLACKBOARD_DB: path.join(haltRuntime, 'blackboard.db'), WATCHDOG_DB: path.join(haltRuntime, 'watchdog.db') },
    encoding: 'utf8',
  });
  assert.equal(halted.status, 0, halted.stderr);
  const haltDecision = JSON.parse(halted.stdout);
  assert.equal(haltDecision.allowed, false);
  assert.equal(haltDecision.reason, halt.expectedDecisionReason);

  const unmounted = negative.cases.find(c => c.name === 'unmounted-tool-deny');
  const unmountedDecision = decideToolUse({
    agentId: unmounted.agentId,
    toolName: unmounted.toolName,
    input: unmounted.toolInput,
  });
  assert.equal(unmountedDecision.allowed, false);
  assert.equal(unmountedDecision.reason, unmounted.expectedDecisionReason);
});

test('Atlas is removed from active registry, templates, dashboard routes, and UI', () => {
  const registry = readJson('templates/agent-registry.json');
  assert.equal(registry.some(agent => agent.id === 'atlas'), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'templates/agents/default/atlas')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'workspaces/atlas')), false);
  const server = fs.readFileSync(path.join(ROOT, 'dashboard/server.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/public/index.html'), 'utf8');
  const enforcement = [
    'tools/glados-ops-mcp/index.js',
    'watchdog/lib/plan-gate.js',
  ].map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  assert.equal(/api\/chat\/atlas|ATLAS_UPLOADS|open-chatbot|renderChatBotPane|\batlas\b/i.test(`${server}\n${app}\n${html}\n${enforcement}`), false);
});

test('v4 model aliases are bare Anthropic Messages aliases without provider prefixes or leading spaces', () => {
  const registry = readJson('templates/agent-registry.json');
  for (const agent of registry) {
    assert.equal(agent.model.includes('/'), false, `${agent.id} model should be a bare alias`);
    assert.equal(agent.model, agent.model.trim(), `${agent.id} model should not have leading/trailing whitespace`);
  }
});

test('disabled high-risk agent posture survives registry migration', () => {
  const registry = readJson('templates/agent-registry.json');
  for (const agent of registry.filter(a => /^(c2|phish|postex)|^phisherman$/.test(a.id))) {
    assert.equal(agent.enabled, false, `${agent.id} must remain disabled by default`);
  }
});

test('v4 tool manifest provides a managed core and specialist tool surface', () => {
  const manifest = readJson('config/redteam-tools.json');
  const registry = readJson('templates/agent-registry.json');
  const policy = readJson('config/glados-policy.json');
  const names = new Set(manifest.tools.map(tool => tool.id));
  for (const required of ['curl', 'mitmproxy', 'nmap', 'nuclei', 'subfinder', 'semgrep']) {
    assert.equal(names.has(required), true, `${required} must be managed by the v4 tool bootstrap`);
  }
  assert.equal(manifest.tools.every(tool => tool.commands?.length && tool.mac?.manager), true);
  for (const agent of registry.filter(entry => entry.enabled !== false)) {
    assert.equal(mountedToolsForAgent(agent.id, policy).includes('Bash'), true, `${agent.id} must mount shell execution`);
    assert.equal(manifest.tools.some(tool => tool.agents.includes('all') || tool.agents.includes(agent.id)), true, `${agent.id} must have managed CLI coverage`);
  }
});

test('v4 desktop UI keeps operation buttons in Settings and removes appearance controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const topbarControls = html.match(/<div class="controls">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.equal(/<button\b/i.test(topbarControls), false, 'topbar controls should not contain operation buttons');
  assert.equal(/color-profile-options|density-options|font-size-options|glados-dash\.color-profile|glados-dash\.density|glados-dash\.font-size/i.test(`${html}\n${app}`), false);
  assert.equal(/open-about|openAbout|renderAboutPane|about-pane/i.test(`${html}\n${app}`), false);
  assert.match(app, /<h2>Operations<\/h2>/);
  assert.match(app, /id="update-app"/);
  assert.match(app, /id="halt-one"/);
  assert.match(app, /id="resume-one"/);
  assert.doesNotMatch(app, /id="halt-all"|id="resume-all"/);
  assert.match(app, /id="chat-stop"/);
  assert.doesNotMatch(`${html}\n${app}`, /indicators-heading|indicators-group|proxy-rps|refreshIndicators|Proxy RPS|Burp RPS/);
  assert.match(app, /Enter to send, Shift\+Enter for newline/);
  assert.match(app, /ev\.key === 'Enter' && !ev\.shiftKey/);
});

test('v4 slash commands keep investigation prompt slash-only and omit RPS shortcuts', () => {
  const slashSource = fs.readFileSync(path.join(ROOT, 'dashboard/lib/slash.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'dashboard/server.js'), 'utf8');
  assert.match(slashSource, /function investigateReadyPrompt/);
  assert.match(server, /cmd === '\/investigate' \? slash\.investigateReadyPrompt\(\)/);
  assert.doesNotMatch(server, /function extractInvestigationTarget/);
  assert.doesNotMatch(server, /const kickoffTarget = extractInvestigationTarget\(message\)/);
  assert.doesNotMatch(slashSource, /\/rps|\/breaker|Proxy RPS/i);
});

test('v4 transcript stream mapper emits UI-native partial events', () => {
  const [event] = mapSdkMessageToEvents('glados', {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    uuid: 'partial-ui-native',
    session_id: 'sess-ui-native',
  });
  assert.equal(event.kind, 'text-stream');
  assert.equal(event.evtType, 'text_delta');
  assert.equal(event.delta, 'hello');
  assert.equal(event.runId, 'sess-ui-native');
});

test('v4 transcript renderer ignores orphan stream-end events', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  assert.match(app, /if \(isEnd && !entry\) \{[\s\S]*?return;[\s\S]*?\}\s*\n\s*if \(!entry\)/);
});

test('v4 report library provides searchable, source-filtered navigation with durable selection', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard/public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/styles.css'), 'utf8');
  assert.match(app, /id="reports-search"/);
  assert.match(app, /data-report-scope="investigations"/);
  assert.match(app, /function filterReportTree\(/);
  assert.match(app, /state\.reports\.selectedPath = relPath/);
  assert.match(app, /function formatReportDate\(/);
  assert.match(css, /\.reports-tree \.file\.active[\s\S]*?box-shadow: inset 3px 0 0 var\(--accent\)/);
});

test('v4 report index budgets reports and investigations independently', () => {
  const source = fs.readFileSync(path.join(ROOT, 'dashboard/lib/reports.js'), 'utf8');
  assert.match(source, /ROOTS\.map\(r => \{\s*const state = \{ count: 0, truncated: false \}/);
  assert.match(source, /truncatedRoots/);
  assert.match(source, /GLADOS_REPORT_TREE_MAX_ENTRIES \|\| 20000/);
  assert.match(source, /GLADOS_REPORT_TREE_MAX_DEPTH \|\| 16/);
});

test('v4 proxy backend defaults to native mitmproxy capture', () => {
  const config = proxyBackendConfig({});
  assert.equal(config.backend, 'mitmproxy');
});

test('v4 active runtime files do not depend on legacy harness or proxy names', () => {
  const activeFiles = [
    'dashboard/server.js',
    'dashboard/lib/agent-details.js',
    'dashboard/lib/harness/agent-sdk.js',
    'dashboard/public/app.js',
    'dashboard/public/index.html',
    'dashboard/public/styles.css',
    'desktop/main.cjs',
    'scripts/bootstrap-macos.sh',
    'scripts/lib/glados-local.js',
    'scripts/update.sh',
    'watchdog/lib/config.js',
    'watchdog/lib/halt.js',
    'watchdog/lib/safety-gate.js',
    'watchdog/watchdog-mcp/index.js',
  ];
  const activeSource = activeFiles.map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  assert.doesNotMatch(activeSource, /OpenClaw|openclaw|OPENCLAW|Burp|burp|BURP_|raw-stream|RawStream|AgentWatcher|JsonlTail|tag-injector|patch-openclaw|restart-gateway/);
});

test('v4 active prompt corpus does not instruct legacy harness or proxy usage', () => {
  const roots = [
    path.join(ROOT, 'templates/agents/default'),
    path.join(ROOT, 'workspaces'),
  ];
  const files = [];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'memory') continue;
        walk(full);
      } else if (/\.(md|skill)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  roots.forEach(walk);
  const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /OpenClaw|openclaw|OPENCLAW|Burp|burp|BURP_|raw-stream|tag-injector|patch-openclaw/);
  assert.doesNotMatch(source, /Ready\. The local ROE, operator context, and local secret profiles are already configured/);
});

test('v4 desktop branding uses text header and GLaDOS desktop icon without renaming the app bundle', () => {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/public/index.html'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8');
  const desktopPkg = readJson('desktop/package.json');
  assert.match(html, />\s*GLaDOS Ops\s*</);
  assert.doesNotMatch(html, /brand-logo|glados-cartoon\.png/);
  assert.doesNotMatch(html, /GLaDOS v4\.0 Ops/);
  assert.match(main, /title:\s*'GLaDOS Ops'/);
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/build/icon.icns')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/build/icon-source.png')), true);
  assert.equal(desktopPkg.build.productName, 'GLaDOS');
  assert.equal(desktopPkg.build.mac.icon, 'build/icon.icns');
});

test('v4 source tree and desktop resources contain no compatibility runtime artifacts', () => {
  const desktopPkg = readJson('desktop/package.json');
  const resources = desktopPkg.build.extraResources || [];
  const serialized = JSON.stringify(resources);
  assert.doesNotMatch(serialized, /openclaw|burp|raw-stream|tag-injector/i);
  for (const rel of [
    'dashboard/lib/openclaw.js',
    'dashboard/lib/agent-watcher.js',
    'dashboard/lib/jsonl-tail.js',
    'dashboard/lib/raw-stream-tail.js',
    'scripts/openclaw-compat.sh',
    'scripts/setup-openclaw-macos.sh',
    'tools/tag-injector.js',
    'tools/patch-openclaw-bundle.sh',
    'tools/burp-ext-glados-proxy-api',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }
});

test('v4 plan ACL writes under the GLaDOS runtime directory', () => {
  const plans = fs.readFileSync(path.join(ROOT, 'dashboard/routes/plans.js'), 'utf8');
  assert.match(plans, /GLADOS_RUNTIME_DIR/);
  assert.match(plans, /policy', 'glados-fetch-acl\.json'/);
  assert.doesNotMatch(plans, /OPENCLAW_HOME|sessions_spawn|tag-injector|\.openclaw/);
});
