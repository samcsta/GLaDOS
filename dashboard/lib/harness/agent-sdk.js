const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GLADOS_RUNTIME_DIR, GLADOS_AGENT_WORKSPACES, BLACKBOARD_DB, WATCHDOG_DB, MODEL_OVERRIDES_JSON } = require('../config');
const { DashboardTranscriptStore } = require('../transcript-store');
const { loadLlmAuthToken } = require('../secrets/llm-secrets');
const { bareModelAlias, DEFAULT_BARE_MODEL } = require('../../../scripts/lib/model-aliases');
const { agentStatus, listHaltedAgents } = require('glados-watchdog/lib/halt');
const { evaluateToolUse, extractTargets } = require('glados-watchdog/lib/safety-gate');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const POLICY_PATH = path.join(REPO_ROOT, 'config', 'glados-policy.json');
const REGISTRY_PATH = path.join(REPO_ROOT, 'templates', 'agent-registry.json');
const TEMPLATE_AGENT_ROOT = path.join(REPO_ROOT, 'templates', 'agents', 'default');
const PROMPT_FILE_ORDER = ['IDENTITY.md', 'SOUL.md', 'RUNBOOK.md', 'TOOLS.md', 'USER.md', 'AGENTS.md'];
const TASK_TOOL_NAMES = new Set(['Task', 'Agent']);
const MCP_SERVER_TOOLS = {
  mcp__blackboard: [
    'blackboard_read',
    'blackboard_write',
    'blackboard_task_read',
    'blackboard_task_update',
    'blackboard_task_create',
    'blackboard_engagement_status',
    'blackboard_engagement_create',
    'blackboard_engagement_update',
    'blackboard_plan_create',
    'blackboard_baseline_get',
    'blackboard_baseline_upsert',
    'blackboard_recon_step_log',
    'blackboard_recon_steps_list',
    'blackboard_finding_validate',
    'blackboard_replan_proposals_list',
    'blackboard_replan_proposal_resolve',
  ],
  mcp__watchdog: [
    'target_probe',
    'target_health',
    'target_list',
    'target_mark',
    'agent_halt',
    'agent_resume',
    'agent_status',
    'plan_check_dispatch',
  ],
  'mcp__glados-ops': [
    'scope_guard_check',
    'operator_context',
    'local_auth_status',
    'local_auth_login',
    'adfs_active_directory_login',
    'evidence_bundle_create',
    'engagement_metrics',
    'js_endpoint_extract',
    'openapi_inventory',
    'tool_availability',
    'safe_ffuf_command',
  ],
  mcp__browser: [
    'browser_click',
    'browser_close',
    'browser_console_messages',
    'browser_drag',
    'browser_drop',
    'browser_evaluate',
    'browser_file_upload',
    'browser_fill_form',
    'browser_find',
    'browser_handle_dialog',
    'browser_hover',
    'browser_navigate',
    'browser_navigate_back',
    'browser_network_request',
    'browser_network_requests',
    'browser_network_state_set',
    'browser_press_key',
    'browser_resize',
    'browser_route',
    'browser_route_list',
    'browser_run_code_unsafe',
    'browser_select_option',
    'browser_snapshot',
    'browser_take_screenshot',
    'browser_type',
    'browser_wait_for',
    'browser_tabs',
    'browser_unroute',
  ],
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function expandHome(value) {
  return String(value || '').replace(/^~(?=$|\/)/, os.homedir());
}

function loadPolicy(policyPath = POLICY_PATH) {
  return readJson(policyPath, {});
}

function readModelOverrides(file = MODEL_OVERRIDES_JSON) {
  const overrides = readJson(file, {});
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
}

function readWorkspaceAgentMeta(agentId, workspaceRoot = agentWorkspaceRoot()) {
  return readJson(path.join(workspaceRoot, agentId, 'agent.json'), {});
}

function applyLocalAgentConfig(row, { workspaceRoot = agentWorkspaceRoot(), modelOverrides = readModelOverrides() } = {}) {
  if (!row?.id) return row;
  const meta = readWorkspaceAgentMeta(row.id, workspaceRoot);
  const overrideModel = modelOverrides[row.id];
  return {
    ...row,
    ...Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)),
    id: row.id,
    name: meta.name || row.name,
    model: bareModelAlias(overrideModel || meta.model || row.model, { fallback: row.model || DEFAULT_BARE_MODEL }),
    enabled: meta.enabled !== undefined ? meta.enabled !== false : row.enabled,
  };
}

function loadRegistry(options = {}) {
  const rows = readJson(REGISTRY_PATH, []);
  const raw = Array.isArray(rows) ? rows : rows.agents || [];
  const workspaceRoot = options.workspaceRoot || agentWorkspaceRoot(options.env || process.env);
  const modelOverrides = options.modelOverrides || readModelOverrides(options.modelOverridesPath);
  return raw.map(row => applyLocalAgentConfig(row, { workspaceRoot, modelOverrides }));
}

function registryById(options = {}) {
  return new Map(loadRegistry(options).filter(row => row?.id).map(row => [row.id, row]));
}

function defaultProfileForAgent(agentId) {
  if (agentId === 'glados') return 'leader';
  if (/(^|-)validator$/.test(agentId) || agentId === 'scope-guardian') return 'validator';
  if (/^report-/.test(agentId)) return 'report';
  return 'specialist';
}

function profileTools(policy, profile) {
  const profiles = policy.toolProfiles || {};
  return Array.isArray(profiles[profile]) ? profiles[profile] : [];
}

function browserMcpEnabled(env = process.env) {
  return env.GLADOS_BROWSER_MCP === '1'
    || !!env.GLADOS_BROWSER_MCP_COMMAND
    || !!env.GLADOS_BROWSER_MCP_ARGS
    || !!env.GLADOS_BROWSER_MCP_ARGS_JSON;
}

function profileCanUseBrowserMcp(policy, profile, agentId) {
  const explicitAgents = policy.browserMcpAgents;
  if (Array.isArray(explicitAgents)) return explicitAgents.includes(agentId);
  return (policy.browserMcpProfiles || []).includes(profile);
}

function browserServerName(agentId) {
  return `browser-${String(agentId || '').replace(/[^a-z0-9._-]/gi, '-')}`;
}

function browserMountForAgent(agentId) {
  return `mcp__${browserServerName(agentId)}`;
}

function expandTaskToolAliases(tools) {
  const out = unique(tools);
  if (out.some(tool => TASK_TOOL_NAMES.has(tool))) {
    for (const name of TASK_TOOL_NAMES) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

function concreteMcpTools(tool) {
  const serverTools = MCP_SERVER_TOOLS[tool]
    || (tool.startsWith('mcp__browser-') && tool.split('__').length === 2
      ? MCP_SERVER_TOOLS.mcp__browser
      : null);
  return serverTools ? serverTools.map(name => `${tool}__${name}`) : [tool];
}

function expandMcpTools(tools) {
  return unique((tools || []).flatMap(tool => tool.startsWith('mcp__') ? concreteMcpTools(tool) : [tool]));
}

function mountedToolsForAgent(agentId, policy = loadPolicy(), options = {}) {
  const explicit = policy.agents?.[agentId]?.tools;
  if (Array.isArray(explicit)) return expandMcpTools(expandTaskToolAliases(explicit));
  const profile = policy.agentToolProfiles?.[agentId] || defaultProfileForAgent(agentId);
  const tools = [...profileTools(policy, profile)];
  if (browserMcpEnabled(options.env || process.env) && profileCanUseBrowserMcp(policy, profile, agentId)) {
    tools.push(browserMountForAgent(agentId));
  }
  return expandMcpTools(expandTaskToolAliases(tools));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function autoApprovedToolsForAgent(tools) {
  const out = [];
  for (const tool of expandMcpTools(unique(tools))) {
    if (TASK_TOOL_NAMES.has(tool)) continue;
    out.push(tool);
  }
  return unique(out);
}

function toolMatchesMount(toolName, mount) {
  if (toolName === mount) return true;
  if (TASK_TOOL_NAMES.has(toolName) && TASK_TOOL_NAMES.has(mount)) return true;
  return false;
}

function toolsMountMcpServer(tools, serverName) {
  const prefix = `mcp__${serverName}__`;
  return (tools || []).some(tool => tool.startsWith(prefix));
}

function targetAgentFromTaskInput(input = {}) {
  return input.subagent_type
    || input.subagentType
    || input.agent
    || input.agentId
    || input.agent_id
    || input.name
    || input.type
    || null;
}

function isTaskDispatchTool(toolName) {
  return TASK_TOOL_NAMES.has(toolName);
}

function isDisabledByDefaultAgent(agentId, policy = loadPolicy()) {
  return (policy.disabledByDefaultPrefixes || []).some(prefix => String(agentId || '').startsWith(prefix));
}

function agentWorkspaceRoot(env = process.env) {
  return env.GLADOS_AGENT_WORKSPACES || GLADOS_AGENT_WORKSPACES;
}

function resolveSdkWorkingDirectory(options = {}) {
  const env = options.env || process.env;
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || GLADOS_RUNTIME_DIR);
  const cwd = path.resolve(options.cwd || env.GLADOS_SDK_CWD || path.join(runtimeDir, 'workspaces'));
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  fs.chmodSync(cwd, 0o700);
  return cwd;
}

function agentEnabled(agentId, { policy = loadPolicy(), workspaceRoot = agentWorkspaceRoot() } = {}) {
  const row = registryById({ workspaceRoot }).get(agentId);
  if (!row) return false;
  if (row && row.enabled === false) return false;
  if (isDisabledByDefaultAgent(agentId, policy)) return false;
  const localDisabled = path.join(workspaceRoot, agentId, '.disabled');
  return !fs.existsSync(localDisabled);
}

function taskAllowlist(policy = loadPolicy(), { workspaceRoot = agentWorkspaceRoot() } = {}) {
  const configured = policy.taskDispatch?.allowAgents;
  if (Array.isArray(configured)) {
    return new Set(configured.filter(id => agentEnabled(id, { policy, workspaceRoot })));
  }
  return new Set(loadRegistry({ workspaceRoot })
    .filter(row => row?.id && row.id !== 'glados' && row.enabled !== false && agentEnabled(row.id, { policy, workspaceRoot }))
    .map(row => row.id));
}

function haltActive(agentId) {
  try { return agentStatus(agentId).haltActive; }
  catch { return true; }
}

function decideToolUse({ agentId, toolName, input = {}, policy = loadPolicy(), workspaceRoot = agentWorkspaceRoot(), env = process.env, turnTargets = [] }) {
  if (!agentEnabled(agentId, { policy, workspaceRoot })) {
    return { allowed: false, reason: `${agentId} is disabled by policy or local workspace state`, interrupt: true };
  }
  if (haltActive(agentId)) {
    return { allowed: false, reason: `${agentId} is halted by the operator`, interrupt: true };
  }

  const mounted = mountedToolsForAgent(agentId, policy, { env });
  if (!mounted.some(tool => toolMatchesMount(toolName, tool))) {
    return { allowed: false, reason: `${toolName} is not mounted for ${agentId}` };
  }

  if (isTaskDispatchTool(toolName)) {
    if (agentId !== 'glados') {
      return { allowed: false, reason: `Only glados can dispatch subagents; ${agentId} cannot use ${toolName}` };
    }
    if (input.run_in_background === true) {
      return {
        allowed: false,
        reason: `${toolName} background dispatch is disabled; retry the same named GLaDOS agent with run_in_background=false so its final result returns to glados`,
      };
    }
    const target = targetAgentFromTaskInput(input);
    if (!target) return { allowed: false, reason: `${toolName} dispatch did not name an allowed GLaDOS agent` };
    const allowedAgents = taskAllowlist(policy, { workspaceRoot });
    if (!allowedAgents.has(target)) return { allowed: false, reason: `${toolName} dispatch to ${target} is not allowed` };
    if (!agentEnabled(target, { policy, workspaceRoot })) return { allowed: false, reason: `${toolName} dispatch target ${target} is disabled` };
    const contractReason = investigationDispatchContractViolation(target, input);
    if (contractReason) return { allowed: false, reason: contractReason };
  }

  const browserContractReason = browserToolContractViolation(toolName, input, env);
  if (browserContractReason) return { allowed: false, reason: browserContractReason };

  const bashContractReason = bashToolContractViolation(toolName, input);
  if (bashContractReason) return { allowed: false, reason: bashContractReason };

  return evaluateToolUse({ agentId, toolName, input, turnTargets });
}

function investigationDispatchContractViolation(targetAgent, input = {}) {
  const prompt = String(input.prompt || input.description || '');
  if (targetAgent === 'net-recon' && (
    !/\boperator_requested_net_recon\s*:\s*true\b/i.test(prompt)
    || !/\boperator_request_reference\s*:\s*\S+/i.test(prompt)
  )) {
    return 'net-recon is operator-optional; include operator_requested_net_recon: true and the operator request reference in the dispatch prompt';
  }
  if ((targetAgent === 'report-writer' || targetAgent === 'report-validator')
      && (
        !/\boperator_wrap_approved\s*:\s*true\b/i.test(prompt)
        || !/\boperator_(?:approval|wrap)_reference\s*:\s*\S+/i.test(prompt)
      )) {
    return `${targetAgent} is wrap-gated; include operator_wrap_approved: true and operator_approval_reference: <reference> in the dispatch prompt`;
  }
  if (targetAgent === 'report-writer') {
    const passes = [...prompt.matchAll(/\breport_pass\s*:\s*(initial|final)\b/gi)];
    if (passes.length !== 1) {
      return 'report-writer requires exactly one finite workflow marker: report_pass: initial or report_pass: final';
    }
  }
  if (targetAgent === 'report-validator' && !/\breport_pass\s*:\s*review-and-edit\b/i.test(prompt)) {
    return 'report-validator is a single review-and-edit pass; include report_pass: review-and-edit';
  }
  return null;
}

function toolCallerAgentId(rootAgentId, input = {}, agentTypesById = new Map()) {
  if (!input.agent_id) return rootAgentId;
  if (input.agent_type) {
    agentTypesById.set(input.agent_id, input.agent_type);
    return input.agent_type;
  }
  return agentTypesById.get(input.agent_id) || null;
}

function normalizeToolInput(toolName, input = {}, { agentId = null } = {}) {
  const name = String(toolName || '');
  const reportingAgent = agentId === 'report-writer' || agentId === 'report-validator';
  let normalized = input;
  if (isTaskDispatchTool(name) && Object.prototype.hasOwnProperty.call(normalized, 'isolation')) {
    // GLaDOS runs the Agent SDK from its durable runtime workspace, which is
    // intentionally outside the source repository. Worktree/remote isolation
    // is therefore not a valid dispatch mode for its local named specialists.
    normalized = { ...normalized };
    delete normalized.isolation;
  }
  if (/__browser_fill_form$/i.test(name) && Array.isArray(input.fields)) {
    normalized = {
      ...normalized,
      fields: input.fields.map((field, index) => ({
        ...field,
        name: field.name || field.element || `field ${index + 1}`,
        target: String(field.target || '').replace(/^ref=/i, ''),
      })),
    };
  }
  if (reportingAgent && /^Read$/i.test(name) && (!Number.isFinite(Number(input.limit)) || Number(input.limit) > 300)) {
    normalized = { ...normalized, limit: 300 };
  }
  if (reportingAgent && /(?:^|__)blackboard_baseline_get$/i.test(name) && input.mode !== 'summary') {
    normalized = { ...normalized, mode: 'summary' };
  }
  return normalized;
}

function pathWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function browserToolContractViolation(toolName, input = {}, env = process.env) {
  const name = String(toolName || '');
  if (/__browser_run_code_unsafe$/i.test(name)) {
    const code = String(input.code || '');
    if (/\bURLSearchParams\b/.test(code) && !/page\.evaluate\s*\([\s\S]*\bURLSearchParams\b/.test(code)) {
      return 'browser_run_code_unsafe executes in Node; create URLSearchParams inside page.evaluate or use browser_evaluate';
    }
  }

  if (/__browser_(?:file_upload|drop)$/i.test(name) && Array.isArray(input.paths)) {
    const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || GLADOS_RUNTIME_DIR);
    const roots = [
      path.resolve(env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations')),
      path.resolve(env.GLADOS_AGENT_WORKSPACES || path.join(runtimeDir, 'workspaces', 'agents')),
    ];
    const invalid = input.paths.find(candidate => (
      !path.isAbsolute(String(candidate || ''))
      || !roots.some(root => pathWithin(root, String(candidate)))
    ));
    if (invalid) {
      return `browser upload path ${invalid} is outside allowed roots; create it under ${roots.join(' or ')}`;
    }
  }
  return null;
}

function bashToolContractViolation(toolName, input = {}) {
  if (String(toolName || '') !== 'Bash') return null;
  const command = String(input.command || '');
  // Root-wide searches can traverse mounted volumes and system trees for
  // minutes. Agents already receive the exact repository/runtime paths, so
  // require a bounded root. This intentionally does not match /Users/... etc.
  if (/(?:^|[;&|()\n'"`])\s*(?:sudo\s+)?find\s+\/(?:\s|$)/i.test(command)) {
    return 'whole-filesystem find is denied; search the known repository, runtime, investigation, report, or workspace path directly';
  }
  return null;
}

function toolTargetsForAgent(agentId, options = {}) {
  return unique([
    ...(options.turnTargets || []),
    ...(options.browserTargetsByAgent?.get(agentId) || []),
  ]);
}

function rememberToolTargets(agentId, toolName, input, decision, options = {}) {
  if (!decision.allowed || !options.browserTargetsByAgent) return;

  let targetAgent = agentId;
  let targets = [];
  if (agentId === 'glados' && isTaskDispatchTool(toolName)) {
    targetAgent = targetAgentFromTaskInput(input);
    targets = extractTargets(input?.prompt || input);
  } else if (/mcp__browser(?:-[a-z0-9._-]+)?__browser_navigate$/i.test(String(toolName || ''))) {
    targets = extractTargets(input?.url || input);
  }
  if (!targetAgent || targets.length === 0) return;
  options.browserTargetsByAgent.set(targetAgent, unique([
    ...(options.browserTargetsByAgent.get(targetAgent) || []),
    ...targets,
  ]));
}

function buildPreToolUseHook(agentId, policy = loadPolicy(), options = {}) {
  return async input => {
    const callerAgentId = toolCallerAgentId(agentId, input, options.agentTypesById);
    const normalizedInput = normalizeToolInput(input.tool_name, input.tool_input, { agentId: callerAgentId });
    const decision = decideToolUse({
      agentId: callerAgentId,
      toolName: input.tool_name,
      input: normalizedInput,
      policy,
      workspaceRoot: options.workspaceRoot,
      env: options.env || process.env,
      turnTargets: toolTargetsForAgent(callerAgentId, options),
    });
    rememberToolTargets(callerAgentId, input.tool_name, normalizedInput, decision, options);
    const hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allowed ? 'allow' : 'deny',
      permissionDecisionReason: decision.reason,
    };
    if (decision.allowed && normalizedInput !== input.tool_input) {
      hookSpecificOutput.updatedInput = normalizedInput;
    }
    if (decision.allowed && callerAgentId === 'glados' && isTaskDispatchTool(input.tool_name)) {
      const target = targetAgentFromTaskInput(normalizedInput);
      hookSpecificOutput.updatedInput = {
        ...normalizedInput,
        subagent_type: target,
        name: normalizedInput?.name || target,
        run_in_background: false,
      };
    }
    return { hookSpecificOutput };
  };
}

function buildCanUseTool(agentId, policy = loadPolicy(), hookOptions = {}) {
  return async (toolName, input, requestOptions = {}) => {
    const callerAgentId = requestOptions.agentID
      ? hookOptions.agentTypesById?.get(requestOptions.agentID)
      : agentId;
    const normalizedInput = normalizeToolInput(toolName, input, { agentId: callerAgentId });
    const decision = callerAgentId
      ? decideToolUse({
        agentId: callerAgentId,
        toolName,
        input: normalizedInput,
        policy,
        workspaceRoot: hookOptions.workspaceRoot,
        env: hookOptions.env || process.env,
        turnTargets: toolTargetsForAgent(callerAgentId, hookOptions),
      })
      : { allowed: false, reason: `Unknown subagent ${requestOptions.agentID} attempted to use ${toolName}`, interrupt: true };
    if (decision.allowed) {
      rememberToolTargets(callerAgentId, toolName, normalizedInput, decision, hookOptions);
      const result = { behavior: 'allow', toolUseID: requestOptions.toolUseID };
      if (normalizedInput !== input) result.updatedInput = normalizedInput;
      if (callerAgentId === 'glados' && isTaskDispatchTool(toolName)) {
        const target = targetAgentFromTaskInput(normalizedInput);
        result.updatedInput = {
          ...normalizedInput,
          subagent_type: target,
          name: normalizedInput?.name || target,
          run_in_background: false,
        };
      }
      return result;
    }
    return {
      behavior: 'deny',
      message: decision.reason,
      interrupt: !!decision.interrupt,
      toolUseID: requestOptions.toolUseID,
    };
  };
}

function buildMcpEnv(env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || GLADOS_RUNTIME_DIR);
  const workspaces = path.resolve(env.GLADOS_AGENT_WORKSPACES || path.join(runtimeDir, 'workspaces', 'agents'));
  return {
    ...env,
    GLADOS_RUNTIME_DIR: runtimeDir,
    GLADOS_REPO_ROOT: REPO_ROOT,
    GLADOS_AGENT_WORKSPACES: workspaces,
    GLADOS_REPORTS_DIR: env.GLADOS_REPORTS_DIR || path.join(runtimeDir, 'reports'),
    GLADOS_INVESTIGATIONS_DIR: env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations'),
    BLACKBOARD_DB: env.BLACKBOARD_DB || path.join(runtimeDir, 'blackboard', 'blackboard.db'),
    WATCHDOG_DB: env.WATCHDOG_DB || path.join(runtimeDir, 'watchdog', 'watchdog.db'),
    PATH: env.PATH,
  };
}

function proxyUrlFromEnv(env = process.env) {
  if (env.GLADOS_PROXY_URL) return env.GLADOS_PROXY_URL;
  if (env.GLADOS_REPLAY_PROXY) return env.GLADOS_REPLAY_PROXY;
  const host = env.GLADOS_MITM_LISTEN_HOST || '127.0.0.1';
  const port = env.GLADOS_MITM_LISTEN_PORT || '18080';
  return `http://${host}:${port}`;
}

function parseMcpArgs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  return raw.split(/\s+/).filter(Boolean);
}

function writeBrowserMcpConfig(agentId, env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || GLADOS_RUNTIME_DIR);
  const dir = path.join(runtimeDir, 'browser-mcp');
  const outputDir = path.resolve(env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  const cdpPort = browserCdpPort(agentId);
  const file = path.join(dir, `${String(agentId).replace(/[^a-z0-9._-]/gi, '-')}.json`);
  const config = {
    browser: {
      isolated: true,
      launchOptions: {
        proxy: { server: proxyUrlFromEnv(env) },
        args: [
          '--remote-debugging-address=127.0.0.1',
          `--remote-debugging-port=${cdpPort}`,
        ],
      },
      contextOptions: {
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          'X-GLaDOS-Agent': agentId,
          'X-GLaDOS-Session': env.GLADOS_SESSION_ID || 'legacy',
          'X-GLaDOS-Transport': 'browser-mcp',
        },
      },
    },
    capabilities: ['core', 'network'],
    outputDir,
    saveSession: false,
    sharedBrowserContext: false,
  };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

function browserCdpPort(agentId) {
  let hash = 0;
  for (const char of String(agentId || 'browser')) hash = ((hash * 33) + char.charCodeAt(0)) >>> 0;
  return 19000 + (hash % 1000);
}

function resolveNodeRuntime(env = process.env) {
  const explicit = env.GLADOS_NODE_PATH || env.npm_node_execpath || env.NODE;
  if (explicit) return { command: explicit, env: {} };
  const command = process.execPath || 'node';
  const needsElectronNodeMode = !!process.versions?.electron;
  return {
    command,
    env: needsElectronNodeMode ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

function buildMcpServers(env = process.env) {
  const runtime = resolveNodeRuntime(env);
  const mcpEnv = { ...buildMcpEnv(env), ...runtime.env };
  const servers = {
    blackboard: {
      type: 'stdio',
      command: runtime.command,
      args: [path.join(REPO_ROOT, 'blackboard', 'blackboard-mcp', 'index.js')],
      env: mcpEnv,
    },
    watchdog: {
      type: 'stdio',
      command: runtime.command,
      args: [path.join(REPO_ROOT, 'watchdog', 'watchdog-mcp', 'index.js')],
      env: mcpEnv,
    },
    'glados-ops': {
      type: 'stdio',
      command: runtime.command,
      args: [path.join(REPO_ROOT, 'tools', 'glados-ops-mcp', 'index.js')],
      env: mcpEnv,
    },
  };
  if (browserMcpEnabled(env)) {
    const policy = loadPolicy();
    const localCli = path.join(REPO_ROOT, 'dashboard', 'node_modules', '@playwright', 'mcp', 'cli.js');
    const useLocalCli = !env.GLADOS_BROWSER_MCP_COMMAND && fs.existsSync(localCli);
    const command = env.GLADOS_BROWSER_MCP_COMMAND || (useLocalCli ? runtime.command : 'npx');
    for (const row of loadRegistry({ env })) {
      if (!row?.id || row.enabled === false || !agentEnabled(row.id, { policy, workspaceRoot: agentWorkspaceRoot(env) })) continue;
      const profile = policy.agentToolProfiles?.[row.id] || defaultProfileForAgent(row.id);
      if (!profileCanUseBrowserMcp(policy, profile, row.id)) continue;
      const configFile = writeBrowserMcpConfig(row.id, env);
      const configuredArgs = parseMcpArgs(env.GLADOS_BROWSER_MCP_ARGS_JSON || env.GLADOS_BROWSER_MCP_ARGS);
      const args = configuredArgs
        ? [...configuredArgs, '--config', configFile]
        : (useLocalCli
          ? [localCli, '--config', configFile]
          : ['-y', '@playwright/mcp@latest', '--config', configFile]);
      servers[browserServerName(row.id)] = {
        type: 'stdio',
        command,
        args,
        env: mcpEnv,
      };
    }
  }
  return servers;
}

function listAgentSkills(agentRoot) {
  const skillsDir = path.join(agentRoot, 'skills');
  let entries;
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  const byName = new Map();
  for (const skill of entries
    .flatMap(entry => {
      if (entry.isFile() && entry.name.endsWith('.skill')) {
        return [{ name: entry.name.replace(/\.skill$/, ''), path: path.join(skillsDir, entry.name) }];
      }
      if (entry.isDirectory()) {
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) return [{ name: entry.name, path: skillFile }];
      }
      return [];
    })) {
    if (!byName.has(skill.name) || skill.path.endsWith('SKILL.md')) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function skillSummary(skill) {
  let raw = '';
  try { raw = fs.readFileSync(skill.path, 'utf8'); } catch {}
  const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    || raw.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))?.trim()
    || '';
  return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
}

function resolveAgentRoot(agentId, { workspaceRoot = agentWorkspaceRoot(), templateRoot = TEMPLATE_AGENT_ROOT } = {}) {
  const workspace = path.join(workspaceRoot, agentId);
  if (fs.existsSync(workspace)) return { root: workspace, source: 'workspace' };
  return { root: path.join(templateRoot, agentId), source: 'template' };
}

const SECURITY_REVIEW_PROMPT_AGENTS = new Set(['glados', 'source-code', 'source-review-validator']);

function securityReviewTemplateOverlay(agentId, templateRoot = TEMPLATE_AGENT_ROOT) {
  if (!SECURITY_REVIEW_PROMPT_AGENTS.has(agentId)) return '';
  const names = agentId === 'glados' ? ['RUNBOOK.md'] : ['IDENTITY.md', 'RUNBOOK.md', 'TOOLS.md'];
  return names.map(name => {
    const file = path.join(templateRoot, agentId, name);
    try { return `## GLaDOS v4 security-review contract (${agentId}/${name})\n${fs.readFileSync(file, 'utf8')}`; }
    catch { return ''; }
  }).filter(Boolean).join('\n\n');
}

function assembleAgentPrompt(agentId, options = {}) {
  const resolved = resolveAgentRoot(agentId, options);
  const parts = [];
  const files = [];
  for (const name of PROMPT_FILE_ORDER) {
    const file = path.join(resolved.root, name);
    try {
      parts.push(fs.readFileSync(file, 'utf8'));
      files.push(name);
    } catch {}
  }
  const skills = listAgentSkills(resolved.root);
  if (skills.length) {
    parts.push(['# Skills', ...skills.map(skillSummary)].join('\n'));
  }
  const securityReviewOverlay = securityReviewTemplateOverlay(agentId, options.templateRoot);
  if (securityReviewOverlay) parts.push(securityReviewOverlay);
  return {
    agentId,
    source: resolved.source,
    root: resolved.root,
    files,
    skills: skills.map(skill => skill.name),
    prompt: parts.join('\n\n').trim() || `You are the ${agentId} GLaDOS agent.`,
  };
}

function readAgentPrompt(agentId, options = {}) {
  return assembleAgentPrompt(agentId, options).prompt;
}

function buildRuntimeContext(agentId, { model, registryRows = [], proxyUrl, workspaceRoot = agentWorkspaceRoot() } = {}) {
  const persistentWorkspace = path.join(workspaceRoot, agentId);
  const investigationsDir = path.join(GLADOS_RUNTIME_DIR, 'investigations');
  const lines = [
    '# Runtime Context (authoritative)',
    `- Current agent id: ${agentId}`,
    `- Active model for this turn: ${model || DEFAULT_BARE_MODEL}`,
    `- Persistent writable workspace: ${persistentWorkspace}`,
    `- Read and update USER.md, MEMORY.md, memory/, skills/, and other agent-owned files in ${persistentWorkspace}. Never write operator state into repository templates or the packaged GLaDOS.app Resources directory.`,
    '- If the operator asks what model you are running, answer from the active model above.',
    '- Do not infer current model names from static roster tables, examples, MEMORY.md, or historical workspace files.',
    `- GLaDOS proxy URL for target HTTP(S): ${proxyUrl || proxyUrlFromEnv()}. For shell HTTP, use /usr/bin/curl -x this URL -k and add X-GLaDOS-Agent: ${agentId}. Do not use legacy :8080 proxy examples unless the operator explicitly overrides it.`,
  ];
  if (agentId === 'glados' && registryRows.length) {
    const halted = listHaltedAgents().map(marker => marker.agentId).filter(Boolean);
    lines.push(`- Operator halt state: ${halted.length ? `halted agents are ${halted.join(', ')}` : 'no agents are halted'}. Treat this as authoritative and do not dispatch a halted agent.`);
    lines.push('- For normal investigations, perform target reachability preflight only with mcp__watchdog__target_probe. Never use Bash/curl or browser tools from GLaDOS for target interaction; delegate that work to a named specialist.');
    lines.push('- Subagent dispatch rule: use the SDK subagent dispatch tool only with subagent_type set to an exact enabled GLaDOS agent id, name set to that same id, and run_in_background=false. Omit the isolation field; GLaDOS specialists run in the managed local runtime workspace, not a git worktree or remote environment. Background dispatch is hard-denied. Never launch a generic unnamed Agent.');
    lines.push('- A specialist dispatch is synchronous and must return its result to this turn. If the SDK nevertheless reports it as running, use SendMessage to the same named agent; never launch another Agent with a prompt beginning "to:" and never substitute a different specialist.');
    lines.push('- After a subagent returns, relay its final result to the operator. Never expose internal agentId values, output_file paths, SendMessage instructions, or raw SDK task metadata.');
    lines.push('- Audit-task lifecycle is mandatory: when blackboard_task_create returns a task ID, include that exact task ID in the specialist dispatch prompt and require the specialist to call blackboard_task_update with completed, failed, or cancelled before returning. If it forgets, reconcile the task yourself from the returned result.');
    lines.push('- Before announcing an engagement complete, call blackboard_engagement_status, reconcile every nonterminal task, then call blackboard_engagement_update with status=complete. Never claim completion while the engagement row is active or a task remains pending/in_progress.');
    lines.push('- Investigation objective: identify and safely exploit meaningful evidence-backed CWEs, preserving multi-step chains toward RCE when supported by scope and evidence. Do not optimize away an auth/access primitive that unlocks a deeper surface.');
    lines.push('- Context-intake gate: merge operator-provided prior context with operator-approved DradisTab, Dradis, and DomainsAI results into baseline.context_intake. If skipped, unavailable, or empty, explicitly mark context_mode=blind and pass that fact to recon and planning.');
    lines.push('- net-recon is operator-optional. Dispatch it only after an explicit operator request and include "operator_requested_net_recon: true" plus the request reference in the task prompt; the harness denies dispatch without that marker.');
    lines.push('- JavaScript gate: immediately after successful SSO, webapp-recon must screenshot the landing page and capture its raw HTML/DOM plus every inline/external script, worker, source map, client config, bootstrap, and dynamically loaded chunk before normal navigation. It returns a landing_js_checkpoint; dispatch js-reverser immediately, then redispatch webapp-recon with resume_after_js_analysis: true and the analyzer leads. Analyze later/new-pivot artifacts before plan synthesis.');
    lines.push('- Privilege-expansion gate: whenever authentication state or privilege changes and new routes become reachable, dispatch webapp-recon again in post-pivot mode before planning further exploitation. Require an inventory of every newly visible route, form, search/filter/sort field, query/body/header/cookie parameter, upload/import/export control, and API request. Feed the delta back through plan-synthesizer.');
    lines.push('- Breadth contract: when the operator asks for all meaningful vulnerabilities or says not to stop at one, obtaining a flag or one critical chain is not completion. Require the coverage ledger and post-pivot surface delta to be reviewed, then validate every meaningful lead or explicitly record why it remains untested.');
    lines.push('- SQLi escalation contract: confirmed injectability is not completion. Require DBMS/privilege fingerprinting, schema/credential access, stacked statements, file read/write, database execution features, and OS command/RCE to be tested when approved and safe, or placed into the next plan with the exact approval/safety blocker. Maintain rce_escalation_status and chain auth/IDOR/reset/admin/XXE/SQLi primitives.');
    lines.push('- Plan decisions: approve all/selected dispatches only approved vectors; requested edits go back to plan-synthesizer with parent_plan_id and verbatim operator_modifications and produce a new pending plan; end investigation stops without automatic reports; pause dispatches nothing.');
    lines.push('- Investigation loop: after each approved test/validation cycle, a pivot forces post-pivot recon + JavaScript analysis + a new plan. Without a pivot, show coverage and unresolved leads and wait for the operator to continue/replan, edit, wrap/report, end, or pause.');
    lines.push('- Wrap gate: never infer reporting from elapsed time, a flag, RCE, an empty queue, or apparent completion. After explicit operator wrap approval, run exactly report-writer with report_pass: initial, report-validator with report_pass: review-and-edit (recommendations plus direct edits), then report-writer with report_pass: final. Stop after the final writer; no revalidation loop unless the operator explicitly asks. Include "operator_wrap_approved: true" and "operator_approval_reference: <reference>" in every report task.');
    lines.push('- Operator-requested proxy smoke tests are diagnostics, not formal investigations. If the operator asks to spawn a named agent for a single GET/navigation so it appears in the Proxy tab, dispatch that named agent directly with a proxy-smoke-test prompt. Do not first run Glob/Read/Grep over local context, prior reports, blackboard, target_probe, Dradis, DomainsAI, or formal kickoff checks.');
    lines.push('- Proxy smoke-test dispatch prompt must instruct the subagent to perform exactly one low-impact GET through the GLaDOS proxy URL, tag it with X-GLaDOS-Agent, report status/redirect/proxy visibility, and stop. No crawling, no resource discovery, no auth, no findings.');
    lines.push('- Current enabled agent model registry:');
    for (const row of registryRows.filter(r => r?.id && r.enabled !== false)) {
      lines.push(`  - ${row.id}: ${bareModelAlias(row.model, { fallback: model || DEFAULT_BARE_MODEL })}`);
    }
  } else {
    lines.push(`- You are the named GLaDOS subagent "${agentId}". This invocation already selected your role; do not wonder whether you are the subagent or spawn another agent to do your own task.`);
    lines.push('- Use your mounted tools directly, including Bash for shell work and MCP tools for browser/watchdog/blackboard/ops work when the task calls for them. If a tool permission is denied, report the exact denial.');
    lines.push('- Return your final result to parent GLaDOS in this task result. Do not ask the operator to continue an internal agent id and do not reveal output_file paths or SendMessage instructions.');
    lines.push('- If the assignment names a blackboard task ID, call blackboard_task_update for that exact ID with completed, failed, or cancelled before returning your final result.');
    lines.push(`- Browser evidence output root: ${investigationsDir}. When browser_take_screenshot has a filename, use an absolute path inside this root (for example, ${path.join(investigationsDir, '136.116.95.87_56453', 'evidence', '01_landing.png')}). A relative filename resolves from the SDK working directory and is not an evidence path.`);
    lines.push('- For browser_fill_form, every field must include name, type, target, and value. Use the raw snapshot target reference (for example f3e28), never ref=f3e28, and refresh the browser snapshot after navigation before reusing references.');
    lines.push(`- Browser uploads may read only from ${investigationsDir} or ${path.join(GLADOS_RUNTIME_DIR, 'workspaces')}. Create payload files there, never in /tmp. Click the file input once; while the file chooser modal is open, call browser_file_upload directly and do not click the input again.`);
    lines.push('- Prefer browser_snapshot, browser_find, browser_fill_form, browser_click, and browser_file_upload over browser_run_code_unsafe. For browser_evaluate, pass a valid function string such as () => location.href; page is not a variable there. For browser_run_code_unsafe, browser globals such as URLSearchParams must be created inside page.evaluate, not in the outer Node callback.');
    lines.push(`- Local credential helper browser bridge: pass cdp_port=${browserCdpPort(agentId)} to glados-ops__local_auth_login or glados-ops__adfs_active_directory_login. The port is loopback-only and unique to this named agent.`);
    lines.push('- If this turn is a proxy smoke test, perform exactly one low-impact GET through the GLaDOS proxy URL using browser MCP or /usr/bin/curl -x; include X-GLaDOS-Agent, report the HTTP status/redirect, then stop. Do not crawl, authenticate, enumerate, or do formal recon.');
    if (agentId === 'webapp-recon') {
      lines.push('- After SSO returns to the target, the first application analysis is the landing-page JavaScript checkpoint. Do not click through navigation before returning its js_handoff to GLaDOS.');
    }
    if (agentId === 'plan-synthesizer') {
      lines.push('- Every SQLi lead requires an escalation ladder through DBMS/privilege fingerprinting, schema/credentials, stacked statements, file primitives, database execution features, and OS command/RCE. Mark each rung approved, approval-required, blocked, or infeasible and preserve auth/IDOR/reset/admin/XXE chain dependencies.');
    }
    if (agentId === 'webapp-vuln') {
      lines.push('- Confirmed SQLi is never terminal. Continue every safe approved rung toward command execution/RCE, maintain rce_escalation_status, and return a concrete replan request for any feasible rung blocked only by approval or risk.');
    }
    if (agentId === 'webapp-validator') {
      lines.push('- SQLi validation is incomplete without reviewing rce_escalation_status across DB privilege, schema/credentials, stacked statements, file primitives, database execution features, and OS command/RCE; require a reason and next-plan action for every untested feasible rung.');
    }
    if (agentId === 'report-writer' || agentId === 'report-validator') {
      lines.push('- Large-input guard: Grep/Glob first; use Read with explicit offset and limit no greater than 300; request blackboard_baseline_get in summary mode. Never load a full transcript, baseline, proxy export, evidence dump, or large report in one call.');
    }
    if (agentId === 'report-writer') {
      lines.push('- Finite reporting role: report_pass: initial creates the complete first draft for one validator review; report_pass: final consumes validator recommendations/direct edits, resolves them, updates the meter cutoff, and publishes the final draft. The final writer pass must not request another validator.');
    }
    if (agentId === 'report-validator') {
      lines.push('- Finite reporting role: this is the single report_pass: review-and-edit between writer passes. Record recommendations, directly correct every evidence-supported defect, return the edited manifest and final-writer actions, and never request revalidation.');
    }
  }
  return lines.join('\n');
}

function appendRuntimeContext(prompt, agentId, context) {
  const runtimeContext = buildRuntimeContext(agentId, context);
  return `${String(prompt || '').trim()}\n\n${runtimeContext}`.trim();
}

function buildAgentDefinitions(policy = loadPolicy(), options = {}) {
  const out = {};
  const registryRows = loadRegistry({ workspaceRoot: options.workspaceRoot, env: options.env });
  const proxyUrl = proxyUrlFromEnv(options.env || process.env);
  const workspaceRoot = options.workspaceRoot || agentWorkspaceRoot(options.env || process.env);
  const allowedAgents = taskAllowlist(policy, { workspaceRoot });
  const mcpServers = buildMcpServers(options.env || process.env);
  for (const row of registryRows) {
    if (!row?.id || row.id === 'glados' || !allowedAgents.has(row.id)) continue;
    const assembled = assembleAgentPrompt(row.id, options);
    const model = bareModelAlias(row.model, { fallback: policy.harness?.defaultModel || DEFAULT_BARE_MODEL });
    const tools = mountedToolsForAgent(row.id, policy, { env: options.env || process.env });
    out[row.id] = {
      description: row.description || row.name || row.id,
      prompt: appendRuntimeContext(assembled.prompt, row.id, { model, registryRows, proxyUrl, workspaceRoot }),
      model,
      tools,
      disallowedTools: beltAndSuspendersDisallowed(tools, policy),
      mcpServers: Object.keys(mcpServers).filter(name => toolsMountMcpServer(tools, name)),
      permissionMode: 'dontAsk',
      background: false,
      maxTurns: policy.harness?.specialistMaxTurns ?? 100,
      criticalSystemReminder_EXPERIMENTAL: [
        `You are the GLaDOS subagent named ${row.id}.`,
        'Use the tools mounted in your AgentDefinition directly; do not claim Bash/browser/MCP are unavailable unless the tool call is actually denied or missing.',
        'Return the final answer to parent GLaDOS and do not expose internal SDK task metadata.',
      ].join(' '),
      skills: assembled.skills,
    };
  }
  return out;
}

function processToolsForAgent(agentId, policy = loadPolicy(), options = {}) {
  const rootTools = mountedToolsForAgent(agentId, policy, options);
  if (agentId !== 'glados') return rootTools;
  const definitions = buildAgentDefinitions(policy, options);
  return unique([
    ...rootTools,
    ...Object.values(definitions).flatMap(definition => definition.tools || []),
  ]);
}

function beltAndSuspendersDisallowed(tools, policy = loadPolicy()) {
  const mounted = new Set(tools);
  return unique((policy.denyBeltAndSuspenders || []).filter(tool => !mounted.has(tool)));
}

function buildSdkEnv(env = process.env, policy = loadPolicy()) {
  const token = loadLlmAuthToken(env);
  if (!token) {
    throw new Error(
      'Missing GLaDOS LiteLLM key. Store it with scripts/setup-llm-secret.sh or set ANTHROPIC_AUTH_TOKEN; refusing to fall back to Claude OAuth.'
    );
  }
  const out = {
    ...env,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || policy.harness?.anthropicBaseUrl || 'https://llmapi.redteamstuff.com',
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CODE_USE_GATEWAY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1',
    DISABLE_TELEMETRY: env.DISABLE_TELEMETRY || '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'glados-v4-dashboard',
    GLADOS_PROXY_URL: proxyUrlFromEnv(env),
  };
  delete out.ANTHROPIC_API_KEY;
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  delete out.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  delete out.CCR_OAUTH_TOKEN_FILE;
  return out;
}

function buildAgentSdkOptions(agentId, options = {}) {
  const policy = options.policy || loadPolicy();
  const agentTypesById = new Map();
  const browserTargetsByAgent = new Map();
  const workspaceRoot = options.workspaceRoot || agentWorkspaceRoot(options.env || process.env);
  const definitions = buildAgentDefinitions(policy, { workspaceRoot, templateRoot: options.templateRoot, env: options.env });
  const tools = processToolsForAgent(agentId, policy, {
    workspaceRoot,
    templateRoot: options.templateRoot,
    env: options.env || process.env,
  });
  const registryRows = loadRegistry({ workspaceRoot, env: options.env });
  const registry = new Map(registryRows.map(row => [row.id, row]));
  const row = registry.get(agentId) || {};
  const assembled = assembleAgentPrompt(agentId, { workspaceRoot, templateRoot: options.templateRoot });
  const model = bareModelAlias(options.model || row.model || policy.harness?.defaultModel, {
    fallback: policy.harness?.defaultModel || DEFAULT_BARE_MODEL,
  });
  const preToolUse = buildPreToolUseHook(agentId, policy, {
    workspaceRoot,
    env: options.env || process.env,
    agentTypesById,
    browserTargetsByAgent,
    turnTargets: options.turnTargets || [],
  });
  const subagentStart = async input => {
    if (input.agent_id && input.agent_type) agentTypesById.set(input.agent_id, input.agent_type);
    return { hookSpecificOutput: { hookEventName: 'SubagentStart' } };
  };
  const subagentStop = async input => {
    if (input.agent_id) agentTypesById.delete(input.agent_id);
    return { hookSpecificOutput: { hookEventName: 'SubagentStop' } };
  };
  const sdkOptions = {
    model,
    cwd: resolveSdkWorkingDirectory(options),
    systemPrompt: options.systemPrompt || appendRuntimeContext(assembled.prompt, agentId, {
      model,
      registryRows,
      proxyUrl: proxyUrlFromEnv(options.env || process.env),
      workspaceRoot,
    }),
    gladosPromptFiles: assembled.files,
    gladosPromptSource: assembled.source,
    gladosPromptSkills: assembled.skills,
    settingSources: [],
    includePartialMessages: true,
    forwardSubagentText: true,
    appendSubagentSystemPrompt: [
      'GLaDOS subagents are operator-visible assessment workers.',
      'They must use their configured AgentDefinition prompt, model, tools, and MCP servers.',
      'They must return the final task result to parent GLaDOS, not ask the operator to message an internal task id.',
    ].join(' '),
    permissionMode: 'dontAsk',
    // Options.tools controls built-ins only. MCP tools are deferred and loaded
    // through ToolSearch, then caller-scoped by AgentDefinition.tools and the
    // authoritative PreToolUse hook.
    tools: tools.filter(tool => !tool.startsWith('mcp__')),
    gladosMountedTools: tools,
    // The SDK process hosts GLaDOS and its AgentDefinition workers. Approve
    // every mounted process tool here; PreToolUse/canUseTool still enforce the
    // caller-specific existence allowlist and policy for each invocation.
    allowedTools: autoApprovedToolsForAgent(tools),
    disallowedTools: beltAndSuspendersDisallowed(tools, policy),
    canUseTool: buildCanUseTool(agentId, policy, {
      workspaceRoot,
      env: options.env || process.env,
      agentTypesById,
      browserTargetsByAgent,
      turnTargets: options.turnTargets || [],
    }),
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      SubagentStart: [{ hooks: [subagentStart] }],
      SubagentStop: [{ hooks: [subagentStop] }],
    },
    mcpServers: buildMcpServers(options.env || process.env),
    agents: definitions,
    env: buildSdkEnv(options.env || process.env, policy),
    maxTurns: options.maxTurns ?? (agentId === 'glados'
      ? (policy.harness?.coordinatorMaxTurns ?? 40)
      : (policy.harness?.specialistMaxTurns ?? 100)),
  };
  if (options.resumeSessionId) sdkOptions.resume = options.resumeSessionId;
  return sdkOptions;
}

function contentText(block) {
  if (!block) return '';
  if (typeof block.thinking === 'string') return block.thinking;
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(contentText).join('');
  return '';
}

function sanitizeSubagentToolResult(text) {
  let out = String(text || '');
  out = out.replace(/<usage>[\s\S]*?<\/usage>/gi, '').trim();
  out = out.replace(/^Async agent launched successfully\..*$/gmi, 'Subagent launched.');
  out = out.replace(/^.*internal metadata.*$/gmi, '');
  out = out.replace(/^agentId:.*$/gmi, '');
  out = out.replace(/^output_file:.*$/gmi, '');
  out = out.replace(/^Do NOT Read or tail this file.*$/gmi, '');
  out = out.replace(/^The agent is working in the background.*$/gmi, '');
  out = out.replace(/^Do not duplicate this agent's work.*$/gmi, '');
  out = out.replace(/^.*Use SendMessage with to:.*$/gmi, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function redactCredentialText(text) {
  let out = String(text || '');
  out = out.replace(
    /((?:new_)?password(?:_repeat)?\s*[:=]\s*)([^\s,;\]}\r\n]+)/gi,
    '$1[REDACTED]'
  );
  out = out.replace(
    /((?:password|new_password)[^;\r\n]{0,200}?\.fill\(\s*)(['"`])[^'"`\r\n]*\2/gi,
    '$1$2[REDACTED]$2'
  );
  out = out.replace(/(<password>)[\s\S]*?(<\/password>)/gi, '$1[REDACTED]$2');
  out = out.replace(
    /("(?:new_)?password(?:_repeat)?"\s*:\s*")[^"]*(")/gi,
    '$1[REDACTED]$2'
  );
  return out;
}

function redactCredentialInput(value, key = '') {
  if (Array.isArray(value)) return value.map(item => redactCredentialInput(item, key));
  if (value && typeof value === 'object') {
    const sensitiveField = /password|passphrase|secret|token|authorization|cookie|credential|api[_-]?key/i.test(
      String(value.name || value.element || value.label || '')
    );
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => {
      if (/password|passphrase|secret|token|authorization|cookie|credential|api[_-]?key/i.test(childKey)) {
        return [childKey, '[REDACTED]'];
      }
      if (sensitiveField && childKey === 'value') return [childKey, '[REDACTED]'];
      return [childKey, redactCredentialInput(childValue, childKey)];
    }));
  }
  if (typeof value === 'string') return redactCredentialText(value);
  return value;
}

function sanitizeToolResultForTranscript(text, toolName, toolInput = {}) {
  const inputText = JSON.stringify(toolInput || {});
  if (toolName === 'Bash' && /(?:openssl\s+rand|generate.{0,40}(?:password|credential)|password.{0,40}generat)/i.test(inputText)) {
    return '[REDACTED: generated credential]';
  }
  if (toolName === 'Read' && /(?:credential|password|secret)/i.test(inputText)) {
    return '[REDACTED: credential file contents]';
  }
  return redactCredentialText(text);
}

function rememberStreamBlockKind(context, ev, kind) {
  if (!context.streamBlockKindByIndex) context.streamBlockKindByIndex = new Map();
  if (ev.index !== undefined && ev.index !== null) context.streamBlockKindByIndex.set(ev.index, kind);
}

function mapSdkMessageToEvents(agentId, message, context = {}) {
  const ts = new Date().toISOString();
  const parentToolUseId = message?.parent_tool_use_id || null;
  const renderAgentId = message?.subagent_type || context.subagentByParentToolUseId?.get(parentToolUseId) || agentId;
  const base = {
    agentId: renderAgentId,
    parentAgentId: renderAgentId === agentId ? null : agentId,
    ts,
    sdkType: message?.type,
    sessionId: message?.session_id,
    sdkUuid: message?.uuid,
    parentToolUseId,
    subagentType: message?.subagent_type || null,
  };
  if (!message) return [];
  if (!context.subagentByParentToolUseId) context.subagentByParentToolUseId = new Map();
  if (!context.toolNameByToolUseId) context.toolNameByToolUseId = new Map();
  if (!context.toolInputByToolUseId) context.toolInputByToolUseId = new Map();
  if (message.subagent_type && parentToolUseId && context.subagentByParentToolUseId) {
    context.subagentByParentToolUseId.set(parentToolUseId, message.subagent_type);
  }

  if (message.type === 'stream_event') {
    const ev = message.event || {};
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
      rememberStreamBlockKind(context, ev, 'text');
      return [{
        ...base,
        kind: 'text-stream',
        evtType: 'text_start',
        delta: '',
        text: '',
        runId: message.session_id || message.uuid || parentToolUseId || undefined,
        id: message.uuid ? `${message.uuid}:text-start` : undefined,
      }];
    }
    if (ev.type === 'content_block_start' && (ev.content_block?.type === 'thinking' || ev.content_block?.type === 'redacted_thinking')) {
      rememberStreamBlockKind(context, ev, 'thinking');
      return [{
        ...base,
        kind: 'thinking-stream',
        evtType: 'thinking_start',
        delta: '',
        text: '',
        runId: message.session_id || message.uuid || parentToolUseId || undefined,
        id: message.uuid ? `${message.uuid}:thinking-start` : undefined,
      }];
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      rememberStreamBlockKind(context, ev, 'text');
      return [{
        ...base,
        kind: 'text-stream',
        evtType: 'text_delta',
        delta: ev.delta.text,
        text: ev.delta.text,
        runId: message.session_id || message.uuid || undefined,
        id: message.uuid || undefined,
      }];
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
      rememberStreamBlockKind(context, ev, 'thinking');
      return [{
        ...base,
        kind: 'thinking-stream',
        evtType: 'thinking_delta',
        delta: ev.delta.thinking,
        text: ev.delta.thinking,
        runId: message.session_id || message.uuid || undefined,
        id: message.uuid || undefined,
      }];
    }
    if (ev.type === 'content_block_stop') {
      const streamKind = context.streamBlockKindByIndex?.get(ev.index);
      if (!streamKind) return [];
      const isThinking = streamKind === 'thinking';
      return [{
        ...base,
        kind: isThinking ? 'thinking-stream' : 'text-stream',
        evtType: isThinking ? 'thinking_end' : 'text_end',
        delta: '',
        text: '',
        runId: message.session_id || message.uuid || parentToolUseId || undefined,
        id: message.uuid ? `${message.uuid}:${streamKind}-end` : undefined,
      }];
    }
    return [];
  }

  if (message.type === 'assistant') {
    const blocks = message.message?.content || message.content || [];
    return blocks.flatMap(block => {
      if (block.type === 'tool_use') {
        const targetAgentId = isTaskDispatchTool(block.name) ? targetAgentFromTaskInput(block.input || {}) : null;
        if (targetAgentId && block.id) context.subagentByParentToolUseId.set(block.id, targetAgentId);
        if (block.id) context.toolNameByToolUseId.set(block.id, block.name);
        if (block.id) context.toolInputByToolUseId.set(block.id, block.input || {});
        const transcriptInput = redactCredentialInput(block.input || {});
        return [{
          ...base,
          kind: 'tool-call',
          text: block.name,
          toolName: block.name,
          toolCallId: block.id,
          toolInput: transcriptInput,
          arguments: transcriptInput,
          targetAgentId,
          id: block.id || message.uuid || undefined,
        }];
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const text = contentText(block);
        return text ? [{ ...base, kind: 'thinking', text, id: message.uuid || undefined }] : [];
      }
      const text = contentText(block);
      return text ? [{ ...base, kind: 'assistant-text', text, id: message.uuid || undefined }] : [];
    });
  }

  if (message.type === 'user') {
    const blocks = message.message?.content || message.content || [];
    return blocks.flatMap(block => {
      if (block.type !== 'tool_result') return [];
      const targetAgentId = context.subagentByParentToolUseId?.get(block.tool_use_id);
      const toolName = context.toolNameByToolUseId?.get(block.tool_use_id);
      const toolInput = context.toolInputByToolUseId?.get(block.tool_use_id) || {};
      const rawText = isTaskDispatchTool(toolName) ? sanitizeSubagentToolResult(contentText(block)) : contentText(block);
      const text = sanitizeToolResultForTranscript(rawText, toolName, toolInput);
      return [{
        ...base,
        agentId: targetAgentId || base.agentId,
        parentAgentId: targetAgentId ? agentId : base.parentAgentId,
        kind: 'tool-result',
        text,
        toolCallId: block.tool_use_id,
        targetAgentId,
        isError: !!block.is_error,
        permissionDenials: block.permission_denials || [],
        id: block.tool_use_id ? `tool-result:${block.tool_use_id}` : message.uuid || undefined,
      }];
    });
  }

  if (message.type === 'result') {
    const isError = !!message.is_error || (Array.isArray(message.errors) && message.errors.length > 0);
    return [{
      ...base,
      kind: isError ? 'error' : 'result',
      text: message.result || message.error || (Array.isArray(message.errors) ? message.errors.join('\n') : '') || message.subtype || '',
      subtype: message.subtype,
      turns: message.num_turns,
      costUsd: message.total_cost_usd,
      durationMs: message.duration_ms,
      durationApiMs: message.duration_api_ms,
      usage: message.usage || null,
      modelUsage: message.modelUsage || message.model_usage || null,
      isError,
      permissionDenials: message.permission_denials || [],
      errors: message.errors || [],
      id: message.uuid || undefined,
    }];
  }

  if (message.type === 'system') {
    if (message.subtype === 'task_started' || message.subtype === 'task_progress' || message.subtype === 'task_notification') {
      if (!context.subagentByTaskId) context.subagentByTaskId = new Map();
      const toolCallId = message.tool_use_id || null;
      const mappedAgent = message.subagent_type
        || context.subagentByParentToolUseId?.get(toolCallId)
        || context.subagentByTaskId.get(message.task_id)
        || base.agentId;
      if (message.task_id && mappedAgent && message.subtype !== 'task_notification') {
        context.subagentByTaskId.set(message.task_id, mappedAgent);
      }
      const live = message.subtype !== 'task_notification';
      const state = message.subtype === 'task_notification' ? message.status : 'running';
      if (!live && message.task_id) context.subagentByTaskId.delete(message.task_id);
      return [{
        ...base,
        agentId: mappedAgent,
        parentAgentId: mappedAgent === agentId ? null : agentId,
        kind: 'liveness',
        text: message.summary || message.description || state,
        live,
        state,
        taskId: message.task_id,
        toolCallId,
        parentToolUseId: toolCallId || base.parentToolUseId,
        subagentType: message.subagent_type || (mappedAgent === agentId ? null : mappedAgent),
        id: message.uuid || `${message.subtype}:${message.task_id}`,
      }];
    }
    if (message.subtype === 'permission_denied') {
      return [{
        ...base,
        kind: 'permission-denied',
        text: message.message || message.decision_reason || `${message.tool_name} denied`,
        toolName: message.tool_name,
        toolCallId: message.tool_use_id,
        decisionReason: message.decision_reason,
        decisionReasonType: message.decision_reason_type,
        id: message.uuid || `permission-denied:${message.tool_use_id}`,
      }];
    }
    if (message.subtype === 'init') {
      return [{
        ...base,
        kind: 'harness-init',
        text: `Agent SDK initialized ${message.model || ''}`.trim(),
        tools: message.tools || [],
        mcpServers: message.mcp_servers || [],
        permissionMode: message.permissionMode,
        id: message.uuid || undefined,
      }];
    }
    if (message.subtype === 'session_state_changed') {
      return [{
        ...base,
        kind: 'liveness',
        text: message.state,
        live: message.state === 'running' || message.state === 'requires_action',
        state: message.state,
        id: message.uuid || undefined,
      }];
    }
  }

  return [];
}

async function importSdkQuery() {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  return mod.query;
}

function sdkErrorText(value) {
  if (!value) return '';
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'string') return value;
  return [
    value.message,
    value.error,
    value.result,
    ...(Array.isArray(value.errors) ? value.errors : []),
  ].filter(Boolean).join('\n');
}

function isMissingSdkConversationError(value) {
  return /No conversation found with session ID:/i.test(sdkErrorText(value));
}

function shouldPersistSdkSession(message) {
  if (!message?.session_id) return false;
  if (message.type !== 'result') return true;
  return !message.is_error && message.subtype !== 'error_during_execution';
}

function firstActivityTimeoutError(timeoutMs) {
  const error = new Error(`Agent SDK produced no model or tool activity within ${timeoutMs}ms`);
  error.code = 'GLADOS_FIRST_ACTIVITY_TIMEOUT';
  error.timeoutMs = timeoutMs;
  return error;
}

function isFirstActivityTimeoutError(value) {
  return value?.code === 'GLADOS_FIRST_ACTIVITY_TIMEOUT';
}

async function nextWithFirstActivityDeadline(iterator, timeoutMs, onTimeout) {
  if (!(timeoutMs > 0)) return iterator.next();
  let timer;
  const pending = Promise.resolve().then(() => iterator.next());
  // The SDK promise may settle after the watchdog wins. Always attach a
  // rejection handler so that late teardown cannot become an unhandled error.
  pending.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(firstActivityTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isMeaningfulTurnActivity(events) {
  return (events || []).some(event => [
    'thinking', 'thinking-stream', 'assistant-text', 'text-stream',
    'tool-call', 'tool-result', 'permission-denied', 'prompt-error', 'result',
  ].includes(event?.kind));
}

async function waitForCoreMcpServers(iterable, sdkOptions, options = {}) {
  if (typeof iterable?.mcpServerStatus !== 'function') return [];
  const configured = new Set(Object.keys(sdkOptions?.mcpServers || {}));
  const required = (options.requiredMcpServers || ['blackboard', 'watchdog', 'glados-ops'])
    .filter(name => configured.has(name));
  if (required.length === 0) return [];

  const timeoutMs = options.mcpReadyTimeoutMs ?? 10000;
  const pollMs = options.mcpReadyPollMs ?? 100;
  const expectedTools = sdkOptions?.gladosMountedTools || sdkOptions?.tools || [];
  const deadline = Date.now() + timeoutMs;
  let statuses = [];
  do {
    statuses = await iterable.mcpServerStatus();
    const byName = new Map((statuses || []).map(status => [status.name || status.server_name, status]));
    const ready = required.every(name => {
      const status = byName.get(name);
      if (status?.status !== 'connected') return false;
      const expected = expectedTools
        .filter(tool => tool.startsWith(`mcp__${name}__`))
        .map(tool => tool.slice(`mcp__${name}__`.length));
      const discovered = new Set((status.tools || []).map(tool => tool.name));
      return expected.every(tool => discovered.has(tool));
    });
    if (ready) return statuses;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (true);

  const byName = new Map((statuses || []).map(status => [status.name || status.server_name, status]));
  const summary = required.map(name => {
    const status = byName.get(name);
    if (status?.status !== 'connected') return `${name}:${status?.status || 'missing'}`;
    const expected = expectedTools
      .filter(tool => tool.startsWith(`mcp__${name}__`))
      .map(tool => tool.slice(`mcp__${name}__`.length));
    const discovered = new Set((status.tools || []).map(tool => tool.name));
    const missing = expected.filter(tool => !discovered.has(tool));
    return missing.length ? `${name}:connected missing-tools=${missing.join('|')}` : `${name}:connected`;
  }).join(', ');
  throw new Error(`Core MCP servers were not ready before the agent turn (${summary})`);
}

async function streamAgentTurnOnce({ agentId, prompt, onEvent, store, queryImpl, options = {} }) {
  const query = queryImpl || await importSdkQuery();
  const turnTargets = options.turnTargets || extractTargets(prompt);
  const sdkOptions = options.sdkOptions || buildAgentSdkOptions(agentId, { ...options, turnTargets });
  const iterable = query({ prompt, options: sdkOptions });
  const transcriptStore = store === false ? null : (store || new DashboardTranscriptStore(BLACKBOARD_DB));
  const events = [];
  const context = { subagentByParentToolUseId: new Map() };
  let interrupted = false;
  async function interrupt(reason = 'interrupted') {
    if (interrupted) return;
    interrupted = true;
    if (typeof iterable.interrupt === 'function') {
      await Promise.resolve(iterable.interrupt(reason)).catch(() => {});
    }
  }
  if (typeof options.onInterruptReady === 'function') {
    options.onInterruptReady(interrupt);
  }
  const abortHandler = () => {
    interrupt(options.abortSignal?.reason || 'operator stop').catch(() => {});
  };
  if (options.abortSignal?.addEventListener) {
    options.abortSignal.addEventListener('abort', abortHandler, { once: true });
  }
  if (options.abortSignal?.aborted) await interrupt(options.abortSignal.reason || 'operator stop');
  await waitForCoreMcpServers(iterable, sdkOptions, options);
  const pollMs = options.haltPollMs ?? 1000;
  const isHalted = options.isAgentHalted || haltActive;
  const haltedInTurn = () => {
    const agents = new Set([agentId, ...context.subagentByParentToolUseId.values()]);
    return [...agents].find(id => isHalted(id)) || null;
  };
  const haltTimer = typeof iterable.interrupt === 'function' && pollMs > 0
    ? setInterval(() => {
      const haltedAgent = haltedInTurn();
      if (interrupted || !haltedAgent) return;
      interrupt(`${haltedAgent} halted by operator`).catch(() => {});
    }, pollMs)
    : null;
  try {
    const iterator = typeof iterable?.[Symbol.asyncIterator] === 'function'
      ? iterable[Symbol.asyncIterator]()
      : iterable;
    const firstActivityTimeoutMs = options.firstActivityTimeoutMs ?? 60_000;
    const firstActivityDeadline = firstActivityTimeoutMs > 0
      ? Date.now() + firstActivityTimeoutMs
      : null;
    let firstActivitySeen = false;
    while (true) {
      const remainingMs = firstActivitySeen || !firstActivityDeadline
        ? 0
        : Math.max(1, firstActivityDeadline - Date.now());
      const next = firstActivitySeen || !firstActivityDeadline
        ? await iterator.next()
        : await nextWithFirstActivityDeadline(iterator, remainingMs, () => {
          interrupt('first model activity timeout').catch(() => {});
        });
      if (next.done) break;
      const message = next.value;
      if (sdkOptions.resume && isMissingSdkConversationError(message)) {
        const error = new Error(sdkErrorText(message));
        error.code = 'GLADOS_STALE_SDK_SESSION';
        throw error;
      }
      if (shouldPersistSdkSession(message) && typeof options.onSessionId === 'function') {
        options.onSessionId(message.session_id, message);
      }
      // A halt poll can interrupt while the iterator is waiting. The value that
      // unblocks that wait belongs to the cancelled turn and must not be shown.
      if (interrupted) break;
      if (options.abortSignal?.aborted) {
        await interrupt(options.abortSignal.reason || 'operator stop');
        break;
      }
      const haltedAgent = haltedInTurn();
      if (!interrupted && haltedAgent && typeof iterable.interrupt === 'function') {
        await interrupt(`${haltedAgent} halted by operator`);
        break;
      }
      const mappedEvents = mapSdkMessageToEvents(agentId, message, context);
      if (!firstActivitySeen && isMeaningfulTurnActivity(mappedEvents)) firstActivitySeen = true;
      for (const ev of mappedEvents) {
        // Streaming deltas are transient UI transport. Persisting every token
        // synchronously to SQLite delays the next SDK chunk and makes the
        // dashboard look stalled. The completed assistant event remains the
        // durable transcript record.
        const isStreamDelta = ev.kind === 'text-stream' || ev.kind === 'thinking-stream';
        const recorded = transcriptStore && !isStreamDelta
          ? transcriptStore.record(options.investigationSessionId || options.env?.GLADOS_SESSION_ID || 'legacy', ev.agentId || agentId, ev)
          : ev;
        events.push(recorded);
        if (onEvent) onEvent(recorded, message);
      }
    }
  } finally {
    if (haltTimer) clearInterval(haltTimer);
    if (options.abortSignal?.removeEventListener) {
      options.abortSignal.removeEventListener('abort', abortHandler);
    }
    if (!store && transcriptStore) transcriptStore.close();
  }
  return events;
}

async function streamAgentTurn(args) {
  const options = args.options || {};
  const resumeSessionId = options.sdkOptions?.resume || options.resumeSessionId;
  try {
    return await streamAgentTurnOnce(args);
  } catch (error) {
    const recoverableResumeFailure = isMissingSdkConversationError(error)
      || isFirstActivityTimeoutError(error);
    if (!resumeSessionId || !recoverableResumeFailure) throw error;
    if (typeof options.onInvalidSession === 'function') {
      await options.onInvalidSession(resumeSessionId, error);
    }
    const retryOptions = { ...options, resumeSessionId: null };
    if (options.sdkOptions) {
      retryOptions.sdkOptions = { ...options.sdkOptions };
      delete retryOptions.sdkOptions.resume;
    }
    return streamAgentTurnOnce({ ...args, options: retryOptions });
  }
}

module.exports = {
  POLICY_PATH,
  loadPolicy,
  loadRegistry,
  readModelOverrides,
  PROMPT_FILE_ORDER,
  mountedToolsForAgent,
  resolveSdkWorkingDirectory,
  processToolsForAgent,
  autoApprovedToolsForAgent,
  agentEnabled,
  isDisabledByDefaultAgent,
  taskAllowlist,
  decideToolUse,
  investigationDispatchContractViolation,
  toolCallerAgentId,
  normalizeToolInput,
  toolTargetsForAgent,
  rememberToolTargets,
  isTaskDispatchTool,
  buildPreToolUseHook,
  buildCanUseTool,
  buildMcpEnv,
  buildMcpServers,
  browserServerName,
  browserMountForAgent,
  writeBrowserMcpConfig,
  buildSdkEnv,
  resolveNodeRuntime,
  assembleAgentPrompt,
  readAgentPrompt,
  buildAgentDefinitions,
  buildAgentSdkOptions,
  mapSdkMessageToEvents,
  isMissingSdkConversationError,
  shouldPersistSdkSession,
  waitForCoreMcpServers,
  isFirstActivityTimeoutError,
  streamAgentTurn,
  bareModelAlias,
};
