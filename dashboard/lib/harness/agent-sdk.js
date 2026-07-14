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
const MCP_TOOL_APPROVALS = {
  mcp__blackboard: [
    'blackboard_read',
    'blackboard_write',
    'blackboard_task_read',
    'blackboard_task_update',
    'blackboard_task_create',
    'blackboard_engagement_status',
    'blackboard_engagement_create',
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
    'adfs_active_directory_login',
    'evidence_bundle_create',
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
    'browser_press_key',
    'browser_resize',
    'browser_select_option',
    'browser_snapshot',
    'browser_take_screenshot',
    'browser_type',
    'browser_wait_for',
    'browser_tabs',
    'browser_get_config',
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

function mountedToolsForAgent(agentId, policy = loadPolicy(), options = {}) {
  const explicit = policy.agents?.[agentId]?.tools;
  if (Array.isArray(explicit)) return expandTaskToolAliases(explicit);
  const profile = policy.agentToolProfiles?.[agentId] || defaultProfileForAgent(agentId);
  const tools = [...profileTools(policy, profile)];
  if (browserMcpEnabled(options.env || process.env) && profileCanUseBrowserMcp(policy, profile, agentId)) {
    tools.push(browserMountForAgent(agentId));
  }
  return expandTaskToolAliases(tools);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function autoApprovedToolsForAgent(tools) {
  const out = [];
  for (const tool of unique(tools)) {
    if (TASK_TOOL_NAMES.has(tool)) continue;
    out.push(tool);
    if (tool.startsWith('mcp__')) {
      out.push(`${tool}__*`);
      for (const name of MCP_TOOL_APPROVALS[tool] || []) out.push(`${tool}__${name}`);
    }
  }
  return unique(out);
}

function toolMatchesMount(toolName, mount) {
  if (toolName === mount) return true;
  if (TASK_TOOL_NAMES.has(toolName) && TASK_TOOL_NAMES.has(mount)) return true;
  if (mount.startsWith('mcp__') && toolName.startsWith(`${mount}__`)) return true;
  return false;
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
    const target = targetAgentFromTaskInput(input);
    if (!target) return { allowed: false, reason: `${toolName} dispatch did not name an allowed GLaDOS agent` };
    const allowedAgents = taskAllowlist(policy, { workspaceRoot });
    if (!allowedAgents.has(target)) return { allowed: false, reason: `${toolName} dispatch to ${target} is not allowed` };
    if (!agentEnabled(target, { policy, workspaceRoot })) return { allowed: false, reason: `${toolName} dispatch target ${target} is disabled` };
  }

  return evaluateToolUse({ agentId, toolName, input, turnTargets });
}

function toolCallerAgentId(rootAgentId, input = {}, agentTypesById = new Map()) {
  if (!input.agent_id) return rootAgentId;
  if (input.agent_type) {
    agentTypesById.set(input.agent_id, input.agent_type);
    return input.agent_type;
  }
  return agentTypesById.get(input.agent_id) || null;
}

function buildPreToolUseHook(agentId, policy = loadPolicy(), options = {}) {
  return async input => {
    const callerAgentId = toolCallerAgentId(agentId, input, options.agentTypesById);
    const decision = decideToolUse({
      agentId: callerAgentId,
      toolName: input.tool_name,
      input: input.tool_input,
      policy,
      workspaceRoot: options.workspaceRoot,
      env: options.env || process.env,
      turnTargets: options.turnTargets || [],
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.allowed ? 'allow' : 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  };
}

function buildCanUseTool(agentId, policy = loadPolicy(), hookOptions = {}) {
  return async (toolName, input, requestOptions = {}) => {
    const callerAgentId = requestOptions.agentID
      ? hookOptions.agentTypesById?.get(requestOptions.agentID)
      : agentId;
    const decision = callerAgentId
      ? decideToolUse({
        agentId: callerAgentId,
        toolName,
        input,
        policy,
        workspaceRoot: hookOptions.workspaceRoot,
        env: hookOptions.env || process.env,
        turnTargets: hookOptions.turnTargets || [],
      })
      : { allowed: false, reason: `Unknown subagent ${requestOptions.agentID} attempted to use ${toolName}`, interrupt: true };
    if (decision.allowed) {
      return { behavior: 'allow', toolUseID: requestOptions.toolUseID };
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
  return {
    ...env,
    GLADOS_RUNTIME_DIR,
    GLADOS_REPO_ROOT: REPO_ROOT,
    GLADOS_AGENT_WORKSPACES,
    GLADOS_REPORTS_DIR: env.GLADOS_REPORTS_DIR || path.join(GLADOS_RUNTIME_DIR, 'reports'),
    GLADOS_INVESTIGATIONS_DIR: env.GLADOS_INVESTIGATIONS_DIR || path.join(GLADOS_RUNTIME_DIR, 'investigations'),
    BLACKBOARD_DB,
    WATCHDOG_DB,
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
  const dir = path.join(GLADOS_RUNTIME_DIR, 'browser-mcp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${String(agentId).replace(/[^a-z0-9._-]/gi, '-')}.json`);
  const config = {
    browser: {
      isolated: true,
      launchOptions: { proxy: { server: proxyUrlFromEnv(env) } },
      contextOptions: {
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          'X-GLaDOS-Agent': agentId,
          'X-GLaDOS-Transport': 'browser-mcp',
        },
      },
    },
    capabilities: ['core', 'network'],
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

function buildRuntimeContext(agentId, { model, registryRows = [], proxyUrl } = {}) {
  const lines = [
    '# Runtime Context (authoritative)',
    `- Current agent id: ${agentId}`,
    `- Active model for this turn: ${model || DEFAULT_BARE_MODEL}`,
    '- If the operator asks what model you are running, answer from the active model above.',
    '- Do not infer current model names from static roster tables, examples, MEMORY.md, or historical workspace files.',
    `- GLaDOS proxy URL for target HTTP(S): ${proxyUrl || proxyUrlFromEnv()}. For shell HTTP, use /usr/bin/curl -x this URL -k and add X-GLaDOS-Agent: ${agentId}. Do not use legacy :8080 proxy examples unless the operator explicitly overrides it.`,
  ];
  if (agentId === 'glados' && registryRows.length) {
    const halted = listHaltedAgents().map(marker => marker.agentId).filter(Boolean);
    lines.push(`- Operator halt state: ${halted.length ? `halted agents are ${halted.join(', ')}` : 'no agents are halted'}. Treat this as authoritative and do not dispatch a halted agent.`);
    lines.push('- Subagent dispatch rule: use the SDK subagent dispatch tool only with subagent_type set to an exact enabled GLaDOS agent id. Never launch a generic unnamed Agent. Do not run subagents in the background for operator-visible work unless the operator explicitly asks for background execution.');
    lines.push('- After a subagent returns, relay its final result to the operator. Never expose internal agentId values, output_file paths, SendMessage instructions, or raw SDK task metadata.');
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
    lines.push('- If this turn is a proxy smoke test, perform exactly one low-impact GET through the GLaDOS proxy URL using browser MCP or /usr/bin/curl -x; include X-GLaDOS-Agent, report the HTTP status/redirect, then stop. Do not crawl, authenticate, enumerate, or do formal recon.');
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
      prompt: appendRuntimeContext(assembled.prompt, row.id, { model, registryRows, proxyUrl }),
      model,
      tools,
      disallowedTools: beltAndSuspendersDisallowed(tools, policy),
      mcpServers: Object.keys(mcpServers).filter(name => tools.includes(`mcp__${name}`)),
      permissionMode: 'dontAsk',
      background: false,
      maxTurns: 12,
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
  const rootTools = mountedToolsForAgent(agentId, policy, { env: options.env || process.env });
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
    cwd: options.cwd || REPO_ROOT,
    systemPrompt: options.systemPrompt || appendRuntimeContext(assembled.prompt, agentId, {
      model,
      registryRows,
      proxyUrl: proxyUrlFromEnv(options.env || process.env),
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
    tools,
    allowedTools: autoApprovedToolsForAgent(rootTools),
    disallowedTools: beltAndSuspendersDisallowed(rootTools, policy),
    canUseTool: buildCanUseTool(agentId, policy, {
      workspaceRoot,
      env: options.env || process.env,
      agentTypesById,
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
    maxTurns: options.maxTurns || 12,
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
        return [{
          ...base,
          kind: 'tool-call',
          text: block.name,
          toolName: block.name,
          toolCallId: block.id,
          toolInput: block.input || {},
          arguments: block.input || {},
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
      const text = isTaskDispatchTool(toolName) ? sanitizeSubagentToolResult(contentText(block)) : contentText(block);
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
      isError,
      permissionDenials: message.permission_denials || [],
      errors: message.errors || [],
      id: message.uuid || undefined,
    }];
  }

  if (message.type === 'system') {
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

async function streamAgentTurn({ agentId, prompt, onEvent, store, queryImpl, options = {} }) {
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
    for await (const message of iterable) {
      if (message?.session_id && typeof options.onSessionId === 'function') {
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
      for (const ev of mapSdkMessageToEvents(agentId, message, context)) {
        const recorded = transcriptStore ? transcriptStore.record(ev.agentId || agentId, ev) : ev;
        events.push(recorded);
        if (onEvent) await onEvent(recorded, message);
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

module.exports = {
  POLICY_PATH,
  loadPolicy,
  loadRegistry,
  readModelOverrides,
  PROMPT_FILE_ORDER,
  mountedToolsForAgent,
  processToolsForAgent,
  autoApprovedToolsForAgent,
  agentEnabled,
  isDisabledByDefaultAgent,
  taskAllowlist,
  decideToolUse,
  toolCallerAgentId,
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
  streamAgentTurn,
  bareModelAlias,
};
