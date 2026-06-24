const fs = require('node:fs');
const path = require('node:path');

const VERSION_FILE = path.resolve(__dirname, '..', '..', 'VERSION');
const FALLBACK_VERSION = 'v0.0.0';
const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function readVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function getVersionInfo() {
  const version = readVersion();
  const m = VERSION_RE.exec(version);
  return {
    version,
    valid: Boolean(m),
    major: m ? Number(m[1]) : null,
    minor: m ? Number(m[2]) : null,
    patch: m ? Number(m[3]) : null,
    file: VERSION_FILE,
  };
}

module.exports = {
  VERSION_FILE,
  VERSION_RE,
  readVersion,
  getVersionInfo,
};
