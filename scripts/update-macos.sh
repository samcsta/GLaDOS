#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node scripts/lib/glados-local.js install-deps
node scripts/lib/glados-local.js update

echo
echo "Update complete. Local agents, reports, investigations, blackboard, watchdog, .env, and OpenClaw sessions were left untouched."
echo "Run: scripts/glados-doctor.sh"
