const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const VERIFY_MS = 24 * 60 * 60 * 1000;
const MAX_CALLS = 36;
const MAX_DOCUMENTS = 18;
const MAX_CANDIDATES = 8;
const MAX_SOURCE_PATHS = 6;
const digest = value => createHash('sha256').update(value).digest('hex');
const unnumber = value => String(value || '').replace(/^\d+: ?/gm, '');
const candidateScope = candidate => candidate.scope || candidate.domain;
const candidateKey = candidate => candidate.targetKey || (candidate.domain ? `domain:${candidate.domain}` : null);
const idleSearch = () => ({ state: 'idle', calls: 0, examined: 0, limit: 5, partial: true, reason: 'Search source evidence directly. Indexing is optional.' });
const fresh = () => ({ version: 1, candidates: [], search: idleSearch() });

function focusQuery(value = '') {
  if (typeof value !== 'string' || value.length > 300 || /[\0\r\n]/.test(value)) invalid('Use a domain, application, or short topic of at most 300 characters.');
  const text = value.trim().toLowerCase();
  let domain = null;
  if (text && !/\s/.test(text)) {
    try {
      const url = new URL(text.includes('://') ? text : `https://${text}`);
      const hostname = url.hostname.replace(/\.$/, '');
      if (!url.username && !url.password && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) domain = hostname;
    } catch {}
  }
  return { text, domain };
}
function candidateMatches(candidate, focus) {
  if (!focus.text) return true;
  if (focus.domain) return candidate.domain === focus.domain || (candidate.targetDomains || []).includes(focus.domain);
  return [candidate.domain, candidate.scope, candidate.targetLabel, candidate.title, candidate.repository,
    candidate.category, ...(candidate.targetDomains || []), ...(candidate.searchQueries || []),
    ...(candidate.evidence || []).flatMap(source => [source.repo, source.path])].filter(Boolean).join(' ').toLowerCase().includes(focus.text);
}
function oneDomainEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const mismatch = [...a].map((char, index) => char === b[index] ? -1 : index).filter(index => index >= 0);
    return mismatch.length === 1 || (mismatch.length === 2 && mismatch[1] === mismatch[0] + 1 && a[mismatch[0]] === b[mismatch[1]] && a[mismatch[1]] === b[mismatch[0]]);
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let index = 0; while (index < shorter.length && shorter[index] === longer[index]) index++;
  return shorter.slice(index) === longer.slice(index + 1);
}
function similarDomain(a, b) {
  if (oneDomainEdit(a, b)) return true;
  const left = a.split('.'), right = b.split('.');
  if (left.length !== right.length) return false;
  const changed = left.map((label, index) => label === right[index] ? -1 : index).filter(index => index >= 0);
  if (changed.length !== 1) return false;
  const x = left[changed[0]], y = right[changed[0]];
  // A moved letter can require two edits. Restrict this wider suggestion to
  // one substantial label; surrounding labels must match known source data.
  if (Math.min(x.length, y.length) < 6 || Math.abs(x.length - y.length) > 2) return false;
  let row = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length] <= 2;
}
function domainSuggestions(candidates, domain) {
  if (!domain || domain.length < 8) return [];
  const known = [...new Set(candidates.flatMap(candidate => [candidate.domain, ...(candidate.targetDomains || [])]).filter(Boolean))];
  return known.filter(knownDomain => similarDomain(domain, knownDomain)).sort().slice(0, 3);
}

function invalid(message, status = 400) {
  const error = new Error(message); error.code = 'invalid_input'; error.status = status; throw error;
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = ''; url.hash = ''; return url.href;
  } catch { return null; }
}
function receiptUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const filter = new URL(value).searchParams.get('filter');
  const url = new URL(safe);
  // DradisTab's target filter is useful receipt provenance. Other query
  // parameters remain stripped so URLs cannot retain authentication values.
  if (filter && filter.length <= 300 && !/[\0\r\n]/.test(filter)) url.searchParams.set('filter', filter);
  return url.href;
}
function isReportStatus(value) { return /^(?:report[\s_-]+)?(?:draft|review|delivered|closed|published|complete(?:d)?|final)$/i.test(String(value || '').trim()); }
function projectKey(project) {
  return project.id == null ? `record:${digest(JSON.stringify([project.name, project.status, project.url])).slice(0, 24)}` : String(project.id);
}
function matchDigest(projects) {
  return digest(JSON.stringify(projects.map(project => [projectKey(project), project.name, project.status, project.url || null]).sort((a, b) => a[0].localeCompare(b[0]))));
}
function reportCheck(result, checkedAt) {
  if (!Array.isArray(result?.projects) || !Number.isSafeInteger(result.total_matched) || result.total_matched < 0) throw new Error('invalid_report_response');
  const projects = result.projects.slice(0, 100).map(project => ({ id: project.project_id, name: String(project.name || '').slice(0, 500), status: String(project.status || 'Unknown').slice(0, 100), url: safeUrl(project.project_url) })).map(project => ({ ...project, matchId: projectKey(project) }));
  // A text match is a reason to investigate/exclude, never proof of a target tie.
  // An empty or apparently complete cached feed cannot prove report absence.
  const reported = projects.some(project => isReportStatus(project.status));
  return {
    status: reported ? 'reported' : 'needs_verification', lookupSucceeded: true,
    label: reported ? 'Possible Dradis report match — excluded' : 'Direct Dradis verification required',
    checkedAt, cacheAgeSeconds: Number.isFinite(result.cache_age_seconds) ? result.cache_age_seconds : null,
    projects, matchDigest: matchDigest(projects), totalMatched: result.total_matched, partial: result.total_matched >= 100 || projects.length >= 100 || result.total_matched > projects.length,
    note: projects.length ? 'Project name matches must be checked against the target scope. Candidates with possible report matches are withheld.' : 'No project matched this Clippy query. The cached feed has no complete target-to-report mapping, so this does not establish that no Dradis report exists.',
  };
}

function canonicalRepository(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim().replace(/^[`'\"]|[`'\"]$/g, '').replace(/\.git$/, '');
  if (/^https?:\/\//i.test(name)) {
    try { const url = new URL(name); if (url.username || url.password) return null; name = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''); } catch { return null; }
  }
  return /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,199}$/i.test(name) ? name : null;
}
function sourceField(content, names) {
  for (const line of content.split(/\r?\n/).slice(0, 150)) {
    const clean = line.replace(/[*`]/g, '').trim();
    const match = clean.match(new RegExp(`^\\|?\\s*(?:[-+]\\s*)?(?:${names})\\s*(?:\\||:)\\s*([^|]+)`, 'i'));
    if (match) return match[1].trim();
  }
  return null;
}
function sourceIdentity(content, identityDocument) {
  const repository = canonicalRepository(sourceField(content, 'canonical repository|repository|source repository|repo'));
  const directCommit = sourceField(content, '(?:assessed |inspected |resolved |source )?(?:commit|commit sha|sha|revision)');
  const commit = directCommit?.match(/^([a-f0-9]{40}|[a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (repository && commit) return { repository, commit, source: null, date: null };
  if (!identityDocument || identityDocument.truncated) return null;
  let manifest;
  try { manifest = JSON.parse(unnumber(identityDocument.content)); } catch { return null; }
  const rows = Array.isArray(manifest.repositories) ? manifest.repositories : [manifest.source || manifest];
  const identities = rows.map(row => {
    const name = canonicalRepository(row.canonical_repository || row.canonical_name || row.full_name || row.repository || row.repo || row.name || row.url);
    const sha = String(row.inspected_sha || row.resolved_sha || row.commit_sha || row.commit || row.revision || row.sha || '').toLowerCase();
    return name && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) ? { repository: name, commit: sha } : null;
  }).filter(Boolean).filter(row => !repository || row.repository.toLowerCase() === repository.toLowerCase());
  // An ambiguous multi-repository manifest cannot identify this finding's source.
  if (identities.length !== 1) return null;
  return { ...identities[0], source: identityDocument, date: manifest.verified_at || manifest.prepared_at || null };
}
function evidenceSection(content) {
  return [...content.matchAll(/^#{1,6}\s+([^\n]+)\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/gm)].find(match => /proof.of.concept|reproduc|steps.to|evidence|technical.details/i.test(match[1]) && match[2].trim().length >= 40);
}
function candidateFromDocument(hit, document, parseFinding, identityDocument = null, { domain: preferredDomain = null } = {}) {
  if (document?.truncated || document?.is_text === false) return null;
  const content = unnumber(document?.content);
  const finding = parseFinding(hit.path, hit, { ...document, content });
  if (!['critical', 'high'].includes(finding.severity)) return null;
  if (/^\s*(?:status|resolution)\s*:?\s+(?:fixed|resolved|closed|remediated)\b/im.test(content.replace(/[|*_`]/g, ' '))) return null;
  const reproduction = evidenceSection(content);
  if (!reproduction) return null;
  const urls = [...content.matchAll(/https?:\/\/[^\s<>"'`\])]+/g)].map(match => safeUrl(match[0])).filter(Boolean);
  const targetUrls = urls.filter(value => finding.targets?.includes(new URL(value).hostname.toLowerCase()));
  const endpoint = targetUrls.find(value => preferredDomain && new URL(value).hostname.toLowerCase() === preferredDomain) || targetUrls[0];
  const targetDomains = [...new Set(targetUrls.map(value => new URL(value).hostname.toLowerCase()))];
  const identity = endpoint ? null : sourceIdentity(content, identityDocument);
  if (!endpoint && !identity) return null;
  const domain = endpoint ? new URL(endpoint).hostname.toLowerCase() : null;
  const scope = domain || `${identity.repository}@${identity.commit}`;
  const targetKey = domain ? `domain:${domain}` : `source:${identity.repository.toLowerCase()}@${identity.commit}`;
  const evidenceDigest = identity ? digest(JSON.stringify([content, identity.repository, identity.commit, identity.source ? unnumber(identity.source.content) : null])) : digest(content);
  const id = digest(`${domain || targetKey}\n${hit.path}`).slice(0, 32);
  const sourceLine = content.slice(0, reproduction.index).split('\n').length;
  const recordedDate = sourceField(content, 'assessment date|date|last tested|discovered')?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || identity?.date || null;
  return {
    id, domain, scope, targetKey, targetKind: domain ? 'network' : 'source', targetLabel: domain || identity.repository,
    ...(identity ? { repository: identity.repository, commit: identity.commit } : {}),
    title: finding.title.slice(0, 500), severity: finding.severity, category: finding.category,
    endpoint, targetDomains, evidenceDigest, evidenceDate: recordedDate, evidenceCheckedAt: new Date().toISOString(), historical: true,
    why: domain ? `The historical ${finding.severity}-severity ${finding.category || 'finding'} explicitly lists ${domain} and includes ${reproduction[1].replace(/[*_`]/g, '').trim().slice(0, 100)}. Verify that this evidence applies to this host and its current configuration.` : `The source documents a ${finding.severity}-severity source-code finding in ${identity.repository} at commit ${identity.commit}, with ${reproduction[1].replace(/[*_`]/g, '').trim().slice(0, 100)}. Deployment reachability and current exploitability remain unverified.`,
    nextStep: domain ? `Review the cited reproduction evidence for ${endpoint}, confirm the target and test accounts are in scope, then check whether the documented ${finding.category || 'security condition'} still holds. Capture current evidence before drafting a report.` : `Review the cited code and reproduction trace at ${identity.commit}, then compare the current library and consuming job's input controls. Establish the authorized deployment and attacker prerequisites before planning a scoped test; do not infer a network target from a similar name.`,
    evidence: [{ path: hit.path, repo: finding.repo, line: sourceLine }, ...(identity?.source ? [{ path: identity.source.path, repo: finding.repo, line: 1, role: 'source_identity' }] : [])],
    saved: false, reportCoverage: { status: 'needs_verification', label: 'Direct Dradis verification required', projects: [] },
  };
}

function createClippyLeads({ call, ensureConnection, parseFinding, safePath, storePath = null, now = () => Date.now(), durationMs = 60000 } = {}) {
  let account = null; let loaded = false; let state = fresh(); let controller = null; let job = null; let revision = 0;
  const coverageVersions = new Map(); const verificationSequences = new Map(); const pendingRelationships = new Map();
  function persist() {
    if (!storePath || !account) return;
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(storePath), `.clippy-leads-${randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, JSON.stringify({ ...state, account }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, storePath); if (process.platform !== 'win32') fs.chmodSync(storePath, 0o600); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  function activate(fingerprint) {
    if (account === fingerprint && loaded) return;
    controller?.abort(); controller = null; job = null; revision++; account = fingerprint; loaded = true; state = fresh(); coverageVersions.clear(); verificationSequences.clear(); pendingRelationships.clear();
    if (!storePath) return;
    try {
      const stat = fs.lstatSync(storePath);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || process.platform !== 'win32' && stat.mode & 0o077) return;
      const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (saved.version === 1 && saved.account === account && Array.isArray(saved.candidates) && saved.search) {
        state = saved;
        if (state.search.state === 'running') state.search = { ...state.search, state: 'paused', reason: 'The previous search stopped when GLaDOS closed. Run a new bounded search to refresh the evidence.' };
      }
    } catch {}
  }
  function deactivate() { controller?.abort(); controller = null; job = null; revision++; account = null; loaded = false; state = fresh(); coverageVersions.clear(); verificationSequences.clear(); pendingRelationships.clear(); }
  function auditCoverage(candidate, coverage) {
    const previous = candidate.reportCoverage;
    if ((previous?.kind === 'analyst_attestation' || previous?.projectDispositions?.length) && JSON.stringify(previous) !== JSON.stringify(coverage)) {
      candidate.reportCheckHistory = [...(candidate.reportCheckHistory || []), previous].slice(-8);
    }
  }
  function knownTies(targetKey) {
    const projects = new Map(); const dispositions = new Map();
    for (const candidate of state.candidates) {
      if (candidateKey(candidate) !== targetKey || !candidate.reportCoverage?.confirmedTie) continue;
      const coverage = candidate.reportCoverage;
      for (const row of coverage.projectDispositions || []) if (row.disposition === 'tied') {
        const project = coverage.projects?.find(project => project.matchId === row.matchId);
        if (project) { projects.set(row.matchId, project); dispositions.set(row.matchId, row); }
      }
    }
    return { projects: [...projects.values()], dispositions: [...dispositions.values()] };
  }
  function retainKnownTies(targetKey, coverage) {
    const known = knownTies(targetKey);
    if (!known.projects.length) return coverage;
    const projects = new Map(known.projects.map(project => [project.matchId, project]));
    for (const project of coverage.projects || []) projects.set(project.matchId, project);
    const merged = [...projects.values()];
    return { ...coverage, projects: merged, matchDigest: matchDigest(merged), confirmedTie: true, projectDispositions: known.dispositions, status: 'reported', label: 'Analyst confirmed a tied report — excluded', note: 'A recorded tied report remains excluded even if a later cached lookup omits it. Resolve the exact known report directly before recording a new no-tied-report check.' };
  }
  function withholdTarget(targetKey, coverage) {
    if (!targetKey) return;
    const withheld = retainKnownTies(targetKey, coverage);
    for (const candidate of state.candidates) if (candidateKey(candidate) === targetKey) { auditCoverage(candidate, withheld); candidate.reportCoverage = { ...withheld }; }
    coverageVersions.set(targetKey, (coverageVersions.get(targetKey) || 0) + 1);
  }
  function withholdSource(filename, reason) {
    const targets = new Set(state.candidates.filter(candidate => candidate.evidence?.some(source => source.path === filename)).map(candidateKey));
    for (const target of targets) withholdTarget(target, { status: 'needs_verification', label: reason, projects: [], checkedAt: new Date(now()).toISOString(), note: 'The previous source or report check is no longer sufficient for this target. Review the current evidence and check Dradis again.' });
  }
  function eligible(candidate) {
    const verification = candidate.reportCoverage;
    return verification?.status === 'no_report_verified' && verification.kind === 'analyst_attestation'
      && verification.scope === candidateScope(candidate) && verification.evidenceDigest === candidate.evidenceDigest
      && verification.matchDigest === matchDigest(verification.projects || [])
      && Array.isArray(verification.projectDispositions)
      && (verification.projects || []).every(project => verification.projectDispositions.some(row => row.matchId === project.matchId && row.disposition === 'unrelated' && row.notes?.length >= 20))
      && verification.sourceUrl && Number.isFinite(Date.parse(verification.checkedAt))
      && now() >= Date.parse(verification.checkedAt) && now() - Date.parse(verification.checkedAt) <= VERIFY_MS;
  }
  function snapshot(query = state.search.query || '') {
    const focus = focusQuery(query);
    const all = state.candidates;
    const exactSources = new Set(all.filter(candidate => candidate.domain === focus.domain).flatMap(candidate => (candidate.evidence || []).map(source => source.path)));
    const candidates = all.filter(candidate => candidateMatches(candidate, focus)).filter(candidate => !focus.domain || candidate.domain === focus.domain || !candidate.evidence?.some(source => exactSources.has(source.path))).map(candidate => {
      const current = candidate.reportCoverage?.status === 'no_report_verified' && !eligible(candidate)
        ? { ...candidate, reportCoverage: { ...candidate.reportCoverage, status: 'stale', label: 'Dradis check expired — verify again' } } : candidate;
      return focus.domain && current.domain !== focus.domain ? { ...current, relatedTarget: focus.domain } : current;
    });
    const order = (a, b) => Number(b.saved) - Number(a.saved) || Number(b.severity === 'critical') - Number(a.severity === 'critical') || String(a.targetLabel || a.domain).localeCompare(String(b.targetLabel || b.domain));
    const leads = candidates.filter(candidate => eligible(candidate) && !candidate.relatedTarget).sort(order).slice(0, 5);
    const review = candidates.filter(candidate => !eligible(candidate) || candidate.relatedTarget).sort(order);
    const search = { ...state.search };
    if (search.state === 'complete' && search.found === 0 && candidates.length) search.reason = 'No new candidates were found in this pass. Matching evidence from earlier searches is shown below; review its source and current Dradis coverage.';
    return { leads, review, search, query: query.trim(), retainedElsewhere: all.length - candidates.length,
      suggestions: candidates.length ? [] : domainSuggestions(all, focus.domain),
      note: 'Evidence is historical. Verify current conditions and Dradis coverage before starting. Chat searches Clippy directly.' };
  }
  async function status({ query } = {}) { await ensureConnection(); return snapshot(query); }
  async function coverageFor(candidate, lookup) {
    const aliases = candidate.domain ? [...new Set([candidate.domain, ...(candidate.targetDomains || [])])] : [candidate.repository, candidate.repository.split('/').pop()];
    const queries = [...new Set(aliases)].slice(0, 4);
    const rows = [];
    for (const query of queries) rows.push(reportCheck(await lookup('projects_search', { query, limit: 100 }), new Date(now()).toISOString()));
    const projects = new Map(); let conflicting = false;
    for (const row of rows) for (const project of row.projects) {
      const previous = projects.get(project.matchId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(project)) conflicting = true;
      projects.set(project.matchId, project);
    }
    // A cached omission cannot erase an analyst-confirmed tied report. Keep
    // those exact projects in the set that must be reviewed directly.
    for (const project of knownTies(candidateKey(candidate)).projects) if (!projects.has(project.matchId)) projects.set(project.matchId, project);
    const merged = [...projects.values()];
    const reported = merged.some(project => isReportStatus(project.status));
    return { ...rows[0], status: reported ? 'reported' : 'needs_verification', label: reported ? 'Possible Dradis report match — review required' : 'Direct Dradis verification required', projects: merged, matchDigest: matchDigest(merged), queries, totalMatched: merged.length, partial: conflicting || aliases.length > queries.length || rows.some(row => row.partial), note: merged.length ? 'These are possible name matches. Check each project directly and record whether its scope is tied, unrelated, or still unknown; a similar name alone does not establish a tie.' : 'No project matched these cached Clippy queries. A direct, scoped Dradis check is still required; empty cached searches do not establish report absence.' };
  }
  async function readCandidate(hit, lookup, manifests = new Map(), focus = {}) {
    const document = await lookup('read', { path: hit.path, offset: 1, limit: 1000 });
    let candidate = candidateFromDocument(hit, document, parseFinding, null, focus);
    const content = unnumber(document?.content);
    if (!candidate && !document?.truncated && ['critical', 'high'].includes(parseFinding(hit.path, hit, document).severity) && evidenceSection(content) && canonicalRepository(sourceField(content, 'canonical repository|repository|source repository|repo'))) {
      const manifestPath = `${hit.path.slice(0, hit.path.indexOf('/findings/'))}/source-manifest.json`;
      safePath(manifestPath);
      if (!manifests.has(manifestPath)) {
        try { manifests.set(manifestPath, { ...await lookup('read', { path: manifestPath, offset: 1, limit: 1000 }), path: manifestPath }); }
        catch (error) {
          if (['not_connected', 'authentication_failed', 'connection_changed'].includes(error.code) || ['lead_budget', 'lead_cancelled'].includes(error.message)) throw error;
          manifests.set(manifestPath, null);
        }
      }
      candidate = candidateFromDocument(hit, document, parseFinding, manifests.get(manifestPath), focus);
    }
    if (candidate && focus.text && !focus.domain && content.toLowerCase().includes(focus.text)) candidate.searchQueries = [focus.text];
    return candidate;
  }
  async function start({ query = '', paths: sourcePaths } = {}) {
    const focus = focusQuery(query);
    if (sourcePaths !== undefined) {
      if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.length > MAX_SOURCE_PATHS) invalid('Choose one to six Clippy finding paths.');
      for (const filename of sourcePaths) {
        if (typeof filename !== 'string' || !/\/findings\/.+\.(?:md|markdown)$/i.test(filename)) invalid('Choose a Clippy finding file.');
        safePath(filename);
      }
      sourcePaths = [...new Set(sourcePaths)];
    }
    await ensureConnection();
    if (controller && state.search.state === 'running') {
      if (sourcePaths) invalid('Wait for the current evidence search to finish before adding cited sources.', 409);
      return snapshot();
    }
    const epoch = ++revision; const active = new AbortController(); controller = active;
    state.search = { ...idleSearch(), query: query.trim(), mode: sourcePaths ? 'sources' : 'search', found: 0, state: 'running', startedAt: new Date(now()).toISOString(), reason: sourcePaths ? 'Checking cited Clippy finding files and exact source identities. Up to six sources, 36 lookups, or one minute; Dradis verification is still required.' : 'Searching source evidence and checking possible Dradis report matches. This search stops after 36 lookups, 18 documents, or one minute.' };
    persist();
    const deadline = setTimeout(() => {
      if (epoch !== revision || controller !== active) return;
      active.abort(); revision++; controller = null;
      state.search = { ...state.search, state: 'paused', checkedAt: new Date(now()).toISOString(), reason: 'The one-minute search limit was reached. Evidence already found is retained; narrow the topic for another search.' };
      try { persist(); } catch { state.search.state = 'error'; state.search.reason = 'The local lead collection could not be saved.'; }
    }, durationMs); deadline.unref?.();
    const valid = () => epoch === revision && controller === active && !active.signal.aborted;
    async function lookup(name, args) {
      if (!valid() || state.search.calls >= MAX_CALLS) throw new Error('lead_budget');
      state.search.calls++;
      const result = await call(name, args, active.signal);
      if (!valid()) throw new Error('lead_cancelled');
      return result;
    }
    job = (async () => {
      try {
        const searchTerm = focus.domain || query.trim();
        const phrase = searchTerm ? `"${searchTerm.replace(/"/g, '""')}"` : null;
        const terms = phrase ? [`${phrase} AND (critical OR high)`, phrase] : ['critical', 'high'];
        const paths = new Set(); const manifests = new Map(); const coverageCache = new Map(); let found = 0;
        const queues = [];
        if (sourcePaths) queues.push(sourcePaths.map(filename => ({ path: filename, repo: filename.split('/')[0] })));
        else for (const term of terms) {
          const hits = await lookup('search', { query: term, limit: 40, path_glob: '*/*findings/*.md' });
          if (!Array.isArray(hits)) throw new Error('invalid_lead_response');
          queues.push(hits);
        }
        // Round-robin queues prevent broad critical results from consuming the
        // entire evidence budget before high-severity sources are examined.
        while (queues.some(queue => queue.length)) {
          if (!valid() || found >= MAX_CANDIDATES || state.search.examined >= MAX_DOCUMENTS || state.search.calls >= MAX_CALLS - 2) break;
          for (const queue of queues) {
            if (!valid() || found >= MAX_CANDIDATES || state.search.examined >= MAX_DOCUMENTS || state.search.calls >= MAX_CALLS - 2) break;
            const hit = queue.shift();
            if (typeof hit?.path !== 'string' || paths.has(hit.path) || !/\/findings\/.+\.(?:md|markdown)$/i.test(hit.path)) continue;
            try { safePath(hit.path); } catch { continue; }
            paths.add(hit.path); state.search.examined++;
            let candidate;
            try { candidate = await readCandidate(hit, lookup, manifests, focus); }
            catch (error) {
              if (!valid() || ['not_connected', 'authentication_failed', 'connection_changed'].includes(error.code) || error.message === 'lead_budget') throw error;
              withholdSource(hit.path, 'Source could not be refreshed — withheld'); persist(); continue;
            }
            if (!candidate) { withholdSource(hit.path, 'Source no longer meets the evidence requirements'); persist(); continue; }
            if (state.candidates.some(item => item.evidence?.some(source => source.path === hit.path) && item.evidenceDigest !== candidate.evidenceDigest)) withholdSource(hit.path, 'Source evidence changed — check Dradis again');
            if (!candidateMatches(candidate, focus)) continue;
            const key = candidateKey(candidate); const checkedAt = new Date(now()).toISOString();
            try {
              if (!coverageCache.has(key)) coverageCache.set(key, await coverageFor(candidate, lookup));
              candidate.reportCoverage = coverageCache.get(key);
            } catch (error) {
              if (!valid() || error.message === 'lead_budget') throw error;
              candidate.reportCoverage = { status: 'needs_verification', label: 'Dradis lookup unavailable — withheld', projects: [], checkedAt, note: 'The cached project lookup failed. Complete a direct Dradis check before considering this candidate.' };
            }
            if (!valid()) break;
            const previous = state.candidates.find(item => item.id === candidate.id);
            const retainedReceipt = previous && eligible(previous) && previous.evidenceDigest === candidate.evidenceDigest && candidate.reportCoverage.lookupSucceeded === true && !candidate.reportCoverage.partial && previous.reportCoverage.matchDigest === candidate.reportCoverage.matchDigest;
            candidate.saved = previous?.saved === true;
            candidate.searchQueries = [...new Set([...(previous?.searchQueries || []), ...(candidate.searchQueries || [])])].slice(-8);
            if (previous?.reportCheckHistory) candidate.reportCheckHistory = previous.reportCheckHistory;
            if (!previous && state.candidates.some(item => candidateKey(item) === key)) withholdTarget(key, { status: 'needs_verification', label: 'New target evidence — check Dradis again', projects: [], checkedAt, note: 'The target now has additional source evidence outside the earlier verification receipt.' });
            if (!retainedReceipt && (!candidate.reportCoverage.lookupSucceeded || candidate.reportCoverage.partial || candidate.reportCoverage.projects.length)) withholdTarget(key, candidate.reportCoverage);
            if (retainedReceipt) candidate.reportCoverage = previous.reportCoverage;
            else {
              if (previous) { const audit = { ...previous }; auditCoverage(audit, candidate.reportCoverage); if (audit.reportCheckHistory) candidate.reportCheckHistory = audit.reportCheckHistory; }
              candidate.reportCoverage = retainKnownTies(key, candidate.reportCoverage);
            }
            state.candidates = state.candidates.filter(item => item.id !== candidate.id);
            state.candidates.push(candidate);
            // Keep bounded evidence collections, while retaining saved leads.
            state.candidates = [...state.candidates.filter(item => item.saved), ...state.candidates.filter(item => !item.saved).slice(-24)].slice(-40);
            found++; state.search.found = found; persist();
          }
        }
        if (valid()) state.search = { ...state.search, state: 'complete', checkedAt: new Date(now()).toISOString(), reason: found ? 'Source-backed candidates are ready for review. Only candidates with a current Dradis verification appear in the recommended shortlist.' : state.search.examined === 0 ? 'No finding documents matched this search. Check the hostname spelling or try the application name; Clippy chat may have used other intelligence sources.' : 'The documents checked did not meet the severity, exact-target, and reproduction-evidence requirements. Ask Clippy Agent to review the cited sources.' };
      } catch (error) {
        if (epoch === revision) state.search = { ...state.search, state: active.signal.aborted || error.message === 'lead_budget' ? 'paused' : 'error', checkedAt: new Date(now()).toISOString(), reason: active.signal.aborted || error.message === 'lead_budget' ? 'The bounded search stopped. Evidence already found is retained; narrow the topic for another search.' : 'Clippy could not finish this search. Existing evidence is retained; check the connection and retry.' };
      } finally {
        clearTimeout(deadline);
        if (controller === active && epoch === revision) { controller = null; job = null; persist(); }
      }
    })();
    // Persistence errors must be observed even though the bounded job outlives HTTP.
    job.catch(() => { if (epoch === revision) { state.search.state = 'error'; state.search.reason = 'The local lead collection could not be saved.'; } });
    return snapshot();
  }
  async function cancel() {
    await ensureConnection(); controller?.abort(); controller = null; revision++;
    if (state.search.state === 'running') state.search = { ...state.search, state: 'paused', reason: 'Search stopped. Evidence already found is retained.' };
    persist(); return snapshot();
  }
  function find(id) { const candidate = state.candidates.find(item => item.id === id); if (!candidate) invalid('This lead is no longer available. Refresh the workspace.', 404); return candidate; }
  async function save(id, { saved } = {}) { await ensureConnection(); if (typeof saved !== 'boolean') invalid('Choose whether to save this lead.'); find(id).saved = saved; persist(); return snapshot(); }
  async function verify(id, input = {}) {
    await ensureConnection();
    const candidate = find(id);
    const epoch = revision;
    if (state.search.state === 'running') invalid('Wait for the source search to finish before recording a Dradis check.', 409);
    if (![true, false].includes(input.noReport) || input.scope !== candidateScope(candidate) || input.evidenceDigest !== candidate.evidenceDigest) invalid('Confirm a Dradis check for this exact target and current evidence.');
    const sourceUrl = receiptUrl(input.sourceUrl);
    if (!sourceUrl || new URL(sourceUrl).protocol !== 'https:' || !/^dradis(?:tab)?\./i.test(new URL(sourceUrl).hostname)) invalid('Provide the HTTPS Dradis or Dradis Tab page used for your check.');
    if (typeof input.notes !== 'string' || input.notes.trim().length < 20 || input.notes.length > 2000 || input.notes.includes('\0')) invalid('Record the aliases, target scope, and project/report sources you checked (20–2000 characters).');
    const supplied = input.projectDispositions === undefined ? [] : input.projectDispositions;
    if (!Array.isArray(supplied) || supplied.length > 200) invalid('Record a disposition for each possible project match.');
    const dispositions = supplied.map(row => {
      if (!row || typeof row.matchId !== 'string' || !['unrelated', 'tied', 'unknown'].includes(row.disposition) || typeof row.notes !== 'string' || row.notes.trim().length < 20 || row.notes.length > 2000 || row.notes.includes('\0')) invalid('For each match, record tied, unrelated, or unknown and notes of 20–2000 characters.');
      return { matchId: row.matchId, disposition: row.disposition, notes: row.notes.trim() };
    });
    const targetKey = candidateKey(candidate);
    if (pendingRelationships.has(targetKey)) invalid('A report relationship check is still refreshing this target. Wait before recording another check.', 409);
    // Positive or unresolved analyst report evidence withholds immediately.
    // It must supersede a concurrent negative check even while that check is
    // awaiting Clippy; only promotion requires the full fresh lookup below.
    const unresolved = dispositions.filter(row => row.disposition !== 'unrelated');
    if (input.noReport === false && (!unresolved.length || !candidate.reportCoverage?.projects?.length)) invalid('Record a tied or unknown relationship for a current possible project match. A no-tied-report receipt requires explicit confirmation.');
    if (unresolved.length && input.matchDigest === candidate.reportCoverage?.matchDigest && unresolved.every(row => candidate.reportCoverage.projects?.some(project => project.matchId === row.matchId))) {
      const confirmedTie = unresolved.some(row => row.disposition === 'tied');
      withholdTarget(targetKey, { ...candidate.reportCoverage, status: confirmedTie ? 'reported' : 'needs_verification', label: input.noReport === false ? 'Report relationship submitted — refreshing evidence' : confirmedTie ? 'Analyst confirmed a tied report — excluded' : 'Project scope remains unknown — withheld', confirmedTie: input.noReport === true && confirmedTie, kind: input.noReport === false ? 'analyst_observation_pending' : 'analyst_observation', projectDispositions: dispositions, sourceUrl, scope: candidateScope(candidate), evidenceDigest: candidate.evidenceDigest, checkedAt: new Date(now()).toISOString(), notes: input.notes.trim() }); persist();
      if (input.noReport === true) invalid('A tied or unresolved report match prevents this candidate from becoming a ready lead.', 409);
    }
    const sequence = (verificationSequences.get(targetKey) || 0) + 1;
    verificationSequences.set(targetKey, sequence);
    if (input.noReport === false) pendingRelationships.set(targetKey, sequence);
    const coverageVersion = coverageVersions.get(targetKey) || 0;
    const currentVerification = () => epoch === revision && state.candidates.includes(candidate) && verificationSequences.get(targetKey) === sequence && (coverageVersions.get(targetKey) || 0) === coverageVersion;
    const active = new AbortController(); let calls = 0;
    let expire;
    const timeout = new Promise((_resolve, reject) => { expire = setTimeout(() => { active.abort(); reject(new Error('verification_timeout')); }, Math.min(durationMs, 30000)); expire.unref?.(); });
    const lookup = async (name, args) => {
      if (!currentVerification()) throw new Error('verification_superseded');
      if (active.signal.aborted || ++calls > 12) throw new Error('verification_budget');
      const result = await call(name, args, active.signal);
      if (active.signal.aborted) throw new Error('verification_timeout');
      return result;
    };
    // Refresh the finding, identity evidence, and exact report match set before
    // accepting an analyst receipt. Cached absence never supplies the receipt.
    let coverage; let refreshed;
    try {
      const source = candidate.evidence?.find(item => item.role !== 'source_identity');
      if (!source?.path) throw new Error('missing_source');
      const refreshedSources = await Promise.race([(async () => {
        const current = await readCandidate({ path: source.path, repo: source.repo }, lookup, new Map(), { domain: candidate.domain });
        if (!current || current.evidenceDigest !== candidate.evidenceDigest || candidateKey(current) !== candidateKey(candidate)) throw new Error('source_changed');
        return { current, coverage: await coverageFor(current, lookup) };
      })(), timeout]);
      refreshed = refreshedSources.current; coverage = refreshedSources.coverage;
    } catch (error) {
      if (!currentVerification()) invalid('A newer source or report check superseded this verification. Refresh before recording a check.', 409);
      if (currentVerification()) {
        withholdTarget(candidateKey(candidate), { status: 'needs_verification', label: error.message === 'source_changed' ? 'Source evidence changed — check Dradis again' : 'Source or Dradis lookup unavailable — withheld', projects: [], checkedAt: new Date(now()).toISOString() }); persist();
      }
      invalid(error.message === 'source_changed' ? 'The source or exact target identity changed. Refresh the evidence and repeat the Dradis check.' : 'Clippy’s source or report lookup is unavailable. Retry before recording a verified lead.', 409);
    } finally { clearTimeout(expire); active.abort(); if (pendingRelationships.get(targetKey) === sequence) pendingRelationships.delete(targetKey); }
    if (!currentVerification()) invalid('A newer source or report check superseded this verification. Refresh before recording a check.', 409);
    if (coverage.partial && input.noReport === true || input.matchDigest !== coverage.matchDigest) { withholdTarget(candidateKey(candidate), coverage); persist(); invalid(coverage.partial && input.noReport === true ? 'The report match inventory is partial or inconsistent. Complete and refresh it before recording a verified lead.' : 'The possible report matches changed. Review the refreshed match list before recording a check.', 409); }
    const currentIds = new Set(coverage.projects.map(project => project.matchId));
    if (new Set(dispositions.map(row => row.matchId)).size !== dispositions.length || dispositions.length !== currentIds.size || dispositions.some(row => !currentIds.has(row.matchId))) {
      withholdTarget(candidateKey(candidate), coverage); persist(); invalid('Review every current possible project match exactly once before recording the check.', 409);
    }
    if (dispositions.some(row => row.disposition !== 'unrelated')) {
      const confirmedTie = dispositions.some(row => row.disposition === 'tied');
      withholdTarget(candidateKey(candidate), { ...coverage, status: confirmedTie ? 'reported' : 'needs_verification', label: confirmedTie ? 'Analyst confirmed a tied report — excluded' : 'Project scope remains unknown — withheld', confirmedTie, kind: 'analyst_observation', projectDispositions: dispositions, sourceUrl, scope: candidateScope(candidate), targetKey, evidenceDigest: candidate.evidenceDigest, checkedAt: new Date(now()).toISOString(), notes: input.notes.trim() }); persist();
      if (input.noReport === false) return snapshot();
      invalid('A tied or unresolved report match prevents this candidate from becoming a ready lead.', 409);
    }
    if (input.noReport === false) invalid('A no-tied-report receipt requires explicit confirmation.', 400);
    candidate.evidenceCheckedAt = refreshed.evidenceCheckedAt;
    const receipt = { ...coverage, status: 'no_report_verified', label: 'Analyst checked Dradis; no tied report found', kind: 'analyst_attestation', sourceUrl, scope: candidateScope(candidate), targetKey: candidateKey(candidate), notes: input.notes.trim(), evidenceDigest: candidate.evidenceDigest, checkedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + VERIFY_MS).toISOString(), projectDispositions: dispositions, note: 'An analyst recorded a direct target-and-alias Dradis check and resolved every current possible project match as unrelated. This is an analyst attestation, not automated proof of absence. Recheck before starting work; verification expires after 24 hours or changed evidence or report matches.' };
    auditCoverage(candidate, receipt); candidate.reportCoverage = receipt;
    coverageVersions.set(targetKey, coverageVersion + 1);
    persist(); return snapshot();
  }
  async function waitForIdle() { if (job) await job; return snapshot(); }
  const fromSources = input => {
    if (!input || !Object.hasOwn(input, 'paths')) invalid('Choose one to six Clippy finding paths.');
    return start(input);
  };
  return { activate, deactivate, status, start, fromSources, cancel, save, verify, waitForIdle };
}

module.exports = { createClippyLeads, candidateFromDocument, reportCheck, isReportStatus, VERIFY_MS };
