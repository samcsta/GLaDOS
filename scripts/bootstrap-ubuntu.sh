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
if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "bootstrap-ubuntu.sh supports Ubuntu x86-64; detected $(dpkg --print-architecture)" >&2
  exit 1
fi

NODE_MAJOR=22
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential ca-certificates curl file git jq libfuse2t64 libsecret-1-0 \
  gnome-keyring openssl python3 python3-venv pipx nmap sqlite3 unzip

if [[ "$node_major" -ne "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ne "$NODE_MAJOR" ]]; then
  echo "GLaDOS requires Node ${NODE_MAJOR}; detected $(node --version)" >&2
  exit 1
fi

cd "$ROOT"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example (runtime paths and non-secret settings only)."
fi

python3 -m pipx ensurepath
export PATH="$HOME/.local/bin:$PATH"

HTTPX_VERSION="1.10.0"
HTTPX_SHA256="63eac4dcd6e5c9867c94765fdaaf66e7b4eeae3474a1f06e600e266a1c81a53e"
if ! command -v httpx >/dev/null 2>&1; then
  (
    httpx_tmp="$(mktemp -d)"
    trap 'rm -rf "$httpx_tmp"' EXIT
    httpx_zip="$httpx_tmp/httpx.zip"
    curl -fL --retry 3 \
      "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_amd64.zip" \
      -o "$httpx_zip"
    printf '%s  %s\n' "$HTTPX_SHA256" "$httpx_zip" | sha256sum -c -
    unzip -q "$httpx_zip" -d "$httpx_tmp/extracted"
    install -d -m 0755 "$HOME/.local/bin"
    install -m 0755 "$httpx_tmp/extracted/httpx" "$HOME/.local/bin/httpx"
  )
fi

SEMGREP_VERSION="1.172.0"
if ! command -v semgrep >/dev/null 2>&1; then
  python3 -m pipx install "semgrep==${SEMGREP_VERSION}"
fi

httpx -version
semgrep --version

if ! command -v mitmdump >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/mitmdump" ]]; then
  python3 -m pipx install mitmproxy
fi

node scripts/lib/glados-local.js install-deps
node scripts/lib/glados-local.js bootstrap
scripts/glados-ca.sh generate
scripts/setup-operator-context.sh

echo
echo "Bootstrap complete."
echo "Optional local credentials setup: scripts/setup-local-secrets.sh"
echo "Store the LiteLLM key: scripts/setup-llm-secret.sh"
echo "To explicitly trust the per-user interception CA system-wide, run:"
echo "  $ROOT/scripts/glados-ca.sh trust"
echo "Run: scripts/glados-doctor.sh"
echo "Build and install the desktop app: scripts/install-desktop-app-ubuntu.sh"
echo "For source development only: npm start --prefix desktop"
