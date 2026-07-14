const fs = require('node:fs');
const path = require('node:path');
const { rebuild } = require('@electron/rebuild');

function electronVersion() {
  const pkg = require('../package.json');
  return String(pkg.devDependencies?.electron || '').replace(/^[^\d]*/, '');
}

function appResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    return path.join(context.appOutDir, appName, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function nativeModulesFor(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  return ['better-sqlite3', 'node-pty'].filter(name => deps[name]);
}

exports.default = async function rebuildCopiedResources(context) {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/python3')) {
    process.env.PYTHON = process.env.PYTHON || '/usr/bin/python3';
    process.env.npm_config_python = process.env.npm_config_python || '/usr/bin/python3';
  }
  const resources = appResourcesDir(context);
  const candidates = [
    path.join(resources, 'dashboard'),
    path.join(resources, 'blackboard', 'blackboard-mcp'),
    path.join(resources, 'watchdog'),
    path.join(resources, 'watchdog', 'watchdog-mcp'),
    path.join(resources, 'tools', 'glados-ops-mcp'),
  ];
  for (const dir of candidates) {
    const onlyModules = nativeModulesFor(dir);
    if (!onlyModules.length) continue;
    console.log(`[rebuild-resources] ${path.relative(resources, dir)}: ${onlyModules.join(', ')}`);
    await rebuild({
      buildPath: dir,
      electronVersion: electronVersion(),
      arch: process.arch,
      onlyModules,
      force: true,
    });
  }
};
