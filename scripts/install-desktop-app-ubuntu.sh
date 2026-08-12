#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_ROOT="$ROOT/artifacts/desktop"
INSTALL_ROOT="${GLADOS_INSTALL_ROOT:-$HOME/.local/opt/glados}"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$APPLICATIONS_DIR/glados.desktop"
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
ICON_FILE="$ICON_ROOT/glados.png"
LAUNCHER="$INSTALL_ROOT/glados"

if [[ "$(uname -s)" != "Linux" ]] || [[ ! -r /etc/os-release ]]; then
  echo "install-desktop-app-ubuntu.sh requires Ubuntu Linux" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "install-desktop-app-ubuntu.sh supports Ubuntu; detected ${ID:-unknown}" >&2
  exit 1
fi
if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "install-desktop-app-ubuntu.sh supports Ubuntu x86-64; detected $(dpkg --print-architecture)" >&2
  exit 1
fi

EXPECTED_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
PACKAGE_VERSION="v$(node -p "require('$ROOT/desktop/package.json').version")"
if [[ "$EXPECTED_VERSION" != "$PACKAGE_VERSION" ]]; then
  echo "VERSION ($EXPECTED_VERSION) does not match desktop/package.json ($PACKAGE_VERSION)" >&2
  exit 1
fi

if [[ -n "${GLADOS_APPIMAGE:-}" ]]; then
  if [[ ! -f "$GLADOS_APPIMAGE" ]]; then
    echo "GLADOS_APPIMAGE does not name a file: $GLADOS_APPIMAGE" >&2
    exit 1
  fi
  SOURCE="$(realpath "$GLADOS_APPIMAGE")"
else
  if [[ ! -x "$ROOT/desktop/node_modules/.bin/electron-builder" ]]; then
    echo "Desktop build dependencies are missing; installing them now."
    npm install --prefix "$ROOT/desktop"
  fi
  npm run dist:ubuntu --prefix "$ROOT/desktop"
  npm run verify:native:ubuntu --prefix "$ROOT/desktop"
  SOURCE="$ARTIFACT_ROOT/GLaDOS-${EXPECTED_VERSION#v}-x86_64.AppImage"
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "No GLaDOS $EXPECTED_VERSION AppImage was found at $SOURCE" >&2
  exit 1
fi

SOURCE_NAME="$(basename "$SOURCE")"
if [[ "$SOURCE_NAME" != *"${EXPECTED_VERSION#v}"* ]]; then
  echo "AppImage filename does not contain expected version ${EXPECTED_VERSION#v}: $SOURCE_NAME" >&2
  exit 1
fi

DEST="$INSTALL_ROOT/GLaDOS-${EXPECTED_VERSION#v}-x86_64.AppImage"
mkdir -p "$INSTALL_ROOT" "$APPLICATIONS_DIR" "$ICON_ROOT"
install -m 0755 "$SOURCE" "$DEST"
ln -sfn "$(basename "$DEST")" "$INSTALL_ROOT/GLaDOS.AppImage"
install -m 0644 "$ROOT/desktop/build/icon-source.png" "$ICON_FILE"

cat > "$LAUNCHER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
launcher_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$launcher_dir/GLaDOS.AppImage" "$@"
EOF
chmod 0755 "$LAUNCHER"

escaped_exec="${LAUNCHER// /\\ }"
cat > "$DESKTOP_FILE" <<EOF
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
chmod 0644 "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if [[ "${KEEP_GLADOS_ARTIFACTS:-0}" != "1" && -z "${GLADOS_APPIMAGE:-}" ]]; then
  rm -rf "$ROOT/artifacts"
fi

echo "Installed GLaDOS $EXPECTED_VERSION at $DEST"
echo "Operator data remains under ${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
echo "Launch from the application menu or run: $LAUNCHER"
