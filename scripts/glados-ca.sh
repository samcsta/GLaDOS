#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${GLADOS_RUNTIME_DIR:-$HOME/.glados}"
SECRETS_DIR="$RUNTIME_DIR/secrets"
KEY_FILE="$SECRETS_DIR/glados-mitm-ca.key"
CERT_FILE="$SECRETS_DIR/glados-mitm-ca.pem"
SUBJECT="/CN=GLaDOS Operator MITM CA $(hostname -s 2>/dev/null || hostname)/O=GLaDOS Local/"

usage() {
  cat <<'EOF'
usage: scripts/glados-ca.sh <generate|status|trust|untrust|rotate>

Generates and manages the per-operator GLaDOS MITM root CA.
The private key is local-only and must remain chmod 600 under ~/.glados/secrets.
EOF
}

ensure_dirs() {
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
}

generate() {
  ensure_dirs
  if [[ -e "$KEY_FILE" || -e "$CERT_FILE" ]]; then
    echo "CA already exists:"
    echo "  $KEY_FILE"
    echo "  $CERT_FILE"
    return 0
  fi
  umask 077
  openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "$SUBJECT" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash"
  chmod 600 "$KEY_FILE"
  chmod 644 "$CERT_FILE"
  echo "Generated local MITM CA:"
  echo "  key:  $KEY_FILE"
  echo "  cert: $CERT_FILE"
}

status() {
  ensure_dirs
  [[ -e "$KEY_FILE" ]] && ls -l "$KEY_FILE" || echo "missing $KEY_FILE"
  [[ -e "$CERT_FILE" ]] && ls -l "$CERT_FILE" || echo "missing $CERT_FILE"
}

trust() {
  generate
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Automatic trust is implemented for macOS only." >&2
    exit 1
  fi
  security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT_FILE"
  echo "Trusted $CERT_FILE in the login keychain."
}

untrust() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Automatic untrust is implemented for macOS only." >&2
    exit 1
  fi
  security delete-certificate -c "GLaDOS Operator MITM CA" "$HOME/Library/Keychains/login.keychain-db" || true
  echo "Removed matching GLaDOS MITM CA certificates from the login keychain, if present."
}

rotate() {
  ensure_dirs
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [[ -e "$KEY_FILE" ]] && mv "$KEY_FILE" "$KEY_FILE.rotated-$stamp"
  [[ -e "$CERT_FILE" ]] && mv "$CERT_FILE" "$CERT_FILE.rotated-$stamp"
  generate
}

cmd="${1:-}"
case "$cmd" in
  generate) generate ;;
  status) status ;;
  trust) trust ;;
  untrust) untrust ;;
  rotate) rotate ;;
  *) usage; exit 2 ;;
esac
