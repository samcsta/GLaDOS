#!/usr/bin/env node
// node-pty's bundled prebuild script silently exits 0 when no prebuilt binary
// exists for the current Node ABI (e.g. Node 25 on arm64 macOS). This leaves
// build/Release empty so the first pty.spawn() fails with "posix_spawnp failed".
// We check after install and force node-gyp rebuild if needed.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ptyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');
const ptyNode = path.join(ptyDir, 'build', 'Release', 'pty.node');
const spawnHelper = path.join(ptyDir, 'build', 'Release', 'spawn-helper');

if (!fs.existsSync(ptyDir)) process.exit(0); // not installed yet — nothing to do

const hasBinary = fs.existsSync(ptyNode) && fs.existsSync(spawnHelper);
if (hasBinary) process.exit(0);

console.log('[ensure-pty-binary] node-pty native binary missing — running node-gyp rebuild');
try {
  execSync('npx --yes node-gyp rebuild', { cwd: ptyDir, stdio: 'inherit' });
} catch (e) {
  console.error('[ensure-pty-binary] rebuild failed. The Terminal tab will not work.');
  console.error('  Fix: install Xcode CLI tools (`xcode-select --install`) and re-run `npm install`.');
  process.exit(1);
}
