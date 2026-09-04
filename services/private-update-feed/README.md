# GLaDOS private update feed

This service exposes macOS and Linux electron-builder update metadata and
artifacts through an HTTPS endpoint restricted to the Red Team VPN. Packaged
clients derive their platform URL and do not require user configuration.
Optional bearer authentication remains available outside the VPN boundary.

The root renders a no-script download page. Its macOS and Linux buttons are
derived from versioned installers actually present under `installers/`.
Windows links to the public source repository because no official Windows
binary or update channel is published.

## Artifact layout

```text
releases/
  macos/
    arm64/
      latest-mac.yml
      GLaDOS-4.5.8-arm64.zip
      GLaDOS-4.5.8-arm64.zip.blockmap
  linux/
    x64/
      latest-linux.yml
      GLaDOS-4.5.8-x86_64.AppImage
installers/
  macos/
    GLaDOS-4.5.8-arm64.dmg
  linux/
    GLaDOS-4.5.8-x86_64.AppImage
    install-glados-linux.sh
    glados.png
```

GLaDOS uses `/glados/macos/arm64` on Apple Silicon and `/glados/linux/x64`
on Debian/Kali/Ubuntu or Fedora x64. Upload versioned payloads and blockmaps
first, then publish `latest-*.yml` last. Never replace an already published
version; rollback by publishing known-good code under a higher version.

## Optional bearer authentication

The production VM may use `GLADOS_UPDATE_REQUIRE_AUTH=0` only when ingress,
private DNS, and routing restrict it to the Red Team VPN. If it is reachable
outside that boundary, enable authentication and generate a per-user token:

```bash
cd services/private-update-feed
npm run token
```

Share the plaintext token through the approved secret channel, store only its
SHA-256 value in `GLADOS_UPDATE_TOKEN_HASHES`, and provision the client through
`GLADOS_UPDATE_BEARER_TOKEN`. Never compile a shared token into the app.

## Deployment

Run the Node service on loopback behind Caddy or approved TLS ingress. Example
environment:

```bash
GLADOS_UPDATE_ROOT=/srv/glados/releases
GLADOS_UPDATE_BASE_PATH=/glados
GLADOS_INSTALLER_ROOT=/srv/glados/installers
GLADOS_INSTALLER_BASE_PATH=/installers
GLADOS_UPDATE_REQUIRE_AUTH=0
GLADOS_UPDATE_TRUST_PROXY_TLS=1
GLADOS_UPDATE_HOST=127.0.0.1
PORT=8088
```

Deployment templates live in `deploy/`. Install the service read-only at
`/opt/glados/private-update-feed`, keep its environment file mode `0600`, and
keep release artifacts readable but not writable by the service user. The
service rejects plain HTTP client traffic, traversal, unauthenticated requests
when enabled, and non-GET/HEAD methods. It supports `Range` and `HEAD`.

`compose.yaml` runs the service read-only with Linux capabilities dropped.
Copy this directory to `/srv/docker/updates`, create `releases/` and
`installers/`, then run `docker compose up -d --build`.

## Security boundary

- TLS protects metadata and downloads in transit; the firewall and private
  DNS/routing restrict production access to VPN clients.
- macOS payloads must carry the expected Developer ID signature and
  notarization ticket.
- Linux needs an independent application-level Ed25519/minisign gate before a
  hardened broad rollout; HTTPS metadata hashes alone do not protect against a
  compromised update host.
- Windows source builds do not use this service.
- Signing/notarization credentials belong in a protected release environment,
  never on the feed server.
