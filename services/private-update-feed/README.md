# GLaDOS private update feed

This service exposes electron-builder update metadata and artifacts through an
authenticated HTTPS endpoint. It stores only SHA-256 hashes of per-user bearer
tokens. The app stores the corresponding token with Electron `safeStorage`
(macOS Keychain; Secret Service/KWallet on Ubuntu).

## Artifact layout

Point `GLADOS_UPDATE_ROOT` at a release directory with this shape:

```text
releases/
  macos/
    arm64/
      latest-mac.yml
      GLaDOS-4.0.1-arm64.zip
      GLaDOS-4.0.1-arm64.zip.blockmap
  linux/
    x64/
      latest-linux.yml
      GLaDOS-4.0.1-x86_64.AppImage
```

The feed URLs entered in GLaDOS are
`https://updates.redteam.example/glados/macos/arm64` on both Macs and
`https://updates.redteam.example/glados/linux/x64` on Ubuntu. Keeping separate
paths prevents a client from ever receiving metadata for the wrong operating
system or architecture.

Upload the versioned payload and any separate blockmap first. The AppImage's
block map is embedded in the AppImage itself. Upload `latest-*.yml` last so
clients can never observe metadata for an unavailable payload. Never replace
a published version; rollback by publishing the known-good code under a higher
patch version.

## Provision a red-team member

```bash
cd services/private-update-feed
npm run token
```

Give the `token=` value to one user through your existing secret-sharing
channel. Append only the `sha256=` value to `GLADOS_UPDATE_TOKEN_HASHES` on the
server. One token per person gives you individual revocation without changing
the app or other users.

## HTTPS deployment

Run the Node service only on loopback and terminate TLS in Caddy (or your
existing authenticated ingress):

```text
updates.redteam.example {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8088 {
    header_up X-Forwarded-Proto https
  }
}
```

Example environment file (mode `0600`):

```bash
GLADOS_UPDATE_ROOT=/srv/glados/releases
GLADOS_UPDATE_BASE_PATH=/glados
GLADOS_UPDATE_TOKEN_HASHES=<sha256-user-1>,<sha256-user-2>
GLADOS_UPDATE_TRUST_PROXY_TLS=1
GLADOS_UPDATE_HOST=127.0.0.1
PORT=8088
```

Deployment templates are included in `deploy/`. On the feed host, install the
service code read-only at `/opt/glados/private-update-feed`, create a dedicated
`glados-updates` system user, place the environment file at
`/etc/glados/update-feed.env` with mode `0600`, and keep release artifacts under
`/srv/glados/releases` readable by that user. Then install/enable the unit and
adapt the Caddy hostname:

```bash
sudo install -m 0644 deploy/glados-update-feed.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now glados-update-feed
sudo systemctl reload caddy
```

Proxy-terminated TLS mode fails closed unless the Node service binds to
loopback. The Caddy template overwrites `X-Forwarded-Proto`; do not expose port
8088 through the host firewall.

The service rejects plain HTTP client traffic, path traversal, unauthenticated
downloads, and non-GET/HEAD methods. It supports `Range` and `HEAD`, which
electron-updater needs for efficient downloads.

## Security boundary

- TLS and bearer authorization protect metadata and downloads in transit.
- `latest-mac.yml` SHA-512 metadata protects against transfer corruption.
- macOS still requires the downloaded app to carry the expected Developer ID
  signature. The feed credential is not a substitute for code signing.
- Do not embed a shared token in the app or CI artifact.
- Do not redirect metadata or artifacts to a different origin; serve them
  directly from the authenticated update hostname.
- Put release signing/notarization credentials in a protected CI environment;
  the feed server never needs them.
- For Ubuntu, add an application-level Ed25519/minisign verification gate before
  production rollout because Linux does not provide the same Developer ID
  enforcement as macOS.
