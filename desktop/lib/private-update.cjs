function validateFeedUrl(value, { allowInsecureLocalhost = false } = {}) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw new Error('update feed must be a valid HTTPS URL'); }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowInsecureLocalhost && parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('update feed must use HTTPS');
  }
  if (parsed.username || parsed.password) throw new Error('update feed URL cannot contain credentials');
  if (parsed.search || parsed.hash) throw new Error('update feed URL cannot contain a query string or fragment');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (token.length < 16) throw new Error('update access token must be at least 16 characters');
  if (token.length > 8192) throw new Error('update access token is too large');
  if (/\p{C}/u.test(token)) throw new Error('update access token contains control characters');
  return token;
}

module.exports = {
  validateFeedUrl,
  validateToken,
};
