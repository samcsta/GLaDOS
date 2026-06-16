#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

OPENCLAW_VERSION="${GLADOS_OPENCLAW_VERSION:-2026.4.5}"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
BREW_PREFIX="$(brew --prefix)"
GLOBAL_NODE_MODULES="$(npm root -g)"
START_GATEWAY=1
if [[ "${1:-}" == "--no-start" ]]; then
  START_GATEWAY=0
fi

if [[ "$NODE_MAJOR" -gt 22 ]]; then
  cat >&2 <<'EOF'
ERROR: Homebrew's latest node is too new for this install path.
Install Node 22 LTS first:
  brew unlink node || true
  brew install node@22
  brew link --overwrite --force node@22
EOF
  exit 1
fi

unset OPENCLAW_HOME

echo "Installing compatible OpenClaw and bundled integration dependencies..."
npm install -g \
  "openclaw@${OPENCLAW_VERSION}" \
  "@buape/carbon@0.14.0" \
  "@larksuiteoapi/node-sdk" \
  "@slack/web-api" \
  "@slack/bolt" \
  "grammy" \
  "@grammyjs/runner" \
  "@grammyjs/transformer-throttler" \
  "@line/bot-sdk"

echo "Regenerating GLaDOS OpenClaw config..."
node scripts/lib/glados-local.js update

echo "Applying GLaDOS OpenClaw bundle patches..."
tools/patch-openclaw-bundle.sh

echo "Installing OpenClaw gateway LaunchAgent..."
env -u OPENCLAW_HOME openclaw gateway install --force

PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
TAG="$PWD/tools/tag-injector.js"

echo "Configuring gateway LaunchAgent environment..."
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OPENCLAW_GATEWAY_PORT string 18789" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OPENCLAW_RAW_STREAM string 1" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NODE_OPTIONS string --require=$TAG" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:BURP_PROXY string ${BURP_PROXY:-http://127.0.0.1:8080}" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:BURP_EXT_API string ${BURP_EXT_API:-http://127.0.0.1:1338}" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:GLADOS_REPO_ROOT string $PWD" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OPENCLAW_DIST string ${GLOBAL_NODE_MODULES}/openclaw/dist" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string ${BREW_PREFIX}/opt/node@22/bin:${BREW_PREFIX}/bin:${BREW_PREFIX}/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$PLIST"

if [[ "$START_GATEWAY" == "1" ]]; then
  echo "Restarting OpenClaw gateway..."
  launchctl bootout "gui/$UID" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST"
  env -u OPENCLAW_HOME openclaw daemon restart
else
  cat <<EOF
Gateway LaunchAgent is configured but not started.
Start later with:
  launchctl bootout gui/\$UID "$PLIST" 2>/dev/null || true
  launchctl bootstrap gui/\$UID "$PLIST"
  env -u OPENCLAW_HOME openclaw daemon restart
EOF
fi

echo
echo "Verify with:"
echo "  env -u OPENCLAW_HOME openclaw gateway status --deep"
echo "  cat ~/.openclaw/logs/tag-injector-health.json | jq ."
