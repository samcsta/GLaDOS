#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
OVERRIDES_FILE="$RUNTIME_DIR/model-overrides.json"

mkdir -p "$RUNTIME_DIR"

if [[ -f "$OVERRIDES_FILE" ]]; then
  echo "Per-agent model overrides already exist at:"
  echo "  $OVERRIDES_FILE"
else
  printf '{}\n' > "$OVERRIDES_FILE"
  echo "Created empty per-agent model overrides at:"
  echo "  $OVERRIDES_FILE"
fi

cat <<EOF

This file maps an agent id to a model ref, e.g.:
  {
    "atlas": "custom-llmapi-redteamstuff-com/minimax-m2.7",
    "report-writer": "custom-llmapi-redteamstuff-com/qwen3.6-27b-fp8"
  }

It lives outside the repo, survives 'git pull' and 'glados update', and always
wins over the registry default. The dashboard model picker writes here for you.
Reference: templates/model-overrides.example.json
After editing, apply it with: scripts/update.sh   (or: node scripts/lib/glados-local.js update)
EOF
