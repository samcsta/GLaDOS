#!/usr/bin/env bash
set -euo pipefail

# Backwards-compatible alias. The full, single-command update flow now lives in
# scripts/update.sh (git pull + deps + migrations + config regen + gateway
# restart + doctor, with --dry-run / --with-openclaw / --no-restart / --force).
exec "$(dirname "$0")/update.sh" "$@"
