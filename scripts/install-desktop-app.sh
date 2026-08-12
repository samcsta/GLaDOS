#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_ROOT="$ROOT/artifacts/desktop"
INSTALL_ROOT="${GLADOS_INSTALL_ROOT:-/Applications}"
DEST="$INSTALL_ROOT/GLaDOS.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
MDIMPORT="/usr/bin/mdimport"
TRASH_DIR="$HOME/.Trash"

SOURCE=""
if [[ -n "${GLADOS_APP_SOURCE:-}" ]]; then
  [[ -d "$GLADOS_APP_SOURCE" ]] || { echo "GLADOS_APP_SOURCE is not an app bundle: $GLADOS_APP_SOURCE" >&2; exit 1; }
  SOURCE="$(cd "$(dirname "$GLADOS_APP_SOURCE")" && pwd)/$(basename "$GLADOS_APP_SOURCE")"
  node "$ROOT/desktop/scripts/verify-packaged.cjs" "$SOURCE"
else
  if [[ ! -x "$ROOT/desktop/node_modules/.bin/electron-builder" ]]; then
    echo "Desktop build dependencies are missing; installing them now."
    npm install --prefix "$ROOT/desktop"
  fi

  npm run pack --prefix "$ROOT/desktop"
  npm run verify:pack --prefix "$ROOT/desktop"

  for candidate in \
    "$ARTIFACT_ROOT/mac-arm64/GLaDOS.app" \
    "$ARTIFACT_ROOT/mac/GLaDOS.app" \
    "$ARTIFACT_ROOT/mac-universal/GLaDOS.app"; do
    if [[ -d "$candidate" ]]; then
      SOURCE="$candidate"
      break
    fi
  done
fi

if [[ -z "$SOURCE" ]]; then
  echo "No verified GLaDOS.app artifact was found under $ARTIFACT_ROOT" >&2
  exit 1
fi

osascript -e 'tell application id "com.glados.ops" to quit' >/dev/null 2>&1 || true
for _ in {1..40}; do
  if ! pgrep -f '^/Applications/GLaDOS\.app/Contents/MacOS/GLaDOS$' >/dev/null; then break; fi
  sleep 0.25
done
if pgrep -f '^/Applications/GLaDOS\.app/Contents/MacOS/GLaDOS$' >/dev/null; then
  echo "GLaDOS is still running; quit it before installing." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT"
if [[ -d "$DEST" ]]; then
  [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$DEST" >/dev/null 2>&1 || true
  mkdir -p "$TRASH_DIR"
  replaced="$TRASH_DIR/GLaDOS.app.replaced-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv "$DEST" "$replaced"
  [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$replaced" >/dev/null 2>&1 || true
  echo "Moved the previous app to Trash: $replaced"
fi
/usr/bin/ditto "$SOURCE" "$DEST"
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -gc >/dev/null 2>&1 || true
[[ -x "$MDIMPORT" ]] && "$MDIMPORT" -i "$INSTALL_ROOT" >/dev/null 2>&1 || true

if [[ "${KEEP_GLADOS_ARTIFACTS:-0}" != "1" && -z "${GLADOS_APP_SOURCE:-}" ]]; then
  rm -rf "$ROOT/artifacts"
fi

echo "Installed $DEST"
echo "Updated Launch Services and Spotlight metadata for $INSTALL_ROOT"
echo "Operator data remains under ${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
echo "Launch with: open '$DEST'"
