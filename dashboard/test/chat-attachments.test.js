const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  attachmentPath,
  publicAttachment,
  storeChatAttachments,
} = require('../lib/chat-attachments');

test('screenshot attachments are type-checked and stored owner-only inside the session', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-chat-images-'));
  const env = { ...process.env, GLADOS_RUNTIME_DIR: runtimeDir };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('test')]);
  const [saved] = storeChatAttachments('session_test', [{
    name: '../screen.png', type: 'image/png', data: `data:image/png;base64,${png.toString('base64')}`,
  }], env);
  assert.equal(saved.name, 'screen.png');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved.file).mode & 0o777, 0o600);
  assert.equal(attachmentPath('session_test', saved.id, env), saved.file);
  assert.match(publicAttachment(saved, 'session_test').url, /^\/api\/chat\/attachments\//);
  assert.throws(() => storeChatAttachments('session_test', [{
    name: 'fake.png', type: 'image/png', data: Buffer.from('not png').toString('base64'),
  }], env), /do not match/);
});
