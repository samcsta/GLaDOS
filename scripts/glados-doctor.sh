#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."
node scripts/lib/glados-local.js doctor "$@"
