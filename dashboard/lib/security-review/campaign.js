const fs = require('node:fs');
const path = require('node:path');

const EXPEDITED_PROFILE_DEFAULTS = Object.freeze({
  minDiscoveryRuns: 3,
  stopAfterNoNew: 3,
  maxDiscoveryRuns: null,
});

function containsFile(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.DS_Store') continue;
      if (entry.isFile() || entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

function buildSecurityReviewCampaign(rootPath) {
  const root = fs.realpathSync(path.resolve(rootPath));
  if (!fs.statSync(root).isDirectory()) throw new Error('security-review campaign target must be a directory');
  const children = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && entry.isDirectory())
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    .filter(entry => containsFile(path.join(root, entry.name)));
  if (children.length < 2) {
    throw new Error('security-review campaign requires at least two non-empty direct child repository directories');
  }
  if (children.length > 50) {
    throw new Error('security-review campaign supports at most 50 direct child repository directories');
  }
  const repositories = children.map((entry, index) => ({
    repository_id: `repo-${String(index + 1).padStart(3, '0')}`,
    name: entry.name,
    relative_path: entry.name,
    absolute_path: path.join(root, entry.name),
    required_discovery_worker: `worker-${String(index + 1).padStart(3, '0')}`,
  }));
  return {
    schema_version: 1,
    root,
    generated_at: new Date().toISOString(),
    repository_count: repositories.length,
    repositories,
  };
}

function expeditedDeepScanConfig(repositoryCount = 0, overrides = {}) {
  const count = Number.isInteger(repositoryCount) && repositoryCount > 0 ? repositoryCount : 0;
  const minDiscoveryRuns = Math.max(EXPEDITED_PROFILE_DEFAULTS.minDiscoveryRuns, count);
  return {
    minDiscoveryRuns,
    stopAfterNoNew: EXPEDITED_PROFILE_DEFAULTS.stopAfterNoNew,
    maxDiscoveryRuns: EXPEDITED_PROFILE_DEFAULTS.maxDiscoveryRuns,
    ...overrides,
  };
}

module.exports = {
  EXPEDITED_PROFILE_DEFAULTS,
  buildSecurityReviewCampaign,
  expeditedDeepScanConfig,
};
