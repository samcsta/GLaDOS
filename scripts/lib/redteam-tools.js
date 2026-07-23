#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'config', 'redteam-tools.json');

function loadManifest() {
  const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(parsed.tools)) throw new Error('red-team tool manifest has no tools array');
  return parsed;
}

function which(command, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function resolveTool(tool, env = process.env) {
  for (const command of tool.commands || []) {
    const found = which(command, env);
    if (found) return found;
  }
  for (const candidate of tool.candidates || []) {
    const absolute = path.resolve(ROOT, candidate);
    try { fs.accessSync(absolute, fs.constants.X_OK); return absolute; } catch {}
  }
  return null;
}

function toolStatus({ tier = 'all', agent = null, env = process.env } = {}) {
  const manifest = loadManifest();
  const tools = manifest.tools.filter(tool => {
    if (tier !== 'all' && tool.tier !== tier) return false;
    return !agent || tool.agents?.includes('all') || tool.agents?.includes(agent);
  }).map(tool => ({ ...tool, path: resolveTool(tool, env) }));
  return {
    version: manifest.version,
    manifest: MANIFEST,
    tools,
    available: tools.filter(tool => tool.path).length,
    missing: tools.filter(tool => !tool.path).map(tool => tool.id),
    missingRequired: tools.filter(tool => tool.required && !tool.path).map(tool => tool.id),
  };
}

function run(command, args, { dryRun = false } = {}) {
  process.stdout.write(`$ ${[command, ...args].join(' ')}\n`);
  if (dryRun) return;
  const result = cp.spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function install({ tier = 'core', dryRun = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('automatic tool provisioning currently supports macOS only');
  const missing = toolStatus({ tier }).tools.filter(tool => !tool.path && tool.mac?.manager && tool.mac.manager !== 'system');
  const brew = [...new Set(missing.flatMap(tool => [
    ...(tool.mac.manager === 'brew' ? [tool.mac.package] : []),
    ...(tool.mac.brew_dependencies || []),
  ]).filter(Boolean))];
  const pipx = [...new Set(missing.filter(tool => tool.mac.manager === 'pipx').map(tool => tool.mac.package))];
  if (brew.length) run('brew', ['install', ...brew], { dryRun });
  if (pipx.length) {
    if (!which('pipx') && !dryRun) run('brew', ['install', 'pipx']);
    for (const pkg of pipx) run('pipx', ['install', pkg], { dryRun });
  }
  return toolStatus({ tier });
}

function main() {
  const command = process.argv[2] || 'check';
  const tier = process.argv.includes('--all') ? 'all' : (process.argv.includes('--specialist') ? 'specialist' : 'core');
  const agentAt = process.argv.indexOf('--agent');
  const agent = agentAt >= 0 ? process.argv[agentAt + 1] : null;
  const result = command === 'install'
    ? install({ tier, dryRun: process.argv.includes('--dry-run') })
    : toolStatus({ tier, agent });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'check' && result.missingRequired.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { MANIFEST, loadManifest, resolveTool, toolStatus, install };
