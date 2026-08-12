#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
SECRETS_DIR="$RUNTIME_DIR/secrets"
FALLBACK_FILE="$SECRETS_DIR/llmapi.json"
SERVICE="${GLADOS_LLM_KEYCHAIN_SERVICE:-glados.llmapi}"
ACCOUNT="${GLADOS_LLM_KEYCHAIN_ACCOUNT:-$(id -un)}"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Enter the LiteLLM / Anthropic Messages key when macOS security prompts."
  security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE" -w
  STORED="$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null || true)"
  if [[ -z "$STORED" ]]; then
    echo "No key was stored in macOS Keychain." >&2
    exit 1
  fi
  echo "Stored LLM key in macOS Keychain service '$SERVICE' for account '$ACCOUNT'."
else
  read -r -s -p "LiteLLM / Anthropic Messages key: " LLM_KEY
  printf '\n'
  if [[ -z "$LLM_KEY" ]]; then
    echo "No key provided." >&2
    exit 1
  fi
  umask 077
  LLM_KEY="$LLM_KEY" node -e 'const fs=require("fs"); const f=process.argv[1]; let token=String(process.env.LLM_KEY || "").trim().replace(/^Bearer\s+/i, "").trim(); if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'\''") && token.endsWith("'\''"))) token=token.slice(1,-1).trim(); if (!token) throw new Error("key is empty after normalization"); fs.writeFileSync(f, JSON.stringify({version:1, token, updated_at:new Date().toISOString()}, null, 2)+"\n", {mode:0o600}); fs.chmodSync(f,0o600);' "$FALLBACK_FILE"
  echo "Stored fallback LLM key at $FALLBACK_FILE with chmod 600."
fi

echo "Verify the stored key and both LiteLLM routes with: scripts/check-llm.sh"
