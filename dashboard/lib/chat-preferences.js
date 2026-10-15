const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const PACKAGE_EFFORT_LEVELS = Object.freeze(['none', 'minimal', ...EFFORT_LEVELS]);
const DEFAULT_EFFORT = 'high';

function preferencesFile(env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  return path.resolve(env.GLADOS_CHAT_PREFERENCES_FILE || path.join(runtimeDir, 'preferences', 'chat.json'));
}

function normalizeEffort(value, fallback = DEFAULT_EFFORT) {
  const effort = String(value || '').trim().toLowerCase();
  return EFFORT_LEVELS.includes(effort) ? effort : fallback;
}

function isPackageAgentId(value) {
  return /^pkg-[a-z][a-z0-9-]{0,63}--[a-z][a-z0-9-]{0,63}$/.test(value);
}

function validAgentId(value) { return /^[a-z0-9._-]{1,80}$/i.test(value) || isPackageAgentId(value); }

function normalizeAgentEffort(agentId, value, fallback = DEFAULT_EFFORT) {
  const levels = isPackageAgentId(agentId) ? PACKAGE_EFFORT_LEVELS : EFFORT_LEVELS;
  const effort = String(value || '').trim().toLowerCase();
  return levels.includes(effort) ? effort : fallback;
}

function normalizeOperatorName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function operatorInitials(value) {
  const words = normalizeOperatorName(value).split(' ').filter(Boolean);
  if (!words.length) return 'You';
  const first = words[0][0] || '';
  const last = words.length > 1 ? words.at(-1)[0] || '' : words[0][1] || '';
  return `${first}${last}`.toUpperCase().slice(0, 2) || 'You';
}

function readChatPreferences(env = process.env) {
  const file = preferencesFile(env);
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const efforts = {};
  const effortRevisions = {};
  for (const [agentId, value] of Object.entries(stored?.efforts || {})) {
    if (!validAgentId(agentId)) continue;
    efforts[agentId] = normalizeAgentEffort(agentId, value);
  }
  for (const [agentId, revision] of Object.entries(stored?.effortRevisions || {})) {
    if (isPackageAgentId(agentId) && typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision)) effortRevisions[agentId] = revision;
  }
  return {
    version: 2,
    efforts,
    effortRevisions,
    autoCompact: stored?.autoCompact !== false,
    operatorName: normalizeOperatorName(stored?.operatorName),
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : null,
    file,
  };
}

function effortForAgent(agentId, env = process.env, fallback = DEFAULT_EFFORT, packageRevision = null) {
  const preferences = readChatPreferences(env);
  if (packageRevision && preferences.effortRevisions[agentId] !== packageRevision) return normalizeAgentEffort(agentId, fallback);
  return preferences.efforts[String(agentId || '')] || normalizeAgentEffort(agentId, fallback);
}

function writeChatPreferences(input = {}, env = process.env) {
  const prior = readChatPreferences(env);
  const next = {
    version: 2,
    efforts: { ...prior.efforts },
    effortRevisions: { ...prior.effortRevisions },
    autoCompact: input.autoCompact === undefined ? prior.autoCompact : input.autoCompact !== false,
    operatorName: input.operatorName === undefined ? prior.operatorName : normalizeOperatorName(input.operatorName),
    updatedAt: new Date().toISOString(),
  };
  if (input.agentId !== undefined || input.effort !== undefined) {
    const agentId = String(input.agentId || '').trim();
    if (!validAgentId(agentId)) throw new Error('valid agentId required');
    next.efforts[agentId] = normalizeAgentEffort(agentId, input.effort, null);
    if (!next.efforts[agentId]) throw new Error(`effort must be one of: ${(isPackageAgentId(agentId) ? PACKAGE_EFFORT_LEVELS : EFFORT_LEVELS).join(', ')}`);
    if (input.packageRevision !== undefined) {
      if (!isPackageAgentId(agentId) || !/^[a-f0-9]{64}$/.test(input.packageRevision)) throw new Error('valid package revision required');
      next.effortRevisions[agentId] = input.packageRevision;
    }
  }
  const file = preferencesFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return readChatPreferences(env);
}

module.exports = {
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  PACKAGE_EFFORT_LEVELS,
  effortForAgent,
  normalizeEffort,
  normalizeOperatorName,
  operatorInitials,
  preferencesFile,
  readChatPreferences,
  writeChatPreferences,
};
