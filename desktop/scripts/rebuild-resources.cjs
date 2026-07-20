const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rebuild } = require('@electron/rebuild');

const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

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

function targetArch(context) {
  if (typeof context.arch === 'string') return context.arch;
  return ARCH_NAMES[context.arch] || process.arch;
}

function pruneArchitecturePackages(resources, platform, arch) {
  const anthropicDir = path.join(resources, 'dashboard', 'node_modules', '@anthropic-ai');
  if (!fs.existsSync(anthropicDir)) return;
  const expected = platform === 'darwin'
    ? `claude-agent-sdk-darwin-${arch}`
    : platform === 'linux'
      ? `claude-agent-sdk-linux-${arch}`
      : null;
  if (!expected) return;
  for (const entry of fs.readdirSync(anthropicDir)) {
    if (!/^claude-agent-sdk-(?:darwin|linux|win32)-/.test(entry)) continue;
    if (entry === expected) continue;
    fs.rmSync(path.join(anthropicDir, entry), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(anthropicDir, expected, 'claude'))) {
    throw new Error(`packaged resources are missing @anthropic-ai/${expected}/claude`);
  }
}

function retainRuntimeBuild(moduleDir, relativeFiles) {
  const buildDir = path.join(moduleDir, 'build');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-native-runtime-'));
  try {
    for (const relativeFile of relativeFiles) {
      const source = path.join(moduleDir, relativeFile);
      if (!fs.existsSync(source)) {
        throw new Error(`native rebuild did not produce ${source}`);
      }
      const destination = path.join(staging, path.basename(relativeFile));
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, fs.statSync(source).mode);
    }
    fs.rmSync(buildDir, { recursive: true, force: true });
    const releaseDir = path.join(buildDir, 'Release');
    fs.mkdirSync(releaseDir, { recursive: true });
    for (const name of fs.readdirSync(staging)) {
      const source = path.join(staging, name);
      const destination = path.join(releaseDir, name);
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, fs.statSync(source).mode);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function normalizeNativeModule(dir, moduleName, platform = process.platform) {
  const moduleDir = path.join(dir, 'node_modules', moduleName);
  if (moduleName === 'better-sqlite3') {
    retainRuntimeBuild(moduleDir, ['build/Release/better_sqlite3.node']);
    fs.rmSync(path.join(moduleDir, 'bin'), { recursive: true, force: true });
    return;
  }
  if (moduleName === 'node-pty') {
    const runtimeFiles = ['build/Release/pty.node'];
    // node-pty only defines and builds spawn-helper on macOS. Its Unix wrapper
    // passes the path on Linux too, but the Linux native binding does not use it.
    if (platform === 'darwin') runtimeFiles.push('build/Release/spawn-helper');
    retainRuntimeBuild(moduleDir, runtimeFiles);
    // The rebuilt Release payload is authoritative. Keeping npm's platform
    // prebuild matrix would leave single-architecture and Windows binaries in
    // a universal macOS bundle and makes native-module auditing ambiguous.
    fs.rmSync(path.join(moduleDir, 'prebuilds'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDir, 'bin'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDir, 'node-addon-api'), { recursive: true, force: true });
  }
}

exports.default = async function rebuildCopiedResources(context) {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/python3')) {
    process.env.PYTHON = process.env.PYTHON || '/usr/bin/python3';
    process.env.npm_config_python = process.env.npm_config_python || '/usr/bin/python3';
  }
  const resources = appResourcesDir(context);
  const arch = targetArch(context);
  pruneArchitecturePackages(resources, context.electronPlatformName, arch);
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
    console.log(`[rebuild-resources] ${path.relative(resources, dir)} (${arch}): ${onlyModules.join(', ')}`);
    await rebuild({
      buildPath: dir,
      electronVersion: electronVersion(),
      arch,
      onlyModules,
      force: true,
    });
    for (const moduleName of onlyModules) {
      normalizeNativeModule(dir, moduleName, context.electronPlatformName);
    }
  }
  // A later @electron/rebuild candidate can revisit a dependency in its parent
  // tree and recreate architecture-stamped .forge-meta files. Normalize every
  // copied runtime once more after all rebuild work has settled.
  for (const dir of candidates) {
    for (const moduleName of nativeModulesFor(dir)) {
      normalizeNativeModule(dir, moduleName, context.electronPlatformName);
    }
  }
};

exports.targetArch = targetArch;
exports.normalizeNativeModule = normalizeNativeModule;
exports.pruneArchitecturePackages = pruneArchitecturePackages;
