#!/usr/bin/env bash
set -euo pipefail

# Source-checkout updater for GLaDOS v4. Packaged GLaDOS.app instances use the
# signed Electron release feed instead. Runtime/operator state lives under
# ~/.glados and is never part of either update payload.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${GLADOS_UPDATE_REMOTE:-origin}"
BRANCH="${GLADOS_UPDATE_BRANCH:-main}"
DRY_RUN=0
FORCE=0

note() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --no-restart) ;; # Electron supervises and restarts the dashboard child.
    -h|--help)
      echo "usage: scripts/update.sh [--dry-run] [--force] [--no-restart]"
      exit 0
      ;;
    *) die "unknown flag: $arg" ;;
  esac
done

git_bin="${GLADOS_GIT:-$(command -v git || true)}"
[[ -n "$git_bin" ]] || die "git not found"
git_cmd() { "$git_bin" -C "$ROOT" "$@"; }

branch="$(git_cmd rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "$BRANCH" && "$FORCE" != "1" ]]; then
  die "on branch '$branch', expected '$BRANCH' (use --force to override)"
fi
if [[ -n "$(git_cmd status --porcelain)" && "$FORCE" != "1" ]]; then
  die "working tree is dirty; commit/stash changes or use --force"
fi

note "Fetching $REMOTE/$BRANCH"
git_cmd fetch "$REMOTE" "$BRANCH"
if [[ "$DRY_RUN" == "1" ]]; then
  git_cmd log --oneline "HEAD..$REMOTE/$BRANCH"
  git_cmd diff --stat "HEAD..$REMOTE/$BRANCH"
  note "Dry run complete; no files or operator data changed"
  exit 0
fi

note "Fast-forwarding source checkout"
git_cmd pull --ff-only "$REMOTE" "$BRANCH"
note "Installing application and MCP dependencies"
node "$ROOT/scripts/lib/glados-local.js" install-deps
note "Applying v4 runtime migrations and refreshing template status"
node "$ROOT/scripts/lib/glados-local.js" update
note "Running GLaDOS doctor"
node "$ROOT/scripts/lib/glados-local.js" doctor

note "Update complete"
echo "Preserved: ~/.glados workspaces, sessions, reports, investigations, proxy traffic, secrets, blackboard, and watchdog data."
