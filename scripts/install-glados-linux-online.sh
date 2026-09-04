#!/usr/bin/env bash
set -euo pipefail

UPDATE_BASE="${GLADOS_UPDATE_BASE_URL:-https://updates.r3dt34m.net/glados/linux/x64}"
INSTALL_ROOT="${GLADOS_INSTALL_ROOT:-$HOME/.local/opt/glados}"
BIN_DIR="${GLADOS_BIN_DIR:-$HOME/.local/bin}"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

if [[ "$(uname -s)" != "Linux" || ! -r /etc/os-release ]]; then
  echo "This installer requires a supported Linux distribution." >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
linux_family=''
case " ${ID:-} ${ID_LIKE:-} " in
  *' debian '*) linux_family='debian' ;;
  *' fedora '*|*' rhel '*) linux_family='fedora' ;;
esac
if [[ -z "$linux_family" ]]; then
  echo "This installer supports Debian/Kali/Ubuntu and Fedora; detected ${ID:-unknown}." >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "This installer supports Linux x86-64; detected $(uname -m)." >&2
  exit 1
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "Required command is missing: sudo" >&2
  exit 1
fi

apt_package() {
  local candidate
  for candidate in "$@"; do
    if apt-cache show "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "No supported package was found for: $*" >&2
  return 1
}

echo "Installing download verification and desktop runtime tools..."
if [[ "$linux_family" == 'debian' ]]; then
  sudo apt-get update
  asound="$(apt_package libasound2t64 libasound2)"
  atk_bridge="$(apt_package libatk-bridge2.0-0t64 libatk-bridge2.0-0)"
  atk="$(apt_package libatk1.0-0t64 libatk1.0-0)"
  cups="$(apt_package libcups2t64 libcups2)"
  fuse="$(apt_package libfuse2t64 libfuse2)"
  gtk="$(apt_package libgtk-3-0t64 libgtk-3-0)"
  sudo apt-get install -y \
    ca-certificates curl gnome-keyring "$asound" "$atk_bridge" "$atk" "$cups" \
    libdrm2 "$fuse" libgbm1 "$gtk" libnotify4 libnss3 libsecret-1-0 \
    libx11-xcb1 libxkbcommon0 libxss1 libxtst6 lsof nmap openssl pipx python3 \
    python3-venv sqlite3 unzip
else
  sudo dnf install -y \
    alsa-lib at-spi2-atk atk ca-certificates cups-libs curl fuse-libs gnome-keyring \
    gtk3 jq libdrm libnotify libsecret libXScrnSaver libxkbcommon libXtst lsof nmap \
    nss openssl pipx python3 sqlite unzip
fi

installer_tmp="$(mktemp -d)"
trap 'rm -rf "$installer_tmp"' EXIT
metadata="$installer_tmp/latest-linux.yml"

echo "Reading the private GLaDOS release channel..."
curl -fL --retry 3 "$UPDATE_BASE/latest-linux.yml" -o "$metadata"
version="$(sed -nE 's/^version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p' "$metadata" | head -n 1)"
artifact="$(sed -nE 's/^[[:space:]]*-[[:space:]]url:[[:space:]]*([^[:space:]]+).*$/\1/p' "$metadata" | head -n 1)"
expected_sha512="$(sed -nE 's/^[[:space:]]*sha512:[[:space:]]*([^[:space:]]+).*$/\1/p' "$metadata" | head -n 1)"
if [[ -z "$version" || ! "$artifact" =~ ^GLaDOS-[0-9]+\.[0-9]+\.[0-9]+-x86_64\.AppImage$ || -z "$expected_sha512" ]]; then
  echo "The GLaDOS release metadata is invalid." >&2
  exit 1
fi

appimage="$installer_tmp/$artifact"
echo "Downloading GLaDOS $version..."
curl -fL --retry 3 "$UPDATE_BASE/$artifact" -o "$appimage"
actual_sha512="$(openssl dgst -sha512 -binary "$appimage" | openssl base64 -A)"
if [[ "$actual_sha512" != "$expected_sha512" ]]; then
  echo "The downloaded AppImage did not match the release metadata hash." >&2
  exit 1
fi

export PATH="$BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}"
python3 -m pipx ensurepath >/dev/null

HTTPX_VERSION="1.10.0"
HTTPX_SHA256="63eac4dcd6e5c9867c94765fdaaf66e7b4eeae3474a1f06e600e266a1c81a53e"
if ! command -v httpx >/dev/null 2>&1; then
  httpx_zip="$installer_tmp/httpx.zip"
  curl -fL --retry 3 \
    "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_amd64.zip" \
    -o "$httpx_zip"
  printf '%s  %s\n' "$HTTPX_SHA256" "$httpx_zip" | sha256sum -c -
  unzip -q "$httpx_zip" -d "$installer_tmp/httpx"
  install -d -m 0755 "$BIN_DIR"
  install -m 0755 "$installer_tmp/httpx/httpx" "$BIN_DIR/httpx"
fi
if ! command -v semgrep >/dev/null 2>&1 && ! command -v pysemgrep >/dev/null 2>&1; then
  python3 -m pipx install 'semgrep==1.176.0'
fi
if semgrep --version >/dev/null 2>&1; then
  semgrep_cli="semgrep"
elif command -v pysemgrep >/dev/null 2>&1 && pysemgrep --version >/dev/null 2>&1; then
  semgrep_cli="pysemgrep"
else
  echo "Semgrep was installed, but neither CLI entry point is usable." >&2
  exit 1
fi
"$semgrep_cli" --version
if ! command -v mitmdump >/dev/null 2>&1; then
  mitmproxy_version="$(python3 -c 'import sys; print("12.2.3" if sys.version_info >= (3, 12) else "11.0.2")')"
  python3 -m pipx install "mitmproxy==${mitmproxy_version}"
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR" "$APPLICATIONS_DIR" "$ICON_DIR"
install -m 0755 "$appimage" "$INSTALL_ROOT/GLaDOS.AppImage"
curl -fL --retry 3 "https://updates.r3dt34m.net/installers/linux/glados.png" \
  -o "$ICON_DIR/glados.png"

cat > "$BIN_DIR/glados" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
appimage="${GLADOS_INSTALL_ROOT:-$HOME/.local/opt/glados}/GLaDOS.AppImage"
restarted_after_update=0
while true; do
  before="$(stat -Lc '%d:%i:%s:%Y' "$appimage")"
  set +e
  "$appimage" "$@"
  status=$?
  set -e
  after="$(stat -Lc '%d:%i:%s:%Y' "$appimage" 2>/dev/null || true)"
  if [[ "$status" -eq 0 && "$restarted_after_update" -eq 0 && -n "$after" && "$after" != "$before" ]]; then
    restarted_after_update=1
    continue
  fi
  exit "$status"
done
EOF
chmod 0755 "$BIN_DIR/glados"

escaped_exec="${BIN_DIR// /\\ }/glados"
cat > "$APPLICATIONS_DIR/glados.desktop" <<EOF
[Desktop Entry]
Name=GLaDOS
Comment=GLaDOS red team operator application
Exec=$escaped_exec %U
TryExec=$escaped_exec
Icon=glados
Terminal=false
Type=Application
Categories=Development;Security;
StartupWMClass=GLaDOS
EOF
chmod 0644 "$APPLICATIONS_DIR/glados.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

echo
echo "GLaDOS $version is installed on ${PRETTY_NAME:-Linux}."
echo "Launch it from the application menu or run: $BIN_DIR/glados"
echo "Future releases will appear as an Update GLaDOS button inside the app."
