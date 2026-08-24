const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function canonicalPath(value) {
  if (!value) return null;
  try { return fs.realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
}

function canonicalRemote(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ssh = raw.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^#?]+)$/i);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/i, '').replace(/\/+$/, '')}`;
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')}`;
  } catch {
    return raw.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  }
}

function sanitizedFinding(row) {
  return {
    id: row.id || row.finding_id,
    ...(row.issue_key ? { issue_key: row.issue_key } : {}),
    title: row.title || row.summary || 'Untitled prior finding',
    severity: row.severity || 'unknown',
    cwe_ids: Array.isArray(row.cwe_ids) ? row.cwe_ids : [],
    locations: Array.isArray(row.locations) ? row.locations.map(location => ({
      path: location.path,
      start_line: location.start_line,
      end_line: location.end_line,
      role: location.role,
    })) : [],
    ...(row.description ? { description: row.description } : {}),
    ...(row.reachability ? { reachability: row.reachability } : {}),
    ...(row.minimum_attacker_access ? { minimum_attacker_access: row.minimum_attacker_access } : {}),
  };
}

function findPriorSecurityReview({ investigationsRoot, repositoryPath, remote = null, excludeEngagementId = null }) {
  const targetPath = canonicalPath(repositoryPath);
  const targetRemote = canonicalRemote(remote);
  let entries = [];
  try { entries = fs.readdirSync(investigationsRoot, { withFileTypes: true }); } catch { return null; }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const reviewRoot = path.join(investigationsRoot, entry.name, 'security-review');
    const receipt = readJson(path.join(reviewRoot, 'completion-receipt.json'));
    const run = readJson(path.join(reviewRoot, 'run.json'));
    const findingsDocument = readJson(path.join(reviewRoot, 'findings.json'));
    const engagementId = receipt?.engagement_id || entry.name;
    if (engagementId === excludeEngagementId || entry.name === excludeEngagementId) continue;
    if (receipt?.status !== 'SEALED' || receipt?.terminal_state !== 'SATURATED' || !run || !Array.isArray(findingsDocument?.findings)) continue;
    const pathMatch = targetPath && canonicalPath(run.repositoryPath) === targetPath;
    const remoteMatch = targetRemote && canonicalRemote(run.remote) === targetRemote;
    if (!pathMatch && !remoteMatch) continue;
    let completedAt = Date.parse(run.deepScan?.completedAt || receipt.generated_at || '');
    if (!Number.isFinite(completedAt)) {
      try { completedAt = fs.statSync(path.join(reviewRoot, 'completion-receipt.json')).mtimeMs; } catch { completedAt = 0; }
    }
    matches.push({ reviewRoot, receipt, run, findingsDocument, engagementId, completedAt, matchBasis: pathMatch ? 'canonical-repository-path' : 'canonical-remote-url' });
  }
  matches.sort((left, right) => right.completedAt - left.completedAt || right.engagementId.localeCompare(left.engagementId));
  const prior = matches[0];
  if (!prior) return null;
  return {
    schema_version: 1,
    status: 'AVAILABLE',
    prior_engagement_id: prior.engagementId,
    match_basis: prior.matchBasis,
    repository_head: prior.run.head || prior.receipt.repository_head || null,
    findings: prior.findingsDocument.findings.map(sanitizedFinding).filter(row => row.id),
  };
}

function writePriorContext(artifactRoot, context) {
  const file = path.join(artifactRoot, 'regression', 'prior-context.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  return file;
}

module.exports = { canonicalRemote, findPriorSecurityReview, writePriorContext };
