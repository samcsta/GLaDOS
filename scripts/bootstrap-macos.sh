#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Edit .env and set your local LLMAPI_API_KEY before operational use."
fi

node scripts/lib/glados-local.js install-deps
node scripts/lib/glados-local.js bootstrap
scripts/setup-operator-context.sh

echo
echo "Bootstrap complete."
echo "Optional local credentials setup: scripts/setup-local-secrets.sh"
echo "Run: scripts/glados-doctor.sh"
echo "Then start the dashboard: cd dashboard && npm start"
