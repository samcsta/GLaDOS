const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

function attachmentsRoot(env = process.env) {
  const runtimeDir = path.resolve(env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));
  return path.resolve(env.GLADOS_CHAT_ATTACHMENTS_DIR || path.join(runtimeDir, 'attachments'));
}

function safeSessionId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(id)) throw new Error('valid session id required for attachments');
  return id;
}

function decodeAttachmentData(value) {
  const raw = String(value || '');
  const match = raw.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  const base64 = match ? match[2] : raw;
  if (!base64 || !/^[a-zA-Z0-9+/=\s]+$/.test(base64)) throw new Error('attachment must contain base64 image data');
  return Buffer.from(base64.replace(/\s+/g, ''), 'base64');
}

function matchesMagic(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') return bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function storeChatAttachments(sessionId, input = [], env = process.env) {
  const rows = Array.isArray(input) ? input : [];
  if (rows.length > MAX_ATTACHMENTS) throw new Error(`attach at most ${MAX_ATTACHMENTS} screenshots`);
  if (!rows.length) return [];
  const session = safeSessionId(sessionId);
  const root = attachmentsRoot(env);
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(dir, 0o700);
  let total = 0;
  return rows.map(row => {
    const mimeType = String(row?.type || row?.mimeType || '').toLowerCase();
    const extension = MIME_EXTENSIONS[mimeType];
    if (!extension) throw new Error('screenshots must be PNG, JPEG, WebP, or GIF images');
    const bytes = decodeAttachmentData(row?.data || row?.dataUrl);
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('each screenshot must be 8 MB or smaller');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('attached screenshots must total 20 MB or less');
    if (!matchesMagic(bytes, mimeType)) throw new Error(`attachment bytes do not match ${mimeType}`);
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${extension}`;
    const file = path.join(dir, id);
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    const name = path.basename(String(row?.name || `Screenshot${extension}`)).slice(0, 160);
    return { id, name, mimeType, size: bytes.length, file };
  });
}

function attachmentPath(sessionId, id, env = process.env) {
  const session = safeSessionId(sessionId);
  const safeId = path.basename(String(id || ''));
  if (!/^[a-z0-9-]+\.(png|jpg|webp|gif)$/i.test(safeId)) return null;
  const root = attachmentsRoot(env);
  const file = path.resolve(root, session, safeId);
  const expectedDir = `${path.resolve(root, session)}${path.sep}`;
  return file.startsWith(expectedDir) ? file : null;
}

function publicAttachment(row, sessionId) {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    url: `/api/chat/attachments/${encodeURIComponent(row.id)}?session_id=${encodeURIComponent(sessionId)}`,
  };
}

module.exports = {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_BYTES,
  MIME_EXTENSIONS,
  attachmentPath,
  attachmentsRoot,
  decodeAttachmentData,
  publicAttachment,
  storeChatAttachments,
};
