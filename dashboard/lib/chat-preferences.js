const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'high';

function preferencesFile(env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  return path.resolve(env.GLADOS_CHAT_PREFERENCES_FILE || path.join(runtimeDir, 'preferences', 'chat.json'));
}

function normalizeEffort(value, fallback = DEFAULT_EFFORT) {
  const effort = String(value || '').trim().toLowerCase();
  return EFFORT_LEVELS.includes(effort) ? effort : fallback;
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
  for (const [agentId, value] of Object.entries(stored?.efforts || {})) {
    if (!/^[a-z0-9._-]{1,80}$/i.test(agentId)) continue;
    efforts[agentId] = normalizeEffort(value);
  }
  return {
    version: 2,
    efforts,
    autoCompact: stored?.autoCompact !== false,
    operatorName: normalizeOperatorName(stored?.operatorName),
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : null,
    file,
  };
}

function effortForAgent(agentId, env = process.env) {
  return readChatPreferences(env).efforts[String(agentId || '')] || DEFAULT_EFFORT;
}

function writeChatPreferences(input = {}, env = process.env) {
  const prior = readChatPreferences(env);
  const next = {
    version: 2,
    efforts: { ...prior.efforts },
    autoCompact: input.autoCompact === undefined ? prior.autoCompact : input.autoCompact !== false,
    operatorName: input.operatorName === undefined ? prior.operatorName : normalizeOperatorName(input.operatorName),
    updatedAt: new Date().toISOString(),
  };
  if (input.agentId !== undefined || input.effort !== undefined) {
    const agentId = String(input.agentId || '').trim();
    if (!/^[a-z0-9._-]{1,80}$/i.test(agentId)) throw new Error('valid agentId required');
    next.efforts[agentId] = normalizeEffort(input.effort, null);
    if (!next.efforts[agentId]) throw new Error(`effort must be one of: ${EFFORT_LEVELS.join(', ')}`);
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
  effortForAgent,
  normalizeEffort,
  normalizeOperatorName,
  operatorInitials,
  preferencesFile,
  readChatPreferences,
  writeChatPreferences,
};
