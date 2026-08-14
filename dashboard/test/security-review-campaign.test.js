const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSecurityReviewCampaign,
  expeditedDeepScanConfig,
} = require('../lib/security-review/campaign');

function campaignFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-security-campaign-'));
  for (const name of ['z-service', 'a-service']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'main.js'), `module.exports = '${name}';\n`);
  }
  fs.mkdirSync(path.join(root, 'empty'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'ignored.js'), 'ignored\n');
  return root;
}

test('campaign manifest deterministically maps one breadth worker to each repository', () => {
  const campaign = buildSecurityReviewCampaign(campaignFixture());
  assert.equal(campaign.repository_count, 2);
  assert.deepEqual(campaign.repositories.map(repo => repo.name), ['a-service', 'z-service']);
  assert.deepEqual(campaign.repositories.map(repo => repo.repository_id), ['repo-001', 'repo-002']);
  assert.deepEqual(campaign.repositories.map(repo => repo.required_discovery_worker), ['worker-001', 'worker-002']);
});

test('expedited campaign reserves breadth passes before bounded hotspot discovery', () => {
  assert.deepEqual(expeditedDeepScanConfig(10), {
    minDiscoveryRuns: 10,
    stopAfterNoNew: 3,
    maxDiscoveryRuns: null,
  });
  assert.deepEqual(expeditedDeepScanConfig(20, { discoveryConcurrency: 3 }), {
    minDiscoveryRuns: 20,
    stopAfterNoNew: 3,
    maxDiscoveryRuns: null,
    discoveryConcurrency: 3,
  });
});

test('campaign rejects a parent without multiple non-empty repositories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-security-campaign-invalid-'));
  fs.mkdirSync(path.join(root, 'only-repo'));
  fs.writeFileSync(path.join(root, 'only-repo', 'main.js'), 'ok\n');
  assert.throws(() => buildSecurityReviewCampaign(root), /at least two/);
});
