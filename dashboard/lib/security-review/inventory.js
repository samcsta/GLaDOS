const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(repositoryPath, args, fallback = '') {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

function isGitWorkTree(repositoryPath) {
  try {
    return execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() === 'true';
  } catch { return false; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeJsonLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function repositoryFiles(repositoryPath) {
  const tracked = git(repositoryPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (!tracked) return [];
  return tracked.split('\0').filter(Boolean).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function classify(relative) {
  const ext = path.extname(relative).toLowerCase();
  if (/^(?:manifests?|deploy|k8s|helm|terraform|infra)\//i.test(relative) || ['.tf', '.tfvars'].includes(ext)) return 'iac';
  if (/^(?:\.github|\.gitlab|ci|pipelines?)\//i.test(relative) || /(?:tekton|pipeline|workflow)/i.test(relative)) return 'cicd';
  if (['.yaml', '.yml', '.json', '.toml', '.ini', '.conf'].includes(ext)) return 'configuration';
  if (['.go', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.rb', '.rs', '.cs', '.php', '.kt', '.swift'].includes(ext)) return 'source';
  if (['.sh', '.bash', '.zsh', '.ps1'].includes(ext)) return 'script';
  return 'other';
}

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function lineMatches(repositoryPath, files, patterns, category) {
  const rows = [];
  for (const relative of files) {
    const file = path.join(repositoryPath, relative);
    let buffer;
    try { buffer = fs.readFileSync(file); } catch { continue; }
    if (isBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (!pattern.regex.test(line)) continue;
        rows.push({ key: `${relative}:${index + 1}:${pattern.id}`, category, rule: pattern.id, file: relative, line: index + 1 });
      }
    });
  }
  return rows;
}

function routeCandidates(repositoryPath, files) {
  const patterns = [
    { id: 'go-router', regex: /\b(?:HandleFunc|Handle|Methods|GET|POST|PUT|PATCH|DELETE|Register)\s*\(/ },
    { id: 'express-router', regex: /\b(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(/i },
    { id: 'python-route', regex: /@(?:app|router)\.(?:get|post|put|patch|delete|route)\s*\(/i },
    { id: 'java-route', regex: /@(?:Request|Get|Post|Put|Patch|Delete)Mapping\b/ },
    { id: 'graphql', regex: /\b(?:Query|Mutation|Resolver|FieldFunc)\b/ },
  ];
  return lineMatches(repositoryPath, files, patterns, 'route-candidate');
}

function scanReceipt(repositoryPath, files, history = false) {
  const rules = [
    { id: 'private-key', regex: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
    { id: 'bearer-or-sas', regex: /(?:Authorization:\s*Bearer|SharedAccessSignature|[?&]sig=)/i },
    { id: 'secret-assignment', regex: /(?:password|passwd|client_secret|api[_-]?key|token)\s*[:=]\s*[^\s"']{8,}/i },
    { id: 'kubernetes-secret-data', regex: /^\s*(?:stringData|data):\s*$/ },
  ];
  if (!history) {
    return {
      mode: 'HEAD',
      completed: true,
      head: git(repositoryPath, ['rev-parse', 'HEAD'], null),
      findings: lineMatches(repositoryPath, files, rules, 'potential-secret').map(row => ({ ...row, valueRedacted: true })),
    };
  }
  const commits = new Map();
  for (const rule of rules) {
    const output = git(repositoryPath, ['log', '--all', `-G${rule.regex.source}`, '--format=COMMIT:%H', '--name-only'], '');
    let commit = null;
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith('COMMIT:')) { commit = line.slice(7); continue; }
      if (!commit || !line.trim()) continue;
      const key = `${commit}:${line}:${rule.id}`;
      commits.set(key, { commit, file: line, rule: rule.id, valueRedacted: true });
    }
  }
  return { mode: 'history', completed: true, head: git(repositoryPath, ['rev-parse', 'HEAD'], null), findings: [...commits.values()] };
}

function generateSecurityReviewInventory({ repositoryPath, artifactRoot }) {
  const root = fs.realpathSync(repositoryPath);
  if (!fs.statSync(root).isDirectory()) throw new Error('security review target must be a directory');
  if (!isGitWorkTree(root)) throw new Error('security review target must be a Git work tree');
  const files = repositoryFiles(root);
  const fileRows = files.map(relative => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    let binary = false;
    try { binary = isBinary(fs.readFileSync(file)); } catch {}
    return {
      key: relative,
      path: relative,
      category: classify(relative),
      size: stat.size,
      sha256: stat.isFile() ? sha256(file) : null,
      binary,
      symlink: stat.isSymbolicLink(),
      disposition: 'unreviewed',
    };
  });
  const suppressionPatterns = [
    { id: 'nolint-gosec', regex: /\/\/\s*nolint(?::[^\n]*gosec|\b)/i },
    { id: 'nosec', regex: /#\s*nosec\b|\/\/\s*nosec\b/i },
    { id: 'semgrep-ignore', regex: /nosemgrep|semgrep-ignore/i },
  ];
  const httpPatterns = [
    { id: 'go-http-client', regex: /\bhttp\.Client\s*\{|\bresty\.New\s*\(|retryablehttp/i },
    { id: 'generic-http-client', regex: /\b(?:axios\.create|requests\.Session|HttpClient\s*\()/ },
  ];
  const cryptoPatterns = [
    { id: 'weak-hash', regex: /\b(?:md5|sha1|des|rc4)\b/i },
    { id: 'crypto-operation', regex: /\b(?:Encrypt|Decrypt|Sign|Verify|NewCipher|createHash|MessageDigest)\b/ },
  ];
  const run = {
    workflowVersion: 2,
    repositoryPath: root,
    remote: git(root, ['config', '--get', 'remote.origin.url'], null),
    branch: git(root, ['branch', '--show-current'], null),
    head: git(root, ['rev-parse', 'HEAD']),
    dirty: !!git(root, ['status', '--porcelain']),
    generatedAt: new Date().toISOString(),
    fileCount: fileRows.length,
  };
  writeJson(path.join(artifactRoot, 'run.json'), run);
  writeJson(path.join(artifactRoot, 'intake', 'scope.json'), { repository: run, scope: ['application', 'iac', 'cicd', 'history'], exclusions: [] });
  writeJsonLines(path.join(artifactRoot, 'inventory', 'files.jsonl'), fileRows);
  writeJsonLines(path.join(artifactRoot, 'inventory', 'routes.jsonl'), routeCandidates(root, files));
  writeJsonLines(path.join(artifactRoot, 'inventory', 'suppressions.jsonl'), lineMatches(root, files, suppressionPatterns, 'suppression'));
  writeJsonLines(path.join(artifactRoot, 'inventory', 'http-clients.jsonl'), lineMatches(root, files, httpPatterns, 'http-client'));
  writeJsonLines(path.join(artifactRoot, 'inventory', 'crypto-operations.jsonl'), lineMatches(root, files, cryptoPatterns, 'crypto'));
  writeJson(path.join(artifactRoot, 'inventory', 'secrets-head.json'), scanReceipt(root, files, false));
  writeJson(path.join(artifactRoot, 'inventory', 'secrets-history.json'), scanReceipt(root, files, true));
  return run;
}

module.exports = { generateSecurityReviewInventory };
