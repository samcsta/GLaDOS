#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${GLADOS_INSTALL_ROOT:-/Applications}"
APP_PATH="$INSTALL_ROOT/GLaDOS.app"
RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
TRASH_DIR="$HOME/.Trash"
LLM_SERVICE="${GLADOS_LLM_KEYCHAIN_SERVICE:-glados.llmapi}"
LLM_ACCOUNT="${GLADOS_LLM_KEYCHAIN_ACCOUNT:-$(id -un)}"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
PURGE_DATA=0
ASSUME_YES=0
DRY_RUN=0
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

usage() {
  cat <<'EOF'
usage: scripts/uninstall-desktop-app.sh [--purge-data] [--yes] [--dry-run]

By default, moves /Applications/GLaDOS.app to Trash and preserves ~/.glados
operator data and the LiteLLM Keychain secret for a future reinstall. The
GLaDOS MITM CA is removed from Keychain trust in both modes.

  --purge-data  Also move ~/.glados and app caches/preferences to Trash, and
                delete the GLaDOS LiteLLM Keychain item.
  --yes         Skip interactive confirmation.
  --dry-run     Print the actions without changing the Mac.
EOF
}

fail() {
  echo "GLaDOS uninstall: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --purge-data) PURGE_DATA=1 ;;
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this uninstaller supports macOS only"
[[ -n "${HOME:-}" && "$HOME" == /* && "$HOME" != "/" ]] || fail "HOME is not a safe absolute path"
[[ "$INSTALL_ROOT" == /* && "$INSTALL_ROOT" != "/" ]] || fail "GLADOS_INSTALL_ROOT must be an absolute directory other than /"
[[ "$APP_PATH" == */GLaDOS.app && "$APP_PATH" != "/GLaDOS.app" ]] || fail "refusing unsafe application target: $APP_PATH"
[[ "$RUNTIME_DIR" == /* && "$RUNTIME_DIR" != "/" && "$RUNTIME_DIR" != "$HOME" ]] || fail "refusing unsafe runtime target: $RUNTIME_DIR"

describe_plan() {
  echo "GLaDOS macOS uninstall"
  echo "  Application:   $APP_PATH"
  if ((PURGE_DATA)); then
    echo "  Operator data: move $RUNTIME_DIR to Trash"
    echo "  LiteLLM key:   delete Keychain service '$LLM_SERVICE' for '$LLM_ACCOUNT'"
  else
    echo "  Operator data: preserve $RUNTIME_DIR"
    echo "  LiteLLM key:   preserve Keychain service '$LLM_SERVICE' for '$LLM_ACCOUNT'"
  fi
  echo "  MITM CA trust: remove GLaDOS Operator MITM CA from the login keychain"
  echo "  Toolchains:    preserve Homebrew, Node, mitmproxy, and red-team tools"
}

describe_plan
if ((DRY_RUN)); then
  echo "Dry run only; nothing was changed."
  exit 0
fi

if ((!ASSUME_YES)); then
  [[ -t 0 ]] || fail "interactive confirmation unavailable; rerun with --yes"
  if ((PURGE_DATA)); then
    read -r -p "Uninstall GLaDOS and purge its local data? Type PURGE to continue: " answer
    [[ "$answer" == "PURGE" ]] || { echo "Cancelled."; exit 0; }
  else
    read -r -p "Uninstall GLaDOS while preserving operator data? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" || "$answer" == "yes" || "$answer" == "YES" ]] || { echo "Cancelled."; exit 0; }
  fi
fi

glados_pids() {
  local pid command executable
  executable="$APP_PATH/Contents/MacOS/GLaDOS"
  while read -r pid command; do
    [[ -n "${pid:-}" && -n "${command:-}" ]] || continue
    case "$command" in
      "$executable"|"$executable "*) printf '%s\n' "$pid" ;;
    esac
  done < <(ps -axo pid=,command=)
}

stop_glados() {
  if [[ "${GLADOS_UNINSTALL_SKIP_PROCESS_STOP:-0}" == "1" ]]; then return; fi
  osascript -e 'tell application id "com.glados.ops" to quit' >/dev/null 2>&1 || true
  local attempt pid
  for attempt in {1..40}; do
    [[ -z "$(glados_pids)" ]] && return
    sleep 0.25
  done
  while read -r pid; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done < <(glados_pids)
  for attempt in {1..20}; do
    [[ -z "$(glados_pids)" ]] && return
    sleep 0.25
  done
  while read -r pid; do
    [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
  done < <(glados_pids)
  [[ -z "$(glados_pids)" ]] || fail "one or more GLaDOS processes could not be stopped"
}

move_to_trash() {
  local source="$1"
  local label="$2"
  local destination
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p "$TRASH_DIR"
  destination="$TRASH_DIR/${label}.uninstalled-${STAMP}-$$"
  [[ ! -e "$destination" ]] || fail "Trash destination already exists: $destination"
  mv "$source" "$destination"
  echo "Moved to Trash: $source -> $destination"
}

remove_ca_trust() {
  if [[ "${GLADOS_UNINSTALL_SKIP_SECURITY:-0}" == "1" ]]; then return; fi
  [[ -f "$LOGIN_KEYCHAIN" ]] || return 0
  security delete-certificate -c "GLaDOS Operator MITM CA" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
  echo "Removed matching GLaDOS MITM CA trust from the login keychain, if present."
}

delete_llm_key() {
  if [[ "${GLADOS_UNINSTALL_SKIP_SECURITY:-0}" == "1" ]]; then return; fi
  security delete-generic-password -a "$LLM_ACCOUNT" -s "$LLM_SERVICE" >/dev/null 2>&1 || true
  echo "Removed the GLaDOS LiteLLM Keychain item, if present."
}

stop_glados
remove_ca_trust

if [[ -d "$APP_PATH" ]]; then
  LSREGISTER='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$APP_PATH" >/dev/null 2>&1 || true
fi
move_to_trash "$APP_PATH" 'GLaDOS.app'

if ((PURGE_DATA)); then
  delete_llm_key
  move_to_trash "$RUNTIME_DIR" 'GLaDOS-operator-data'
  move_to_trash "$HOME/Library/Caches/com.glados.ops" 'com.glados.ops-cache'
  move_to_trash "$HOME/Library/Caches/com.glados.ops.ShipIt" 'com.glados.ops.ShipIt-cache'
  move_to_trash "$HOME/Library/Caches/glados-updater" 'glados-updater-cache'
  move_to_trash "$HOME/Library/Preferences/com.glados.ops.plist" 'com.glados.ops-preferences.plist'
  move_to_trash "$HOME/Library/Saved Application State/com.glados.ops.savedState" 'com.glados.ops-saved-state'
fi

echo
echo "GLaDOS has been uninstalled."
if ((PURGE_DATA)); then
  echo "Purged filesystem data was moved to Trash and is recoverable until Trash is emptied."
  echo "Deleted Keychain items and removed certificate trust are not restored from Trash."
else
  echo "Operator data remains at $RUNTIME_DIR for a future reinstall."
fi
echo "Developer ID certificates and GLaDOS release/notarization credentials were not touched."
