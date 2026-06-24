const path = require('node:path');

const SLASH_COMMANDS = [
  { cmd: '/help', desc: 'List dashboard slash commands' },
  { cmd: '/goal <target>', desc: 'Start an approval-gated webapp investigation goal' },
  { cmd: '/investigate <target>', desc: 'Alias for /goal <target>' },
  { cmd: '/security-review <url|domain|path>', desc: 'Start a security-review workflow; local paths queue source-code' },
  { cmd: '/status', desc: 'Show active goals, jobs, agents, plans, and target health' },
  { cmd: '/agents', desc: 'Show live subagents (curl /api/agents)' },
  { cmd: '/halt <agent>', desc: 'Halt a single agent (use /halt-all for engagement-wide halt)' },
  { cmd: '/halt-all', desc: 'Engagement-wide halt (Burp scope drop-all + deny-all)' },
  { cmd: '/resume <agent>', desc: 'Resume a halted agent' },
  { cmd: '/resume-all', desc: 'Resume all halted agents and restore Burp scope' },
  { cmd: '/probe <url>', desc: 'Run watchdog target_probe against a URL' },
  { cmd: '/rps', desc: 'Show Burp requests-per-second' },
  { cmd: '/breaker', desc: 'Alias for /rps' },
  { cmd: '/clear', desc: 'Clear the current transcript view (local only)' },
];

const ALLOWED = new Set(SLASH_COMMANDS.map(c => c.cmd.split(/\s+/)[0]));

function parseSlashCommand(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('/')) return { ok: false, error: 'slash command required' };
  const [cmd, ...rest] = text.split(/\s+/);
  if (!ALLOWED.has(cmd)) return { ok: false, cmd, arg: rest.join(' '), error: `unknown command: ${cmd}` };
  return { ok: true, cmd, arg: rest.join(' ').trim(), raw: text };
}

function helpText() {
  const groups = [
    ['Workflow', ['/goal <target>', '/investigate <target>', '/security-review <url|domain|path>', '/status']],
    ['Safety', ['/halt <agent>', '/halt-all', '/resume <agent>', '/resume-all']],
    ['Diagnostics', ['/agents', '/probe <url>', '/rps', '/help', '/clear']],
  ];
  const byCmd = new Map(SLASH_COMMANDS.map(c => [c.cmd, c.desc]));
  const lines = [];
  for (const [title, cmds] of groups) {
    lines.push(`${title}:`);
    for (const cmd of cmds) lines.push(`  ${cmd.padEnd(30)} ${byCmd.get(cmd) || ''}`);
  }
  lines.push('');
  lines.push('Dashboard /security-review is separate from Claude Code CLI skills.');
  return lines.join('\n');
}

function targetUsage(cmd = '/goal') {
  return `usage: ${cmd} <url-or-domain>`;
}

function isUrlOrDomain(value) {
  const text = String(value || '').trim();
  return /^https?:\/\/[^\s"'`<>]+$/i.test(text)
    || /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(?:\/[^\s"'`<>]*)?$/i.test(text);
}

function isExistingLocalPath(value, fs = require('node:fs')) {
  if (!value) return false;
  const resolved = path.resolve(String(value));
  try { return fs.existsSync(resolved); } catch { return false; }
}

function formatStatus(status) {
  const lines = [];
  const goals = status?.goals || [];
  const jobs = status?.jobs || [];
  const activeAgents = status?.activeAgents || [];
  const targets = status?.targetHealth || [];
  const failures = status?.recentFailures || [];
  const plans = status?.plans || {};
  lines.push(`Goals: ${goals.length ? goals.map(g => `${g.type}:${g.target} [${g.status}]`).join(', ') : 'none active'}`);
  lines.push(`Jobs: ${jobs.length ? jobs.map(j => `${j.agent_id}:${j.job_type} [${j.status}]`).join(', ') : 'none active'}`);
  lines.push(`Agents: ${activeAgents.length ? activeAgents.map(a => a.agentId || a.id).join(', ') : 'none active'}`);
  lines.push(`Pending pre-check approval: ${status?.pendingPrecheckApproval ? status.pendingPrecheckApproval.target : 'none'}`);
  lines.push(`Plans: pending=${plans.pending || 0}, approved=${plans.approved || 0}, executing=${plans.executing || 0}`);
  if (targets.length) {
    lines.push(`Targets: ${targets.slice(0, 5).map(t => `${t.target_url || t.target}: ${t.state || 'unknown'}`).join(', ')}`);
  }
  if (failures.length) {
    lines.push(`Recent failures: ${failures.map(f => `${f.agent_id}:${f.error || f.status}`).join('; ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  SLASH_COMMANDS,
  parseSlashCommand,
  helpText,
  targetUsage,
  isUrlOrDomain,
  isExistingLocalPath,
  formatStatus,
};
