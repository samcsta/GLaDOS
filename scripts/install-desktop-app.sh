#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_ROOT="$ROOT/artifacts/desktop"
INSTALL_ROOT="${GLADOS_INSTALL_ROOT:-/Applications}"
DEST="$INSTALL_ROOT/GLaDOS.app"

if [[ ! -x "$ROOT/desktop/node_modules/.bin/electron-builder" ]]; then
  echo "Desktop build dependencies are missing; installing them now."
  npm install --prefix "$ROOT/desktop"
fi

npm run pack --prefix "$ROOT/desktop"
npm run verify:pack --prefix "$ROOT/desktop"

SOURCE=""
for candidate in \
  "$ARTIFACT_ROOT/mac-arm64/GLaDOS.app" \
  "$ARTIFACT_ROOT/mac/GLaDOS.app" \
  "$ARTIFACT_ROOT/mac-universal/GLaDOS.app"; do
  if [[ -d "$candidate" ]]; then
    SOURCE="$candidate"
    break
  fi
done

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
rm -rf "$DEST"
/usr/bin/ditto "$SOURCE" "$DEST"

if [[ "${KEEP_GLADOS_ARTIFACTS:-0}" != "1" ]]; then
  rm -rf "$ROOT/artifacts"
fi

echo "Installed $DEST"
echo "Operator data remains under ${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
echo "Launch with: open '$DEST'"
