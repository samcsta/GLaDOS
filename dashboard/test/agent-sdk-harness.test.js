const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROMPT_FILE_ORDER,
  bareModelAlias,
  assembleAgentPrompt,
  loadRegistry,
  loadPolicy,
  agentEnabled,
  buildSdkEnv,
  buildAgentSdkOptions,
  buildAgentDefinitions,
  decideToolUse,
  mountedToolsForAgent,
  autoApprovedToolsForAgent,
  mapSdkMessageToEvents,
  streamAgentTurn,
  browserServerName,
} = require('../lib/harness/agent-sdk');
const { SdkSessionRegistry } = require('../lib/harness/session-registry');

function baseTestEnv(extra = {}) {
  const env = { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-token', ...extra };
  for (const key of ['GLADOS_BROWSER_MCP', 'GLADOS_BROWSER_MCP_COMMAND', 'GLADOS_BROWSER_MCP_ARGS', 'GLADOS_BROWSER_MCP_ARGS_JSON', 'GLADOS_MITM_LISTEN_HOST', 'GLADOS_MITM_LISTEN_PORT', 'GLADOS_PROXY_URL', 'GLADOS_REPLAY_PROXY']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

test('normalizes LiteLLM model aliases for the Anthropic Messages route', () => {
  assert.equal(bareModelAlias(' custom-llmapi-redteamstuff-com/claude-sonnet-4-6 '), 'claude-sonnet-4-6');
  assert.equal(bareModelAlias(' claude-sonnet-4-6 '), 'claude-sonnet-4-6');
  assert.equal(bareModelAlias('claude-opus-4-8'), 'claude-opus-4-8');
});

test('uses per-agent tools as the existence allowlist and PreToolUse as hard deny', async () => {
  const opts = buildAgentSdkOptions('webapp-recon', {
    env: baseTestEnv(),
    turnTargets: ['https://ford.com'],
  });
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.forwardSubagentText, true);
  assert.equal(opts.permissionMode, 'dontAsk');
  assert.deepEqual(opts.tools, mountedToolsForAgent('webapp-recon'));
  assert.equal(opts.tools.includes('Task'), false);
  assert.equal(opts.tools.includes('Agent'), false);
  assert.ok(opts.tools.includes('Bash'));
  assert.equal(opts.tools.includes('WebFetch'), false);
  assert.ok(opts.tools.includes('WebSearch'));
  assert.ok(opts.tools.includes('mcp__glados-ops'));
  assert.equal(opts.allowedTools.includes('Task'), false);
  assert.equal(opts.allowedTools.includes('Agent'), false);
  assert.deepEqual(opts.allowedTools, autoApprovedToolsForAgent(opts.tools));
  assert.equal(opts.disallowedTools.includes('Bash'), false);
  assert.ok(opts.env.GLADOS_PROXY_URL.endsWith(':18080'));

  const hook = opts.hooks.PreToolUse[0].hooks[0];
  assert.equal(
    (await hook({ tool_name: 'Bash', tool_input: { command: '/usr/bin/curl -x http://127.0.0.1:18080 -k -H "X-GLaDOS-Agent: webapp-recon" https://ford.com' }, tool_use_id: 't1' }))
      .hookSpecificOutput.permissionDecision,
    'allow'
  );
  assert.deepEqual(await hook({ tool_name: 'NotebookEdit', tool_input: {}, tool_use_id: 't1b' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'NotebookEdit is not mounted for webapp-recon',
    },
  });
  assert.deepEqual(await hook({ tool_name: 'Agent', tool_input: { subagent_type: 'webapp-vuln' }, tool_use_id: 't3' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Agent is not mounted for webapp-recon',
    },
  });
  assert.deepEqual(await opts.canUseTool('Agent', { subagent_type: 'webapp-vuln' }, { toolUseID: 't5' }), {
    behavior: 'deny',
    message: 'Agent is not mounted for webapp-recon',
    interrupt: false,
    toolUseID: 't5',
  });
});

test('GLaDOS process mounts fleet tools but enforces caller-specific permissions', async () => {
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const opts = buildAgentSdkOptions('glados', { env, turnTargets: ['https://example.test'] });
  const rootTools = mountedToolsForAgent('glados', loadPolicy(), { env });
  const webappBrowserMount = `mcp__${browserServerName('webapp-recon')}`;
  assert.ok(opts.tools.includes('Agent'));
  assert.ok(opts.tools.includes('Bash'));
  assert.ok(opts.tools.includes(webappBrowserMount));
  assert.equal(rootTools.includes('Bash'), true);
  assert.equal(rootTools.some(tool => tool.startsWith('mcp__browser-')), false);
  assert.equal(opts.allowedTools.includes('Agent'), false);
  assert.equal(opts.allowedTools.includes('Bash'), true);
  assert.equal(opts.allowedTools.includes(webappBrowserMount), false);
  assert.equal('glados' in opts.agents, false);
  assert.equal('claude' in opts.agents, false);
  assert.ok(opts.agents['webapp-recon'].tools.includes('Bash'));
  assert.ok(opts.agents['webapp-recon'].tools.includes(webappBrowserMount));
  assert.equal(opts.agents['webapp-recon'].tools.includes('Agent'), false);
  assert.deepEqual(opts.agents['webapp-recon'].mcpServers, ['blackboard', 'watchdog', 'glados-ops', browserServerName('webapp-recon')]);

  const hook = opts.hooks.PreToolUse[0].hooks[0];
  const start = opts.hooks.SubagentStart[0].hooks[0];
  await start({ hook_event_name: 'SubagentStart', agent_id: 'worker-1', agent_type: 'webapp-recon' });
  assert.equal((await hook({
    hook_event_name: 'PreToolUse',
    agent_id: 'worker-1',
    agent_type: 'webapp-recon',
    tool_name: 'Bash',
    tool_input: { command: 'true' },
    tool_use_id: 'bash-1',
  })).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal((await hook({
    hook_event_name: 'PreToolUse',
    agent_id: 'worker-1',
    agent_type: 'webapp-recon',
    tool_name: `${webappBrowserMount}__browser_navigate`,
    tool_input: { url: 'https://example.test' },
    tool_use_id: 'browser-1',
  })).hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(await hook({
    hook_event_name: 'PreToolUse',
    agent_id: 'worker-1',
    agent_type: 'webapp-recon',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'net-recon' },
    tool_use_id: 'nested-agent-1',
  }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Agent is not mounted for webapp-recon',
    },
  });
  assert.equal((await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'true' },
    tool_use_id: 'root-bash-1',
  })).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal((await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'webapp-recon' },
    tool_use_id: 'root-agent-1',
  })).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal((await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'claude' },
    tool_use_id: 'root-agent-2',
  })).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await opts.canUseTool('Bash', { command: 'true' }, { toolUseID: 'bash-2', agentID: 'worker-1' }), {
    behavior: 'allow',
    toolUseID: 'bash-2',
  });
  assert.deepEqual(await opts.canUseTool('Bash', { command: 'true' }, { toolUseID: 'bash-3', agentID: 'unknown-worker' }), {
    behavior: 'deny',
    message: 'Unknown subagent unknown-worker attempted to use Bash',
    interrupt: true,
    toolUseID: 'bash-3',
  });
});

test('optional browser MCP mounts only when enabled and uses the active GLaDOS proxy', () => {
  const serverName = browserServerName('webapp-recon');
  const mount = `mcp__${serverName}`;
  const disabled = buildAgentSdkOptions('webapp-recon', {
    env: baseTestEnv(),
  });
  assert.equal(disabled.tools.includes(mount), false);
  assert.equal(serverName in disabled.mcpServers, false);

  const enabled = buildAgentSdkOptions('webapp-recon', {
    env: {
      ...baseTestEnv(),
      GLADOS_BROWSER_MCP: '1',
      GLADOS_MITM_LISTEN_PORT: '19090',
    },
  });
  assert.ok(enabled.tools.includes(mount));
  assert.ok(enabled.allowedTools.includes(`${mount}__*`));
  assert.ok(enabled.mcpServers[serverName].command);
  const configFlag = enabled.mcpServers[serverName].args.indexOf('--config');
  assert.notEqual(configFlag, -1);
  const browserConfig = JSON.parse(fs.readFileSync(enabled.mcpServers[serverName].args[configFlag + 1], 'utf8'));
  assert.equal(browserConfig.browser.launchOptions.proxy.server, 'http://127.0.0.1:19090');
  assert.equal(browserConfig.browser.contextOptions.ignoreHTTPSErrors, true);
  assert.equal(browserConfig.browser.contextOptions.extraHTTPHeaders['X-GLaDOS-Agent'], 'webapp-recon');
  assert.equal(browserConfig.browser.contextOptions.extraHTTPHeaders['X-GLaDOS-Transport'], 'browser-mcp');
  assert.equal(decideToolUse({
    agentId: 'webapp-recon',
    toolName: `${mount}__browser_navigate`,
    input: { url: 'https://ford.com' },
    policy: loadPolicy(),
    env: enabled.env,
    turnTargets: ['https://ford.com'],
  }).allowed, true);
  assert.equal(decideToolUse({
    agentId: 'webapp-recon',
    toolName: `${mount}__browser_click`,
    input: { ref: 'link-1' },
    policy: loadPolicy(),
    env: enabled.env,
    turnTargets: ['https://ford.com'],
  }).allowed, true);
});

test('SDK resume ids persist outside the app payload and feed the resume option', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-sdk-resume-'));
  const registry = new SdkSessionRegistry({ runtimeDir: runtime });
  registry.set('glados', 'session-one');
  assert.equal(registry.get('glados'), 'session-one');
  assert.equal(fs.statSync(path.dirname(registry.file)).mode & 0o077, 0);
  assert.equal(fs.statSync(registry.file).mode & 0o077, 0);
  const opts = buildAgentSdkOptions('glados', {
    env: baseTestEnv(),
    resumeSessionId: registry.get('glados'),
  });
  assert.equal(opts.resume, 'session-one');
  registry.clear('glados');
  assert.equal(registry.get('glados'), null);
});

test('every enabled subagent mounts the core operational tool and MCP baseline', () => {
  const policy = loadPolicy();
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const required = [
    'Read',
    'Glob',
    'Grep',
    'Bash',
    'WebSearch',
    'mcp__blackboard',
    'mcp__watchdog',
    'mcp__glados-ops',
  ];
  const missingByAgent = [];
  for (const row of loadRegistry({ env })) {
    if (!row?.id || row.id === 'glados' || !agentEnabled(row.id, { policy })) continue;
    const opts = buildAgentSdkOptions(row.id, { env });
    const tools = mountedToolsForAgent(row.id, policy, { env });
    const missing = required.filter(tool => !tools.includes(tool));
    if (missing.length) missingByAgent.push(`${row.id}: ${missing.join(', ')}`);
    assert.equal(tools.includes('Task'), false, `${row.id} must not mount Task`);
    assert.equal(tools.includes('Agent'), false, `${row.id} must not mount Agent`);
    for (const tool of tools) {
      assert.equal(opts.disallowedTools.includes(tool), false, `${row.id} mounted ${tool} must not be disallowed`);
    }
    const browserMount = `mcp__${browserServerName(row.id)}`;
    assert.equal(
      tools.includes(browserMount),
      policy.browserMcpAgents.includes(row.id),
      `${row.id} browser MCP existence must match its explicit policy`
    );
  }
  assert.deepEqual(missingByAgent, []);
});

test('every enabled agent mounts Bash and only GLaDOS can dispatch', () => {
  const policy = loadPolicy();
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const missingBash = [];
  const dispatchCapable = [];
  for (const row of loadRegistry({ env })) {
    if (!row?.id || !agentEnabled(row.id, { policy })) continue;
    const tools = mountedToolsForAgent(row.id, policy, { env });
    if (!tools.includes('Bash')) missingBash.push(row.id);
    if (tools.includes('Task') || tools.includes('Agent')) dispatchCapable.push(row.id);
  }
  assert.deepEqual(missingBash, []);
  assert.deepEqual(dispatchCapable, ['glados']);
});

test('forces LiteLLM gateway auth and refuses OAuth fallback', () => {
  assert.throws(
    () => buildSdkEnv({
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'glados-no-llm-secret-')),
      GLADOS_RUNTIME_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'glados-no-llm-runtime-')),
      GLADOS_LLM_KEYCHAIN_SERVICE: `glados.test.missing.${Date.now()}`,
      GLADOS_LLM_KEYCHAIN_ACCOUNT: `missing-${Date.now()}`,
    }),
    /Missing GLaDOS LiteLLM key/
  );

  const env = buildSdkEnv({
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: 'litellm-test-token',
    ANTHROPIC_API_KEY: 'should-not-survive',
    CLAUDE_CODE_OAUTH_TOKEN: 'should-not-survive',
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'litellm-test-token');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://llmapi.redteamstuff.com');
  assert.equal(env.CLAUDE_CODE_USE_GATEWAY, '1');
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
});

test('denies disabled high-risk agents and blocked subagent dispatch', () => {
  assert.equal(decideToolUse({
    agentId: 'c2-builder',
    toolName: 'mcp__blackboard__list_findings',
    input: {},
  }).allowed, false);

  const dispatch = decideToolUse({
    agentId: 'glados',
    toolName: 'Task',
    input: { subagent_type: 'postex-validator' },
  });
  assert.equal(dispatch.allowed, false);
  assert.match(dispatch.reason, /not allowed|disabled/i);

  const aliasDispatch = decideToolUse({
    agentId: 'glados',
    toolName: 'Agent',
    input: { subagentType: 'webapp-recon' },
  });
  assert.equal(aliasDispatch.allowed, true);

  const aliasBlocked = decideToolUse({
    agentId: 'glados',
    toolName: 'Agent',
    input: { subagentType: 'postex-validator' },
  });
  assert.equal(aliasBlocked.allowed, false);
  assert.match(aliasBlocked.reason, /not allowed|disabled/i);
});

test('operator workspace edits change assembled prompts and expose skills', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-agent-prompt-'));
  const agentDir = path.join(workspaceRoot, 'glados');
  fs.mkdirSync(path.join(agentDir, 'skills', 'operator-skill'), { recursive: true });
  for (const name of PROMPT_FILE_ORDER) {
    fs.writeFileSync(path.join(agentDir, name), `${name} initial\n`);
  }
  fs.writeFileSync(path.join(agentDir, 'skills', 'operator-skill', 'SKILL.md'), 'description: Operator workspace skill\n');

  const first = assembleAgentPrompt('glados', { workspaceRoot });
  assert.equal(first.source, 'workspace');
  assert.deepEqual(first.files, PROMPT_FILE_ORDER);
  assert.ok(first.prompt.includes('IDENTITY.md initial'));
  assert.ok(first.prompt.includes('operator-skill: Operator workspace skill'));
  assert.deepEqual(first.skills, ['operator-skill']);

  fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), 'IDENTITY.md edited by operator\n');
  const second = assembleAgentPrompt('glados', { workspaceRoot });
  assert.ok(second.prompt.includes('edited by operator'));
  assert.notEqual(first.prompt, second.prompt);

  const opts = buildAgentSdkOptions('glados', {
    workspaceRoot,
    env: { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-token' },
  });
  assert.ok(opts.systemPrompt.includes('edited by operator'));
  assert.ok(opts.systemPrompt.includes('Active model for this turn: claude-sonnet-5'));
  assert.ok(opts.systemPrompt.includes('Do not infer current model names from static roster tables'));
  assert.ok(opts.systemPrompt.includes('Operator-requested proxy smoke tests are diagnostics'));
  assert.ok(opts.systemPrompt.includes('dispatch that named agent directly with a proxy-smoke-test prompt'));
  assert.deepEqual(opts.gladosPromptFiles, PROMPT_FILE_ORDER);
  assert.deepEqual(opts.gladosPromptSkills, ['operator-skill']);
});

test('proxy smoke-test instructions override formal investigation preflight', () => {
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const glados = buildAgentSdkOptions('glados', { env });
  assert.ok(glados.systemPrompt.includes('Operator-requested proxy smoke tests are diagnostics'));
  assert.ok(glados.systemPrompt.includes('Do not first run Glob/Read/Grep over local context'));
  assert.match(glados.systemPrompt, /Do not search local files,\s+prior reports,\s+operator context,\s+blackboard/);
  assert.match(glados.systemPrompt, /do not run\s+`target_probe`\s+or\s+`scope_guard_check`\s+first/);

  const webappRecon = buildAgentSdkOptions('webapp-recon', { env });
  assert.ok(webappRecon.systemPrompt.includes('Proxy Smoke Test Mode'));
  assert.ok(webappRecon.systemPrompt.includes('/usr/bin/curl -x "$GLADOS_PROXY_URL"'));
  assert.ok(webappRecon.systemPrompt.includes('Do not authenticate, crawl, enumerate'));

  const definitions = buildAgentDefinitions(loadPolicy(), { env });
  assert.ok(definitions['webapp-recon'].tools.includes('Bash'));
  assert.ok(definitions['webapp-recon'].tools.includes(`mcp__${browserServerName('webapp-recon')}`));
  assert.equal(definitions['webapp-recon'].permissionMode, 'dontAsk');
  assert.equal(definitions['webapp-recon'].background, false);
  assert.match(definitions['webapp-recon'].criticalSystemReminder_EXPERIMENTAL, /GLaDOS subagent named webapp-recon/);
});

test('all assembled enabled-agent prompts avoid legacy proxy or harness instructions', () => {
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const policy = loadPolicy();
  for (const row of loadRegistry({ env })) {
    if (!row?.id || !agentEnabled(row.id, { policy })) continue;
    const opts = buildAgentSdkOptions(row.id, { env });
    assert.doesNotMatch(
      opts.systemPrompt,
      /OpenClaw|openclaw|OPENCLAW|Burp|burp|BURP_|127\.0\.0\.1:8080|localhost:1337|raw-stream|tag-injector|patch-openclaw|GLaDOS proxy Pro/,
      row.id
    );
  }
});

test('runtime context overrides stale workspace model tables', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-stale-model-prompt-'));
  const agentDir = path.join(workspaceRoot, 'glados');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
    id: 'glados',
    name: 'glados',
    model: 'claude-sonnet-5',
    enabled: true,
  }, null, 2));
  for (const name of PROMPT_FILE_ORDER) {
    const text = name === 'IDENTITY.md'
      ? '| glados | GLaDOS Leader | claude-sonnet-4-6 |\n'
      : `${name}\n`;
    fs.writeFileSync(path.join(agentDir, name), text);
  }
  const opts = buildAgentSdkOptions('glados', {
    workspaceRoot,
    env: { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-token' },
  });
  assert.equal(opts.model, 'claude-sonnet-5');
  assert.ok(opts.systemPrompt.includes('claude-sonnet-4-6'), 'stale prompt content is still visible for auditability');
  assert.ok(opts.systemPrompt.includes('Active model for this turn: claude-sonnet-5'));
  assert.ok(opts.systemPrompt.includes('- glados: claude-sonnet-5'));
  assert.ok(opts.systemPrompt.includes('If the operator asks what model you are running, answer from the active model above.'));
});

test('maps SDK partial stream, tool calls, tool results, result, and liveness events', () => {
  const context = {};
  const events = [
    ...mapSdkMessageToEvents('glados', {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
      uuid: 'partial-1',
      session_id: 's1',
    }, context),
    ...mapSdkMessageToEvents('glados', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'webapp-recon' } }] },
      parent_tool_use_id: null,
      uuid: 'assistant-1',
      session_id: 's1',
    }, context),
    ...mapSdkMessageToEvents('glados', {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'subagent thinking about a proxy-visible navigation plan' } },
      parent_tool_use_id: 'tool-1',
      uuid: 'partial-child-thinking',
      session_id: 's1',
    }, context),
    ...mapSdkMessageToEvents('webapp-recon', {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done\nagentId: internal\noutput_file: /tmp/private\n<usage>secret</usage>' }] },
      parent_tool_use_id: 'parent-1',
      uuid: 'user-1',
      session_id: 's1',
    }, context),
    ...mapSdkMessageToEvents('glados', {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: 'live-1',
      session_id: 's1',
    }, context),
    ...mapSdkMessageToEvents('glados', {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      num_turns: 2,
      uuid: 'result-1',
      session_id: 's1',
    }, context),
  ];

  assert.deepEqual(events.map(ev => ev.kind), ['text-stream', 'tool-call', 'thinking-stream', 'tool-result', 'liveness', 'result']);
  assert.equal(events[0].delta, 'hel');
  assert.equal(events[0].runId, 's1');
  assert.equal(events[1].targetAgentId, 'webapp-recon');
  assert.equal(events[2].agentId, 'webapp-recon');
  assert.equal(events[3].parentToolUseId, 'parent-1');
  assert.equal(events[3].text, 'done');
  assert.equal(events[4].live, true);
});

test('maps assistant thinking blocks and content block stops into visible thinking events', () => {
  const context = {};
  const events = [
    ...mapSdkMessageToEvents('glados', {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'visible model thinking text' }] },
      uuid: 'think-message',
      session_id: 's-think',
    }, context),
    ...mapSdkMessageToEvents('glados', {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      uuid: 'think-start',
      session_id: 's-think',
    }, context),
    ...mapSdkMessageToEvents('glados', {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      uuid: 'think-stop',
      session_id: 's-think',
    }, context),
  ];
  assert.deepEqual(events.map(ev => ev.kind), ['thinking', 'thinking-stream', 'thinking-stream']);
  assert.deepEqual(events.map(ev => ev.evtType || ev.kind), ['thinking', 'thinking_start', 'thinking_end']);
});

test('does not treat opaque SDK subagent ids as dashboard agent names', () => {
  const [event] = mapSdkMessageToEvents('glados', {
    type: 'assistant',
    agent_id: 'a1c554b2c33b4c6b1',
    message: { content: [{ type: 'text', text: 'parent-visible text' }] },
    uuid: 'opaque-agent-id',
    session_id: 'opaque-session',
  });
  assert.equal(event.agentId, 'glados');
});

test('denied tools surface as permission_denied, is_error tool_result, and result permission_denials through streamAgentTurn', async () => {
  function fakeQuery({ options }) {
    return {
      async *[Symbol.asyncIterator]() {
        const hook = options.hooks.PreToolUse[0].hooks[0];
        const hookResult = await hook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'postex' },
          tool_use_id: 'toolu_deny_postex',
        });
        assert.equal(hookResult.hookSpecificOutput.permissionDecision, 'deny');
        yield {
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Task',
          tool_use_id: 'toolu_deny_postex',
          decision_reason: hookResult.hookSpecificOutput.permissionDecisionReason,
          message: hookResult.hookSpecificOutput.permissionDecisionReason,
          uuid: 'deny-postex',
          session_id: 's-deny',
        };
        yield {
          type: 'user',
          uuid: 'tool-result-deny-postex',
          session_id: 's-deny',
          parent_tool_use_id: null,
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_deny_postex',
              content: hookResult.hookSpecificOutput.permissionDecisionReason,
              is_error: true,
              permission_denials: [{
                tool_name: 'Task',
                tool_use_id: 'toolu_deny_postex',
                tool_input: { subagent_type: 'postex' },
              }],
            }],
          },
        };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: [hookResult.hookSpecificOutput.permissionDecisionReason],
          permission_denials: [{
            tool_name: 'Task',
            tool_use_id: 'toolu_deny_postex',
            tool_input: { subagent_type: 'postex' },
          }],
          num_turns: 1,
          total_cost_usd: 0,
          uuid: 'result-deny-postex',
          session_id: 's-deny',
        };
      },
    };
  }

  const events = await streamAgentTurn({
    agentId: 'glados',
    prompt: 'dispatch postex',
    store: false,
    queryImpl: fakeQuery,
    options: {
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-token' },
      haltPollMs: 0,
    },
  });
  assert.deepEqual(events.map(ev => ev.kind), ['permission-denied', 'tool-result', 'error']);
  assert.equal(events[1].isError, true);
  assert.equal(events[2].isError, true);
  assert.equal(events[2].permissionDenials[0].tool_name, 'Task');
});

test('streams SDK messages through the dashboard event mapper without raw JSONL tailing', async () => {
  async function* fakeQuery() {
    yield {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      uuid: 'partial-2',
      session_id: 's2',
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: 'done',
      uuid: 'result-2',
      session_id: 's2',
    };
  }

  const events = await streamAgentTurn({
    agentId: 'glados',
    prompt: 'hi',
    store: false,
    queryImpl: () => fakeQuery(),
    options: { sdkOptions: { includePartialMessages: true } },
  });
  assert.deepEqual(events.map(ev => ev.text), ['hello', 'done']);
});

test('streamAgentTurn interrupts the SDK query when an abort signal fires', async () => {
  const ac = new AbortController();
  let interruptCalls = 0;
  function fakeQuery() {
    return {
      interrupt() {
        interruptCalls += 1;
      },
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } },
          uuid: 'partial-before-stop',
          session_id: 's-stop',
        };
        await new Promise(resolve => setTimeout(resolve, 15));
        yield {
          type: 'result',
          subtype: 'success',
          result: 'should not be recorded after abort',
          uuid: 'result-after-stop',
          session_id: 's-stop',
        };
      },
    };
  }

  const promise = streamAgentTurn({
    agentId: 'glados',
    prompt: 'stop me',
    store: false,
    queryImpl: fakeQuery,
    options: {
      sdkOptions: { includePartialMessages: true },
      abortSignal: ac.signal,
      haltPollMs: 0,
    },
  });
  setTimeout(() => ac.abort('test stop'), 1);
  const events = await promise;
  assert.equal(interruptCalls, 1);
  assert.deepEqual(events.map(ev => ev.text), ['first']);
});

test('streamAgentTurn interrupts an in-flight agent when its halt marker becomes active', async () => {
  let halted = false;
  let interruptCalls = 0;
  function fakeQuery() {
    return {
      interrupt() { interruptCalls += 1; },
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } },
          uuid: 'before-halt',
          session_id: 's-halt',
        };
        await new Promise(resolve => setTimeout(resolve, 20));
        yield {
          type: 'result',
          subtype: 'success',
          result: 'must not survive halt',
          uuid: 'after-halt',
          session_id: 's-halt',
        };
      },
    };
  }
  const promise = streamAgentTurn({
    agentId: 'webapp-recon',
    prompt: 'local fixture',
    store: false,
    queryImpl: fakeQuery,
    options: {
      sdkOptions: { includePartialMessages: true },
      haltPollMs: 2,
      isAgentHalted: id => id === 'webapp-recon' && halted,
    },
  });
  setTimeout(() => { halted = true; }, 3);
  const events = await promise;
  assert.equal(interruptCalls, 1);
  assert.deepEqual(events.map(event => event.text), ['working']);
});
