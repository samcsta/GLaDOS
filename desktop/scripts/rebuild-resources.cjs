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

function nativeModuleKey(dir, moduleName) {
  const pkgPath = path.join(dir, 'node_modules', moduleName, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return `${moduleName}@${pkg.version}`;
}

function runtimeFilesFor(moduleName, platform = process.platform) {
  if (moduleName === 'better-sqlite3') return ['build/Release/better_sqlite3.node'];
  if (moduleName === 'node-pty') {
    if (platform === 'win32') return [];
    return platform === 'darwin'
      ? ['build/Release/pty.node', 'build/Release/spawn-helper']
      : ['build/Release/pty.node'];
  }
  throw new Error(`unsupported native module: ${moduleName}`);
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
      : platform === 'win32'
        ? `claude-agent-sdk-win32-${arch}`
        : null;
  if (!expected) return;
  for (const entry of fs.readdirSync(anthropicDir)) {
    if (!/^claude-agent-sdk-(?:darwin|linux|win32)-/.test(entry)) continue;
    if (entry === expected) continue;
    fs.rmSync(path.join(anthropicDir, entry), { recursive: true, force: true });
  }
  const executable = platform === 'win32' ? 'claude.exe' : 'claude';
  if (!fs.existsSync(path.join(anthropicDir, expected, executable))) {
    throw new Error(`packaged resources are missing @anthropic-ai/${expected}/${executable}`);
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

function pruneNodePtyWindowsArchitectures(moduleDir, arch) {
  const expected = arch === 'arm64' ? 'arm64' : 'x64';
  const conptyRoot = path.join(moduleDir, 'third_party', 'conpty');
  if (!fs.existsSync(conptyRoot)) return;
  for (const version of fs.readdirSync(conptyRoot)) {
    const versionDir = path.join(conptyRoot, version);
    let entries = [];
    try { entries = fs.readdirSync(versionDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^win10-(x64|arm64)$/i);
      if (match && match[1].toLowerCase() !== expected) {
        fs.rmSync(path.join(versionDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function normalizeNativeModule(dir, moduleName, platform = process.platform, arch = process.arch) {
  const moduleDir = path.join(dir, 'node_modules', moduleName);
  if (moduleName === 'better-sqlite3') {
    retainRuntimeBuild(moduleDir, runtimeFilesFor(moduleName, platform));
    fs.rmSync(path.join(moduleDir, 'bin'), { recursive: true, force: true });
    return;
  }
  if (moduleName === 'node-pty') {
    // Windows builds need the complete @electron/rebuild output: conpty,
    // winpty helpers, DLLs, and their native modules. There is only one
    // packaged node-pty copy, so leave that output intact rather than applying
    // the small POSIX runtime reduction below.
    if (platform === 'win32') {
      fs.rmSync(path.join(moduleDir, 'prebuilds'), { recursive: true, force: true });
      fs.rmSync(path.join(moduleDir, 'node-addon-api'), { recursive: true, force: true });
      pruneNodePtyWindowsArchitectures(moduleDir, arch);
      return;
    }
    retainRuntimeBuild(moduleDir, runtimeFilesFor(moduleName, platform));
    // The rebuilt Release payload is authoritative. Keeping npm's platform
    // prebuild matrix would leave single-architecture and Windows binaries in
    // a universal macOS bundle and makes native-module auditing ambiguous.
    fs.rmSync(path.join(moduleDir, 'prebuilds'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDir, 'bin'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDir, 'node-addon-api'), { recursive: true, force: true });
  }
}

function captureRuntimePayload(dir, moduleName, platform = process.platform) {
  const moduleDir = path.join(dir, 'node_modules', moduleName);
  return runtimeFilesFor(moduleName, platform).map(relativeFile => {
    const source = path.join(moduleDir, relativeFile);
    if (!fs.existsSync(source)) throw new Error(`native rebuild did not produce ${source}`);
    return { name: path.basename(relativeFile), contents: fs.readFileSync(source), mode: fs.statSync(source).mode };
  });
}

function installRuntimePayload(dir, moduleName, payload, platform = process.platform) {
  const moduleDir = path.join(dir, 'node_modules', moduleName);
  const buildDir = path.join(moduleDir, 'build');
  fs.rmSync(buildDir, { recursive: true, force: true });
  const releaseDir = path.join(buildDir, 'Release');
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const file of payload) {
    const destination = path.join(releaseDir, file.name);
    fs.writeFileSync(destination, file.contents, { mode: file.mode });
    fs.chmodSync(destination, file.mode);
  }
  if (moduleName === 'better-sqlite3') fs.rmSync(path.join(moduleDir, 'bin'), { recursive: true, force: true });
  if (moduleName === 'node-pty') {
    fs.rmSync(path.join(moduleDir, 'prebuilds'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDir, 'bin'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDir, 'node-addon-api'), { recursive: true, force: true });
  }
  for (const relativeFile of runtimeFilesFor(moduleName, platform)) {
    if (!fs.existsSync(path.join(moduleDir, relativeFile))) {
      throw new Error(`cached native runtime did not produce ${path.join(moduleDir, relativeFile)}`);
    }
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
  const runtimeCache = new Map();
  for (const dir of candidates) {
    const onlyModules = nativeModulesFor(dir);
    if (!onlyModules.length) continue;
    const rebuildModules = onlyModules.filter(moduleName => !runtimeCache.has(nativeModuleKey(dir, moduleName)));
    if (rebuildModules.length) {
      console.log(`[rebuild-resources] ${path.relative(resources, dir)} (${arch}): ${rebuildModules.join(', ')}`);
      await rebuild({
        buildPath: dir,
        electronVersion: electronVersion(),
        arch,
        onlyModules: rebuildModules,
        force: true,
      });
    }
    for (const moduleName of onlyModules) {
      const key = nativeModuleKey(dir, moduleName);
      if (context.electronPlatformName === 'win32' && moduleName === 'node-pty') {
        normalizeNativeModule(dir, moduleName, context.electronPlatformName, arch);
        continue;
      }
      if (runtimeCache.has(key)) {
        console.log(`[rebuild-resources] reuse ${key} for ${path.relative(resources, dir)} (${arch})`);
        installRuntimePayload(dir, moduleName, runtimeCache.get(key), context.electronPlatformName);
      } else {
        normalizeNativeModule(dir, moduleName, context.electronPlatformName, arch);
        runtimeCache.set(key, captureRuntimePayload(dir, moduleName, context.electronPlatformName));
      }
    }
  }
  // A later @electron/rebuild candidate can revisit a dependency in its parent
  // tree and recreate architecture-stamped .forge-meta files. Normalize every
  // copied runtime once more after all rebuild work has settled.
  for (const dir of candidates) {
    for (const moduleName of nativeModulesFor(dir)) {
      normalizeNativeModule(dir, moduleName, context.electronPlatformName, arch);
    }
  }
};

exports.targetArch = targetArch;
exports.captureRuntimePayload = captureRuntimePayload;
exports.installRuntimePayload = installRuntimePayload;
exports.nativeModuleKey = nativeModuleKey;
exports.normalizeNativeModule = normalizeNativeModule;
exports.pruneArchitecturePackages = pruneArchitecturePackages;
exports.pruneNodePtyWindowsArchitectures = pruneNodePtyWindowsArchitectures;
