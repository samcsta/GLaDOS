const fs = require('node:fs');
const path = require('node:path');

const VERSION_FILE = path.resolve(__dirname, '..', '..', 'VERSION');
const FALLBACK_VERSION = 'v0.0.00000000.0';
const VERSION_RE = /^v(\d+\.\d+)\.(\d{8})\.(\d+)$/;

function readVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function formatVersionDate(stamp) {
  if (!/^\d{8}$/.test(stamp || '')) return null;
  const mm = stamp.slice(0, 2);
  const dd = stamp.slice(2, 4);
  const yyyy = stamp.slice(4, 8);
  return `${yyyy}-${mm}-${dd}`;
}

function getVersionInfo() {
  const version = readVersion();
  const m = VERSION_RE.exec(version);
  return {
    version,
    valid: Boolean(m),
    major: m ? m[1] : null,
    date: m ? m[2] : null,
    isoDate: m ? formatVersionDate(m[2]) : null,
    sequence: m ? Number(m[3]) : null,
    file: VERSION_FILE,
  };
}

module.exports = {
  VERSION_FILE,
  VERSION_RE,
  readVersion,
  getVersionInfo,
};
