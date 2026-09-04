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
  if (/\.sh$/i.test(file)) return 'text/x-shellscript; charset=utf-8';
  if (/\.ps1$/i.test(file)) return 'text/plain; charset=utf-8';
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.ya?ml$/i.test(file)) return 'application/yaml; charset=utf-8';
  if (/\.json$/i.test(file)) return 'application/json; charset=utf-8';
  if (/\.zip$/i.test(file)) return 'application/zip';
  if (/\.dmg$/i.test(file)) return 'application/x-apple-diskimage';
  if (/\.deb$/i.test(file)) return 'application/vnd.debian.binary-package';
  if (/\.(?:exe|msi)$/i.test(file)) return 'application/vnd.microsoft.portable-executable';
  if (/\.AppImage$/i.test(file)) return 'application/octet-stream';
  return 'application/octet-stream';
}

function immutableArtifact(file) {
  const name = path.basename(file);
  if (/\.ya?ml$/i.test(name) || /\.(?:sh|ps1)$/i.test(name)) return false;
  if (/^glados\.png$/i.test(name)) return false;
  return /\d+\.\d+\.\d+/.test(name);
}

function installerVersion(name) {
  const match = String(name).match(/-(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?(?:-|\.)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function latestInstaller(root, platform, pattern) {
  if (!root) return null;
  const directory = path.join(root, platform);
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return null; }
  return entries
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => ({ name: entry.name, version: installerVersion(entry.name) }))
    .filter(entry => entry.version)
    .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderDownloadPage(installerRoot, installerBasePath = '/installers') {
  const platforms = [
    {
      directory: 'macos', title: 'macOS', detail: 'Apple silicon · macOS 13 or newer',
      pattern: /^GLaDOS-.*-arm64\.dmg$/i, action: 'Download DMG',
    },
    {
      directory: 'linux', title: 'Linux', detail: 'Fedora, Kali/Debian, or Ubuntu · x86-64',
      pattern: /^GLaDOS-.*-(?:x86_64|x64)\.AppImage$/i, action: 'Download AppImage',
      setupPath: `${installerBasePath}/linux/install-glados-linux.sh`,
      setupLabel: 'Download easy installer',
      setupHint: '<code>bash ~/Downloads/install-glados-linux.sh</code>',
    },
    {
      directory: 'windows', title: 'Windows', detail: 'Windows 11 · Intel/AMD 64-bit',
      pattern: /^GLaDOS-.*-(?:x86_64|x64).*(?:\.exe|\.msi)$/i, action: 'Download installer',
      setupPath: `${installerBasePath}/windows/install-glados-windows.ps1`,
      setupLabel: 'Download setup script',
      setupHint: '<code>powershell -ExecutionPolicy Bypass -File .\\install-glados-windows.ps1</code>',
    },
  ];
  const cards = platforms.map(platform => {
    const installer = latestInstaller(installerRoot, platform.directory, platform.pattern);
    const setup = installer && platform.setupPath
      ? `<a class="download" href="${platform.setupPath}" download>${platform.setupLabel}</a><span class="hint">Then run ${platform.setupHint}</span>`
      : '';
    const download = installer
      ? `${setup}<a class="${setup ? 'secondary' : 'download'}" href="${installerBasePath}/${platform.directory}/${encodeURIComponent(installer.name)}" download>${platform.action}</a><span class="version">Version ${installer.version.join('.')}</span>`
      : '<span class="unavailable">Coming soon</span>';
    return `<section class="card"><h2>${platform.title}</h2><p>${platform.detail}</p>${download}</section>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download GLaDOS</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090d0f;color:#f5f7f8}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 0,#24343a 0,#0d1417 42%,#090d0f 75%)}main{width:min(1040px,calc(100% - 40px));margin:0 auto;padding:80px 0}header{max-width:700px;margin-bottom:42px}.eyebrow{color:#8ae6c1;font-size:.78rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase}h1{font-size:clamp(2.5rem,7vw,5.5rem);line-height:.95;margin:.35em 0 .25em;letter-spacing:-.06em}header p{color:#aebbc0;font-size:1.08rem;line-height:1.65}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{min-height:230px;padding:25px;border:1px solid #2a3a3f;border-radius:18px;background:rgba(17,25,28,.88);display:flex;flex-direction:column}.card h2{margin:0 0 8px;font-size:1.2rem}.card p{margin:0;color:#94a4aa;line-height:1.5}.download,.unavailable{margin-top:auto;border-radius:10px;padding:12px 14px;text-align:center;font-weight:750}.download{background:#75e0b5;color:#07120e;text-decoration:none}.download:hover{background:#98edca}.secondary{color:#8ae6c1;text-align:center;margin-top:12px;font-size:.84rem}.hint{color:#89999f;text-align:center;font-size:.76rem;line-height:1.45;margin-top:10px}.hint code{color:#bac8cc}.unavailable{border:1px solid #33454b;color:#76868c}.version{margin-top:10px;color:#7d8d92;text-align:center;font-size:.8rem}footer{margin-top:38px;color:#718086;font-size:.85rem}@media(max-width:760px){main{padding:50px 0}.grid{grid-template-columns:1fr}.card{min-height:190px}}
</style></head><body><main><header><div class="eyebrow">Red Team software</div><h1>Download GLaDOS</h1><p>Connect to the Red Team VPN, choose your operating system, and launch the installer. Linux supports Fedora, Kali/Debian, and Ubuntu on x86-64. Once installed, GLaDOS checks this private release channel and offers future updates in the app.</p></header><div class="grid">${cards}</div><footer>Private distribution · Red Team VPN required</footer></main></body></html>`;
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

function createHandler({
  root,
  basePath = '/glados',
  installerRoot = null,
  installerBasePath = '/installers',
  tokenHashes,
  requireAuth = true,
  trustProxyTls = false,
}) {
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
    const pathname = new URL(request.url, 'http://update-feed.local').pathname;
    if (pathname === '/' || pathname === '/downloads') {
      const body = renderDownloadPage(installerRoot, installerBasePath);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'private, no-cache',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'x-frame-options': 'DENY',
      });
      if (request.method === 'HEAD') return response.end();
      response.end(body);
      return;
    }
    const file = resolveUpdateFile(root, basePath, request.url)
      || (installerRoot ? resolveUpdateFile(installerRoot, installerBasePath, request.url) : null);
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
      'cache-control': immutableArtifact(file) ? 'private, max-age=31536000, immutable' : 'private, no-cache',
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
  const installerRoot = env.GLADOS_INSTALLER_ROOT ? path.resolve(env.GLADOS_INSTALLER_ROOT) : null;
  if (installerRoot && !fs.statSync(installerRoot).isDirectory()) {
    throw new Error('GLADOS_INSTALLER_ROOT must be an existing directory');
  }
  const handler = createHandler({
    root,
    basePath: env.GLADOS_UPDATE_BASE_PATH || '/glados',
    installerRoot,
    installerBasePath: env.GLADOS_INSTALLER_BASE_PATH || '/installers',
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

module.exports = {
  authorized, createHandler, createServer, immutableArtifact, latestInstaller, parseRange, parseTokenHashes,
  renderDownloadPage, resolveUpdateFile, tokenHash,
};
