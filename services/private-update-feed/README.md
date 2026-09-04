# GLaDOS private update feed

This service exposes electron-builder update metadata and artifacts through an
HTTPS endpoint restricted to the Red Team VPN. Packaged GLaDOS clients know the
platform-specific feed URL and do not require users to configure a URL or
credential. Optional bearer authentication remains available for deployments
that are not protected by the VPN boundary.

New users visit the origin root (for production,
`https://updates.r3dt34m.net/`). The service renders a no-script download page
whose platform buttons are derived from the newest versioned files actually
present under `installers/`. A platform remains marked **Coming soon** until its
installer has been published, so the page cannot advertise a missing payload.

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
  windows/
    x64/
      latest.yml
      GLaDOS-4.0.1-x64.exe
```

GLaDOS automatically uses `https://updates.r3dt34m.net/glados/macos/arm64` on
Apple Silicon, `/glados/linux/x64` on Debian/Kali/Ubuntu or Fedora x64, and
`/glados/windows/x64` on Windows x64. Keeping separate paths prevents a client from ever receiving
metadata for the wrong operating system or architecture.

When `GLADOS_INSTALLER_ROOT` is configured, separately downloadable installers
are served under `/installers/` by the same process. This supports a single
VPN-only Caddy reverse proxy without granting the container write access to
published artifacts.

For Linux, publish `install-glados-linux.sh` and `glados.png` beside the latest
AppImage. For Windows, publish `install-glados-windows.ps1` beside the signed
NSIS installer. The landing page recommends the appropriate setup script, which provisions
the workstation and installs the AppImage at a stable, user-writable path so
future in-app updates can replace it. The direct AppImage remains available for
workstations whose prerequisites are already installed.

Upload the versioned payload and any separate blockmap first. The AppImage's
block map is embedded in the AppImage itself. Upload `latest-*.yml` last so
clients can never observe metadata for an unavailable payload. Never replace
a published version; rollback by publishing the known-good code under a higher
patch version.

## Optional bearer authentication

The production VM uses `GLADOS_UPDATE_REQUIRE_AUTH=0` because its DNS, routing,
and ingress firewall restrict the endpoint to the Red Team VPN. Signed release
artifacts remain mandatory. If the endpoint is ever reachable outside that
boundary, set `GLADOS_UPDATE_REQUIRE_AUTH=1` and provision one token per user:

```bash
cd services/private-update-feed
npm run token
```

Give the `token=` value to one user through your existing secret-sharing
channel. Append only the `sha256=` value to `GLADOS_UPDATE_TOKEN_HASHES` on the
server, and provision the plaintext token through
`GLADOS_UPDATE_BEARER_TOKEN`. Never compile a shared token into the app.

## HTTPS deployment

Run the Node service only on loopback and terminate TLS in Caddy (or your
existing authenticated ingress):

```text
updates.r3dt34m.net {
  encode zstd gzip

  tls {
    dns googleclouddns {
      gcp_project ford-4b73927e8436f15d997f4b84
    }
  }

  handle_path /installers/* {
    root * /srv/glados/installers
    file_server
  }

  handle {
    reverse_proxy 127.0.0.1:8088 {
      header_up X-Forwarded-Proto https
    }
  }
}
```

Example environment file (mode `0600`):

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

## Docker Compose deployment

`compose.yaml` runs the feed read-only with all Linux capabilities dropped and
uses host networking only so it can bind the exact IPv6 loopback upstream Caddy
expects. Copy this service directory to `/srv/docker/updates`, create the local
`releases/` and `installers/` directories, and run `docker compose up -d --build`.
The default upstream is `[::1]:4000`; it can be changed with
`GLADOS_UPDATE_PORT` if the infrastructure owner assigns another loopback port.

## Security boundary

- TLS protects metadata and downloads in transit; the GCP firewall and private
  DNS/routing restrict production access to Red Team VPN clients.
- `latest-mac.yml` SHA-512 metadata protects against transfer corruption.
- macOS still requires the downloaded app to carry the expected Developer ID
  signature. The feed credential is not a substitute for code signing.
- Windows releases require Authenticode signing, and Linux releases require the
  application-level signature gate described in the distribution plan.
- Do not embed a shared token in the app or CI artifact if optional bearer
  authentication is enabled.
- Do not redirect metadata or artifacts to a different origin; serve them
  directly from the authenticated update hostname.
- Put release signing/notarization credentials in a protected CI environment;
  the feed server never needs them.
- For Linux, add an application-level Ed25519/minisign verification gate before
  production rollout because Linux does not provide the same Developer ID
  enforcement as macOS.
