#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
SANDBOX=0
LIVE=0
LIVE_SUBAGENT=0
JSON_ONLY=0
CHECK_GATEWAY=1
CHECK_DOCTOR=1

RESULTS=()

usage() {
  cat <<'EOF'
Usage: scripts/openclaw-compat.sh [--version <version> --sandbox] [--live] [--live-subagent] [--json]

Default mode is read-only against the current OpenClaw install.

Options:
  --version <v>     Candidate OpenClaw version for sandbox mode.
  --sandbox         Install candidate into ~/.glados/openclaw-compat/<version>/.
  --live            Opt-in live smoke: send a short message to glados.
  --live-subagent   Opt-in live smoke: request a safe Phase 1 subagent check.
  --json            Print only JSON.
  --no-gateway      Skip gateway status check (for tests/offline use).
  --no-doctor       Skip glados-doctor subset (for tests/offline use).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --sandbox) SANDBOX=1; shift ;;
    --live) LIVE=1; shift ;;
    --live-subagent) LIVE_SUBAGENT=1; LIVE=1; shift ;;
    --json) JSON_ONLY=1; shift ;;
    --no-gateway) CHECK_GATEWAY=0; shift ;;
    --no-doctor) CHECK_DOCTOR=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

json_escape() {
  node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.stringify(s)));'
}

add_result() {
  local name="$1" status="$2" detail="${3:-}"
  local escaped
  escaped="$(printf '%s' "$detail" | json_escape)"
  RESULTS+=("{\"name\":\"$name\",\"status\":\"$status\",\"detail\":$escaped}")
}

run_check() {
  local name="$1"; shift
  local out status
  set +e
  out="$("$@" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then add_result "$name" "pass" "$out"; else add_result "$name" "fail" "$out"; fi
  return 0
}

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
OPENCLAW_HOME_EFFECTIVE="${OPENCLAW_HOME:-$HOME/.openclaw}"
GLADOS_RUNTIME_EFFECTIVE="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
OPENCLAW_DIST_EFFECTIVE="${OPENCLAW_DIST:-}"

if [[ "$SANDBOX" == "1" ]]; then
  [[ -n "$VERSION" ]] || { echo "--sandbox requires --version <version>" >&2; exit 2; }
  ROOT="$HOME/.glados/openclaw-compat/$VERSION"
  PREFIX="$ROOT/npm-prefix"
  OPENCLAW_HOME_EFFECTIVE="$ROOT/openclaw-home"
  GLADOS_RUNTIME_EFFECTIVE="$ROOT/glados-runtime"
  mkdir -p "$PREFIX" "$OPENCLAW_HOME_EFFECTIVE" "$GLADOS_RUNTIME_EFFECTIVE"
  add_result "sandbox_root" "pass" "$ROOT"
  run_check "sandbox_npm_install" npm install --prefix "$PREFIX" "openclaw@$VERSION"
  OPENCLAW_BIN="$PREFIX/node_modules/.bin/openclaw"
  OPENCLAW_DIST_EFFECTIVE="$PREFIX/node_modules/openclaw/dist"
  run_check "sandbox_config_regen" env OPENCLAW_HOME="$OPENCLAW_HOME_EFFECTIVE" GLADOS_RUNTIME_DIR="$GLADOS_RUNTIME_EFFECTIVE" node "$REPO_ROOT/scripts/lib/glados-local.js" update --no-restart
  run_check "sandbox_patch" env OPENCLAW_DIST="$OPENCLAW_DIST_EFFECTIVE" bash "$REPO_ROOT/tools/patch-openclaw-bundle.sh"
fi

if [[ -z "$OPENCLAW_DIST_EFFECTIVE" ]]; then
  if npm_root="$(npm root -g 2>/dev/null)"; then
    OPENCLAW_DIST_EFFECTIVE="$npm_root/openclaw/dist"
  else
    OPENCLAW_DIST_EFFECTIVE=""
  fi
fi

run_check "node_version" node -p 'process.version'

if command -v "$OPENCLAW_BIN" >/dev/null 2>&1 || [[ -x "$OPENCLAW_BIN" ]]; then
  run_check "openclaw_version" env -u OPENCLAW_HOME "$OPENCLAW_BIN" --version
else
  add_result "openclaw_binary" "fail" "openclaw not found: $OPENCLAW_BIN"
fi

CONFIG="$OPENCLAW_HOME_EFFECTIVE/openclaw.json"
run_check "openclaw_config_parse" node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
const agents=j?.agents?.list||[];
if(!agents.length) throw new Error("agents.list is empty");
console.log(JSON.stringify({path:p, agents:agents.length}));
' "$CONFIG"

if [[ -d "$OPENCLAW_DIST_EFFECTIVE" ]]; then
  if grep -Rqs "GLADOS_ALS_PATCH_V1" "$OPENCLAW_DIST_EFFECTIVE"; then
    add_result "patch_als_marker" "pass" "$OPENCLAW_DIST_EFFECTIVE"
  else
    add_result "patch_als_marker" "fail" "GLADOS_ALS_PATCH_V1 not found in $OPENCLAW_DIST_EFFECTIVE"
  fi
  if grep -Rqs "GLADOS_SSRF_ROUTE_V2" "$OPENCLAW_DIST_EFFECTIVE"; then
    add_result "patch_ssrf_marker" "pass" "$OPENCLAW_DIST_EFFECTIVE"
  else
    add_result "patch_ssrf_marker" "fail" "GLADOS_SSRF_ROUTE_V2 not found in $OPENCLAW_DIST_EFFECTIVE"
  fi
else
  add_result "openclaw_dist" "fail" "dist not found: $OPENCLAW_DIST_EFFECTIVE"
fi

SENTINEL="$OPENCLAW_HOME_EFFECTIVE/logs/tag-injector-health.json"
run_check "tag_injector_health" node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
const stale=Date.now()-Number(j.ts||0)>180000;
if(j.healthy===false || stale) throw new Error(JSON.stringify({...j,stale}));
console.log(JSON.stringify({...j,stale}));
' "$SENTINEL"

RAW="$OPENCLAW_HOME_EFFECTIVE/logs/raw-stream.jsonl"
if [[ -e "$RAW" ]]; then add_result "raw_stream_file" "pass" "$RAW"; else add_result "raw_stream_file" "fail" "missing: $RAW"; fi

if [[ "$CHECK_GATEWAY" == "1" ]] && { command -v "$OPENCLAW_BIN" >/dev/null 2>&1 || [[ -x "$OPENCLAW_BIN" ]]; }; then
  run_check "gateway_status" env -u OPENCLAW_HOME "$OPENCLAW_BIN" gateway status --deep
else
  add_result "gateway_status" "skip" "skipped"
fi

if [[ "$CHECK_DOCTOR" == "1" && -x "$REPO_ROOT/scripts/glados-doctor.sh" ]]; then
  run_check "glados_doctor" "$REPO_ROOT/scripts/glados-doctor.sh"
else
  add_result "glados_doctor" "skip" "skipped"
fi

if [[ "$LIVE" == "1" ]]; then
  run_check "live_glados_message" env -u OPENCLAW_HOME "$OPENCLAW_BIN" agent --agent glados --message "Compatibility smoke test. Reply with OK only." --json
fi

if [[ "$LIVE_SUBAGENT" == "1" ]]; then
  run_check "live_subagent_request" env -u OPENCLAW_HOME "$OPENCLAW_BIN" agent --agent glados --message "Compatibility smoke test: dispatch source-code only if already safe; otherwise say SKIPPED." --json
fi

json="[$(IFS=,; echo "${RESULTS[*]}")]"
overall="pass"
if printf '%s' "$json" | grep -q '"status":"fail"'; then overall="fail"; fi

if [[ "$JSON_ONLY" == "1" ]]; then
  printf '{"ok":%s,"results":%s}\n' "$([[ "$overall" == "pass" ]] && echo true || echo false)" "$json"
else
  echo "OpenClaw compatibility: $overall"
  printf '%s\n' "$json" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  for (const r of JSON.parse(s)) {
    const detail = String(r.detail || "");
    const first = detail.split(/\r?\n/)[0].slice(0, 140);
    console.log(`- ${String(r.status).toUpperCase().padEnd(5)} ${r.name}: ${first}`);
  }
});
'
  echo
  printf 'JSON: {"ok":%s,"results":%s}\n' "$([[ "$overall" == "pass" ]] && echo true || echo false)" "$json"
fi

[[ "$overall" == "pass" ]]
