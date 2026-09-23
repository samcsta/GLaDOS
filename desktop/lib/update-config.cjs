const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_UPDATER_CACHE_DIR = 'glados-updater';

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function renderUpdateConfig({ feedUrl, channel = 'latest', updaterCacheDirName = DEFAULT_UPDATER_CACHE_DIR }) {
  return [
    'provider: generic',
    `url: ${yamlScalar(feedUrl)}`,
    `channel: ${yamlScalar(channel)}`,
    `updaterCacheDirName: ${yamlScalar(updaterCacheDirName)}`,
    '',
  ].join('\n');
}

function writeUpdateConfigFile(configPath, options, { mode = 0o644, directoryMode = 0o755 } = {}) {
  const parent = path.dirname(configPath);
  fs.mkdirSync(parent, { recursive: true, mode: directoryMode });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, renderUpdateConfig(options), { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, configPath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return configPath;
}

function isRegularFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function ensureFallbackUpdateConfig({
  bundledConfigPath,
  userDataDir,
  feedUrl,
  channel = 'latest',
  updaterCacheDirName = DEFAULT_UPDATER_CACHE_DIR,
}) {
  if (isRegularFile(bundledConfigPath)) return null;
  return writeUpdateConfigFile(
    path.join(userDataDir, 'app-update.yml'),
    { feedUrl, channel, updaterCacheDirName },
    { mode: 0o600, directoryMode: 0o700 },
  );
}

module.exports = {
  DEFAULT_UPDATER_CACHE_DIR,
  ensureFallbackUpdateConfig,
  renderUpdateConfig,
  writeUpdateConfigFile,
};
