#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
VERSION_NUMBER="${VERSION#v}"
ARTIFACT_DIR="$ROOT/artifacts"
APPIMAGE_REL="artifacts/desktop/ubuntu-x64/GLaDOS-${VERSION_NUMBER}-x86_64.AppImage"
INSTALLER_REL="scripts/install-desktop-app-ubuntu.sh"
BUILDER_REL="scripts/build-ubuntu-test-bundle.sh"
LLM_CHECK_REL="scripts/check-llm.sh"
OUTPUT="$ARTIFACT_DIR/GLaDOS-${VERSION_NUMBER}-Ubuntu-test-bundle.tar.gz"
CHECKSUM="$OUTPUT.sha256"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-ubuntu-test-bundle.sh currently requires macOS bsdtar" >&2
  exit 1
fi
if [[ ! -f "$ROOT/$APPIMAGE_REL" ]]; then
  echo "Ubuntu AppImage is missing: $ROOT/$APPIMAGE_REL" >&2
  exit 1
fi
if [[ ! -f "$ROOT/$INSTALLER_REL" ]]; then
  echo "Ubuntu installer is missing: $ROOT/$INSTALLER_REL" >&2
  exit 1
fi

mkdir -p "$ARTIFACT_DIR"
manifest="$(mktemp "${TMPDIR:-/tmp}/glados-ubuntu-manifest.XXXXXX")"
temporary_archive="$(mktemp "$ARTIFACT_DIR/.glados-ubuntu-bundle.XXXXXX.tar.gz")"
trap 'rm -f "$manifest" "$temporary_archive"' EXIT

cd "$ROOT"
git ls-files -z > "$manifest"
for required_path in "$INSTALLER_REL" "$BUILDER_REL" "$LLM_CHECK_REL" "$APPIMAGE_REL"; do
  if ! git ls-files --error-unmatch -- "$required_path" >/dev/null 2>&1; then
    printf '%s\0' "$required_path" >> "$manifest"
  fi
done

# USTAR is sufficient for this bundle's paths and avoids PAX metadata records;
# the remaining exclusions prevent macOS metadata from entering the payload.
COPYFILE_DISABLE=1 tar \
  --format ustar \
  --no-acls \
  --no-fflags \
  --no-mac-metadata \
  --no-xattrs \
  --uid 0 \
  --gid 0 \
  --uname root \
  --gname root \
  -czf "$temporary_archive" \
  --null \
  -T "$manifest"

mv "$temporary_archive" "$OUTPUT"
archive_hash="$(shasum -a 256 "$OUTPUT" | awk '{print $1}')"
printf '%s  %s\n' "$archive_hash" "$(basename "$OUTPUT")" > "$CHECKSUM"
chmod 0644 "$OUTPUT" "$CHECKSUM"

echo "Created $OUTPUT"
cat "$CHECKSUM"
