#!/usr/bin/env bash
#
# One-command GLaDOS update for macOS.
#
# Replaces the manual ritual (git pull + per-package npm install + migrations +
# config regen + gateway restart). Idempotent: re-running with no new commits is
# a no-op. Preserves all local state (agents, reports, investigations, blackboard,
# watchdog, operator-context, local-auth, .env, per-agent model overrides, and
# OpenClaw sessions).
#
# Usage:
#   scripts/update.sh [--dry-run] [--with-openclaw] [--no-restart] [--force]
#
#   --dry-run        Show what would change (incoming commits, steps) and exit.
#   --with-openclaw  Also reinstall/patch OpenClaw + LaunchAgent (version bumps).
#   --no-restart     Skip restarting the OpenClaw gateway daemon.
#   --force          Proceed even if the working tree is dirty or not on `main`.
#
# Functions are all defined first; `main "$@"` is the only top-level call (last
# line) so the in-flight `git pull` cannot corrupt the running script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="origin"
BRANCH="main"

DRY_RUN=0
WITH_OPENCLAW=0
NO_RESTART=0
FORCE=0

note() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run)       DRY_RUN=1 ;;
      --with-openclaw) WITH_OPENCLAW=1 ;;
      --no-restart)    NO_RESTART=1 ;;
      --force)         FORCE=1 ;;
      -h|--help)       sed -n '2,20p' "$0"; exit 0 ;;
      *)               die "unknown flag: $arg (try --help)" ;;
    esac
  done
}

preflight() {
  note "Pre-flight checks"

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$node_major" -gt 22 ]]; then
    die "Node $(node -v) is too new for GLaDOS native deps. Install Node 22 LTS:
  brew unlink node || true
  brew install node@22
  brew link --overwrite --force node@22"
  fi

  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "$REPO_ROOT is not a git repository"
  fi

  local cur_branch
  cur_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [[ "$cur_branch" != "$BRANCH" ]]; then
    if [[ "$FORCE" == "1" ]]; then
      warn "on branch '$cur_branch', not '$BRANCH' (continuing: --force)"
    else
      die "on branch '$cur_branch', not '$BRANCH'. Switch to $BRANCH or pass --force."
    fi
  fi

  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    if [[ "$FORCE" == "1" ]]; then
      warn "working tree has uncommitted changes (continuing: --force)"
    else
      die "working tree has uncommitted changes. Commit/stash them or pass --force."
    fi
  fi
}

show_incoming() {
  note "Fetching $REMOTE/$BRANCH to preview incoming changes"
  git -C "$REPO_ROOT" fetch "$REMOTE" "$BRANCH"
  local range="HEAD..$REMOTE/$BRANCH"
  local count
  count="$(git -C "$REPO_ROOT" rev-list --count "$range" 2>/dev/null || echo 0)"
  if [[ "$count" == "0" ]]; then
    echo "Already up to date with $REMOTE/$BRANCH (0 incoming commits)."
  else
    echo "$count incoming commit(s):"
    git -C "$REPO_ROOT" log --oneline "$range"
    echo
    echo "Files that would change:"
    git -C "$REPO_ROOT" diff --stat "$range"
  fi
}

git_pull() {
  note "git pull $REMOTE $BRANCH"
  if ! git -C "$REPO_ROOT" pull --ff-only "$REMOTE" "$BRANCH"; then
    die "git pull failed (likely diverged history or conflicts). Resolve manually:
  git -C \"$REPO_ROOT\" status
  # then re-run scripts/update.sh"
  fi
}

install_and_regen() {
  note "Installing dependencies (dashboard + 4 MCP packages)"
  node "$REPO_ROOT/scripts/lib/glados-local.js" install-deps

  note "Running migrations + regenerating OpenClaw config"
  node "$REPO_ROOT/scripts/lib/glados-local.js" update
}

maybe_openclaw() {
  if [[ "$WITH_OPENCLAW" == "1" ]]; then
    note "Updating OpenClaw runtime (global npm + bundle patches + LaunchAgent)"
    "$REPO_ROOT/scripts/setup-openclaw-macos.sh"
  fi
}

restart_gateway() {
  if [[ "$NO_RESTART" == "1" ]]; then
    warn "skipping gateway restart (--no-restart); changes apply after next restart"
    return
  fi
  if [[ "$WITH_OPENCLAW" == "1" ]]; then
    return  # setup-openclaw-macos.sh already restarted the gateway
  fi
  note "Restarting OpenClaw gateway so the new config takes effect"
  node "$REPO_ROOT/scripts/lib/glados-local.js" restart-gateway || \
    warn "gateway restart skipped/failed; restart manually with: openclaw daemon restart"
}

run_doctor() {
  note "Running glados-doctor"
  "$REPO_ROOT/scripts/glados-doctor.sh" || warn "doctor reported issues (see above)"
}

main() {
  parse_args "$@"
  cd "$REPO_ROOT"
  preflight

  if [[ "$DRY_RUN" == "1" ]]; then
    show_incoming
    echo
    note "Dry run — no changes made. Would then: install-deps, update (migrations+regen),$([[ $WITH_OPENCLAW == 1 ]] && echo ' update OpenClaw,') restart gateway, doctor."
    exit 0
  fi

  git_pull
  install_and_regen
  maybe_openclaw
  restart_gateway
  run_doctor

  echo
  note "Update complete."
  echo "Preserved: local agents, reports, investigations, blackboard, watchdog,"
  echo "operator-context, local-auth, .env, per-agent model overrides, and sessions."
}

main "$@"
