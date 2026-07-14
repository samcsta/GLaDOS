#!/usr/bin/env bash
set -euo pipefail

# macOS alias for the v4 source-checkout updater.
exec "$(dirname "$0")/update.sh" "$@"
