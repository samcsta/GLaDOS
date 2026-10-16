const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROMPT_FILES = ['IDENTITY.md', 'SOUL.md', 'RUNBOOK.md', 'TOOLS.md', 'USER.md', 'AGENTS.md'];
const MAX_FILE_BYTES = 256 * 1024;
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }

function createAgentWorkspaceEditor({ workspaceRoot, registryPath, activeAgentIds = () => [], availableToolsForAgent = () => [] }) {
  const root = path.resolve(workspaceRoot);
  function workspace(id) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !(Array.isArray(registry) ? registry : registry.agents || []).some(row => row.id === id)) fail('Built-in agent not found', 404);
    const directory = path.join(root, id);
    safe(directory);
    if (!fs.existsSync(directory)) fail('Agent workspace not initialized', 404);
    return directory;
  }
  function safe(file) {
    if (file !== root && !file.startsWith(root + path.sep)) fail('Invalid workspace path');
    let current = root;
    for (const part of ['', ...path.relative(root, file).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) fail('Agent editor paths cannot contain symlinks'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function read(id) {
    const directory = workspace(id);
    const names = [...PROMPT_FILES];
    const skills = path.join(directory, 'skills'); safe(skills);
    if (fs.existsSync(skills)) {
      for (const entry of fs.readdirSync(skills, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && /^[a-zA-Z0-9_.-]+\.skill$/.test(entry.name)) names.push(`skills/${entry.name}`);
        if (entry.isDirectory() && /^[a-zA-Z0-9_.-]+$/.test(entry.name)) {
          const file = path.join(skills, entry.name, 'SKILL.md'); safe(file);
          if (fs.existsSync(file)) names.push(`skills/${entry.name}/SKILL.md`);
        }
      }
    }
    if (names.length > 106) fail('Too many agent skill files');
    const documents = names.map(name => {
      const file = path.join(directory, name); safe(file);
      if (!fs.existsSync(file)) return { name, exists: false, content: null };
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail(`Cannot edit ${name}: not a supported text file`);
      return { name, exists: true, content: fs.readFileSync(file, 'utf8') };
    });
    const configurationFile = path.join(directory, 'agent.json'); safe(configurationFile);
    const configurationExists = fs.existsSync(configurationFile);
    const configuration = configurationExists ? fs.readFileSync(configurationFile, 'utf8') : null;
    const metadata = configuration ? JSON.parse(configuration) : {};
    const disabledTools = Array.isArray(metadata.disabledTools) ? metadata.disabledTools : [];
    const availableTools = [...new Set(availableToolsForAgent(id))].sort();
    const revision = crypto.createHash('sha256').update(JSON.stringify({ documents, configuration, availableTools })).digest('hex');
    return { agentId: id, workspace: directory, revision, documents, loadOrder: [...PROMPT_FILES],
      availableTools, disabledTools };

  }
  function save(id, { expectedRevision, documents = {}, disabledTools } = {}) {
    const before = read(id);
    if (!expectedRevision || expectedRevision !== before.revision) fail('Agent instructions changed. Reload before saving.', 409);
    if (activeAgentIds().includes(id)) fail('Finish or stop this agent before changing its instructions.', 409);
    if (!documents || typeof documents !== 'object' || Array.isArray(documents)) fail('Instruction documents are required');
    const allowed = new Map(before.documents.map(doc => [doc.name, doc]));
    const changes = Object.entries(documents).map(([name, content]) => {
      if (!allowed.has(name)) fail('Only the listed instruction and skill documents can be edited');
      if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_FILE_BYTES) fail(`Invalid document: ${name}`);
      return { name, content, before: allowed.get(name) };
    }).filter(row => row.content !== row.before.content);
    const configurationFile = path.join(before.workspace, 'agent.json'); safe(configurationFile);
    const configurationExists = fs.existsSync(configurationFile);
    const configuration = configurationExists ? fs.readFileSync(configurationFile, 'utf8') : null;
    if (disabledTools !== undefined) {
      const allowed = new Set([...before.availableTools, ...before.disabledTools]);
      if (!Array.isArray(disabledTools) || disabledTools.length > 1000 || disabledTools.some(tool => typeof tool !== 'string' || !allowed.has(tool)) || new Set(disabledTools).size !== disabledTools.length) fail('Choose only this agent’s existing tools');
      if (JSON.stringify([...disabledTools].sort()) !== JSON.stringify([...before.disabledTools].sort())) {
        changes.push({ name: 'agent.json', content: `${JSON.stringify({ ...(configuration ? JSON.parse(configuration) : {}), disabledTools: [...disabledTools].sort() }, null, 2)}\n`, before: { exists: configurationExists, content: configuration } });
      }
    }
    if (!changes.length) return { ...before, changed: 0 };
    const backupDir = path.join(before.workspace, '.instruction-history', crypto.randomUUID()); safe(backupDir);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(path.dirname(backupDir), 0o700);
    fs.writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify({ ...before, configurationBefore: configuration }), { mode: 0o600, flag: 'wx' });
    const staged = [];
    try {
      for (const change of changes) {
        const target = path.join(before.workspace, change.name); safe(target);
        const temp = path.join(path.dirname(target), `.instruction-${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temp, change.content, { mode: 0o600, flag: 'wx' });
        staged.push({ ...change, target, temp });
      }
      // Check again after staging, before replacing any live document.
      if (read(id).revision !== before.revision) fail('Agent instructions changed. Reload before saving.', 409);
      const applied = [];
      try {
        for (const row of staged) { safe(row.target); fs.renameSync(row.temp, row.target); applied.push(row); }
      } catch (error) {
        for (const row of applied.reverse()) {
          if (row.before.exists) fs.writeFileSync(row.target, row.before.content, { mode: 0o600 });
          else fs.unlinkSync(row.target);
        }
        throw error;
      }
    } finally { for (const row of staged) { try { fs.unlinkSync(row.temp); } catch {} } }
    return { ...read(id), changed: changes.length };
  }
  return { read, save };
}

module.exports = { createAgentWorkspaceEditor, PROMPT_FILES };
