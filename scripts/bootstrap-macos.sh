#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example (runtime paths and non-secret settings only)."
fi

node scripts/lib/glados-local.js install-deps
scripts/setup-redteam-tools.sh --install
node scripts/lib/glados-local.js bootstrap
scripts/glados-ca.sh generate
scripts/setup-operator-context.sh

echo
echo "Bootstrap complete."
echo "Optional local credentials setup: scripts/setup-local-secrets.sh"
echo "Store the LiteLLM key: scripts/setup-llm-secret.sh"
echo "Run: scripts/glados-doctor.sh"
echo "Install the desktop app: scripts/install-desktop-app.sh"
echo "For source development only: npm start --prefix desktop"
