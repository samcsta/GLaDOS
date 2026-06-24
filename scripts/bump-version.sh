#!/usr/bin/env bash
set -euo pipefail

# Bump the GLaDOS release marker used by the dashboard Settings pane.
#
# Format:
#   v<major>.<minor>.<patch>
#
# Examples:
#   v3.6.0
#   v3.6.1
#   v3.6.2

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$ROOT/VERSION"
BASE="${GLADOS_VERSION_BASE:-}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '1,18p' "$0"
  echo
  echo "Environment overrides:"
  echo "  GLADOS_VERSION_BASE=3.7"
  exit 0
fi

current="$(cat "$VERSION_FILE" 2>/dev/null || true)"
if [[ -n "$BASE" ]]; then
  if ! [[ "$BASE" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: GLADOS_VERSION_BASE must look like 3.6" >&2
    exit 1
  fi
  prefix="v${BASE}."
  patch=0
else
  if ! [[ "$current" =~ ^v([0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
    echo "ERROR: current VERSION must look like v3.6.0" >&2
    exit 1
  fi
  prefix="v${BASH_REMATCH[1]}."
  patch=$((BASH_REMATCH[2] + 1))
fi

next="${prefix}${patch}"
printf '%s\n' "$next" > "$VERSION_FILE"
echo "$next"
