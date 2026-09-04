const { validateFeedUrl, validateToken } = require('./private-update.cjs');

const DEFAULT_UPDATE_ORIGIN = 'https://updates.r3dt34m.net/glados';
const WINDOWS_SOURCE_URL = 'https://github.com/samcsta/GLaDOS';

function binaryUpdatesSupported(platform = process.platform, arch = process.arch) {
  return (platform === 'darwin' && arch === 'arm64') || (platform === 'linux' && arch === 'x64');
}

function platformFeedPath(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'macos/arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux/x64';
  throw new Error(`binary updater does not support ${platform}/${arch}; Windows releases are built from source`);
}

function resolveUpdateAccess({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const explicitFeed = String(env.GLADOS_UPDATE_FEED_URL || '').trim();
  const origin = validateFeedUrl(env.GLADOS_UPDATE_FEED_ORIGIN || DEFAULT_UPDATE_ORIGIN);
  const feedUrl = validateFeedUrl(explicitFeed || `${origin}/${platformFeedPath(platform, arch)}`);
  const tokenValue = String(env.GLADOS_UPDATE_BEARER_TOKEN || '').trim();
  const token = tokenValue ? validateToken(tokenValue) : null;
  return {
    feedUrl,
    source: explicitFeed || env.GLADOS_UPDATE_FEED_ORIGIN ? 'environment' : 'built-in',
    requestHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

module.exports = {
  DEFAULT_UPDATE_ORIGIN,
  WINDOWS_SOURCE_URL,
  binaryUpdatesSupported,
  platformFeedPath,
  resolveUpdateAccess,
};
