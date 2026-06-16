#!/usr/bin/env bash
set -euo pipefail

# Bump the GLaDOS release marker used by the dashboard Settings pane.
#
# Format:
#   v<major>.<MMDDYYYY>.<daily-sequence>
#
# Examples:
#   v3.5.06162026.1
#   v3.5.06162026.2
#   v3.5.06172026.1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$ROOT/VERSION"
MAJOR="${GLADOS_MAJOR_VERSION:-3.5}"
DATE_STAMP="${GLADOS_VERSION_DATE:-$(date +%m%d%Y)}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '1,18p' "$0"
  echo
  echo "Environment overrides:"
  echo "  GLADOS_MAJOR_VERSION=3.6"
  echo "  GLADOS_VERSION_DATE=06162026"
  exit 0
fi

if ! [[ "$MAJOR" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: GLADOS_MAJOR_VERSION must look like 3.5" >&2
  exit 1
fi

if ! [[ "$DATE_STAMP" =~ ^[0-9]{8}$ ]]; then
  echo "ERROR: GLADOS_VERSION_DATE must look like MMDDYYYY" >&2
  exit 1
fi

current="$(cat "$VERSION_FILE" 2>/dev/null || true)"
sequence=1
prefix="v${MAJOR}.${DATE_STAMP}."
if [[ "$current" == "$prefix"* ]]; then
  current_sequence="${current#$prefix}"
  if [[ "$current_sequence" =~ ^[0-9]+$ ]]; then
    sequence=$((current_sequence + 1))
  fi
fi

next="v${MAJOR}.${DATE_STAMP}.${sequence}"
printf '%s\n' "$next" > "$VERSION_FILE"
echo "$next"
