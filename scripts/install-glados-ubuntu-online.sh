#!/usr/bin/env bash
set -euo pipefail

installer_url="${GLADOS_LINUX_INSTALLER_URL:-https://updates.r3dt34m.net/installers/linux/install-glados-linux.sh}"
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
curl -fL --retry 3 "$installer_url" -o "$temporary"
exec bash "$temporary" "$@"
