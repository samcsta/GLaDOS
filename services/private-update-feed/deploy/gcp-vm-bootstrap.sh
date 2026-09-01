#!/usr/bin/env bash
set -euo pipefail

metadata_url="http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/glados/bootstrap"

report_status() {
  curl --fail --silent --show-error \
    --request PUT \
    --header "Metadata-Flavor: Google" \
    --data "$1" \
    "$metadata_url" >/dev/null || true
}

trap 'report_status "failed at line ${LINENO}"' ERR
report_status "initializing"

data_device="/dev/disk/by-id/google-glados-updates-data0"
for _ in $(seq 1 60); do
  [[ -b "$data_device" ]] && break
  sleep 2
done
[[ -b "$data_device" ]]

if [[ -z "$(blkid -s TYPE -o value "$data_device" || true)" ]]; then
  mkfs.ext4 -F -m 0 -L glados-updates "$data_device"
fi

mkdir -p /srv/glados
data_uuid="$(blkid -s UUID -o value "$data_device")"
if ! grep -q "^UUID=${data_uuid} " /etc/fstab; then
  printf 'UUID=%s /srv/glados ext4 defaults,nofail,discard 0 2\n' "$data_uuid" >> /etc/fstab
fi

mountpoint -q /srv/glados || mount /srv/glados
mkdir -p \
  /srv/glados/releases/macos/arm64 \
  /srv/glados/releases/linux/x64 \
  /srv/glados/releases/windows/x64 \
  /srv/glados/installers/macos \
  /srv/glados/installers/linux \
  /srv/glados/installers/windows
chown root:root /srv/glados
chmod 0755 /srv/glados /srv/glados/releases /srv/glados/installers

report_status "complete uuid=${data_uuid} mount=/srv/glados"
