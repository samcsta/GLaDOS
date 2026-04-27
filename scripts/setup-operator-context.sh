#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
CONTEXT_FILE="$RUNTIME_DIR/operator-context.json"
FORCE=0
TEMPLATE="templates/operator-context/ford-redteam.json"

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) TEMPLATE="$arg" ;;
  esac
done

mkdir -p "$RUNTIME_DIR"

if [[ -f "$CONTEXT_FILE" && "$FORCE" != "1" ]]; then
  echo "Operator context already exists: $CONTEXT_FILE"
  echo "Leaving it untouched. Edit it directly if this workstation needs custom context."
  exit 0
fi

if [[ -f "$CONTEXT_FILE" ]]; then
  BACKUP="$CONTEXT_FILE.bak-$(date +%Y%m%d%H%M%S)"
  cp "$CONTEXT_FILE" "$BACKUP"
  chmod 600 "$BACKUP"
  echo "Backed up existing operator context to $BACKUP"
fi

cp "$TEMPLATE" "$CONTEXT_FILE"
chmod 600 "$CONTEXT_FILE"
echo "Wrote operator context to $CONTEXT_FILE"
