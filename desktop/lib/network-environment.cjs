const LOCAL_BYPASS_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const REQUIRED_NODE_OPTIONS = ['--use-system-ca', '--use-env-proxy'];

function appendNodeOptions(current = '', required = REQUIRED_NODE_OPTIONS) {
  const parts = String(current || '').trim().split(/\s+/).filter(Boolean);
  for (const option of required) {
    if (!parts.includes(option)) parts.push(option);
  }
  return parts.join(' ');
}

function mergeNoProxy(current = '') {
  const values = String(current || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const host of LOCAL_BYPASS_HOSTS) {
    if (!values.includes(host)) values.push(host);
  }
  return values.join(',');
}

function proxyUrlFromPacResult(value = '') {
  for (const directive of String(value || '').split(';')) {
    const [kindRaw, endpointRaw] = directive.trim().split(/\s+/, 2);
    const kind = String(kindRaw || '').toUpperCase();
    const endpoint = String(endpointRaw || '').trim();
    if (!endpoint || kind === 'DIRECT') continue;
    if (kind === 'PROXY' || kind === 'HTTP') return `http://${endpoint}`;
    if (kind === 'HTTPS') return `https://${endpoint}`;
    if (kind === 'SOCKS' || kind === 'SOCKS5') return `socks5://${endpoint}`;
  }
  return null;
}

async function systemNetworkEnvironment(options = {}) {
  const env = options.env || process.env;
  const next = {
    NODE_OPTIONS: appendNodeOptions(env.NODE_OPTIONS),
    NO_PROXY: mergeNoProxy(env.NO_PROXY || env.no_proxy),
  };
  const explicitProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (explicitProxy) return next;
  if (typeof options.resolveProxy !== 'function') return next;

  try {
    const resolved = await options.resolveProxy(options.url);
    const proxyUrl = proxyUrlFromPacResult(resolved);
    if (proxyUrl) {
      next.HTTPS_PROXY = proxyUrl;
      next.HTTP_PROXY = proxyUrl;
    }
  } catch {}
  return next;
}

module.exports = {
  LOCAL_BYPASS_HOSTS,
  REQUIRED_NODE_OPTIONS,
  appendNodeOptions,
  mergeNoProxy,
  proxyUrlFromPacResult,
  systemNetworkEnvironment,
};
