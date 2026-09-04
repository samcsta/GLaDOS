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
  const wikiUrl = 'https://wiki.r3dt34m.net/rt/glados';
  const logoPath = `${installerBasePath.replace(/\/$/, '')}/linux/glados.png`;
  const platforms = [
    {
      directory: 'macos', title: 'macOS', mark: 'M', status: 'Maintained',
      detail: 'Apple silicon · macOS 13 or newer', note: 'Developer ID signed and Apple notarized',
      pattern: /^GLaDOS-.*-arm64\.dmg$/i, action: 'Download DMG',
    },
    {
      directory: 'linux', title: 'Linux', mark: 'L', status: 'Maintained',
      detail: 'Fedora, Kali/Debian, or Ubuntu · x86-64', note: 'One tested AppImage for every supported distro',
      pattern: /^GLaDOS-.*-(?:x86_64|x64)\.AppImage$/i, action: 'Download AppImage',
      setupPath: `${installerBasePath}/linux/install-glados-linux.sh`,
      setupLabel: 'Download easy installer',
      setupHint: '<code>bash ~/Downloads/install-glados-linux.sh</code>',
    },
    {
      directory: 'windows', title: 'Windows', mark: 'W', status: 'Source build',
      detail: 'Windows 11 x64 · build releases from source', note: 'Native compatibility tested on each major release',
      sourceUrl: 'https://git.r3dt34m.net/scosta44/glados',
    },
  ];
  const cards = platforms.map(platform => {
    const heading = `<div class="platform-row"><span class="platform-mark">${platform.mark}</span><div><h3>${platform.title}</h3><span class="status">${platform.status}</span></div></div><p>${platform.detail}</p><span class="note">${platform.note}</span>`;
    if (platform.sourceUrl) {
      const source = escapeHtml(platform.sourceUrl);
      return `<article class="card">${heading}<div class="card-actions"><a class="download" href="${source}" rel="noreferrer">Open Gitea source</a><span class="hint">No official Windows binaries are published.</span></div></article>`;
    }
    const installer = latestInstaller(installerRoot, platform.directory, platform.pattern);
    const setup = installer && platform.setupPath
      ? `<a class="download" href="${platform.setupPath}" download>${platform.setupLabel}</a><span class="hint">Then run ${platform.setupHint}</span>`
      : '';
    const download = installer
      ? `${setup}<a class="${setup ? 'secondary' : 'download'}" href="${installerBasePath}/${platform.directory}/${encodeURIComponent(installer.name)}" download>${platform.action}</a><span class="version">Version ${installer.version.join('.')}</span>`
      : '<span class="unavailable">Coming soon</span>';
    return `<article class="card">${heading}<div class="card-actions">${download}</div></article>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#090b0f"><title>Download GLaDOS · Red Team</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a0d;color:#f7f8fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#080a0d;overflow-x:hidden}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 16% 0,rgba(216,55,58,.2),transparent 34%),radial-gradient(circle at 82% 9%,rgba(255,174,41,.09),transparent 26%),linear-gradient(155deg,#11151b 0,#090b0f 48%,#060709 100%)}main{position:relative;width:min(1120px,calc(100% - 40px));margin:0 auto;padding:64px 0 38px}.hero{display:grid;grid-template-columns:210px 1fr;gap:48px;align-items:center;padding:34px;border:1px solid rgba(255,255,255,.1);border-radius:28px;background:linear-gradient(145deg,rgba(25,29,36,.94),rgba(12,14,18,.88));box-shadow:0 28px 90px rgba(0,0,0,.38);overflow:hidden}.logo-shell{position:relative;display:grid;place-items:center}.logo-shell:before{content:"";position:absolute;width:86%;height:86%;border-radius:50%;background:#d63338;filter:blur(34px);opacity:.22}.logo{position:relative;display:block;width:min(100%,190px);height:auto;filter:drop-shadow(0 20px 24px rgba(0,0,0,.48))}.eyebrow{display:flex;align-items:center;gap:9px;color:#ffb34d;font-size:.76rem;font-weight:800;letter-spacing:.17em;text-transform:uppercase}.eyebrow:before{content:"";width:8px;height:8px;border-radius:50%;background:#e7474b;box-shadow:0 0 18px #e7474b}h1{font-size:clamp(3.4rem,8vw,6.6rem);line-height:.86;margin:.2em 0 .22em;letter-spacing:-.065em}.hero p{max-width:720px;margin:0;color:#aeb5c0;font-size:1.05rem;line-height:1.65}.hero-actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:25px}.wiki{display:inline-flex;align-items:center;gap:9px;padding:11px 15px;border:1px solid rgba(255,255,255,.14);border-radius:11px;color:#f5f7fa;background:rgba(255,255,255,.05);text-decoration:none;font-weight:720}.wiki:hover{border-color:#e64d51;background:rgba(230,77,81,.12)}.release-note{color:#777f8b;font-size:.82rem}.download-section{margin-top:50px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;margin:0 4px 18px}.section-heading h2{font-size:1.45rem;margin:0}.section-heading p{margin:0;color:#777f8b;font-size:.87rem}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{position:relative;min-height:330px;padding:24px;border:1px solid rgba(255,255,255,.1);border-radius:20px;background:linear-gradient(160deg,rgba(24,28,34,.96),rgba(12,14,18,.96));display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.2);overflow:hidden}.card:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,#e3484c,#f0a139,transparent)}.platform-row{display:flex;align-items:center;gap:13px}.platform-mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(255,255,255,.13);border-radius:12px;color:#fff;background:#20252d;font-weight:850}.platform-row h3{margin:0 0 3px;font-size:1.17rem}.status{color:#f1a74a;font-size:.7rem;font-weight:780;letter-spacing:.08em;text-transform:uppercase}.card>p{margin:22px 0 0;color:#abb2bd;line-height:1.5}.note{display:block;margin-top:9px;color:#717a86;font-size:.78rem;line-height:1.4}.card-actions{display:flex;flex-direction:column;margin-top:auto;padding-top:26px}.download,.unavailable{border-radius:11px;padding:12px 14px;text-align:center;font-weight:780}.download{background:linear-gradient(135deg,#e94b50,#c83237);color:#fff;text-decoration:none;box-shadow:0 10px 24px rgba(203,48,54,.2)}.download:hover{background:linear-gradient(135deg,#f15b60,#da3b41)}.secondary{color:#f0aa51;text-align:center;margin-top:13px;font-size:.84rem;text-decoration:none}.secondary:hover{color:#ffc274}.hint{color:#777f8b;text-align:center;font-size:.74rem;line-height:1.45;margin-top:9px}.hint code{color:#b9c0c9}.unavailable{border:1px solid #343a43;color:#7d8590}.version{margin-top:10px;color:#777f8b;text-align:center;font-size:.78rem}footer{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;margin:34px 4px 0;color:#666f7b;font-size:.8rem}footer a{color:#aeb5c0;text-decoration:none}footer a:hover{color:#fff}@media(max-width:820px){main{padding-top:28px}.hero{grid-template-columns:1fr;text-align:center;gap:18px;padding:30px 24px}.logo{width:150px}.eyebrow,.hero-actions{justify-content:center}.hero p{margin-inline:auto}.grid{grid-template-columns:1fr}.card{min-height:290px}.section-heading{align-items:start;flex-direction:column;gap:5px}}@media(max-width:460px){main{width:min(100% - 24px,1120px)}h1{font-size:3.4rem}.hero{border-radius:20px}.section-heading p{line-height:1.45}}
</style></head><body><main><header class="hero"><div class="logo-shell"><img class="logo" src="${escapeHtml(logoPath)}" alt="GLaDOS logo" width="190" height="190"></div><div><div class="eyebrow">Red Team operator platform</div><h1>GLaDOS</h1><p>Install the maintained desktop application for macOS or Linux, or build the compatibility-tested Windows release from source. Connect to the Red Team VPN before downloading.</p><div class="hero-actions"><a class="wiki" href="${wikiUrl}" rel="noreferrer">Read the GLaDOS wiki <span aria-hidden="true">↗</span></a><span class="release-note">Private distribution · current release shown below</span></div></div></header><section class="download-section"><div class="section-heading"><h2>Choose your platform</h2><p>Signed releases and verified source from Red Team infrastructure</p></div><div class="grid">${cards}</div></section><footer><span>GLaDOS desktop distribution · Red Team VPN required</span><a href="${wikiUrl}" rel="noreferrer">Documentation and installation guide</a></footer></main></body></html>`;
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
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'x-frame-options': 'DENY',
      });
      if (request.method === 'HEAD') return response.end();
      response.end(body);
      return;
    }
    if (pathname.startsWith(`${basePath.replace(/\/$/, '')}/windows/`)
      || pathname.startsWith(`${installerBasePath.replace(/\/$/, '')}/windows/`)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"Windows binaries are not published"}\n');
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
