const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { READ_TOOLS: CLIPPY_READ_TOOLS } = require('./secrets/clippy-mcp');

const SCHEMA_VERSION = 1;
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_INSTRUCTIONS_BYTES = 128 * 1024;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_FILES = new Set(['agents.md', 'tools.md', 'agent.json', 'package.json']);
const LEGACY_CLIPPY_TOOLS = ['search', 'read', 'list_repos', 'list_files', 'projects_search', 'cross_search'].map(name => `mcp__clippy__${name}`);
// These are trusted integration policy, never fields accepted from an uploaded
// manifest. Editing Clippy's behavior does not grant new runtime capabilities.
const EDITABLE_INTEGRATIONS = {
  'clippy-intel': {
    source: 'clippy-intel.glados-agent.json', agentId: 'clippy', connectors: ['clippy'],
    tools: [...CLIPPY_READ_TOOLS].map(name => `mcp__clippy__${name}`),
  },
  herbie: {
    source: 'herbie.glados-agent.json',
    agentIds: ['coordinator', 'packet-analysis', 'mechanic', 'pain', 'panic', 'security', 'red-teamer', 'dns-specialist', 'password-auditor', 'planner', 'researcher', 'coder', 'devops', 'reviewer'],
    teamIds: ['herbie-team'], connectors: [],
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'WebSearch'],
    agentTools: {
      coordinator: ['Read', 'Glob', 'Grep'],
      'packet-analysis': ['Read', 'Glob', 'Grep', 'Bash'],
      'dns-specialist': ['Read', 'Glob', 'Grep', 'Bash'],
      researcher: ['Read', 'Glob', 'Grep', 'WebSearch'],
      coder: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'],
      devops: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'],
    },
  },
};

function editableIntegrationPolicy(record) {
  const policy = EDITABLE_INTEGRATIONS[record.id];
  return record.managedIntegration === true && record.managedSource === policy?.source ? policy : null;
}

class AgentPackageError extends Error {
  constructor(message, code = 'INVALID_AGENT_PACKAGE', status = 400) {
    super(message);
    this.name = 'AgentPackageError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function invalid(message) { throw new AgentPackageError(message); }
function conflict(message) { throw new AgentPackageError(message, 'AGENT_PACKAGE_CONFLICT', 409); }
function missing(message) { throw new AgentPackageError(message, 'AGENT_PACKAGE_NOT_FOUND', 404); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function statOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function inspectObject(value, location = 'package', depth = 0) {
  if (depth > 30) invalid('package nesting is too deep');
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(`${location} must be a plain JSON object`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) invalid(`${location} contains a forbidden property`);
    inspectObject(item, `${location}.${key}`, depth + 1);
  }
}

function text(value, label, { required = false, max = 1024, trim = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') invalid(`${label} must be text`);
  const result = trim ? value.trim() : value;
  if (required && !result.trim()) invalid(`${label} is required`);
  if (result.includes('\0')) invalid(`${label} cannot contain NUL characters`);
  if (Buffer.byteLength(result) > max) invalid(`${label} is too large`);
  return result;
}

function id(value, label) {
  const result = text(value, label, { required: true, max: 64 });
  if (!ID_PATTERN.test(result)) invalid(`${label} must be a lowercase identifier with hyphens`);
  return result;
}

function resourcePath(value, label = 'resource path') {
  const result = text(value, label, { required: true, max: 240, trim: false });
  if (result.includes('\\') || result.startsWith('/') || /^[A-Za-z]:/.test(result)
      || result.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(part)
        || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || result.split('/').some(part => part.startsWith('.'))) invalid(`${label} must be a safe relative file path`);
  if (RESERVED_FILES.has(result.toLowerCase())) invalid(`${label} is reserved by GLaDOS`);
  return result;
}

function stringList(value, label, { max = 100, itemMax = 1024, identifiers = false } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be an array of at most ${max} entries`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, { required: true, max: itemMax }));
  if (identifiers && result.some(item => !/^[A-Za-z0-9][A-Za-z0-9_.:*\/-]*$/.test(item))) invalid(`${label} contains an invalid capability identifier`);
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicate entries`);
  return result;
}

function normalizeSkills(value, resources, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) invalid(`${label} must be an array of at most 64 skills`);
  const seen = new Set();
  return value.map((input, index) => {
    const raw = typeof input === 'string' ? { id: input } : input;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`${label}[${index}] must describe a skill`);
    const skillId = id(raw.id, `${label}[${index}].id`);
    if (seen.has(skillId)) invalid(`${label} contains a duplicate skill identifier`);
    seen.add(skillId);
    const instructions = text(raw.instructions, `${label}[${index}].instructions`, { max: MAX_INSTRUCTIONS_BYTES, trim: false });
    const file = resourcePath(raw.path || `skills/${skillId}/SKILL.md`, 'skill path');
    if (!file.startsWith(`skills/${skillId}/`) || !file.endsWith('/SKILL.md')) invalid('skill path must be skills/<id>/SKILL.md');
    const resource = resources.find(item => item.path === file);
    if (!instructions.trim() && !resource?.text.trim()) invalid(`skill ${skillId} requires instructions or a packaged SKILL.md resource`);
    if (instructions && resource && instructions !== resource.text) invalid(`skill ${skillId} instructions conflict with its resource`);
    return {
      id: skillId,
      name: text(raw.name || skillId, 'skill name', { required: true, max: 160 }),
      description: text(raw.description, 'skill description', { max: 2048 }),
      path: file,
      ...(instructions ? { instructions } : {}),
    };
  });
}

function normalizeManifest(input, { builtInIds = [] } = {}) {
  inspectObject(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('package must be a JSON object');
  if (input.schemaVersion !== SCHEMA_VERSION) invalid('schemaVersion must be 1');
  const packageId = id(input.id, 'package id');
  if (new Set(builtInIds).has(packageId)) invalid(`package id ${packageId} is reserved by a built-in agent`);
  const version = text(input.version, 'package version', { required: true, max: 100 });
  if (!VERSION_PATTERN.test(version)) invalid('package version must use semantic versioning, such as 1.0.0');
  if (!Array.isArray(input.agents) || !input.agents.length || input.agents.length > 32) invalid('package must contain between 1 and 32 agents');
  const rawResources = input.resources || [];
  if (!Array.isArray(rawResources) || rawResources.length > 250) invalid('resources must be an array of at most 250 files');
  const resourcePaths = new Set();
  const foldedPaths = new Set();
  const resources = rawResources.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`resources[${index}] must describe a text file`);
    if (item.type === 'symlink' || item.symlink || item.linkTarget) invalid('symlink resources are not supported');
    const file = resourcePath(item.path);
    if (resourcePaths.has(file) || foldedPaths.has(file.toLowerCase())) invalid(`duplicate resource path: ${file}`);
    for (const existing of resourcePaths) {
      if (existing.startsWith(`${file}/`) || file.startsWith(`${existing}/`)) invalid('resource paths cannot collide as files and directories');
    }
    for (const existing of foldedPaths) {
      if (existing.startsWith(`${file.toLowerCase()}/`) || file.toLowerCase().startsWith(`${existing}/`)) invalid('resource paths cannot collide as files and directories');
    }
    resourcePaths.add(file);
    foldedPaths.add(file.toLowerCase());
    return { path: file, text: text(item.text, `resource ${file}`, { max: MAX_RESOURCE_BYTES, trim: false }) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const ids = new Set();
  const agents = input.agents.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`agents[${index}] must be an object`);
    const agentId = id(raw.id, 'agent id');
    if (ids.has(agentId)) invalid(`duplicate agent identifier: ${agentId}`);
    ids.add(agentId);
    const connectors = stringList(raw.connectors, 'connectors', { identifiers: true });
    const requiredConnectors = raw.requiredConnectors === undefined ? [...connectors]
      : stringList(raw.requiredConnectors, 'requiredConnectors', { identifiers: true });
    if (requiredConnectors.some(connector => !connectors.includes(connector))) invalid('requiredConnectors must be included in connectors');
    const effort = raw.effort || 'high';
    if (!EFFORTS.has(effort)) invalid('effort must be none, minimal, low, medium, high, xhigh, or max');
    return {
      id: agentId,
      name: text(raw.name || agentId, 'agent name', { required: true, max: 160 }),
      description: text(raw.description, 'agent description', { max: 4096 }),
      instructions: text(raw.instructions, 'agent instructions', { required: true, max: MAX_INSTRUCTIONS_BYTES, trim: false }),
      model: text(raw.model, 'agent model', { max: 160 }) || null,
      effort,
      enabled: raw.enabled !== false,
      connectors,
      requiredConnectors,
      tools: stringList(raw.tools, 'tools', { identifiers: true }),
      deliverables: stringList(raw.deliverables, 'deliverables', { max: 32, itemMax: 4096 }),
      skills: normalizeSkills(raw.skills, resources, 'skills'),
    };
  });
  const rawTeams = input.teams || [];
  if (!Array.isArray(rawTeams) || rawTeams.length > 16) invalid('teams must be an array of at most 16 teams');
  const teams = rawTeams.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('team must be an object');
    const teamId = id(raw.id, 'team id');
    if (ids.has(teamId)) invalid(`team identifier collides with an agent or team: ${teamId}`);
    ids.add(teamId);
    const members = stringList(raw.members, 'team members', { max: 32, itemMax: 64 });
    if (!members.length || members.some(member => !agents.some(agent => agent.id === member))) invalid('team members must refer to agents in this package');
    const coordinator = raw.coordinator ? id(raw.coordinator, 'team coordinator') : members[0];
    if (!members.includes(coordinator)) invalid('team coordinator must be one of its members');
    return {
      id: teamId,
      name: text(raw.name || teamId, 'team name', { required: true, max: 160 }),
      description: text(raw.description, 'team description', { max: 4096 }),
      instructions: text(raw.instructions, 'team instructions', { max: MAX_INSTRUCTIONS_BYTES, trim: false }),
      members,
      coordinator,
      enabled: raw.enabled !== false,
    };
  });
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    id: packageId,
    version,
    name: text(input.name || packageId, 'package name', { required: true, max: 160 }),
    description: text(input.description, 'package description', { max: 4096 }),
    agents,
    teams,
    resources,
  };
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_PACKAGE_BYTES) invalid('agent package exceeds the 5 MiB size limit');
  return manifest;
}

function parseJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value) > MAX_PACKAGE_BYTES) invalid('agent package exceeds the 5 MiB size limit');
  try { return JSON.parse(value); } catch { invalid('agent package contains invalid JSON'); }
}

function markdownManifest(value, filename = 'agent.md') {
  const instructions = text(value, 'Markdown instructions', { required: true, max: MAX_INSTRUCTIONS_BYTES, trim: false });
  const name = instructions.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filename, path.extname(filename));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'agent';
  const packageId = `imported-${slug}-${sha(instructions).slice(0, 8)}`;
  return {
    schemaVersion: 1, id: packageId, version: '1.0.0', name,
    description: 'Imported from an instruction Markdown file.',
    agents: [{ id: 'specialist', name, description: '', instructions, tools: [], connectors: [], skills: [], deliverables: [] }],
  };
}

function manifestFromFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 251) invalid('folder import must contain 1 to 251 text files');
  const validated = files.map(raw => {
    if (!raw || typeof raw !== 'object' || raw.type === 'symlink' || raw.symlink || raw.linkTarget) invalid('folder imports cannot contain symlinks');
    const file = resourcePath(raw.path, 'folder file path');
    return { path: file, text: text(raw.text ?? raw.content, `folder file ${file}`, { max: MAX_PACKAGE_BYTES, trim: false }) };
  });
  const manifests = validated.filter(file => /(^|\/)(?:glados-agent|manifest)\.json$/.test(file.path) || file.path.endsWith('.glados-agent.json'));
  if (manifests.length !== 1) invalid('folder import must include exactly one glados-agent.json, manifest.json, or .glados-agent.json manifest');
  const selectedManifest = manifests[0];
  const prefix = selectedManifest.path.includes('/') ? selectedManifest.path.slice(0, selectedManifest.path.lastIndexOf('/') + 1) : '';
  if (validated.some(file => prefix && !file.path.startsWith(prefix))) invalid('folder files must be under the manifest directory');
  const manifest = parseJson(selectedManifest.text);
  inspectObject(manifest);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) invalid('folder manifest must be a JSON object');
  if (manifest.resources !== undefined && !Array.isArray(manifest.resources)) invalid('folder manifest resources must be an array');
  const resources = [...(manifest.resources || [])];
  for (const file of validated) {
    if (file === selectedManifest) continue;
    const relative = file.path.slice(prefix.length);
    const prior = resources.find(resource => resource.path === relative);
    if (prior && prior.text !== file.text) invalid(`folder file conflicts with embedded resource: ${relative}`);
    if (!prior) resources.push({ path: relative, text: file.text });
  }
  return { ...manifest, resources };
}

function parsePackage(input, options = {}) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) inspectObject(input);
  if (input && typeof input === 'object' && input.format === 'markdown') {
    inspectObject(input);
    return markdownManifest(input.text, input.filename || options.filename);
  }
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'package')) {
    inspectObject(input);
    return parsePackage(input.package, options);
  }
  if (options.format === 'markdown' || /\.md$/i.test(options.filename || '')) return markdownManifest(input, options.filename);
  if (input && typeof input === 'object' && Array.isArray(input.files)) return manifestFromFiles(input.files);
  return parseJson(input);
}

function readPackageFolder(directory) {
  const root = path.resolve(directory);
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) invalid('package folder must be a directory, not a symlink');
  const files = [];
  let bytes = 0;
  let directories = 0;
  function visit(dir, depth = 0) {
    if (depth > 20 || ++directories > 500) invalid('folder nesting exceeds agent package limits');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) invalid('folder imports cannot contain symlinks');
      if (stat.isDirectory()) visit(target, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_PACKAGE_BYTES || files.length >= 251) invalid('folder exceeds agent package limits');
        const contents = fs.readFileSync(target);
        const decoded = contents.toString('utf8');
        if (!Buffer.from(decoded).equals(contents)) invalid('folder resources must contain UTF-8 text');
        files.push({ path: path.relative(root, target).split(path.sep).join('/'), text: decoded });
      } else invalid('folder resources must be regular text files');
    }
  }
  visit(root);
  return { files };
}

function ensureSafeDirectory(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) invalid('package storage path escaped its root');
  let current = root;
  const ancestors = [];
  while (!statOrNull(current)) { ancestors.unshift(current); current = path.dirname(current); }
  if (statOrNull(current).isSymbolicLink()) invalid('package storage cannot use symlink directories');
  for (const dir of ancestors) fs.mkdirSync(dir, { mode: 0o700 });
  current = root;
  if (fs.lstatSync(current).isSymbolicLink()) invalid('package storage cannot use symlink directories');
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = statOrNull(current);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('package storage cannot use symlink directories');
    } else fs.mkdirSync(current, { mode: 0o700 });
  }
}

function writeFile(root, file, contents, { immutable = false } = {}) {
  ensureSafeDirectory(root, path.dirname(file));
  const stat = statOrNull(file);
  if (stat?.isSymbolicLink()) invalid('package storage cannot use symlink files');
  if (stat && !stat.isFile()) invalid('package storage files must be regular files');
  if (immutable && stat) {
    if (fs.readFileSync(file, 'utf8') !== contents) conflict('immutable package revision already exists with different contents');
    return;
  }
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function scopedAgentId(packageId, agentId) { return `pkg-${packageId}--${agentId}`; }

function createAgentPackageStore({ runtimeDir = process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'), builtInIds = [] } = {}) {
  const root = path.join(path.resolve(runtimeDir), 'agent-packages');
  const indexFile = path.join(root, 'index.json');
  const builtins = [...new Set(builtInIds)];
  function readIndex() {
    const stat = statOrNull(indexFile);
    if (!stat) return { schemaVersion: 1, packages: [] };
    if (stat.isSymbolicLink()) invalid('package index cannot be a symlink');
    let index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { throw new AgentPackageError('agent package index is unreadable', 'AGENT_PACKAGE_STORAGE_ERROR', 500); }
    inspectObject(index);
    if (index.schemaVersion !== 1 || !Array.isArray(index.packages)) throw new AgentPackageError('agent package index is invalid', 'AGENT_PACKAGE_STORAGE_ERROR', 500);
    return index;
  }
  function writeIndex(index) { writeFile(root, indexFile, `${JSON.stringify(index, null, 2)}\n`); }
  function find(index, packageId) {
    id(packageId, 'package id');
    const record = index.packages.find(item => item.id === packageId);
    if (!record) missing(`agent package not found: ${packageId}`);
    return record;
  }
  function assertRevision(record, expectedRevision) {
    if (!expectedRevision) conflict('expectedRevision is required to change an existing package');
    if (record.active?.revision !== expectedRevision) conflict('this agent package changed; reload it before saving');
  }
  function revisionFile(packageId, version, revision) {
    id(packageId, 'package id');
    if (typeof version !== 'string' || typeof revision !== 'string'
      || !VERSION_PATTERN.test(version) || !/^[a-f0-9]{64}$/.test(revision)) invalid('invalid package version or revision');
    return path.join(root, 'packages', packageId, 'versions', version, revision, 'package.json');
  }
  function readManifest(record, selector = record.active) {
    if (!selector) return null;
    const known = record.revisions.find(item => item.version === selector.version && item.revision === selector.revision);
    if (!known) missing('package revision not found');
    const file = revisionFile(record.id, selector.version, selector.revision);
    if (fs.lstatSync(file).isSymbolicLink()) invalid('package revision cannot be a symlink');
    const manifest = normalizeManifest(parseJson(fs.readFileSync(file, 'utf8')), { builtInIds: builtins });
    if (sha(JSON.stringify(manifest)) !== selector.revision) throw new AgentPackageError('agent package revision integrity check failed', 'AGENT_PACKAGE_STORAGE_ERROR', 500);
    return manifest;
  }
  function selectRevision(record, options = {}) {
    let selector = record.active;
    if (options.version !== undefined || options.revision !== undefined) {
      if (options.version !== undefined && (typeof options.version !== 'string' || !VERSION_PATTERN.test(options.version))) invalid('invalid package version');
      if (options.revision !== undefined && (typeof options.revision !== 'string' || !/^[a-f0-9]{64}$/.test(options.revision))) invalid('invalid package revision');
      const candidates = record.revisions.filter(item => (options.version === undefined || item.version === options.version)
        && (options.revision === undefined || item.revision === options.revision));
      if (!candidates.length) missing('package revision not found');
      const selected = candidates[candidates.length - 1];
      selector = { version: selected.version, revision: selected.revision };
    }
    return selector;
  }
  function view(record, options = {}) {
    const selector = selectRevision(record, options);
    const manifest = readManifest(record, selector);
    const editablePolicy = editableIntegrationPolicy(record);
    const activeMeta = record.revisions.find(item => item.revision === record.active?.revision);
    const versions = record.revisions.map(item => ({ ...item, active: item.revision === record.active?.revision, staged: item.revision !== record.active?.revision && !item.activatedAt }));
    return {
      id: record.id, name: manifest?.name || record.id, description: manifest?.description || '',
      version: record.active?.version || null, revision: record.active?.revision || null,
      activeVersion: record.active?.version || null, activeRevision: record.active?.revision || null,
      selectedVersion: selector?.version || null, selectedRevision: selector?.revision || null,
      active: record.active ? { ...record.active } : null, enabled: record.enabled !== false && !record.archived,
      archived: !!record.archived, source: activeMeta?.source || record.source,
      managedIntegration: record.managedIntegration === true, integrated: record.managedIntegration === true,
      editableIntegration: Boolean(editablePolicy),
      ...(editablePolicy ? { integrationCapabilities: {
        tools: [...editablePolicy.tools], connectors: [...editablePolicy.connectors],
        ...(editablePolicy.agentTools ? { agentTools: editablePolicy.agentTools, defaultAgentTools: ['Read', 'Glob', 'Grep'] } : {}),
      } } : {}),
      managedSource: record.managedSource || null,
      optIn: record.optIn === true,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      manifest, agentCount: manifest?.agents.length || 0, teamCount: manifest?.teams.length || 0,
      versions, revisions: versions,
      staged: versions.filter(item => item.staged),
    };
  }
  function prepare(input, options = {}) { return normalizeManifest(parsePackage(input, options), { builtInIds: builtins }); }
  function preparePublicImport(input, options = {}) {
    const manifest = prepare(input, options);
    if (manifest.teams.length) invalid('Upload individual agents only. Team integrations are installed from the GLaDOS source collection.');
    if (readIndex().packages.find(record => record.id === manifest.id)?.managedIntegration) conflict('This identity belongs to a managed integration. Update its source package instead of uploading over it.');
    return manifest;
  }
  function preview(input, options = {}) {
    const manifest = preparePublicImport(input, options);
    const revision = sha(JSON.stringify(manifest));
    const record = readIndex().packages.find(item => item.id === manifest.id);
    return {
      manifest, id: manifest.id, name: manifest.name, version: manifest.version, revision,
      agents: manifest.agents.map(agent => ({ id: agent.id, runtimeId: scopedAgentId(manifest.id, agent.id), name: agent.name, description: agent.description, model: agent.model, effort: agent.effort, connectors: agent.connectors, requiredConnectors: agent.requiredConnectors, tools: agent.tools, deliverables: agent.deliverables, skills: agent.skills.map(skill => ({ id: skill.id, name: skill.name, path: skill.path })) })),
      teams: manifest.teams, resources: manifest.resources.map(resource => ({ path: resource.path, bytes: Buffer.byteLength(resource.text) })),
      connectors: [...new Set(manifest.agents.flatMap(agent => agent.connectors))],
      requiredConnectors: [...new Set(manifest.agents.flatMap(agent => agent.requiredConnectors))],
      tools: [...new Set(manifest.agents.flatMap(agent => agent.tools))],
      existing: record ? { revision: record.active?.revision || null, version: record.active?.version || null, archived: !!record.archived } : null,
      alreadyImported: !!record?.revisions.some(item => item.revision === revision),
      willStage: !!record,
    };
  }
  function persist(manifest, { source, record, activate = false, expectedRevision, managedSource, disabledByDefault = false, packageEnabled, optIn } = {}) {
    const index = readIndex();
    const existing = index.packages.find(item => item.id === manifest.id);
    if (record && !existing) missing('agent package no longer exists');
    if (activate && existing) assertRevision(existing, expectedRevision);
    const revision = sha(JSON.stringify(manifest));
    const now = new Date().toISOString();
    const current = existing || { id: manifest.id, source, enabled: !disabledByDefault, archived: false, active: null, revisions: [], createdAt: now, updatedAt: now };
    if (managedSource) { current.managedIntegration = true; current.managedSource = managedSource; }
    if (typeof packageEnabled === 'boolean') current.enabled = packageEnabled;
    if (typeof optIn === 'boolean') current.optIn = optIn;
    writeFile(root, revisionFile(manifest.id, manifest.version, revision), `${JSON.stringify(manifest, null, 2)}\n`, { immutable: true });
    if (!current.revisions.some(item => item.revision === revision)) current.revisions.push({ version: manifest.version, revision, source, createdAt: now });
    if (!existing || activate) {
      current.active = { version: manifest.version, revision }; current.archived = false;
      current.revisions.find(item => item.revision === revision).activatedAt = now;
    }
    current.updatedAt = now;
    if (!existing) index.packages.push(current);
    writeIndex(index);
    return view(current);
  }
  function importPackage(input, options = {}) {
    const manifest = preparePublicImport(input, options);
    return persist(manifest, { source: 'imported', activate: options.activate === true, expectedRevision: options.expectedRevision });
  }
  function installIntegration(input, options = {}) {
    const manifest = prepare(input, options);
    const existing = readIndex().packages.find(record => record.id === manifest.id);
    if (existing && !existing.managedIntegration) conflict('A user package already uses this integration identity. Choose a distinct identity in the source package.');
    const managedSource = path.basename(text(options.sourcePath || `${manifest.id}.glados-agent.json`, 'integration source', { required: true, max: 4096 }));
    const policy = existing && editableIntegrationPolicy(existing);
    const previous = existing ? readManifest(existing) : null;
    const previousAgent = previous?.agents.find(agent => agent.id === policy?.agentId);
    // The original integration accidentally exposed only six knowledge tools.
    // Upgrade that exact default set, even after a prompt/model edit, while
    // respecting an operator's deliberately narrower tool selection. Preserve
    // all other fields, activation state, history, and archived status.
    if (policy && managedSource === policy.source && previousAgent
      && previousAgent.tools.length === LEGACY_CLIPPY_TOOLS.length
      && LEGACY_CLIPPY_TOOLS.every(tool => previousAgent.tools.includes(tool))) {
      previousAgent.tools = [...policy.tools];
      const source = existing.revisions.find(item => item.revision === existing.active?.revision)?.source || 'integrated';
      persist(previous, { source, record: existing, activate: true, expectedRevision: existing.active.revision, managedSource });
      const index = readIndex(); const record = find(index, manifest.id);
      record.archived = existing.archived;
      const sourceHash = sha(JSON.stringify(manifest));
      record.integrationSources = [...(record.integrationSources || []), { sourceHash, version: manifest.version, revision: record.active.revision, managedSource, installedAt: new Date().toISOString() }];
      writeIndex(index);
      return view(record);
    }
    // Once the operator edits this integration, it is their active definition.
    // App startup/build source seeding must neither overwrite it nor keep
    // offering old defaults as newly staged revisions.
    if (existing && policy
      && existing.revisions.find(item => item.revision === existing.active?.revision)?.source === 'custom') return view(existing);
    const sourceHash = sha(JSON.stringify(manifest));
    if (existing?.integrationSources?.some(item => item.sourceHash === sourceHash)) return view(existing);
    manifest.agents = manifest.agents.map(agent => ({ ...agent, enabled: previous?.agents.find(item => item.id === agent.id)?.enabled ?? agent.enabled }));
    manifest.teams = manifest.teams.map(team => ({ ...team, enabled: previous?.teams.find(item => item.id === team.id)?.enabled ?? false }));
    const result = persist(manifest, { source: 'integrated', managedSource, disabledByDefault: true });
    const index = readIndex(); const record = find(index, manifest.id);
    const revision = sha(JSON.stringify(manifest));
    record.integrationSources = [...(record.integrationSources || []), { sourceHash, version: manifest.version, revision, managedSource, installedAt: new Date().toISOString() }];
    writeIndex(index);
    return { ...result, managedIntegration: true, integrated: true, managedSource };
  }
  function create(input) {
    const manifest = prepare(input);
    if (readIndex().packages.some(item => item.id === manifest.id)) conflict(`package ${manifest.id} already exists; choose another identity or edit its current revision`);
    return persist(manifest, { source: 'custom' });
  }
  // An explicit catalog installation activates a complete team in one index
  // write. Dependencies are checked by the caller before entering this method.
  // Recovering an archived integration uses its last active operator revision.
  function installOptInIntegration(input, options = {}) {
    const sourceManifest = prepare(input, options);
    const existing = readIndex().packages.find(record => record.id === sourceManifest.id);
    const managedSource = path.basename(text(options.sourcePath || `${sourceManifest.id}.glados-agent.json`, 'integration source', { required: true, max: 4096 }));
    if (existing) {
      if (!existing.managedIntegration || existing.managedSource !== managedSource) conflict('A different package already uses this integration identity');
      assertRevision(existing, options.expectedRevision);
    }
    const manifest = existing ? readManifest(existing) : sourceManifest;
    const team = manifest.teams.find(item => item.id === options.teamId);
    if (!team) missing('This integration does not contain its expected team');
    team.enabled = true;
    const coordinator = manifest.agents.find(agent => agent.id === team.coordinator);
    if (coordinator) coordinator.enabled = true;
    const source = existing?.revisions.find(item => item.revision === existing.active?.revision)?.source || 'integrated';
    return persist(manifest, { source, ...(existing ? { record: existing, expectedRevision: options.expectedRevision } : {}),
      activate: true, managedSource, packageEnabled: true, optIn: true });
  }
  function save(packageId, input, options = {}) {
    const record = find(readIndex(), packageId);
    assertRevision(record, options.expectedRevision);
    const manifest = prepare(input);
    if (manifest.id !== packageId) invalid('editing a package cannot change its stable identity');
    const policy = editableIntegrationPolicy(record);
    if (policy) {
      if (policy.agentIds) {
        if (manifest.agents.length !== policy.agentIds.length || manifest.agents.some(agent => !policy.agentIds.includes(agent.id))
          || manifest.teams.length !== policy.teamIds.length || manifest.teams.some(team => !policy.teamIds.includes(team.id))) invalid('Editing this integration must preserve its agent and team identities');
        for (const agent of manifest.agents) {
          const allowed = policy.agentTools[agent.id] || ['Read', 'Glob', 'Grep'];
          if (agent.tools.some(tool => !allowed.includes(tool)) || agent.connectors.some(connector => !policy.connectors.includes(connector))) invalid('Herbie capabilities must stay within the supported tools for this role');
        }
      } else {
        if (manifest.agents.length !== 1 || manifest.agents[0].id !== policy.agentId || manifest.teams.length) invalid('Editing this integration must preserve its Clippy Agent identity and single-agent structure');
        const agent = manifest.agents[0];
        if (agent.tools.some(tool => !policy.tools.includes(tool)) || agent.connectors.some(connector => !policy.connectors.includes(connector))) invalid('Clippy Agent capabilities are limited to its read-only Clippy tools and connector');
      }
    }
    return persist(manifest, { source: 'custom', record, activate: true, expectedRevision: options.expectedRevision });
  }
  function activate(packageId, options = {}) {
    const index = readIndex();
    const record = find(index, packageId);
    assertRevision(record, options.expectedRevision);
    const selector = { version: options.version, revision: options.revision };
    readManifest(record, selector);
    record.active = selector;
    record.revisions.find(item => item.revision === selector.revision).activatedAt = new Date().toISOString();
    record.archived = false;
    record.updatedAt = new Date().toISOString();
    writeIndex(index);
    return view(record);
  }
  function setEnabled(packageId, enabled, options = {}) {
    if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
    const index = readIndex();
    const record = find(index, packageId);
    assertRevision(record, options.expectedRevision);
    record.enabled = enabled;
    record.updatedAt = new Date().toISOString();
    writeIndex(index);
    return view(record);
  }
  function setEntryEnabled(runtimeId, enabled, options = {}) {
    if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
    const match = /^pkg-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(runtimeId || '');
    if (!match) invalid('invalid package runtime agent identifier');
    const record = find(readIndex(), match[1]);
    assertRevision(record, options.expectedRevision);
    const manifest = readManifest(record);
    const entry = [...manifest.agents, ...manifest.teams].find(item => item.id === match[2]);
    if (!entry) missing('package runtime agent not found');
    entry.enabled = enabled;
    return save(record.id, manifest, options);
  }
  function setTeamEnabled(packageId, localId, enabled, options = {}) {
    if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
    id(localId, 'team id');
    const record = find(readIndex(), packageId);
    assertRevision(record, options.expectedRevision);
    const manifest = readManifest(record);
    const team = manifest.teams.find(item => item.id === localId);
    if (!team) missing('package team not found');
    team.enabled = enabled;
    const activeSource = record.revisions.find(item => item.revision === record.active?.revision)?.source;
    return persist(manifest, { source: record.managedIntegration && activeSource !== 'custom' ? 'integrated' : 'custom', record, activate: true,
      expectedRevision: options.expectedRevision, ...(enabled ? { packageEnabled: true } : {}) });
  }
  function remove(packageId, options = {}) {
    const index = readIndex();
    const record = find(index, packageId);
    assertRevision(record, options.expectedRevision);
    record.archived = true;
    record.enabled = false;
    record.updatedAt = new Date().toISOString();
    writeIndex(index);
    return { id: packageId, archived: true, recoverable: true };
  }
  function removeEntry(packageId, kind, localId, options = {}) {
    if (!['agent', 'team'].includes(kind)) invalid('entry kind must be agent or team');
    id(localId, `${kind} id`);
    const record = find(readIndex(), packageId);
    assertRevision(record, options.expectedRevision);
    const manifest = readManifest(record);
    const key = kind === 'agent' ? 'agents' : 'teams';
    if (!manifest[key].some(entry => entry.id === localId)) missing(`package ${kind} not found`);
    manifest[key] = manifest[key].filter(entry => entry.id !== localId);
    const deleted = { kind, id: localId };
    if (!manifest.agents.length) return { ...remove(packageId, options), deleted };
    if (kind === 'agent') manifest.teams = manifest.teams.map(team => {
      const members = team.members.filter(member => member !== localId);
      return { ...team, members, coordinator: members.includes(team.coordinator) ? team.coordinator : members[0] };
    }).filter(team => team.members.length);
    return { id: packageId, package: save(packageId, manifest, options), archived: false, deleted };
  }
  function exportPackage(packageId, options = {}) {
    const record = find(readIndex(), packageId);
    const selector = selectRevision(record, options);
    const manifest = readManifest(record, selector);
    return { filename: `${packageId}-${manifest.version}.glados-agent.json`, manifest, text: `${JSON.stringify(manifest, null, 2)}\n`, version: manifest.version, revision: selector.revision };
  }
  function projectWorkspace(manifest, revision, localId, instructions, agent) {
    const workspace = path.join(root, 'workspaces', manifest.id, revision, localId);
    ensureSafeDirectory(root, workspace);
    writeFile(root, path.join(workspace, 'AGENTS.md'), instructions, { immutable: true });
    writeFile(root, path.join(workspace, 'TOOLS.md'), `# Available capabilities\n\nTools: ${agent.tools.join(', ') || 'None selected'}\n\nConnectors: ${agent.connectors.join(', ') || 'None selected'}\n\nExpected deliverables:\n${agent.deliverables.map(item => `- ${item}`).join('\n')}\n`, { immutable: true });
    writeFile(root, path.join(workspace, 'agent.json'), `${JSON.stringify({ ...agent, id: scopedAgentId(manifest.id, localId), packageId: manifest.id, packageVersion: manifest.version, packageRevision: revision }, null, 2)}\n`, { immutable: true });
    for (const resource of manifest.resources) writeFile(root, path.join(workspace, ...resource.path.split('/')), resource.text, { immutable: true });
    for (const skill of agent.skills) {
      if (skill.instructions) writeFile(root, path.join(workspace, ...skill.path.split('/')), skill.instructions, { immutable: true });
    }
    return workspace;
  }
  function runtimeEntries({ includeDisabled = false } = {}) {
    const out = [];
    for (const record of readIndex().packages) {
      if (record.archived || !record.active || (!includeDisabled && record.enabled === false)) continue;
      const manifest = readManifest(record);
      const revision = record.active.revision;
      const source = record.revisions.find(item => item.revision === revision)?.source || record.source;
      const packageFields = { packageId: manifest.id, packageVersion: manifest.version, packageRevision: revision, packageCapabilities: true, source, subagent: true,
        managedIntegration: record.managedIntegration === true, integrated: record.managedIntegration === true,
        editableIntegration: Boolean(editableIntegrationPolicy(record)), managedSource: record.managedSource || null };
      for (const agent of manifest.agents) {
        const memberships = manifest.teams.filter(team => team.members.includes(agent.id));
        const enabled = record.enabled !== false && agent.enabled !== false;
        if (!enabled && !includeDisabled) continue;
        const workspace = projectWorkspace(manifest, revision, agent.id, agent.instructions, agent);
        out.push({ ...agent, ...packageFields, localId: agent.id, id: scopedAgentId(manifest.id, agent.id), enabled, workspace,
          skills: agent.skills.map(skill => ({ ...skill, path: path.join(workspace, ...skill.path.split('/')) })),
          teamInternal: memberships.length > 0,
          ...(memberships.length ? { teamId: scopedAgentId(manifest.id, memberships[0].id), teamCoordinatorId: scopedAgentId(manifest.id, memberships[0].id), teamMemberships: memberships.map(team => scopedAgentId(manifest.id, team.id)) } : {}),
        });
      }
      for (const team of manifest.teams) {
        const coordinator = manifest.agents.find(agent => agent.id === team.coordinator);
        const enabled = record.enabled !== false && team.enabled !== false && coordinator.enabled !== false;
        if (!enabled && !includeDisabled) continue;
        const participants = team.members.map(member => manifest.agents.find(agent => agent.id === member))
          .filter(agent => agent.enabled !== false);
        const members = participants.map(agent => scopedAgentId(manifest.id, agent.id));
        const instructions = `${coordinator.instructions}\n\n# Team: ${team.name}\n\n${team.instructions}\n\nCoordinate this package's team. Delegate only to these members: ${members.join(', ')}. Combine their work into the expected deliverables.\n`;
        const workspace = projectWorkspace(manifest, revision, team.id, instructions, coordinator);
        out.push({ ...coordinator, ...packageFields, localId: team.id, id: scopedAgentId(manifest.id, team.id), name: team.name, description: team.description || coordinator.description,
          enabled, workspace, instructions,
          skills: coordinator.skills.map(skill => ({ ...skill, path: path.join(workspace, ...skill.path.split('/')) })),
          connectors: [...coordinator.connectors],
          requiredConnectors: [...new Set(participants.flatMap(agent => agent.requiredConnectors))],
          teamCoordinator: true, teamInternal: false, teamId: scopedAgentId(manifest.id, team.id), teamMembers: members,
          team: { ...team, members, coordinator: scopedAgentId(manifest.id, team.coordinator) },
        });
      }
    }
    return out;
  }
  return {
    root, indexFile,
    list: ({ includeArchived = false } = {}) => readIndex().packages.filter(record => includeArchived || !record.archived).map(view),
    get: (packageId, options = {}) => view(find(readIndex(), packageId), options),
    preview, create, import: importPackage, importPackage, installIntegration, installOptInIntegration, importIntegration: installIntegration, save, activate, setEnabled, setEntryEnabled, setTeamEnabled, remove, removeEntry, export: exportPackage, exportPackage, runtimeEntries,
  };
}

function listPackageRuntimeEntries({ env = process.env, builtInIds = [], includeDisabled = false } = {}) {
  return createAgentPackageStore({ runtimeDir: env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'), builtInIds }).runtimeEntries({ includeDisabled });
}

module.exports = { AgentPackageError, SCHEMA_VERSION, MAX_PACKAGE_BYTES, createAgentPackageStore, listPackageRuntimeEntries, normalizeManifest, parsePackage, readPackageFolder, scopedAgentId };
