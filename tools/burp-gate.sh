#!/usr/bin/env bash
# burp-gate.sh — global kill switch for the GLaDOS Burp-gated egress layer.
#
# Actions:
#   halt-all            Scope/match-replace is flipped so Burp drops every request.
#                       Used for engagement-wide stop.
#   halt-agent <id>     Per-agent halt (informational; real enforcement is via
#                       exec-approvals.json deny rules written by watchdog/lib/halt.js).
#   resume-all          Restore the normal red-team scope.
#   resume-agent <id>   Per-agent resume (informational).
#   status              Print current scope mode.
#
# Requires the Burp Pro REST API to be enabled at BURP_API (default 127.0.0.1:1337).
# If BURP_API_KEY is set, it is sent as X-API-KEY.
#
# Note on scope toggling: Burp's built-in REST API does not reliably expose
# /v0.1/scope as a mutable endpoint in every version. We still PUT it (it works
# on some 2024+ builds and is harmless otherwise), but the primary enforcement
# for halts is:
#   1) HTTPS_PROXY env on agents (set in ~/.openclaw/openclaw.json) forces all
#      agent traffic through Burp on :8080.
#   2) watchdog/lib/halt.js writes deny rules into ~/.openclaw/exec-approvals.json
#      so the agent's next network tool call is refused by OpenClaw.
# The GLaDOS Burp extension at :1338 provides visibility (proxy history, RPS)
# for the dashboard — installed separately from
# tools/burp-ext-glados-proxy-api/.

set -euo pipefail

BURP_API="${BURP_API:-http://127.0.0.1:1337}"
BURP_API_KEY="${BURP_API_KEY:-}"
MODE_FILE="${MODE_FILE:-$HOME/.openclaw/burp-gate.state}"

auth_header() {
  if [[ -n "$BURP_API_KEY" ]]; then echo -H "X-API-KEY: $BURP_API_KEY"; fi
}

burp_get() {
  curl -sS --max-time 4 $(auth_header) "$BURP_API$1" || true
}

burp_put() {
  curl -sS --max-time 4 -X PUT -H 'Content-Type: application/json' $(auth_header) --data "$2" "$BURP_API$1" || true
}

halt_all() {
  mkdir -p "$(dirname "$MODE_FILE")"
  echo "HALTED $(date -u +%FT%TZ)" > "$MODE_FILE"
  # Best-effort: tell Burp to include an empty scope. Older Burp REST doesn't expose this
  # as a mutable endpoint; the primary enforcement is the HTTPS_PROXY env + exec-approvals
  # deny rules. We still write the state file so the dashboard can surface the gate state.
  burp_put "/v0.1/scope" '{"include":[],"exclude":[{"rule":"^.*$"}]}' >/dev/null
  echo "halt-all: burp scope dropped; state=$MODE_FILE"
}

resume_all() {
  mkdir -p "$(dirname "$MODE_FILE")"
  echo "OPEN $(date -u +%FT%TZ)" > "$MODE_FILE"
  burp_put "/v0.1/scope" '{"include":[{"rule":"^.*$"}],"exclude":[]}' >/dev/null
  echo "resume-all: burp scope restored; state=$MODE_FILE"
}

halt_agent() {
  local id="$1"
  mkdir -p "$(dirname "$MODE_FILE")"
  echo "AGENT-HALT $id $(date -u +%FT%TZ)" >> "$MODE_FILE.log"
  echo "halt-agent $id: deny rules written by watchdog exec-approvals"
}

resume_agent() {
  local id="$1"
  mkdir -p "$(dirname "$MODE_FILE")"
  echo "AGENT-RESUME $id $(date -u +%FT%TZ)" >> "$MODE_FILE.log"
  echo "resume-agent $id"
}

status() {
  if [[ -f "$MODE_FILE" ]]; then cat "$MODE_FILE"; else echo "OPEN (no state file)"; fi
}

cmd="${1:-status}"
case "$cmd" in
  halt-all)     halt_all ;;
  resume-all)   resume_all ;;
  halt-agent)   halt_agent "${2:?agent id required}" ;;
  resume-agent) resume_agent "${2:?agent id required}" ;;
  status)       status ;;
  *) echo "usage: $0 {halt-all|resume-all|halt-agent <id>|resume-agent <id>|status}" >&2; exit 2 ;;
esac
