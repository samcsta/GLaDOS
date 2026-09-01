#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseTokenHashes(value) {
  const hashes = String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!hashes.length || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('GLADOS_UPDATE_TOKEN_HASHES must contain comma-separated SHA-256 token hashes');
  }
  return hashes.map(hash => Buffer.from(hash, 'hex'));
}

function authorized(request, hashes) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const candidate = Buffer.from(tokenHash(match[1]), 'hex');
  return hashes.some(expected => expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate));
}

function contentType(file) {
  if (/\.ya?ml$/i.test(file)) return 'application/yaml; charset=utf-8';
  if (/\.json$/i.test(file)) return 'application/json; charset=utf-8';
  if (/\.zip$/i.test(file)) return 'application/zip';
  if (/\.dmg$/i.test(file)) return 'application/x-apple-diskimage';
  if (/\.deb$/i.test(file)) return 'application/vnd.debian.binary-package';
  if (/\.(?:exe|msi)$/i.test(file)) return 'application/vnd.microsoft.portable-executable';
  if (/\.AppImage$/i.test(file)) return 'application/octet-stream';
  return 'application/octet-stream';
}

function resolveUpdateFile(root, basePath, requestUrl) {
  const parsed = new URL(requestUrl, 'http://update-feed.local');
  const prefix = `${basePath.replace(/\/$/, '')}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  let relative;
  try { relative = decodeURIComponent(parsed.pathname.slice(prefix.length)); }
  catch { return null; }
  if (!relative || relative.includes('\0')) return null;
  const candidate = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!candidate.startsWith(rootPrefix)) return null;
  return candidate;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return false;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isSafeInteger(start) || start < 0) return false;
    if (end == null) end = size - 1;
  }
  if (!Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end: Math.min(end, size - 1) };
}

function createHandler({ root, basePath = '/glados', tokenHashes, requireAuth = true, trustProxyTls = false }) {
  const hashes = requireAuth
    ? (Array.isArray(tokenHashes) ? tokenHashes : parseTokenHashes(tokenHashes))
    : [];
  return (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const forwardedHttps = trustProxyTls && String(request.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
    if (!request.socket.encrypted && !forwardedHttps) {
      response.writeHead(426, { 'content-type': 'application/json' });
      response.end('{"error":"HTTPS required"}\n');
      return;
    }
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}\n');
      return;
    }
    if (requireAuth && !authorized(request, hashes)) {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="GLaDOS updates"' });
      response.end('{"error":"unauthorized"}\n');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const file = resolveUpdateFile(root, basePath, request.url);
    let stat;
    try { stat = file ? fs.statSync(file) : null; } catch {}
    if (!file || !stat?.isFile()) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}\n');
      return;
    }
    const range = parseRange(request.headers.range, stat.size);
    if (range === false) {
      response.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    const start = range?.start || 0;
    const end = range?.end ?? stat.size - 1;
    const headers = {
      'accept-ranges': 'bytes',
      'content-type': contentType(file),
      'content-length': String(end - start + 1),
      'cache-control': /\.ya?ml$/i.test(file) ? 'private, no-cache' : 'private, max-age=31536000, immutable',
      etag: `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
  };
}

function createServer(env = process.env) {
  const root = path.resolve(env.GLADOS_UPDATE_ROOT || '');
  if (!env.GLADOS_UPDATE_ROOT || !fs.statSync(root).isDirectory()) throw new Error('GLADOS_UPDATE_ROOT must be an existing directory');
  const handler = createHandler({
    root,
    basePath: env.GLADOS_UPDATE_BASE_PATH || '/glados',
    tokenHashes: env.GLADOS_UPDATE_TOKEN_HASHES,
    requireAuth: env.GLADOS_UPDATE_REQUIRE_AUTH !== '0',
    trustProxyTls: env.GLADOS_UPDATE_TRUST_PROXY_TLS === '1',
  });
  if (env.GLADOS_UPDATE_TLS_CERT && env.GLADOS_UPDATE_TLS_KEY) {
    return https.createServer({
      cert: fs.readFileSync(env.GLADOS_UPDATE_TLS_CERT),
      key: fs.readFileSync(env.GLADOS_UPDATE_TLS_KEY),
    }, handler);
  }
  if (env.GLADOS_UPDATE_TRUST_PROXY_TLS !== '1') {
    throw new Error('configure a TLS certificate/key or set GLADOS_UPDATE_TRUST_PROXY_TLS=1 behind a loopback reverse proxy');
  }
  return http.createServer(handler);
}

if (require.main === module) {
  try {
    const host = process.env.GLADOS_UPDATE_HOST || '127.0.0.1';
    if (process.env.GLADOS_UPDATE_TRUST_PROXY_TLS === '1' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('proxy-terminated TLS mode must bind the update service to loopback');
    }
    const server = createServer();
    const port = Number(process.env.PORT || 8088);
    server.listen(port, host, () => process.stdout.write(`GLaDOS private update feed listening on ${host}:${port}\n`));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { authorized, createHandler, createServer, parseRange, parseTokenHashes, resolveUpdateFile, tokenHash };
