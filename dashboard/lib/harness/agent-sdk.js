const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GLADOS_RUNTIME_DIR, GLADOS_AGENT_WORKSPACES, BLACKBOARD_DB, WATCHDOG_DB, MODEL_OVERRIDES_JSON } = require('../config');
const { DashboardTranscriptStore } = require('../transcript-store');
const { loadLlmAuthToken } = require('../secrets/llm-secrets');
const { fetchLiteLlmModels } = require('../litellm-models');
const { isFullAccessEnabled } = require('../full-access');
const { normalizeEffort } = require('../chat-preferences');
const { bareModelAlias, DEFAULT_BARE_MODEL } = require('../../../scripts/lib/model-aliases');
const { agentStatus, listHaltedAgents } = require('glados-watchdog/lib/halt');
const { evaluateToolUse, extractTargets, forbiddenSecretAccess } = require('glados-watchdog/lib/safety-gate');
const {
  discoveryDispatchCheckpoint,
  ensureDiscoverySaturated,
  discoveryWorkerIdFromPrompt,
  claimDiscoveryWorker,
  markDeepScanCapped,
} = require('../security-review/deep-scan');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const POLICY_PATH = path.join(REPO_ROOT, 'config', 'glados-policy.json');
const REGISTRY_PATH = path.join(REPO_ROOT, 'templates', 'agent-registry.json');
const TEMPLATE_AGENT_ROOT = path.join(REPO_ROOT, 'templates', 'agents', 'default');
const PROMPT_FILE_ORDER = ['IDENTITY.md', 'SOUL.md', 'RUNBOOK.md', 'TOOLS.md', 'USER.md', 'AGENTS.md'];
const TASK_TOOL_NAMES = new Set(['Task', 'Agent']);
const SECURITY_REVIEW_SPECIALIST_ROLES = new Set([
  'authorization-access-control',
  'data-flow-injection',
  'secrets-history',
  'resilience-error-handling',
  'iac-config-manifests',
  'cryptography-suppressions',
]);
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
    'desktop_snapshot',
    'desktop_list_windows',
    'desktop_click',
    'desktop_type',
    'desktop_key',
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
  const modelOverridesPath = options.modelOverridesPath
    || (options.env?.GLADOS_RUNTIME_DIR
      ? path.join(path.resolve(options.env.GLADOS_RUNTIME_DIR), 'model-overrides.json')
      : MODEL_OVERRIDES_JSON);
  const modelOverrides = options.modelOverrides || readModelOverrides(modelOverridesPath);
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
  const env = options.env || process.env;
  const explicit = policy.agents?.[agentId]?.tools;
  const profile = policy.agentToolProfiles?.[agentId] || defaultProfileForAgent(agentId);
  const tools = Array.isArray(explicit) ? [...explicit] : [...profileTools(policy, profile)];
  if (!Array.isArray(explicit) && browserMcpEnabled(env)
      && env.GLADOS_SECURITY_REVIEW !== '1'
      && profileCanUseBrowserMcp(policy, profile, agentId)) {
    tools.push(browserMountForAgent(agentId));
  }
  const expanded = expandMcpTools(expandTaskToolAliases(tools));
  if (env.GLADOS_SECURITY_REVIEW !== '1') return expanded;
  return expanded.filter(tool => tool !== 'Bash' && tool !== 'NotebookEdit'
    && !tool.startsWith('mcp__glados-ops__') && !tool.startsWith('mcp__browser-'));
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

function haltActive(agentId, env = process.env) {
  try { return agentStatus(agentId, { sessionId: env.GLADOS_SESSION_ID || 'legacy' }).haltActive; }
  catch { return true; }
}

function decideToolUse({ agentId, toolName, input = {}, policy = loadPolicy(), workspaceRoot = agentWorkspaceRoot(), env = process.env, turnTargets = [] }) {
  if (!agentEnabled(agentId, { policy, workspaceRoot })) {
    return { allowed: false, reason: `${agentId} is disabled by policy or local workspace state`, interrupt: true };
  }
  if (haltActive(agentId, env)) {
    return { allowed: false, reason: `${agentId} is halted by the operator`, interrupt: true };
  }

  if (env.GLADOS_SECURITY_REVIEW === '1') {
    if (/^mcp__glados-ops__(?:desktop_|local_auth_|adfs_active_directory_login$)/i.test(String(toolName || ''))
        || /^mcp__browser-[^_]+__browser_/i.test(String(toolName || ''))) {
      return { allowed: false, reason: 'desktop, browser, and local-auth capabilities are unavailable in a source-only security review' };
    }
    if (/blackboard_engagement_create$/i.test(String(toolName || ''))) {
      return { allowed: false, reason: 'the security-review controller already provisioned this engagement; use the supplied engagement_id' };
    }
    if (/(?:^|__)(?:Read|Glob|Grep)$/i.test(String(toolName || ''))) {
      const requested = String(input.file_path || input.path || '');
      const roots = [
        env.GLADOS_SECURITY_REVIEW_REPOSITORY,
        env.GLADOS_SECURITY_REVIEW_ARTIFACT_ROOT,
      ].filter(Boolean).map(value => path.resolve(value));
      if (!requested || !path.isAbsolute(requested)
          || !roots.some(root => pathWithin(root, requested))) {
        return {
          allowed: false,
          reason: 'source-review reads and searches must use an absolute path inside the selected repository or current artifact_root',
        };
      }
    }
    if (env.GLADOS_SECURITY_REVIEW_GIT_HISTORY !== '1' && /(?:^|__)Bash$/i.test(String(toolName || ''))
        && /(?:^|[;&|()\s])git(?:\s|$)/i.test(String(input.command || ''))) {
      return { allowed: false, reason: 'this security-review target is a directory snapshot without Git metadata; use run.json and inventory artifacts' };
    }
    if (/^(?:Write|Edit|MultiEdit)$/i.test(String(toolName || ''))
        && /(?:controller[\\/]workflow-contract\.txt|discovery[\\/]deep[\\/](?:workers\.jsonl|worker-\d{3}[\\/]receipt\.json)|validation[\\/](?:runtime-model-observations|model-receipts)\.jsonl|(?:^|[\\/])(?:findings|observations|coverage|scan-manifest|completion-receipt)\.json)$/.test(String(input.file_path || input.path || ''))) {
      return { allowed: false, reason: 'security-review final ledgers and sealed outputs are controller-owned and cannot be edited by agents' };
    }
    if (/^(?:Write|Edit|MultiEdit)$/i.test(String(toolName || ''))) {
      const requested = String(input.file_path || input.path || '');
      const artifactRoot = path.resolve(env.GLADOS_SECURITY_REVIEW_ARTIFACT_ROOT || '');
      if (requested && artifactRoot) {
        const destination = path.resolve(requested);
        if (destination !== artifactRoot && !destination.startsWith(`${artifactRoot}${path.sep}`)) {
          return { allowed: false, reason: 'security-review artifact writes must stay below the assigned artifact_root' };
        }
      }
    }
    if (/(?:^|__)Bash$/i.test(String(toolName || ''))
        && /(?:workflow-contract\.txt|workers\.jsonl|discovery[\\/]deep[\\/]worker-\d{3}[\\/]receipt\.json|runtime-model-observations\.jsonl|model-receipts\.jsonl|findings\.json|observations\.json|coverage\.json|scan-manifest\.json|completion-receipt\.json)/.test(String(input.command || ''))
        && /(?:>|tee\b|cp\b|mv\b|rm\b|python\b|perl\b|ruby\b)/.test(String(input.command || ''))) {
      return { allowed: false, reason: 'security-review runtime ledgers are controller-owned projections and cannot be modified from Bash' };
    }
    if (/(?:^|__)Bash$/i.test(String(toolName || ''))
        && /(?:blackboard\.db|BLACKBOARD_DB)/.test(String(input.command || ''))
        && /(?:sqlite3|better-sqlite3|python|INSERT\b|UPDATE\b|DELETE\b|DROP\b|ALTER\b)/i.test(String(input.command || ''))) {
      return { allowed: false, interrupt: true, reason: 'direct mutation of the controller blackboard database is prohibited; use scoped blackboard tools' };
    }
    if (/(?:^|__)Bash$/i.test(String(toolName || ''))) {
      const command = String(input.command || '');
      const mutating = /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|install|mkdir|touch|truncate|tee|ln|chmod|chown|python\d*|perl|ruby|node)\b|(?:^|[^<])>{1,2}(?!>)/i.test(command);
      if (mutating) return { allowed: false, reason: 'security-review Bash is read-only; use Write or Edit for artifact_root output' };
    }
  }

  const mounted = mountedToolsForAgent(agentId, policy, { env });
  if (!mounted.some(tool => toolMatchesMount(toolName, tool))) {
    return { allowed: false, reason: `${toolName} is not mounted for ${agentId}` };
  }

  const desktopControlTool = /^mcp__glados-ops__desktop_/i.test(String(toolName || ''));
  const fullAccess = agentId === 'glados' && isFullAccessEnabled(env);
  if (desktopControlTool && !fullAccess) {
    return { allowed: false, reason: 'desktop control requires the operator to enable Full Access in Settings' };
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
    const contractReason = investigationDispatchContractViolation(target, input, env);
    if (contractReason) return { allowed: false, reason: contractReason };
  }

  if (fullAccess) {
    const secretReason = forbiddenSecretAccess(toolName, input);
    if (secretReason) return { allowed: false, interrupt: true, reason: secretReason };
    return { allowed: true, reason: 'GLaDOS Full Access is enabled by the operator' };
  }

  const browserContractReason = browserToolContractViolation(toolName, input, env);
  if (browserContractReason) return { allowed: false, reason: browserContractReason };

  const bashContractReason = bashToolContractViolation(toolName, input);
  if (bashContractReason) return { allowed: false, reason: bashContractReason };

  return evaluateToolUse({ agentId, toolName, input, turnTargets });
}

function investigationDispatchContractViolation(targetAgent, input = {}, env = process.env) {
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
  const hasSecurityReviewRole = /security_review_role\s*:/i.test(prompt);
  const roleLines = [...prompt.matchAll(/^security_review_role:\s*([a-z0-9-]+)\s*$/gim)];
  if (hasSecurityReviewRole && roleLines.length !== 1) {
    return 'security-review dispatch requires exactly one standalone security_review_role line';
  }
  const securityReviewRole = roleLines[0]?.[1]?.toLowerCase() || null;
  const artifactRoot = prompt.match(/^artifact_root:\s*(.+)\s*$/im)?.[1]?.trim();
  if (targetAgent === 'source-code' && artifactRoot && !securityReviewRole) {
    return 'security-review source-code dispatch requires exactly one standalone security_review_role line';
  }
  if (securityReviewRole === 'blind-discovery') {
    if (targetAgent !== 'source-code') return 'blind discovery must dispatch the source-code agent';
    const workerId = discoveryWorkerIdFromPrompt(prompt);
    const retryOf = prompt.match(/^retry_of:\s*(worker-\d+)\s*$/im)?.[1] || null;
    if (!artifactRoot || !workerId) return 'blind discovery dispatch requires exact artifact_root and worker_id fields';
    const investigationsRoot = path.resolve(env.GLADOS_INVESTIGATIONS_DIR || path.join(env.GLADOS_RUNTIME_DIR || GLADOS_RUNTIME_DIR, 'investigations'));
    const resolvedArtifactRoot = path.resolve(artifactRoot);
    if (!resolvedArtifactRoot.startsWith(`${investigationsRoot}${path.sep}`)) return 'blind discovery artifact_root must be inside the configured GLaDOS investigations directory';
    const checkpoint = discoveryDispatchCheckpoint(resolvedArtifactRoot, { nextWorkerId: workerId, retryOf });
    const capReason = checkpoint.invalid.find(reason => /deadline has elapsed|maximum of \d+ attempts/.test(reason));
    if (capReason) {
      try { markDeepScanCapped(resolvedArtifactRoot, capReason); } catch {}
    }
    if (!checkpoint.passed) return `blind discovery dispatch checkpoint failed: ${checkpoint.invalid.slice(0, 4).join('; ')}`;
  }
  const postDiscoveryRole = SECURITY_REVIEW_SPECIALIST_ROLES.has(securityReviewRole)
    || securityReviewRole === 'source-review-validator'
    || securityReviewRole === 'historical-regression';
  if (postDiscoveryRole) {
    if (securityReviewRole === 'source-review-validator' && targetAgent !== 'source-review-validator') return 'source-review-validator role must dispatch the source-review-validator agent';
    if (securityReviewRole !== 'source-review-validator' && targetAgent !== 'source-code') return `${securityReviewRole} must dispatch the source-code agent`;
      if (!artifactRoot) return 'security-review specialist dispatch requires an exact artifact_root field';
      const investigationsRoot = path.resolve(env.GLADOS_INVESTIGATIONS_DIR || path.join(env.GLADOS_RUNTIME_DIR || GLADOS_RUNTIME_DIR, 'investigations'));
      const resolvedArtifactRoot = path.resolve(artifactRoot);
      if (!resolvedArtifactRoot.startsWith(`${investigationsRoot}${path.sep}`)) return 'security-review specialist artifact_root must be inside the configured GLaDOS investigations directory';
      const saturation = ensureDiscoverySaturated(resolvedArtifactRoot);
      if (!saturation.passed) return `security-review specialist dispatch requires discovery saturation: ${saturation.invalid.slice(0, 4).join('; ')}`;
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

function canonicalSecurityReviewPath(value, env = process.env) {
  if (typeof value !== 'string') return value;
  const candidate = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;
  if (env.GLADOS_SECURITY_REVIEW !== '1') return candidate;
  const artifactRoot = env.GLADOS_SECURITY_REVIEW_ARTIFACT_ROOT;
  if (!artifactRoot || !path.isAbsolute(artifactRoot)) return candidate;
  if (!path.isAbsolute(candidate)) return candidate;
  const resolved = path.resolve(candidate);
  const repositoryRoot = env.GLADOS_SECURITY_REVIEW_REPOSITORY;
  if (pathWithin(artifactRoot, resolved)
      || repositoryRoot && path.isAbsolute(repositoryRoot) && pathWithin(repositoryRoot, resolved)) {
    return resolved;
  }
  const runtimeRoot = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  const investigationsRoot = path.resolve(env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeRoot, 'investigations'));
  if (resolved === runtimeRoot || resolved === investigationsRoot) return path.resolve(artifactRoot);

  // A model occasionally copies the long engagement directory with one
  // character or digit wrong. There is exactly one writable artifact root in
  // a source-review turn, so repair only paths that unmistakably target a
  // GLaDOS investigation's security-review subtree. This keeps the permission
  // boundary strict while removing identifier transcription from the model's
  // responsibilities.
  const marker = `${path.sep}security-review`;
  const markerIndex = resolved.lastIndexOf(marker);
  const investigationMarker = `${path.sep}.glados${path.sep}investigations${path.sep}`;
  if (markerIndex >= 0 && resolved.includes(investigationMarker)) {
    const suffix = resolved.slice(markerIndex + marker.length);
    const repaired = path.resolve(artifactRoot, `.${suffix}`);
    if (pathWithin(artifactRoot, repaired)) return repaired;
  }
  return resolved;
}

function canonicalizeSecurityReviewDispatchPrompt(prompt, env = process.env) {
  const text = String(prompt || '');
  const artifactRoot = env.GLADOS_SECURITY_REVIEW_ARTIFACT_ROOT;
  if (env.GLADOS_SECURITY_REVIEW !== '1' || !artifactRoot || !path.isAbsolute(artifactRoot)) return text;
  const roleLines = [...text.matchAll(/^security_review_role:\s*([a-z0-9-]+)\s*$/gim)];
  if (roleLines.length !== 1) return text;
  const role = roleLines[0][1].toLowerCase();
  const workerLines = [...text.matchAll(/^worker_id:\s*(worker-\d{3})\s*$/gim)];
  const retryLines = [...text.matchAll(/^retry_of:\s*(worker-\d{3})\s*$/gim)];
  if (role === 'blind-discovery' && workerLines.length !== 1) return text;

  const body = text.split(/\r?\n/).filter(line => !(
    /^security_review_role\s*:/i.test(line)
    || /^artifact_root\s*:/i.test(line)
    || /^engagement_id\s*:/i.test(line)
    || /^repository_path\s*:/i.test(line)
    || role === 'blind-discovery' && /^(?:worker_id|retry_of)\s*:/i.test(line)
  ));
  const header = [`security_review_role: ${role}`];
  if (role === 'blind-discovery') header.push(`worker_id: ${workerLines[0][1].toLowerCase()}`);
  header.push(`artifact_root: ${path.resolve(artifactRoot)}`);
  if (role === 'blind-discovery' && retryLines.length === 1) header.push(`retry_of: ${retryLines[0][1].toLowerCase()}`);
  if (env.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID) header.push(`engagement_id: ${env.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID}`);
  if (env.GLADOS_SECURITY_REVIEW_REPOSITORY) header.push(`repository_path: ${path.resolve(env.GLADOS_SECURITY_REVIEW_REPOSITORY)}`);
  return [...header, ...body].join('\n').trim();
}

function normalizeToolInput(toolName, input = {}, { agentId = null, env = process.env } = {}) {
  const name = String(toolName || '');
  const reportingAgent = agentId === 'report-writer' || agentId === 'report-validator';
  let normalized = input;
  if (/(?:^|__)(?:Read|Glob|Grep)$/i.test(name)) {
    for (const field of ['file_path', 'path']) {
      const value = normalized[field];
      if (typeof value !== 'string') continue;
      const canonical = canonicalSecurityReviewPath(value, env);
      if (canonical === value) continue;
      normalized = {
        ...normalized,
        [field]: canonical,
      };
    }
  }
  if (/(?:^|__)(?:Write|Edit)$/i.test(name) && typeof normalized.file_path === 'string') {
    const canonical = canonicalSecurityReviewPath(normalized.file_path, env);
    if (canonical !== normalized.file_path) normalized = { ...normalized, file_path: canonical };
  }
  if ((/^Read$/i.test(name) || /__Read$/i.test(name)) && (!input.pages || typeof input.pages === 'string' && !input.pages.trim())) {
    // The bundled Agent SDK may re-expand an omitted optional pages field to
    // an invalid empty string before execution. An explicit first-page value
    // works for ordinary text reads and is the safe default for PDFs.
    normalized = { ...normalized, pages: '1' };
  }
  if (isTaskDispatchTool(name) && (
    Object.prototype.hasOwnProperty.call(normalized, 'isolation')
    || Object.prototype.hasOwnProperty.call(normalized, 'model')
  )) {
    // GLaDOS runs the Agent SDK from its durable runtime workspace, which is
    // intentionally outside the source repository. Worktree/remote isolation
    // is therefore not a valid dispatch mode for its local named specialists.
    // The named AgentDefinition is also the sole authority for the specialist
    // model. A Task-level model alias takes precedence in the Agent SDK and
    // previously collapsed every configured role to the coordinator's
    // hard-coded "sonnet" dispatch value.
    normalized = { ...normalized };
    delete normalized.isolation;
    delete normalized.model;
  }
  if (agentId === 'glados' && isTaskDispatchTool(name)) {
    const field = Object.prototype.hasOwnProperty.call(normalized, 'prompt') ? 'prompt' : 'description';
    if (typeof normalized[field] === 'string') {
      const prompt = canonicalizeSecurityReviewDispatchPrompt(normalized[field], env);
      if (prompt !== normalized[field]) normalized = { ...normalized, [field]: prompt };
    }
  }
  if (env.GLADOS_SECURITY_REVIEW === '1'
      && /(?:^|__)blackboard_/i.test(name)
      && Object.prototype.hasOwnProperty.call(normalized, 'engagement_id')
      && env.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID
      && normalized.engagement_id !== env.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID) {
    normalized = { ...normalized, engagement_id: env.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID };
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
  if ((/^Read$/i.test(name) || /__Read$/i.test(name)) && (!Number.isFinite(Number(input.limit)) || Number(input.limit) > 300)) {
    normalized = { ...normalized, limit: 300 };
  }
  if ((/^Grep$/i.test(name) || /__Grep$/i.test(name))
      && env.GLADOS_SECURITY_REVIEW === '1'
      && (!Number.isFinite(Number(input.head_limit)) || Number(input.head_limit) > 20)) {
    // Long JSONL matches make the SDK spill results into its private
    // ~/.claude cache, which is deliberately outside source-review scope and
    // creates a guaranteed follow-on permission error. Keep results inline;
    // workers can use Grep offset pagination when they need another page.
    normalized = { ...normalized, head_limit: 20 };
  }
  if ((/^Read$/i.test(name) || /__Read$/i.test(name)) && typeof normalized.file_path === 'string') {
    try {
      const bytes = fs.statSync(normalized.file_path).size;
      const sizeAwareLimit = bytes > 1024 * 1024 ? 10 : bytes > 256 * 1024 ? 40 : bytes > 64 * 1024 ? 80 : null;
      if (sizeAwareLimit && Number(normalized.limit) > sizeAwareLimit) {
        normalized = { ...normalized, limit: sizeAwareLimit };
      }
    } catch {}
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
    const normalizedInput = normalizeToolInput(input.tool_name, input.tool_input, {
      agentId: callerAgentId,
      env: options.env || process.env,
    });
    const decision = decideToolUse({
      agentId: callerAgentId,
      toolName: input.tool_name,
      input: normalizedInput,
      policy,
      workspaceRoot: options.workspaceRoot,
      env: options.env || process.env,
      turnTargets: toolTargetsForAgent(callerAgentId, options),
    });
    if (decision.allowed && callerAgentId === 'glados' && isTaskDispatchTool(input.tool_name)) {
      const prompt = String(normalizedInput.prompt || normalizedInput.description || '');
      const workerId = discoveryWorkerIdFromPrompt(prompt);
      const retryOf = prompt.match(/^retry_of:\s*(worker-\d{3})\s*$/im)?.[1] || null;
      const artifactRoot = prompt.match(/^artifact_root:\s*(.+)\s*$/im)?.[1]?.trim();
      if (workerId && artifactRoot) {
        const engagementId = path.basename(path.dirname(path.resolve(artifactRoot)));
        const claim = claimDiscoveryWorker({
          dbPath: (options.env || process.env).BLACKBOARD_DB || BLACKBOARD_DB,
          artifactRoot, engagementId,
          workerId,
          toolCallId: input.tool_use_id,
          retryOf,
          requestedModel: registryById({ env: options.env || process.env }).get('source-code')?.model || null,
        });
        if (!claim.claimed) {
          if (/maximum of \d+ attempts/.test(claim.reason)) {
            try { markDeepScanCapped(artifactRoot, claim.reason); } catch {}
          }
          decision.allowed = false;
          decision.reason = claim.reason;
        }
      }
      if (decision.allowed && options.reviewReservations && input.tool_use_id) {
        if (!options.reviewReservations.has(input.tool_use_id)
            && options.reviewReservations.size >= options.reviewConcurrencyLimit) {
          decision.allowed = false;
          decision.reason = `security-review concurrency limit ${options.reviewConcurrencyLimit} reached; retry after the current foreground batch completes`;
          const prompt = String(normalizedInput.prompt || normalizedInput.description || '');
          const workerId = discoveryWorkerIdFromPrompt(prompt);
          const artifactRoot = prompt.match(/^artifact_root:\s*(.+)\s*$/im)?.[1]?.trim();
          if (workerId && artifactRoot) {
            try {
              const engagementId = path.basename(path.dirname(path.resolve(artifactRoot)));
              const db = new (require('better-sqlite3'))((options.env || process.env).BLACKBOARD_DB || BLACKBOARD_DB);
              db.prepare(`DELETE FROM security_review_worker_attempts WHERE engagement_id=? AND worker_id=? AND tool_call_id=? AND status='STARTED'`).run(engagementId, workerId, input.tool_use_id);
              db.prepare(`DELETE FROM security_review_worker_runs WHERE engagement_id=? AND worker_id=? AND tool_call_id=? AND status='STARTED'`).run(engagementId, workerId, input.tool_use_id);
              db.close();
            } catch {}
          }
        } else {
          options.reviewReservations.add(input.tool_use_id);
        }
      }
    }
    rememberToolTargets(callerAgentId, input.tool_name, normalizedInput, decision, options);
    const hookSpecificOutput = { hookEventName: 'PreToolUse' };
    if (!decision.allowed) {
      hookSpecificOutput.permissionDecision = 'deny';
      hookSpecificOutput.permissionDecisionReason = decision.reason;
    }
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

function buildReviewReleaseHook(eventName, reservations) {
  return async input => {
    if (input.tool_use_id) reservations?.delete(input.tool_use_id);
    return { hookSpecificOutput: { hookEventName: eventName } };
  };
}

function buildReviewBatchHook(reservations) {
  return async input => {
    for (const call of input.tool_calls || []) {
      if (isTaskDispatchTool(call?.tool_name) && call.tool_use_id) reservations?.delete(call.tool_use_id);
    }
    return { hookSpecificOutput: { hookEventName: 'PostToolBatch' } };
  };
}

function buildCanUseTool(agentId, policy = loadPolicy(), hookOptions = {}) {
  return async (toolName, input, requestOptions = {}) => {
    const callerAgentId = requestOptions.agentID
      ? hookOptions.agentTypesById?.get(requestOptions.agentID)
      : agentId;
    const normalizedInput = normalizeToolInput(toolName, input, {
      agentId: callerAgentId,
      env: hookOptions.env || process.env,
    });
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
  };
  if (env.GLADOS_SECURITY_REVIEW !== '1') {
    servers['glados-ops'] = {
      type: 'stdio',
      command: runtime.command,
      args: [path.join(REPO_ROOT, 'tools', 'glados-ops-mcp', 'index.js')],
      env: mcpEnv,
    };
  }
  if (browserMcpEnabled(env) && env.GLADOS_SECURITY_REVIEW !== '1') {
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

function securityReviewTemplateOverlay(agentId, templateRoot = TEMPLATE_AGENT_ROOT, env = process.env) {
  if (env.GLADOS_SECURITY_REVIEW !== '1' || !SECURITY_REVIEW_PROMPT_AGENTS.has(agentId)) return '';
  const names = agentId === 'glados' ? ['RUNBOOK.md'] : ['IDENTITY.md', 'RUNBOOK.md', 'TOOLS.md'];
  return names.map(name => {
    const file = path.join(templateRoot, agentId, name);
    try { return `## GLaDOS v4 security-review contract (${agentId}/${name})\n${fs.readFileSync(file, 'utf8')}`; }
    catch { return ''; }
  }).filter(Boolean).join('\n\n');
}

function assembleAgentPrompt(agentId, options = {}) {
  const resolved = resolveAgentRoot(agentId, options);
  const securityReviewContract = options.env?.GLADOS_SECURITY_REVIEW === '1'
    && SECURITY_REVIEW_PROMPT_AGENTS.has(agentId);
  const parts = [];
  const files = [];
  // Automated source reviews use a versioned, repository-owned contract. Do
  // not mix the persistent agent's startup checklist, user memory, or stale
  // workspace runbook into these isolated workers: those instructions both
  // inflate every dispatch and can trigger forbidden workspace reads before
  // the worker reaches its actual assignment.
  for (const name of securityReviewContract ? [] : PROMPT_FILE_ORDER) {
    const file = path.join(resolved.root, name);
    try {
      parts.push(fs.readFileSync(file, 'utf8'));
      files.push(name);
    } catch {}
  }
  const skills = securityReviewContract ? [] : listAgentSkills(resolved.root);
  if (skills.length) {
    parts.push(['# Skills', ...skills.map(skillSummary)].join('\n'));
  }
  const securityReviewOverlay = securityReviewTemplateOverlay(agentId, options.templateRoot, options.env);
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

function buildRuntimeContext(agentId, { model, registryRows = [], proxyUrl, workspaceRoot = agentWorkspaceRoot(), env = process.env } = {}) {
  const persistentWorkspace = path.join(workspaceRoot, agentId);
  const investigationsDir = path.join(GLADOS_RUNTIME_DIR, 'investigations');
  const securityReview = env.GLADOS_SECURITY_REVIEW === '1';
  const lines = [
    '# Runtime Context (authoritative)',
    `- Current agent id: ${agentId}`,
    `- Active model for this turn: ${model || DEFAULT_BARE_MODEL}`,
    `- Persistent writable workspace: ${persistentWorkspace}`,
    securityReview
      ? `- Security-review isolation: do not read or write agent-owned files in ${persistentWorkspace}; use only the selected repository, current artifact root, and blackboard tools.`
      : `- Read and update USER.md, MEMORY.md, memory/, skills/, and other agent-owned files in ${persistentWorkspace}. Never write operator state into repository templates or the packaged GLaDOS.app Resources directory.`,
    '- If the operator asks what model you are running, answer from the active model above.',
    '- Do not infer current model names from static roster tables, examples, MEMORY.md, or historical workspace files.',
    `- GLaDOS proxy URL for target HTTP(S): ${proxyUrl || proxyUrlFromEnv()}. For shell HTTP, use /usr/bin/curl -x this URL -k and add X-GLaDOS-Agent: ${agentId}. Do not use legacy :8080 proxy examples unless the operator explicitly overrides it.`,
  ];
  if (securityReview) {
    const repositoryPath = env.GLADOS_SECURITY_REVIEW_REPOSITORY || '(read repository_path from the task)';
    const artifactRoot = env.GLADOS_SECURITY_REVIEW_ARTIFACT_ROOT || '(read artifact_root from the task)';
    const reviewEngagementId = env.GLADOS_SECURITY_REVIEW_ENGAGEMENT_ID
      || (path.isAbsolute(artifactRoot) ? path.basename(path.dirname(artifactRoot)) : '(read engagement_id from the task)');
    const gitHistoryAvailable = env.GLADOS_SECURITY_REVIEW_GIT_HISTORY === '1';
    lines.push(`- Security-review engagement id: ${reviewEngagementId}. Use this exact value for every blackboard call that requires engagement_id; never send an empty engagement_id.`);
    lines.push(`- Security-review repository root: ${repositoryPath}. Use absolute paths; the SDK working directory is not the assessed repository.`);
    lines.push(`- Security-review artifact root: ${artifactRoot}. The source tree is read-only; write review output only below this artifact root or through blackboard tools.`);
    lines.push(`- Security-review source type: ${env.GLADOS_SECURITY_REVIEW_SOURCE_TYPE || 'unknown'}. Git history available: ${gitHistoryAvailable ? 'yes' : 'no'}. ${gitHistoryAvailable ? 'Use Git only when the assigned review step requires history.' : 'Do not run Git commands; consume run.json and inventory/secrets-history.json as authoritative.'}`);
    lines.push('- Prompt files and role contracts are already loaded. Do not reread SOUL.md, USER.md, IDENTITY.md, RUNBOOK.md, TOOLS.md, MEMORY.md, or memory/ as startup work. Blind review must not consult agent memory or prior-assessment context.');
    lines.push('- Every Read tool call must explicitly include pages: "1" unless reading a specific PDF page range. The bundled SDK rejects its empty pages default before permission-time repair on some subagent calls.');
    lines.push('- Derive available files and directories from inventory/files.jsonl. Do not guess conventional paths such as src/test or gradle/libs.versions.toml when absent.');
    lines.push('- Snapshot verification is harness-owned. Do not invent a find/shasum or per-file digest aggregate; use the canonical run.json revision and harness verification receipt.');
    lines.push('- Static analysis, worker continuation, specialist review, validation, and writes below artifact_root require no operator approval. Continue automatically until saturated and sealed or a real terminal blocker occurs.');
    lines.push('- Security-review report exception: never wait for wrap approval and never dispatch report-writer or report-validator for the built-in package. Return after the run and deep manifest are SATURATED and all terminal analysis artifacts are ready. The controller owns engagement completion, canonicalization, sealing, and automatic Markdown/HTML/per-finding generation; the desktop then generates the PDF. Approval remains required only for live actions, optional custom reports, or external publication.');
    lines.push('- The engagement is already provisioned by the controller. Never call blackboard_engagement_create for this review.');
    lines.push('- Full Access is ignored for this source-only review. Desktop, browser, local-auth, and Apple Events tools are unavailable.');
  }
  if (agentId === 'glados' && registryRows.length) {
    if (env.GLADOS_SECURITY_REVIEW === '1') {
      // The source-review capability boundary above is authoritative.
    } else if (isFullAccessEnabled(env)) {
      lines.push('- Full Access is ENABLED by the operator. You may use desktop_snapshot, desktop_list_windows, desktop_click, desktop_type, and desktop_key; read/edit requested files; and run shell commands without per-command prompts. macOS Accessibility and Screen Recording consent still apply.');
      lines.push('- Full Access changes tool permission handling, not operator intent. Perform destructive or external actions only when they are clearly requested in the current operator turn, and verify ambiguous targets before acting.');
    } else {
      lines.push('- Full Access is disabled. Desktop-control tools are unavailable; tell the operator to enable Full Access in Settings if the requested task requires them.');
    }
    const halted = listHaltedAgents({ sessionId: env.GLADOS_SESSION_ID || 'legacy' }).map(marker => marker.agentId).filter(Boolean);
    lines.push(`- Operator halt state: ${halted.length ? `halted agents are ${halted.join(', ')}` : 'no agents are halted'}. Treat this as authoritative and do not dispatch a halted agent.`);
    lines.push('- For normal investigations, perform target reachability preflight only with mcp__watchdog__target_probe. Never use Bash/curl or browser tools from GLaDOS for target interaction; delegate that work to a named specialist.');
    lines.push('- Subagent dispatch rule: use the SDK subagent dispatch tool only with subagent_type set to an exact enabled GLaDOS agent id, name set to that same id, and run_in_background=false. Omit model and isolation: each named AgentDefinition owns its configured model, and GLaDOS specialists run in the managed local runtime workspace rather than a git worktree or remote environment. Background dispatch is hard-denied. Never launch a generic unnamed Agent.');
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
    lines.push(securityReview
      ? '- Use the mounted Read, Glob, Grep, Write, Edit, and blackboard tools directly. Bash is intentionally unavailable in source-review isolation; do not search for or request it.'
      : '- Use your mounted tools directly, including Bash for shell work and MCP tools for browser/watchdog/blackboard/ops work when the task calls for them. If a tool permission is denied, report the exact denial.');
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
  const configuredAllowlist = Array.isArray(options.subagentAllowlist) ? new Set(options.subagentAllowlist) : null;
  const allowedAgents = new Set([...taskAllowlist(policy, { workspaceRoot })]
    .filter(agentId => !configuredAllowlist || configuredAllowlist.has(agentId)));
  const mcpServers = buildMcpServers(options.env || process.env);
  for (const row of registryRows) {
    if (!row?.id || row.id === 'glados' || !allowedAgents.has(row.id)) continue;
    const assembled = assembleAgentPrompt(row.id, options);
    const model = bareModelAlias(options.modelOverride || row.model, { fallback: policy.harness?.defaultModel || DEFAULT_BARE_MODEL });
    const tools = mountedToolsForAgent(row.id, policy, { env: options.env || process.env });
    out[row.id] = {
      description: row.description || row.name || row.id,
      prompt: appendRuntimeContext(assembled.prompt, row.id, {
        model,
        registryRows,
        proxyUrl,
        workspaceRoot,
        env: options.env || process.env,
      }),
      model,
      tools,
      disallowedTools: beltAndSuspendersDisallowed(tools, policy),
      mcpServers: Object.keys(mcpServers).filter(name => toolsMountMcpServer(tools, name)),
      permissionMode: 'default',
      background: false,
      maxTurns: policy.harness?.specialistMaxTurns ?? 100,
      criticalSystemReminder_EXPERIMENTAL: [
        `You are the GLaDOS subagent named ${row.id}.`,
        ...(options.env?.GLADOS_SECURITY_REVIEW === '1'
          ? ['This is an isolated security review. Prompt files are already loaded; do not read the persistent agent workspace, USER.md, MEMORY.md, memory/, IDENTITY.md, RUNBOOK.md, TOOLS.md, or AGENTS.md.']
          : []),
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
  const definitions = buildAgentDefinitions(policy, {
    workspaceRoot,
    templateRoot: options.templateRoot,
    env: options.env,
    modelOverride: options.modelOverride,
    subagentAllowlist: options.subagentAllowlist,
  });
  const tools = processToolsForAgent(agentId, policy, {
    workspaceRoot,
    templateRoot: options.templateRoot,
    env: options.env || process.env,
    subagentAllowlist: options.subagentAllowlist,
  });
  const registryRows = loadRegistry({ workspaceRoot, env: options.env });
  const registry = new Map(registryRows.map(row => [row.id, row]));
  const row = registry.get(agentId) || {};
  const assembled = assembleAgentPrompt(agentId, {
    workspaceRoot,
    templateRoot: options.templateRoot,
    env: options.env || process.env,
  });
  const model = bareModelAlias(options.model || row.model || policy.harness?.defaultModel, {
    fallback: policy.harness?.defaultModel || DEFAULT_BARE_MODEL,
  });
  const configuredReviewConcurrency = Number(options.reviewConcurrencyLimit || policy.harness?.securityReviewMaxExecutions || 3);
  const reviewConcurrencyLimit = Number.isInteger(configuredReviewConcurrency) && configuredReviewConcurrency > 0
    ? Math.min(8, configuredReviewConcurrency)
    : 3;
  const reviewReservations = options.reviewKey ? new Set() : null;
  const fullAccess = agentId === 'glados'
    && (options.env || process.env).GLADOS_SECURITY_REVIEW !== '1'
    && isFullAccessEnabled(options.env || process.env);
  const preToolUse = buildPreToolUseHook(agentId, policy, {
    workspaceRoot,
    env: options.env || process.env,
    agentTypesById,
    browserTargetsByAgent,
    turnTargets: options.turnTargets || [],
    reviewConcurrencyLimit,
    reviewReservations,
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
      env: options.env || process.env,
    }),
    gladosPromptFiles: assembled.files,
    gladosPromptSource: assembled.source,
    gladosPromptSkills: assembled.skills,
    settingSources: [],
    settings: { autoCompactEnabled: options.autoCompact !== false },
    includePartialMessages: true,
    forwardSubagentText: true,
    appendSubagentSystemPrompt: [
      'GLaDOS subagents are operator-visible assessment workers.',
      'They must use their configured AgentDefinition prompt, model, tools, and MCP servers.',
      'They must return the final task result to parent GLaDOS, not ask the operator to message an internal task id.',
    ].join(' '),
    // In default mode the SDK routes non-allowlisted calls to canUseTool.
    // GLaDOS answers that callback programmatically, so there is no operator
    // prompt, while updatedInput remains effective. dontAsk would auto-deny
    // before the callback; a PreToolUse allow would bypass input repair.
    permissionMode: fullAccess ? 'bypassPermissions' : 'default',
    allowDangerouslySkipPermissions: fullAccess,
    // Options.tools controls built-ins only. MCP tools are deferred and loaded
    // through ToolSearch, then caller-scoped by AgentDefinition.tools and the
    // authoritative PreToolUse hook.
    tools: tools.filter(tool => !tool.startsWith('mcp__')),
    gladosMountedTools: tools,
    // Keep ordinary calls off the SDK's static allowlist so canUseTool applies
    // caller-aware input repair after PreToolUse policy enforcement. Full
    // Access uses the SDK's bypass mode and retains its historical auto-allow
    // list.
    allowedTools: fullAccess ? autoApprovedToolsForAgent(tools) : [],
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
      ...(reviewReservations ? {
        PostToolUse: [{ matcher: 'Agent|Task', hooks: [buildReviewReleaseHook('PostToolUse', reviewReservations)] }],
        PostToolUseFailure: [{ matcher: 'Agent|Task', hooks: [buildReviewReleaseHook('PostToolUseFailure', reviewReservations)] }],
        PostToolBatch: [{ hooks: [buildReviewBatchHook(reviewReservations)] }],
      } : {}),
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
  const effort = normalizeEffort(options.effort, null);
  if (effort) sdkOptions.effort = effort;
  if (options.resumeSessionId) sdkOptions.resume = options.resumeSessionId;
  if (reviewReservations) sdkOptions.gladosReviewReservations = reviewReservations;
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

function compactSecurityReviewDispatchTranscriptInput(toolName, input = {}, env = process.env) {
  if (env.GLADOS_SECURITY_REVIEW !== '1' || !isTaskDispatchTool(toolName)) return input;
  const prompt = String(input.prompt || input.description || '');
  const compact = [
    prompt.match(/^security_review_role:\s*[^\r\n]+/im)?.[0],
    prompt.match(/^worker_id:\s*worker-\d{3}/im)?.[0],
    prompt.match(/^retry_of:\s*worker-\d{3}/im)?.[0],
    '[managed security-review assignment; immutable scope is runtime-bound]',
  ].filter(Boolean).join('\n');
  const field = Object.prototype.hasOwnProperty.call(input, 'prompt') ? 'prompt' : 'description';
  return { ...input, [field]: compact };
}

function compactSecurityReviewWorkerResult(text, { isError = false } = {}) {
  const value = String(text || '').trim();
  if (isError || /(?:^|\b)(?:error|failed|denied|blocked)(?:\b|:)/i.test(value)) {
    const firstLine = value.split(/\r?\n/).find(Boolean) || 'unknown worker failure';
    return `Internal security-review worker error: ${firstLine.slice(0, 500)}`;
  }
  return 'Internal security-review worker completed; durable artifacts and task state were retained.';
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
    requestId: message?.request_id || null,
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
        const effectiveInput = normalizeToolInput(block.name, block.input || {}, {
          agentId: renderAgentId,
          env: context.env || process.env,
        });
        const transcriptInput = redactCredentialInput(compactSecurityReviewDispatchTranscriptInput(
          block.name,
          effectiveInput,
          context.env || process.env
        ));
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
      let rawText = isTaskDispatchTool(toolName) ? sanitizeSubagentToolResult(contentText(block)) : contentText(block);
      if (targetAgentId && (context.env || process.env).GLADOS_SECURITY_REVIEW === '1') {
        rawText = compactSecurityReviewWorkerResult(rawText, { isError: !!block.is_error });
      }
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
    if (message.subtype === 'status') {
      return [{
        ...base,
        kind: 'context-status',
        text: message.status === 'compacting' ? 'Compacting conversation context…' : '',
        status: message.status || null,
        compactResult: message.compact_result || null,
        compactError: message.compact_error || null,
        id: message.uuid || undefined,
      }];
    }
    if (message.subtype === 'compact_boundary') {
      return [{
        ...base,
        kind: 'context-compacted',
        text: `Context compacted automatically (${Number(message.compact_metadata?.pre_tokens || 0).toLocaleString()} tokens before compaction).`,
        trigger: message.compact_metadata?.trigger || 'auto',
        preTokens: Number(message.compact_metadata?.pre_tokens || 0),
        postTokens: Number(message.compact_metadata?.post_tokens || 0) || null,
        durationMs: Number(message.compact_metadata?.duration_ms || 0) || null,
        id: message.uuid || undefined,
      }];
    }
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
      const reviewWorker = (context.env || process.env).GLADOS_SECURITY_REVIEW === '1' && mappedAgent !== agentId;
      if (!live && message.task_id) context.subagentByTaskId.delete(message.task_id);
      return [{
        ...base,
        agentId: mappedAgent,
        parentAgentId: mappedAgent === agentId ? null : agentId,
        kind: 'liveness',
        text: reviewWorker
          ? live
            ? message.description || 'Security-review worker running.'
            : `Security-review worker ${state || 'finished'}.`
          : message.summary || message.description || state,
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
        model: message.model || null,
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

function sdkPromptWithAttachments(prompt, attachments = []) {
  const rows = (Array.isArray(attachments) ? attachments : []).filter(row => row?.file && row?.mimeType);
  if (!rows.length) return prompt;
  const content = [{ type: 'text', text: String(prompt || '') }];
  for (const row of rows) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: row.mimeType,
        data: fs.readFileSync(row.file).toString('base64'),
      },
    });
  }
  return (async function* input() {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
  })();
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

function turnIdleTimeoutError(timeoutMs) {
  const error = new Error(`Agent SDK produced no messages for ${timeoutMs}ms during an active turn`);
  error.code = 'GLADOS_TURN_IDLE_TIMEOUT';
  error.timeoutMs = timeoutMs;
  return error;
}

function isTurnIdleTimeoutError(value) {
  return value?.code === 'GLADOS_TURN_IDLE_TIMEOUT';
}

async function nextWithFirstActivityDeadline(iterator, timeoutMs, onTimeout, reportedTimeoutMs = timeoutMs) {
  if (!(timeoutMs > 0)) return iterator.next();
  let timer;
  const pending = Promise.resolve().then(() => iterator.next());
  // The SDK promise may settle after the watchdog wins. Always attach a
  // rejection handler so that late teardown cannot become an unhandled error.
  pending.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(firstActivityTimeoutError(reportedTimeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextWithTurnIdleDeadline(iterator, timeoutMs, onTimeout) {
  if (!(timeoutMs > 0)) return iterator.next();
  let timer;
  const pending = Promise.resolve().then(() => iterator.next());
  pending.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(turnIdleTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function enhanceFirstActivityTimeoutError(error, options = {}) {
  if (!isFirstActivityTimeoutError(error) || options.firstActivityDiagnostic === false) return error;
  const fetchModels = options.modelCatalogFetcher || fetchLiteLlmModels;
  let catalog;
  try {
    catalog = await fetchModels({ env: options.env, timeoutMs: options.modelCatalogTimeoutMs || 5000 });
  } catch {
    catalog = { available: false, reason: 'diagnostic-error', message: 'LiteLLM diagnostics could not run.' };
  }

  const model = bareModelAlias(error.model || options.sdkOptions?.model || options.modelOverride, { fallback: null });
  let detail;
  if (!catalog?.available) {
    detail = catalog?.message || 'LiteLLM authentication and connectivity could not be verified.';
  } else if (model && !catalog.models?.includes(model)) {
    detail = `LiteLLM is reachable, but model ${model} is not available to this key.`;
  } else {
    detail = 'LiteLLM authentication, connectivity, and model discovery succeeded; the Agent SDK subprocess stalled before model or tool activity.';
  }
  error.message = `${error.message}. ${detail}`;
  error.liteLlmDiagnostic = {
    available: Boolean(catalog?.available),
    reason: catalog?.reason || null,
    status: catalog?.status || null,
    model: model || null,
    modelAvailable: catalog?.available && model ? catalog.models?.includes(model) : null,
  };
  return error;
}

function isMeaningfulTurnActivity(events) {
  return (events || []).some(event => [
    'thinking', 'thinking-stream', 'assistant-text', 'text-stream',
    'tool-call', 'tool-result', 'permission-denied', 'prompt-error', 'result',
  ].includes(event?.kind));
}

function suppressSecurityReviewWorkerTranscriptEvent(event, { agentId, env = process.env } = {}) {
  return env.GLADOS_SECURITY_REVIEW === '1'
    && Boolean(event?.parentAgentId)
    && event.parentAgentId === agentId
    && (event.kind === 'assistant-text' || event.kind === 'text-stream');
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
  const iterable = query({ prompt: sdkPromptWithAttachments(prompt, options.attachments), options: sdkOptions });
  const transcriptStore = store === false ? null : (store || new DashboardTranscriptStore(BLACKBOARD_DB));
  const events = [];
  const context = {
    subagentByParentToolUseId: new Map(),
    env: options.env || process.env,
  };
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
  const isHalted = options.isAgentHalted || (id => haltActive(id, options.env || process.env));
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
    let sdkMessagesSeen = 0;
    const turnIdleTimeoutMs = options.turnIdleTimeoutMs
      ?? ((options.env || process.env).GLADOS_SECURITY_REVIEW === '1' ? 180_000 : 600_000);
    while (true) {
      const remainingMs = firstActivitySeen || !firstActivityDeadline
        ? 0
        : Math.max(1, firstActivityDeadline - Date.now());
      const next = firstActivitySeen || !firstActivityDeadline
        ? await nextWithTurnIdleDeadline(iterator, turnIdleTimeoutMs, () => {
          interrupt('active turn idle timeout').catch(() => {});
        })
        : await nextWithFirstActivityDeadline(iterator, remainingMs, () => {
          interrupt('first model activity timeout').catch(() => {});
        }, firstActivityTimeoutMs);
      if (next.done) break;
      const message = next.value;
      sdkMessagesSeen += 1;
      if (sdkOptions.resume && isMissingSdkConversationError(message)) {
        const error = new Error(sdkErrorText(message));
        error.code = 'GLADOS_STALE_SDK_SESSION';
        throw error;
      }
      if (shouldPersistSdkSession(message) && typeof options.onSessionId === 'function') {
        options.onSessionId(message.session_id, message);
      }
      // Preserve terminal SDK usage/cost after interruption. Other late output
      // belongs to the cancelled turn and must not be shown.
      if (interrupted && message?.type !== 'result') break;
      if (interrupted && message?.type === 'result' && !message?.usage && !message?.modelUsage && !message?.model_usage && message?.total_cost_usd == null) break;
      if (options.abortSignal?.aborted) {
        await interrupt(options.abortSignal.reason || 'operator stop');
        if (message?.type !== 'result') break;
        if (!message?.usage && !message?.modelUsage && !message?.model_usage && message?.total_cost_usd == null) break;
      }
      const haltedAgent = haltedInTurn();
      if (!interrupted && haltedAgent && typeof iterable.interrupt === 'function') {
        await interrupt(`${haltedAgent} halted by operator`);
        break;
      }
      const mappedEvents = mapSdkMessageToEvents(agentId, message, context);
      if (typeof options.onSdkMessage === 'function') await options.onSdkMessage(message, context);
      if (!firstActivitySeen && isMeaningfulTurnActivity(mappedEvents)) firstActivitySeen = true;
      for (const ev of mappedEvents) {
        // A source-review worker's prose is machine-to-machine control output.
        // Tool/liveness events remain auditable, but forwarding its text (and
        // especially raw transient API errors) as chat makes an automatically
        // recovering review look terminal and duplicates the final report.
        if (suppressSecurityReviewWorkerTranscriptEvent(ev, {
          agentId,
          env: options.env || process.env,
        })) continue;
        // Streaming deltas are transient UI transport. Persisting every token
        // synchronously to SQLite delays the next SDK chunk and makes the
        // dashboard look stalled. The completed assistant event remains the
        // durable transcript record.
        const isStreamDelta = ev.kind === 'text-stream' || ev.kind === 'thinking-stream';
        const recorded = transcriptStore && !isStreamDelta
          ? transcriptStore.record(options.investigationSessionId || options.env?.GLADOS_SESSION_ID || 'legacy', ev.agentId || agentId, {
              ...ev,
              engagementId: options.engagementId || null,
              controllerJobId: options.controllerJobId || null,
            })
          : ev;
        events.push(recorded);
        if (onEvent) onEvent(recorded, message);
      }
    }
    if (!firstActivitySeen) {
      const error = new Error(`Agent SDK ended without meaningful model or tool activity (${sdkMessagesSeen} SDK messages)`);
      error.code = 'GLADOS_EMPTY_SDK_TURN';
      throw error;
    }
  } catch (error) {
    if (isFirstActivityTimeoutError(error) && !error.model) error.model = sdkOptions.model || null;
    throw error;
  } finally {
    sdkOptions.gladosReviewReservations?.clear();
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
      || isFirstActivityTimeoutError(error)
      || isTurnIdleTimeoutError(error);
    if (!resumeSessionId || !recoverableResumeFailure) {
      throw await enhanceFirstActivityTimeoutError(error, options);
    }
    if (typeof options.onInvalidSession === 'function') {
      await options.onInvalidSession(resumeSessionId, error);
    }
    const retryOptions = { ...options, resumeSessionId: null };
    if (options.sdkOptions) {
      retryOptions.sdkOptions = { ...options.sdkOptions };
      delete retryOptions.sdkOptions.resume;
    }
    try {
      return await streamAgentTurnOnce({ ...args, options: retryOptions });
    } catch (retryError) {
      throw await enhanceFirstActivityTimeoutError(retryError, retryOptions);
    }
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
  buildReviewReleaseHook,
  buildReviewBatchHook,
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
  enhanceFirstActivityTimeoutError,
  suppressSecurityReviewWorkerTranscriptEvent,
  streamAgentTurn,
  bareModelAlias,
};
