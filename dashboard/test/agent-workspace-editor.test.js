const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAgentWorkspaceEditor, PROMPT_FILES } = require('../lib/agent-workspace-editor');
const { assembleAgentPrompt, mountedToolsForAgent } = require('../lib/harness/agent-sdk');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-workspace-editor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'agents');
  const workspace = path.join(workspaceRoot, 'webapp-recon');
  fs.mkdirSync(path.join(workspace, 'skills', 'example'), { recursive: true });
  for (const name of PROMPT_FILES.filter(name => name !== 'USER.md')) fs.writeFileSync(path.join(workspace, name), `Original ${name}\r\n`);
  fs.writeFileSync(path.join(workspace, 'agent.json'), '{"name":"Original","model":"original-model","enabled":true}\n');
  fs.writeFileSync(path.join(workspace, 'skills', 'example', 'SKILL.md'), 'description: An original skill\n');
  fs.writeFileSync(path.join(workspace, 'skills', 'legacy.skill'), 'description: Legacy skill\n');
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'webapp-recon' }]));
  let active = [];
  const editor = createAgentWorkspaceEditor({ workspaceRoot, registryPath, activeAgentIds: () => active, availableToolsForAgent: () => ['Read', 'Bash', 'Write'] });
  return { root, workspaceRoot, workspace, editor, setActive: value => { active = value; } };
}
function fingerprint(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map(name => {
    const file = path.join(root, name); const stat = fs.lstatSync(file);
    return [name, stat.mtimeMs, stat.mode, stat.isFile() ? fs.readFileSync(file).toString('base64') : null];
  });
}

test('reading and no-op saving preserve every workspace byte, timestamp, mode and absent document', t => {
  const f = fixture(t); const before = fingerprint(f.root);
  const snapshot = f.editor.read('webapp-recon');
  assert.deepEqual(snapshot.loadOrder, PROMPT_FILES);
  assert.equal(snapshot.documents.find(doc => doc.name === 'USER.md').exists, false);
  assert.ok(snapshot.documents.some(doc => doc.name === 'skills/legacy.skill'));
  assert.ok(snapshot.documents.some(doc => doc.name === 'skills/example/SKILL.md'));
  assert.equal(f.editor.save('webapp-recon', { expectedRevision: snapshot.revision, documents: {} }).changed, 0);
  assert.equal(f.editor.save('webapp-recon', { expectedRevision: snapshot.revision, documents: { 'AGENTS.md': snapshot.documents.find(doc => doc.name === 'AGENTS.md').content } }).changed, 0);
  assert.deepEqual(fingerprint(f.root), before);
});

test('explicit edit changes the actual assembled prompt, backs up originals, and preserves metadata and other documents', t => {
  const f = fixture(t); const before = f.editor.read('webapp-recon');
  const env = { ...process.env, GLADOS_RUNTIME_DIR: f.root, GLADOS_AGENT_WORKSPACES: f.workspaceRoot, GLADOS_SECURITY_REVIEW: '0' };
  const assemble = () => assembleAgentPrompt('webapp-recon', { workspaceRoot: f.workspaceRoot, env });
  assert.match(assemble().prompt, /Original AGENTS.md/);
  const metadata = fs.readFileSync(path.join(f.workspace, 'agent.json'), 'utf8');
  const after = f.editor.save('webapp-recon', { expectedRevision: before.revision, documents: { 'AGENTS.md': 'Explicit operator instruction\n' } });
  assert.equal(after.changed, 1); assert.notEqual(after.revision, before.revision);
  const prompt = assemble();
  assert.match(prompt.prompt, /Explicit operator instruction/); assert.doesNotMatch(prompt.prompt, /Original AGENTS.md/);
  assert.deepEqual(prompt.files, PROMPT_FILES.filter(name => name !== 'USER.md'));
  for (const doc of before.documents.filter(doc => doc.name !== 'AGENTS.md')) assert.deepEqual(after.documents.find(row => row.name === doc.name), doc);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'agent.json'), 'utf8'), metadata);
  const history = path.join(f.workspace, '.instruction-history');
  const backups = fs.readdirSync(history); assert.equal(backups.length, 1);
  const backup = path.join(history, backups[0], 'before.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(backup)), { ...before, configurationBefore: metadata });
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(history).mode & 0o777, 0o700);
});

test('stale revisions, active turns, invalid identities and unsupported files cannot write', t => {
  const f = fixture(t); const snapshot = f.editor.read('webapp-recon');
  const before = fingerprint(f.root);
  for (const documents of [{ '../AGENTS.md': 'bad' }, { 'agent.json': '{}' }, { 'AGENTS.md': null }, { 'AGENTS.md': '\0' }, { 'AGENTS.md': 'x'.repeat(256 * 1024 + 1) }]) {
    assert.throws(() => f.editor.save('webapp-recon', { expectedRevision: snapshot.revision, documents }));
  }
  for (const id of ['../webapp-recon', 'pkg-herbie--coordinator', 'unknown']) assert.throws(() => f.editor.read(id));
  assert.throws(() => f.editor.save('webapp-recon', { expectedRevision: 'stale', documents: { 'AGENTS.md': 'bad' } }), error => error.status === 409);
  f.setActive(['webapp-recon']);
  assert.throws(() => f.editor.save('webapp-recon', { expectedRevision: snapshot.revision, documents: { 'AGENTS.md': 'bad' } }), error => error.status === 409);
  assert.deepEqual(fingerprint(f.root), before);
});

test('symlinked files and history directories cannot escape the workspace', t => {
  const f = fixture(t); const original = fs.readFileSync(path.join(f.workspace, 'AGENTS.md'));
  const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'outside');
  fs.unlinkSync(path.join(f.workspace, 'AGENTS.md')); fs.symlinkSync(outside, path.join(f.workspace, 'AGENTS.md'));
  assert.throws(() => f.editor.read('webapp-recon'), /symlink/);
  fs.unlinkSync(path.join(f.workspace, 'AGENTS.md')); fs.writeFileSync(path.join(f.workspace, 'AGENTS.md'), original);
  fs.symlinkSync(f.root, path.join(f.workspace, '.instruction-history'));
  const revision = f.editor.read('webapp-recon').revision;
  assert.throws(() => f.editor.save('webapp-recon', { expectedRevision: revision, documents: { 'AGENTS.md': 'bad' } }), /symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'AGENTS.md')), original);
});


test('explicit tool edits only narrow the existing role policy, preserve prompt bytes, and can be reversed', t => {
  const f = fixture(t);
  const options = { workspaceRoot: f.workspaceRoot, env: { ...process.env, GLADOS_RUNTIME_DIR: f.root, GLADOS_TEAM_ID: 'glados', GLADOS_CLIPPY_MCP: '0', GLADOS_BROWSER_MCP: '0', GLADOS_SECURITY_REVIEW: '0' } };
  const policy = { agents: { 'webapp-recon': { tools: ['Read', 'Bash', 'Write'] } } };
  const original = f.editor.read('webapp-recon');
  const originalPrompt = assembleAgentPrompt('webapp-recon', options).prompt;
  assert.deepEqual(mountedToolsForAgent('webapp-recon', policy, options), ['Read', 'Bash', 'Write']);
  assert.throws(() => f.editor.save('webapp-recon', { expectedRevision: original.revision, disabledTools: ['arbitrary-new-tool'] }), /existing tools/);
  const edited = f.editor.save('webapp-recon', { expectedRevision: original.revision, disabledTools: ['Bash'] });
  assert.deepEqual(mountedToolsForAgent('webapp-recon', policy, options), ['Read', 'Write']);
  assert.deepEqual(mountedToolsForAgent('webapp-recon', policy, { ...options, ignoreAgentToolRestrictions: true }), ['Read', 'Bash', 'Write']);
  assert.equal(assembleAgentPrompt('webapp-recon', options).prompt, originalPrompt);
  assert.deepEqual(edited.documents, original.documents);
  const meta = JSON.parse(fs.readFileSync(path.join(f.workspace, 'agent.json')));
  assert.equal(meta.name, 'Original'); assert.equal(meta.model, 'original-model'); assert.equal(meta.enabled, true);
  f.editor.save('webapp-recon', { expectedRevision: edited.revision, disabledTools: [] });
  assert.deepEqual(mountedToolsForAgent('webapp-recon', policy, options), ['Read', 'Bash', 'Write']);
});
