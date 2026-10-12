#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
SECRETS_DIR="$RUNTIME_DIR/secrets"
SECRET_FILE="$SECRETS_DIR/clippy-mcp.json"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
read -r -s -p "Clippy MCP bearer token: " CLIPPY_TOKEN
printf '\n'
if [[ -z "$CLIPPY_TOKEN" ]]; then
  echo "No token provided." >&2
  exit 1
fi

umask 077
CLIPPY_TOKEN="$CLIPPY_TOKEN" SECRET_FILE="$SECRET_FILE" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const token = String(process.env.CLIPPY_TOKEN || '').trim().replace(/^Bearer\s+/i, '').trim();
if (!token || token.length > 16_384 || /[\r\n\0]/.test(token)) throw new Error('Invalid Clippy token');
const file = process.env.SECRET_FILE;
const temporary = path.join(path.dirname(file), `.clippy-mcp-${randomUUID()}.tmp`);
try {
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
} finally {
  try { fs.unlinkSync(temporary); } catch {}
}
NODE
unset CLIPPY_TOKEN
echo "Clippy MCP credential stored in an owner-only local file. Restart GLaDOS to connect."
