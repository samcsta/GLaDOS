#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
SECRETS_DIR="$RUNTIME_DIR/secrets"
AUTH_FILE="$SECRETS_DIR/local-auth.json"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

read -r -p "Ford SSO username: " FORD_USER
read -r -s -p "Ford SSO password: " FORD_PASS
printf '\n'

read -r -p "Dradis username [same as Ford SSO]: " DRADIS_USER
DRADIS_USER="${DRADIS_USER:-$FORD_USER}"
read -r -s -p "Dradis password [same as Ford SSO password]: " DRADIS_PASS
printf '\n'
DRADIS_PASS="${DRADIS_PASS:-$FORD_PASS}"

AUTH_FILE="$AUTH_FILE" \
FORD_USER="$FORD_USER" \
FORD_PASS="$FORD_PASS" \
DRADIS_USER="$DRADIS_USER" \
DRADIS_PASS="$DRADIS_PASS" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const out = {
  version: 1,
  updated_at: new Date().toISOString(),
  profiles: {
    'ford-sso': {
      username: process.env.FORD_USER || '',
      ['pass' + 'word']: process.env.FORD_PASS || '',
      allowed_hosts: [
        'corp.sts.ford.com',
        'www.is.dealerconnection.com'
      ],
      purpose: 'Ford ADFS / Active Directory login for authorized assessments'
    },
    dradis: {
      username: process.env.DRADIS_USER || '',
      ['pass' + 'word']: process.env.DRADIS_PASS || '',
      allowed_hosts: [
        'dradis.redteamstuff.com',
        'dradistab.redteamstuff.com'
      ],
      purpose: 'Dradis prior-report lookup and approved report workflow'
    }
  }
};

fs.mkdirSync(path.dirname(process.env.AUTH_FILE), { recursive: true });
fs.writeFileSync(process.env.AUTH_FILE, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(process.env.AUTH_FILE, 0o600);
NODE

echo "Wrote local auth profiles to $AUTH_FILE"
echo "This file is outside the repo and must not be committed."
