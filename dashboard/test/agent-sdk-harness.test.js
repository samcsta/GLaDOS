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
  waitForCoreMcpServers,
  streamAgentTurn,
  browserServerName,
  normalizeToolInput,
  toolTargetsForAgent,
  rememberToolTargets,
  resolveSdkWorkingDirectory,
  investigationDispatchContractViolation,
} = require('../lib/harness/agent-sdk');
const { SdkSessionRegistry } = require('../lib/harness/session-registry');
const { ResumeCoordinator } = require('../lib/harness/resume-coordinator');
const { classifyToolUse, extractTargets } = require('glados-watchdog/lib/safety-gate');

function baseTestEnv(extra = {}) {
  const env = { ...process.env, ANTHROPIC_AUTH_TOKEN: 'test-token', ...extra };
  for (const key of ['GLADOS_BROWSER_MCP', 'GLADOS_BROWSER_MCP_COMMAND', 'GLADOS_BROWSER_MCP_ARGS', 'GLADOS_BROWSER_MCP_ARGS_JSON', 'GLADOS_MITM_LISTEN_HOST', 'GLADOS_MITM_LISTEN_PORT', 'GLADOS_PROXY_URL', 'GLADOS_REPLAY_PROXY']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

test('resume coordinator preserves the exact interrupted specialist assignment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-resume-state-'));
  const filePath = path.join(root, 'state', 'paused-agent-work.json');
  const coordinator = new ResumeCoordinator({ filePath });
  coordinator.capture('webapp-recon', {
    parentAgentId: 'glados',
    taskDescription: 'Proxy smoke test',
    taskPrompt: 'Perform exactly one GET to https://www.ford.com and stop.',
    operatorPrompt: 'Spawn webapp-recon for a one-request proxy test.',
  });

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

  const restored = new ResumeCoordinator({ filePath });
  const snapshot = restored.take('webapp-recon');
  const continuation = coordinator.buildContinuationPrompt(snapshot);
  assert.equal(snapshot.agentId, 'webapp-recon');
  assert.match(continuation, /Re-dispatch exactly webapp-recon/);
  assert.match(continuation, /Perform exactly one GET to https:\/\/www\.ford\.com and stop\./);
  assert.match(continuation, /Spawn webapp-recon for a one-request proxy test\./);
  assert.match(continuation, /Relay the resumed agent's final result back to the operator/);
  assert.doesNotMatch(continuation, /net-recon|subagent_type: claude/);
  assert.equal(restored.take('webapp-recon'), null, 'a paused task can only be consumed once');
  assert.equal(new ResumeCoordinator({ filePath }).take('webapp-recon'), null, 'consumption persists across restarts');
});

test('normalizes LiteLLM model aliases for the Anthropic Messages route', () => {
  assert.equal(bareModelAlias(' custom-llmapi-redteamstuff-com/claude-sonnet-4-6 '), 'claude-sonnet-4-6');
  assert.equal(bareModelAlias(' claude-sonnet-4-6 '), 'claude-sonnet-4-6');
  assert.equal(bareModelAlias('claude-opus-4-8'), 'claude-opus-4-8');
});

test('enforces operator-only net recon and operator-controlled report wrap dispatches', () => {
  assert.match(
    investigationDispatchContractViolation('net-recon', { prompt: 'Run network recon.' }),
    /operator_requested_net_recon: true/
  );
  assert.equal(investigationDispatchContractViolation('net-recon', {
    prompt: 'operator_requested_net_recon: true\noperator_request_reference: chat-message-42',
  }), null);

  for (const agent of ['report-writer', 'report-validator']) {
    assert.match(
      investigationDispatchContractViolation(agent, { prompt: 'The assessment seems done.' }),
      /operator_wrap_approved: true/
    );
    assert.equal(investigationDispatchContractViolation(agent, {
      prompt: `operator_wrap_approved: true\noperator_approval_reference: chat-message-73\nreport_pass: ${agent === 'report-writer' ? 'initial' : 'review-and-edit'}`,
    }), null);
    assert.equal(investigationDispatchContractViolation(agent, {
      prompt: `operator_wrap_approved: true\noperator_wrap_reference: supervising-operator-20260715\nreport_pass: ${agent === 'report-writer' ? 'final' : 'review-and-edit'}`,
    }), null, 'the documented wrap-reference synonym must not false-reject a valid approval');
  }
  assert.match(investigationDispatchContractViolation('report-writer', {
    prompt: 'operator_wrap_approved: true\noperator_approval_reference: chat-message-73',
  }), /report_pass: initial/);
  assert.match(investigationDispatchContractViolation('report-validator', {
    prompt: 'operator_wrap_approved: true\noperator_approval_reference: chat-message-73',
  }), /review-and-edit/);
});

test('uses the caller tool policy and PreToolUse hard deny for direct turns', async () => {
  const opts = buildAgentSdkOptions('webapp-recon', {
    env: baseTestEnv(),
    turnTargets: ['https://ford.com'],
  });
  const intendedTools = mountedToolsForAgent('webapp-recon');
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.forwardSubagentText, true);
  assert.equal(opts.permissionMode, 'dontAsk');
  assert.deepEqual(opts.tools, intendedTools.filter(tool => !tool.startsWith('mcp__')));
  assert.deepEqual(opts.gladosMountedTools, intendedTools);
  assert.equal(intendedTools.includes('Task'), false);
  assert.equal(intendedTools.includes('Agent'), false);
  assert.ok(intendedTools.includes('Bash'));
  assert.ok(intendedTools.includes('ToolSearch'));
  assert.equal(intendedTools.includes('WebFetch'), false);
  assert.ok(intendedTools.includes('WebSearch'));
  assert.ok(intendedTools.includes('Write'));
  assert.ok(intendedTools.includes('Edit'));
  assert.ok(intendedTools.includes('NotebookEdit'));
  assert.ok(intendedTools.includes('TodoWrite'));
  assert.ok(intendedTools.includes('mcp__glados-ops__scope_guard_check'));
  assert.ok(intendedTools.includes('mcp__glados-ops__local_auth_login'));
  assert.ok(intendedTools.includes('mcp__glados-ops__engagement_metrics'));
  assert.equal(intendedTools.includes('mcp__glados-ops'), false);
  assert.equal(opts.allowedTools.includes('Task'), false);
  assert.equal(opts.allowedTools.includes('Agent'), false);
  assert.deepEqual(opts.allowedTools, autoApprovedToolsForAgent(intendedTools));
  assert.equal(opts.disallowedTools.includes('Bash'), false);
  assert.equal(opts.disallowedTools.includes('ToolSearch'), false);
  assert.ok(opts.env.GLADOS_PROXY_URL.endsWith(':18080'));

  const hook = opts.hooks.PreToolUse[0].hooks[0];
  assert.equal(
    (await hook({ tool_name: 'Bash', tool_input: { command: '/usr/bin/curl -x http://127.0.0.1:18080 -k -H "X-GLaDOS-Agent: webapp-recon" https://ford.com' }, tool_use_id: 't1' }))
      .hookSpecificOutput.permissionDecision,
    'allow'
  );
  assert.deepEqual(await hook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/glados-test.ipynb' }, tool_use_id: 't1b' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'NotebookEdit is a local or passive operation',
    },
  });
  assert.deepEqual(await hook({ tool_name: 'MultiEdit', tool_input: {}, tool_use_id: 't1c' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'MultiEdit is not mounted for webapp-recon',
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
  assert.ok(opts.gladosMountedTools.includes('Agent'));
  assert.ok(opts.gladosMountedTools.includes('SendMessage'));
  assert.ok(opts.gladosMountedTools.includes('Bash'));
  assert.ok(opts.gladosMountedTools.includes(`${webappBrowserMount}__browser_navigate`));
  assert.equal(opts.gladosMountedTools.includes(webappBrowserMount), false);
  assert.equal(opts.tools.some(tool => tool.startsWith('mcp__')), false);
  assert.equal(rootTools.includes('Bash'), true);
  assert.equal(rootTools.some(tool => tool.startsWith('mcp__browser-')), false);
  assert.equal(opts.allowedTools.includes('Agent'), false);
  assert.equal(opts.allowedTools.includes('SendMessage'), true);
  assert.equal(opts.maxTurns, 40);
  assert.equal(opts.allowedTools.includes('Bash'), true);
  assert.equal(opts.allowedTools.includes(webappBrowserMount), false);
  assert.equal(opts.allowedTools.includes(`${webappBrowserMount}__browser_navigate`), true);
  assert.equal(opts.allowedTools.includes(`${webappBrowserMount}__browser_snapshot`), true);
  assert.equal(opts.allowedTools.includes(`${webappBrowserMount}__browser_take_screenshot`), true);
  assert.equal('glados' in opts.agents, false);
  assert.equal('claude' in opts.agents, false);
  assert.ok(opts.agents['webapp-recon'].tools.includes('Bash'));
  assert.ok(opts.agents['webapp-recon'].tools.includes(`${webappBrowserMount}__browser_navigate`));
  assert.ok(opts.agents['webapp-recon'].tools.includes(`${webappBrowserMount}__browser_run_code_unsafe`));
  assert.equal(opts.agents['webapp-recon'].tools.includes('Agent'), false);
  assert.equal(opts.agents['webapp-recon'].tools.includes('SendMessage'), false);
  assert.equal(opts.agents['webapp-recon'].maxTurns, 100);
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
  const dispatchDecision = await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'webapp-recon' },
    tool_use_id: 'root-agent-1',
  });
  assert.equal(dispatchDecision.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(dispatchDecision.hookSpecificOutput.updatedInput, {
    subagent_type: 'webapp-recon',
    name: 'webapp-recon',
    run_in_background: false,
  });
  assert.deepEqual(await opts.canUseTool('Agent', {
    subagent_type: 'webapp-recon',
    run_in_background: true,
    prompt: 'Perform the assigned recon and return the result.',
  }, { toolUseID: 'root-agent-can-use' }), {
    behavior: 'deny',
    message: 'Agent background dispatch is disabled; retry the same named GLaDOS agent with run_in_background=false so its final result returns to glados',
    interrupt: false,
    toolUseID: 'root-agent-can-use',
  });
  assert.deepEqual(await opts.canUseTool('Agent', {
    subagent_type: 'webapp-recon',
    run_in_background: false,
    prompt: 'Perform the assigned recon and return the result.',
  }, { toolUseID: 'root-agent-foreground' }), {
    behavior: 'allow',
    toolUseID: 'root-agent-foreground',
    updatedInput: {
      subagent_type: 'webapp-recon',
      name: 'webapp-recon',
      run_in_background: false,
      prompt: 'Perform the assigned recon and return the result.',
    },
  });
  assert.deepEqual(await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'net-recon', run_in_background: true },
    tool_use_id: 'root-agent-background',
  }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Agent background dispatch is disabled; retry the same named GLaDOS agent with run_in_background=false so its final result returns to glados',
    },
  });
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
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-browser-mcp-'));
  const serverName = browserServerName('webapp-recon');
  const mount = `mcp__${serverName}`;
  const disabled = buildAgentSdkOptions('webapp-recon', {
    env: baseTestEnv(),
  });
  assert.equal(disabled.gladosMountedTools.includes(mount), false);
  assert.equal(serverName in disabled.mcpServers, false);

  const enabled = buildAgentSdkOptions('webapp-recon', {
    env: {
      ...baseTestEnv(),
      GLADOS_BROWSER_MCP: '1',
      GLADOS_MITM_LISTEN_PORT: '19090',
      GLADOS_RUNTIME_DIR: runtimeDir,
    },
    turnTargets: ['https://ford.com'],
  });
  assert.equal(enabled.gladosMountedTools.includes(mount), false);
  assert.ok(enabled.gladosMountedTools.includes(`${mount}__browser_navigate`));
  assert.equal(enabled.allowedTools.includes(`${mount}__*`), false);
  assert.ok(enabled.allowedTools.includes(`${mount}__browser_navigate`));
  assert.ok(enabled.allowedTools.includes(`${mount}__browser_snapshot`));
  assert.ok(enabled.allowedTools.includes(`${mount}__browser_take_screenshot`));
  assert.ok(enabled.mcpServers[serverName].command);
  const configFlag = enabled.mcpServers[serverName].args.indexOf('--config');
  assert.notEqual(configFlag, -1);
  const browserConfig = JSON.parse(fs.readFileSync(enabled.mcpServers[serverName].args[configFlag + 1], 'utf8'));
  assert.equal(browserConfig.browser.launchOptions.proxy.server, 'http://127.0.0.1:19090');
  assert.ok(browserConfig.browser.launchOptions.args.includes('--remote-debugging-address=127.0.0.1'));
  assert.equal(browserConfig.browser.launchOptions.args.some(arg => /^--remote-debugging-port=19\d{3}$/.test(arg)), true);
  assert.equal(browserConfig.browser.contextOptions.ignoreHTTPSErrors, true);
  assert.equal(browserConfig.browser.contextOptions.extraHTTPHeaders['X-GLaDOS-Agent'], 'webapp-recon');
  assert.equal(browserConfig.browser.contextOptions.extraHTTPHeaders['X-GLaDOS-Transport'], 'browser-mcp');
  assert.equal(browserConfig.outputDir, path.join(runtimeDir, 'investigations'));
  assert.equal(fs.statSync(browserConfig.outputDir).mode & 0o777, 0o700);
  const fillDecision = enabled.hooks.PreToolUse[0].hooks[0]({
    hook_event_name: 'PreToolUse',
    tool_name: `${mount}__browser_fill_form`,
    tool_input: {
      fields: [{ element: 'Username', type: 'textbox', target: 'ref=f3e28', value: 'mustang' }],
    },
    tool_use_id: 'fill-normalize-1',
  });
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
  return fillDecision.then(result => {
    assert.equal(result.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(result.hookSpecificOutput.updatedInput.fields, [{
      element: 'Username',
      name: 'Username',
      type: 'textbox',
      target: 'f3e28',
      value: 'mustang',
    }]);
  });
});

test('subagent dispatch prompt seeds current-page browser authorization targets', () => {
  const options = {
    turnTargets: [],
    browserTargetsByAgent: new Map(),
  };
  rememberToolTargets('glados', 'Agent', {
    subagent_type: 'webapp-vuln',
    prompt: 'Assess only http://136.116.95.87:56453/ and its subpaths.',
    run_in_background: false,
  }, { allowed: true }, options);

  assert.deepEqual(toolTargetsForAgent('webapp-vuln', options), [
    'http://136.116.95.87:56453/',
  ]);
  assert.deepEqual(toolTargetsForAgent('net-recon', options), []);
});

test('successful browser navigation authorizes current-page actions for that agent only', async () => {
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const opts = buildAgentSdkOptions('webapp-recon', {
    env,
    turnTargets: ['https://ford.com'],
  });
  const hook = opts.hooks.PreToolUse[0].hooks[0];
  const navigate = await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__browser-webapp-recon__browser_navigate',
    tool_input: { url: 'https://ford.com/account' },
    tool_use_id: 'navigate-remember-target',
  });
  assert.equal(navigate.hookSpecificOutput.permissionDecision, 'allow');

  const click = await hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__browser-webapp-recon__browser_click',
    tool_input: { ref: 'save-button' },
    tool_use_id: 'click-remembered-target',
  });
  assert.equal(click.hookSpecificOutput.permissionDecision, 'allow');
});

test('runtime prompt requires absolute browser evidence filenames', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-browser-evidence-'));
  const env = baseTestEnv({ GLADOS_RUNTIME_DIR: runtimeDir, GLADOS_BROWSER_MCP: '1' });
  const opts = buildAgentSdkOptions('webapp-recon', { env });
  assert.match(opts.systemPrompt, /When browser_take_screenshot has a filename, use an absolute path/);
  assert.match(opts.systemPrompt, /Create payload files there, never in \/tmp/);
  assert.match(opts.systemPrompt, /while the file chooser modal is open, call browser_file_upload directly/);
  assert.match(opts.systemPrompt, /URLSearchParams must be created inside page\.evaluate/);
  assert.doesNotMatch(opts.systemPrompt, /Save screenshots with a path relative to this root/);
});

test('browser contract rejects unsupported Node globals and upload paths before Playwright', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-browser-contract-'));
  const env = baseTestEnv({ GLADOS_RUNTIME_DIR: runtimeDir, GLADOS_BROWSER_MCP: '1' });
  const opts = buildAgentSdkOptions('webapp-recon', {
    env,
    turnTargets: ['https://example.test'],
  });
  const hook = opts.hooks.PreToolUse[0].hooks[0];

  const unsafe = await hook({
    tool_name: 'mcp__browser-webapp-recon__browser_run_code_unsafe',
    tool_input: { code: 'async (page) => new URLSearchParams("q=test")' },
    tool_use_id: 'unsafe-url-search-params',
  });
  assert.equal(unsafe.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(unsafe.hookSpecificOutput.permissionDecisionReason, /inside page\.evaluate/);

  const outsideRoot = await hook({
    tool_name: 'mcp__browser-webapp-recon__browser_file_upload',
    tool_input: { paths: ['/tmp/xxe_probe.xml'] },
    tool_use_id: 'outside-upload-root',
  });
  assert.equal(outsideRoot.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outsideRoot.hookSpecificOutput.permissionDecisionReason, /outside allowed roots/);

  const allowedPath = path.join(runtimeDir, 'investigations', 'target', 'evidence', 'probe.xml');
  const insideRoot = await hook({
    tool_name: 'mcp__browser-webapp-recon__browser_file_upload',
    tool_input: { paths: [allowedPath] },
    tool_use_id: 'inside-upload-root',
  });
  assert.equal(insideRoot.hookSpecificOutput.permissionDecision, 'allow');
});

test('Bash contract denies root-wide find while allowing bounded absolute searches', () => {
  const base = {
    agentId: 'report-validator',
    toolName: 'Bash',
    policy: loadPolicy(),
    workspaceRoot: path.join(os.homedir(), '.glados', 'workspaces', 'agents'),
    env: baseTestEnv(),
    turnTargets: [],
  };
  const denied = decideToolUse({
    ...base,
    input: { command: "find / -iname 'REPORT-TEMPLATE.md' 2>/dev/null" },
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /whole-filesystem find is denied/);

  const nestedDenied = decideToolUse({
    ...base,
    input: { command: "eval 'find / -name REPORT-TEMPLATE.md'" },
  });
  assert.equal(nestedDenied.allowed, false);

  const allowed = decideToolUse({
    ...base,
    input: { command: "find /Users/samcsta/.glados/reports -name REPORT-TEMPLATE.md" },
  });
  assert.equal(allowed.allowed, true);
});

test('scope parsing ignores URL paths and browser JavaScript while preserving the turn target', () => {
  const target = 'http://136.116.95.87:56453/robots.txt';
  assert.deepEqual(extractTargets(target), [target]);

  const headersOnlyGet = classifyToolUse('Bash', {
    command: `/usr/bin/curl -x http://127.0.0.1:18080 -D - -H "X-GLaDOS-Agent: webapp-recon" ${target}`,
  });
  assert.equal(headersOnlyGet.mutating, false, 'curl -D dumps headers and is not curl -d request data');
  assert.deepEqual(headersOnlyGet.targets, [target]);

  const evaluate = classifyToolUse('mcp__browser-webapp-recon__browser_evaluate', {
    function: '() => ({ html: document.documentElement.outerHTML, cookies: document.cookie })',
  });
  assert.equal(evaluate.targetCapable, true);
  assert.deepEqual(evaluate.targets, []);

  const navigate = classifyToolUse('mcp__browser-webapp-recon__browser_navigate', { url: target });
  assert.deepEqual(navigate.targets, [target]);
});

test('browser form input normalization repairs missing names and ref-prefixed targets', () => {
  assert.deepEqual(normalizeToolInput('mcp__browser-webapp-recon__browser_fill_form', {
    fields: [
      { element: 'Username', type: 'textbox', target: 'ref=f3e28', value: 'mustang' },
      { name: 'Password', type: 'textbox', target: 'f3e29', value: 'secret' },
    ],
  }), {
    fields: [
      { element: 'Username', name: 'Username', type: 'textbox', target: 'f3e28', value: 'mustang' },
      { name: 'Password', type: 'textbox', target: 'f3e29', value: 'secret' },
    ],
  });
});

test('reporting tool normalization paginates reads and requests compact baseline data', () => {
  assert.deepEqual(normalizeToolInput('Read', { file_path: '/tmp/large.md' }, { agentId: 'report-writer' }), {
    file_path: '/tmp/large.md',
    limit: 300,
  });
  assert.deepEqual(normalizeToolInput('Read', { file_path: '/tmp/large.md', offset: 301, limit: 900 }, { agentId: 'report-validator' }), {
    file_path: '/tmp/large.md',
    offset: 301,
    limit: 300,
  });
  assert.deepEqual(normalizeToolInput('mcp__blackboard__blackboard_baseline_get', {
    engagement_id: 'eng-1',
    mode: 'full',
  }, { agentId: 'report-writer' }), {
    engagement_id: 'eng-1',
    mode: 'summary',
  });
  assert.deepEqual(normalizeToolInput('Read', { file_path: '/tmp/large.md' }, { agentId: 'webapp-recon' }), {
    file_path: '/tmp/large.md',
  });
});

test('SDK resume ids are scoped to the durable SDK working directory', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-sdk-resume-'));
  const registry = new SdkSessionRegistry({ runtimeDir: runtime });
  const cwd = resolveSdkWorkingDirectory({ env: { GLADOS_RUNTIME_DIR: runtime } });
  registry.set('glados', 'session-one', cwd);
  assert.equal(registry.get('glados', cwd), 'session-one');
  assert.equal(fs.statSync(path.dirname(registry.file)).mode & 0o077, 0);
  assert.equal(fs.statSync(registry.file).mode & 0o077, 0);
  const opts = buildAgentSdkOptions('glados', {
    env: baseTestEnv({ GLADOS_RUNTIME_DIR: runtime }),
    resumeSessionId: registry.get('glados', cwd),
  });
  assert.equal(opts.cwd, cwd);
  assert.equal(opts.resume, 'session-one');
  assert.equal(registry.get('glados', path.join(runtime, 'relocated-app')), null);
  registry.clear('glados');
  assert.equal(registry.get('glados'), null);
});

test('legacy unscoped SDK resume ids are rejected when a cwd scope is required', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-sdk-legacy-resume-'));
  const registry = new SdkSessionRegistry({ runtimeDir: runtime });
  registry.set('glados', 'legacy-session');
  assert.equal(registry.get('glados', path.join(runtime, 'workspaces')), null);
});

test('every enabled subagent mounts the local-work tool and MCP baseline', () => {
  const policy = loadPolicy();
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const required = [
    'Read',
    'Glob',
    'Grep',
    'Bash',
    'WebSearch',
    'Write',
    'Edit',
    'NotebookEdit',
    'TodoWrite',
    'mcp__blackboard__blackboard_read',
    'mcp__blackboard__blackboard_plan_create',
    'mcp__watchdog__target_health',
    'mcp__glados-ops__scope_guard_check',
    'mcp__glados-ops__local_auth_login',
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
      tools.includes(`${browserMount}__browser_navigate`),
      policy.browserMcpAgents.includes(row.id),
      `${row.id} browser MCP existence must match its explicit policy`
    );
  }
  assert.deepEqual(missingByAgent, []);
});

test('every enabled agent mounts the full local-work baseline and only GLaDOS can dispatch', () => {
  const policy = loadPolicy();
  const env = baseTestEnv({ GLADOS_BROWSER_MCP: '1' });
  const localWorkTools = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'Write', 'Edit', 'NotebookEdit', 'TodoWrite'];
  const missingByAgent = [];
  const dispatchCapable = [];
  for (const row of loadRegistry({ env })) {
    if (!row?.id || !agentEnabled(row.id, { policy })) continue;
    const tools = mountedToolsForAgent(row.id, policy, { env });
    const missing = localWorkTools.filter(tool => !tools.includes(tool));
    if (missing.length) missingByAgent.push(`${row.id}: ${missing.join(', ')}`);
    if (tools.includes('Task') || tools.includes('Agent')) dispatchCapable.push(row.id);
  }
  assert.deepEqual(missingByAgent, []);
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
  assert.match(opts.systemPrompt, new RegExp(`Persistent writable workspace: ${agentDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(opts.systemPrompt, /Never write operator state into repository templates or the packaged GLaDOS\.app Resources directory/);
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
  assert.ok(glados.systemPrompt.includes('Privilege-expansion gate'));
  assert.ok(glados.systemPrompt.includes('obtaining a flag or one critical chain is not completion'));
  assert.ok(glados.systemPrompt.includes('Context-intake gate'));
  assert.ok(glados.systemPrompt.includes('context_mode=blind'));
  assert.ok(glados.systemPrompt.includes('net-recon is operator-optional'));
  assert.ok(glados.systemPrompt.includes('JavaScript gate'));
  assert.ok(glados.systemPrompt.includes('landing_js_checkpoint'));
  assert.ok(glados.systemPrompt.includes('SQLi escalation contract'));
  assert.ok(glados.systemPrompt.includes('requested edits go back to plan-synthesizer'));
  assert.ok(glados.systemPrompt.includes('Investigation loop'));
  assert.ok(glados.systemPrompt.includes('Wrap gate'));
  assert.ok(glados.systemPrompt.includes('operator_wrap_approved: true'));
  assert.match(glados.systemPrompt, /report-writer with report_pass: initial.*report-validator with report_pass: review-and-edit.*report-writer with report_pass: final/);
  assert.match(glados.systemPrompt, /Do not search local files,\s+prior reports,\s+operator context,\s+blackboard/);
  assert.match(glados.systemPrompt, /do not run\s+`target_probe`\s+or\s+`scope_guard_check`\s+first/);

  const webappRecon = buildAgentSdkOptions('webapp-recon', { env });
  assert.ok(webappRecon.systemPrompt.includes('Proxy Smoke Test Mode'));
  assert.ok(webappRecon.systemPrompt.includes('/usr/bin/curl -x "$GLADOS_PROXY_URL"'));
  assert.ok(webappRecon.systemPrompt.includes('Do not authenticate, crawl, enumerate'));
  assert.ok(webappRecon.systemPrompt.includes('Post-Pivot Recon Mode'));
  assert.match(webappRecon.systemPrompt, /landing-page JavaScript checkpoint/i);
  assert.ok(webappRecon.systemPrompt.includes('manage users'));
  assert.ok(webappRecon.systemPrompt.includes('SQL injection'));

  const definitions = buildAgentDefinitions(loadPolicy(), { env });
  assert.ok(definitions['webapp-recon'].tools.includes('Bash'));
  assert.ok(definitions['webapp-recon'].tools.includes(`mcp__${browserServerName('webapp-recon')}__browser_navigate`));
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
      /OpenClaw|openclaw|OPENCLAW|Burp|burp|BURP_|127\.0\.0\.1:8080|localhost:1337|raw-stream|tag-injector|patch-openclaw|GLaDOS proxy Pro|circuit_status/,
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
      total_cost_usd: 1.25,
      duration_ms: 500,
      duration_api_ms: 300,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { 'claude-sonnet-5': { costUSD: 1.25 } },
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
  assert.equal(events[5].costUsd, 1.25);
  assert.equal(events[5].durationMs, 500);
  assert.deepEqual(events[5].usage, { input_tokens: 100, output_tokens: 20 });
  assert.deepEqual(events[5].modelUsage, { 'claude-sonnet-5': { costUSD: 1.25 } });
});

test('redacts generated and browser-entered credentials from durable transcript events', () => {
  const context = {};
  const browserCall = mapSdkMessageToEvents('webapp-vuln', {
    type: 'assistant',
    message: { content: [{
      type: 'tool_use',
      id: 'password-fill',
      name: 'mcp__browser-webapp-vuln__browser_fill_form',
      input: { fields: [{ name: 'Password', type: 'textbox', target: 'password', value: 'do-not-store-me' }] },
    }] },
  }, context)[0];
  assert.equal(browserCall.toolInput.fields[0].value, '[REDACTED]');
  assert.equal(browserCall.arguments.fields[0].value, '[REDACTED]');

  const browserResult = mapSdkMessageToEvents('webapp-vuln', {
    type: 'user',
    message: { content: [{
      type: 'tool_result',
      tool_use_id: 'password-fill',
      content: 'await page.getByRole(\'textbox\', { name: \'Password\' }).fill(\'do-not-store-me\');',
    }] },
  }, context)[0];
  assert.doesNotMatch(browserResult.text, /do-not-store-me/);
  assert.match(browserResult.text, /REDACTED/);

  mapSdkMessageToEvents('webapp-vuln', {
    type: 'assistant',
    message: { content: [{
      type: 'tool_use',
      id: 'generate-password',
      name: 'Bash',
      input: { command: 'openssl rand -base64 24', description: 'Generate strong random credential' },
    }] },
  }, context);
  const generatedResult = mapSdkMessageToEvents('webapp-vuln', {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'generate-password', content: 'raw-secret-output' }] },
  }, context)[0];
  assert.equal(generatedResult.text, '[REDACTED: generated credential]');

  mapSdkMessageToEvents('webapp-validator', {
    type: 'assistant',
    message: { content: [{
      type: 'tool_use',
      id: 'read-credential',
      name: 'Read',
      input: { file_path: '/tmp/admin-takeover-credential.txt' },
    }] },
  }, context);
  const credentialRead = mapSdkMessageToEvents('webapp-validator', {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'read-credential', content: 'new_password: do-not-store-me' }] },
  }, context)[0];
  assert.equal(credentialRead.text, '[REDACTED: credential file contents]');
});

test('maps SDK background task lifecycle into authoritative subagent liveness', () => {
  const context = {};
  mapSdkMessageToEvents('glados', {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-net', name: 'Task', input: { subagent_type: 'net-recon' } }] },
    uuid: 'dispatch-net',
    session_id: 's-task',
  }, context);
  const [started] = mapSdkMessageToEvents('glados', {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-net',
    tool_use_id: 'tool-net',
    subagent_type: 'net-recon',
    description: 'Low-impact network recon',
    uuid: 'task-started-net',
    session_id: 's-task',
  }, context);
  const [progress] = mapSdkMessageToEvents('glados', {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-net',
    description: 'Writing baseline',
    usage: { total_tokens: 10, tool_uses: 2, duration_ms: 50 },
    uuid: 'task-progress-net',
    session_id: 's-task',
  }, context);
  const [completed] = mapSdkMessageToEvents('glados', {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-net',
    status: 'completed',
    output_file: '/tmp/internal-output',
    summary: 'Network recon complete',
    uuid: 'task-completed-net',
    session_id: 's-task',
  }, context);

  assert.deepEqual([started.kind, progress.kind, completed.kind], ['liveness', 'liveness', 'liveness']);
  assert.deepEqual([started.agentId, progress.agentId, completed.agentId], ['net-recon', 'net-recon', 'net-recon']);
  assert.deepEqual([started.live, progress.live, completed.live], [true, true, false]);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.text, 'Network recon complete');
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

test('stale SDK conversations clear and retry once without resume', async () => {
  const attempts = [];
  const persisted = [];
  const invalidated = [];
  function fakeQuery({ options }) {
    attempts.push(options.resume || null);
    return {
      async *[Symbol.asyncIterator]() {
        if (options.resume) {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: [`No conversation found with session ID: ${options.resume}`],
            session_id: options.resume,
          };
          return;
        }
        yield { type: 'result', subtype: 'success', result: 'recovered', session_id: 'fresh-session' };
      },
    };
  }
  const events = await streamAgentTurn({
    agentId: 'glados',
    prompt: 'continue',
    store: false,
    queryImpl: fakeQuery,
    options: {
      sdkOptions: { includePartialMessages: true, resume: 'stale-session' },
      onSessionId: sessionId => persisted.push(sessionId),
      onInvalidSession: sessionId => invalidated.push(sessionId),
      haltPollMs: 0,
    },
  });
  assert.deepEqual(attempts, ['stale-session', null]);
  assert.deepEqual(invalidated, ['stale-session']);
  assert.deepEqual(persisted, ['fresh-session']);
  assert.deepEqual(events.map(event => event.text), ['recovered']);
});

test('waits for core MCP servers before consuming an agent turn', async () => {
  let statusCalls = 0;
  const iterable = {
    async mcpServerStatus() {
      statusCalls += 1;
      const status = statusCalls >= 2 ? 'connected' : 'pending';
      const tools = {
        blackboard: ['blackboard_read'],
        watchdog: ['target_probe'],
        'glados-ops': ['scope_guard_check'],
      };
      return ['blackboard', 'watchdog', 'glados-ops'].map(name => ({
        name,
        status,
        tools: status === 'connected' ? tools[name].map(tool => ({ name: tool })) : undefined,
      }));
    },
  };
  const statuses = await waitForCoreMcpServers(iterable, {
    mcpServers: { blackboard: {}, watchdog: {}, 'glados-ops': {}, browser: {} },
    tools: [
      'mcp__blackboard__blackboard_read',
      'mcp__watchdog__target_probe',
      'mcp__glados-ops__scope_guard_check',
    ],
  }, { mcpReadyTimeoutMs: 100, mcpReadyPollMs: 1 });
  assert.equal(statusCalls, 2);
  assert.ok(statuses.every(status => status.status === 'connected'));
});

test('core MCP readiness requires every mounted concrete tool to be discovered', async () => {
  const iterable = {
    async mcpServerStatus() {
      return [
        { name: 'blackboard', status: 'connected', tools: [{ name: 'blackboard_read' }] },
      ];
    },
  };
  await assert.rejects(
    waitForCoreMcpServers(iterable, {
      mcpServers: { blackboard: {} },
      tools: ['mcp__blackboard__blackboard_read', 'mcp__blackboard__blackboard_task_read'],
    }, { requiredMcpServers: ['blackboard'], mcpReadyTimeoutMs: 0 }),
    /blackboard:connected missing-tools=blackboard_task_read/
  );
});

test('fails clearly when a core MCP server never becomes ready', async () => {
  const iterable = {
    async mcpServerStatus() {
      return [
        { name: 'blackboard', status: 'connected' },
        { name: 'watchdog', status: 'failed' },
        { name: 'glados-ops', status: 'pending' },
      ];
    },
  };
  await assert.rejects(
    waitForCoreMcpServers(iterable, {
      mcpServers: { blackboard: {}, watchdog: {}, 'glados-ops': {} },
    }, { mcpReadyTimeoutMs: 0, mcpReadyPollMs: 1 }),
    /blackboard:connected, watchdog:failed, glados-ops:pending/
  );
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

test('streamAgentTurn interrupts a turn that produces no first model activity', async () => {
  let interrupted = false;
  const queryImpl = () => ({
    interrupt: async () => { interrupted = true; },
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
  });

  await assert.rejects(
    streamAgentTurn({
      agentId: 'glados',
      prompt: 'continue the approved action',
      store: false,
      queryImpl,
      options: { firstActivityTimeoutMs: 25, haltPollMs: 0 },
    }),
    error => error.code === 'GLADOS_FIRST_ACTIVITY_TIMEOUT'
  );
  assert.equal(interrupted, true);
});

test('streamAgentTurn drops a resumed session and retries once after first-activity timeout', async () => {
  let calls = 0;
  let invalidated = null;
  const queryImpl = ({ options }) => {
    calls += 1;
    if (options.resume) {
      return {
        interrupt: async () => {},
        [Symbol.asyncIterator]() { return this; },
        next() { return new Promise(() => {}); },
      };
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'recovered' }] }, session_id: 'fresh-session' };
        yield { type: 'result', subtype: 'success', result: 'recovered', session_id: 'fresh-session' };
      },
    };
  };

  const events = await streamAgentTurn({
    agentId: 'glados',
    prompt: 'continue the approved action',
    store: false,
    queryImpl,
    options: {
      resumeSessionId: 'stale-session',
      firstActivityTimeoutMs: 25,
      haltPollMs: 0,
      onInvalidSession: (sessionId, error) => { invalidated = { sessionId, code: error.code }; },
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(invalidated, { sessionId: 'stale-session', code: 'GLADOS_FIRST_ACTIVITY_TIMEOUT' });
  assert.equal(events.some(event => event.kind === 'assistant-text' && event.text === 'recovered'), true);
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
