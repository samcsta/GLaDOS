#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != "Linux" ]] || [[ ! -r /etc/os-release ]]; then
  echo "bootstrap-ubuntu.sh requires Ubuntu Linux" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "bootstrap-ubuntu.sh supports Ubuntu; detected ${ID:-unknown}" >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential ca-certificates curl git jq libsecret-1-0 gnome-keyring \
  openssl python3 python3-venv pipx nmap

python3 -m pipx ensurepath
if ! command -v mitmdump >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/mitmdump" ]]; then
  python3 -m pipx install mitmproxy
fi

"$ROOT/scripts/glados-ca.sh" generate

echo
echo "Ubuntu prerequisites are installed."
echo "To explicitly trust the per-user interception CA system-wide, run:"
echo "  $ROOT/scripts/glados-ca.sh trust"
