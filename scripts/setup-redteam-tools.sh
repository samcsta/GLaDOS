#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command="check"
args=()

for arg in "$@"; do
  case "$arg" in
    --install) command="install" ;;
    --all|--specialist|--dry-run|--agent) args+=("$arg") ;;
    *) args+=("$arg") ;;
  esac
done

exec node "$ROOT/scripts/lib/redteam-tools.js" "$command" "${args[@]}"
