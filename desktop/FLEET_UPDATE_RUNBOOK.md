# GLaDOS fleet update runbook

## Supported fleet

- Mac 1: macOS Apple Silicon (`arm64`)
- Mac 2: macOS Apple Silicon (`arm64`)
- Linux: Debian/Kali/Ubuntu or Fedora (`x86_64`) running the AppImage
- Windows: Windows x64 running the signed NSIS installation
- macOS feed: `https://updates.r3dt34m.net/glados/macos/arm64`
- Linux feed: `https://updates.r3dt34m.net/glados/linux/x64`
- Windows feed: `https://updates.r3dt34m.net/glados/windows/x64`

Keep the app ID `com.glados.ops`, signing identity, feed paths, and architecture
stable.

## v4.4.8 clean-Mac correction

Do not overwrite the published v4.4.8 artifacts. That build could use a
Homebrew `mitmdump` from the release Mac during smoke testing even though it
was not present in the app, and its loose `.command` uninstaller could be
blocked by Gatekeeper. Upgrade affected Macs manually to v4.4.9. The corrected
release bundles pinned mitmproxy arm64, forces the packaged test to use it with
a system-only `PATH`, and replaces the script launcher with a separately
signed, notarized, and stapled uninstaller app.

As a temporary v4.4.8 repair before installing v4.4.9, run
`brew install --cask mitmproxy`, then fully quit and reopen GLaDOS. To uninstall
v4.4.8 without bypassing Gatekeeper, run
`bash "/Applications/GLaDOS.app/Contents/Resources/scripts/uninstall-desktop-app.sh"`.

## One-time bootstrap before v4.0.1

The originally installed v4.0.0 macOS app predates the private updater. It
cannot discover v4.0.1 by itself. Perform one manual installation of a signed,
notarized, updater-enabled v4.0.0 baseline on both Macs. Install the matching
v4.0.0 AppImage baseline on Linux. After that bootstrap, updates are delivered
with the in-app button.

Do not install the unsigned development artifacts. A production Mac baseline
requires a Developer ID Application certificate and Apple notarization
credentials:

```bash
export CSC_NAME='Your Name or Company (TEAMID)'
export APPLE_KEYCHAIN_PROFILE='glados-notary'
npm run release:mac --prefix desktop
```

For CI without a Keychain profile, provide `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` instead.

The release command fails closed when signing or notarization credentials are
missing. Back up `~/.glados`, quit GLaDOS, and install the resulting DMG on each
Mac. The app bundle is replaced; reports, investigations, model assignments,
credentials, proxy data, and workspaces remain under `~/.glados`.

For Linux, install and launch the AppImage rather than a distro package when in-app
self-update is required:

```bash
chmod 0755 GLaDOS-4.0.0-x86_64.AppImage
./GLaDOS-4.0.0-x86_64.AppImage
```

## Deploy the VPN-only HTTPS feed

1. Provision `updates.r3dt34m.net` through the split-DNS Red Team pattern and
   issue its TLS certificate with Caddy's Google Cloud DNS challenge provider.
2. Install `services/private-update-feed` on the feed host and use the supplied
   systemd and Caddy templates.
3. Set `GLADOS_UPDATE_REQUIRE_AUTH=0`; the GCP ingress firewall, split DNS, and
   routing are the access boundary. Keep the optional bearer mode disabled
   unless this endpoint is intentionally exposed beyond the VPN.
4. Create `/srv/docker/updates/releases/{macos/arm64,linux/x64,windows/x64}`.
   Keep the feed service on loopback behind Caddy and expose only HTTPS.
5. Put first-install DMGs, AppImages, and signed Windows installers under
   `/srv/docker/updates/installers`; Caddy serves direct installer paths only
   to clients that can reach the VPN-only host.
6. No workstation feed setup is required. Packaged GLaDOS selects the correct
   URL and checks automatically.

## Publish v4.0.1

From a clean release branch, set the same version in both version sources:

```bash
printf 'v4.0.1\n' > VERSION
npm version 4.0.1 --no-git-tag-version --prefix desktop
test "$(sed 's/^v//' VERSION)" = "$(node -p 'require("./desktop/package.json").version')"
```

Build the Mac release on Apple Silicon with the signing/notarization variables
shown above:

```bash
npm run release:mac --prefix desktop
```

Build Linux x64 from the Debian 12 compatibility baseline and run the packaged
payload unchanged on Debian, Kali, and Fedora:

```bash
npm run dist:linux:docker --prefix desktop
npm run smoke:debian:gui:docker --prefix desktop
npm run smoke:kali:docker --prefix desktop
npm run smoke:fedora:docker --prefix desktop
```

Build Windows x64 on a native protected Windows host with the Authenticode
certificate available only through `CSC_LINK` and `CSC_KEY_PASSWORD`:

```powershell
npm run release:windows --prefix desktop
```

All three builds must pass tests, recursive native-architecture audits, and packaged
smoke tests. Then perform a clean-host smoke test and an upgrade test from the
signed/updater-enabled v4.0.0 baseline.

Publish immutable payloads first:

- macOS: signed ZIP, ZIP blockmap, and optional DMG
- Linux: AppImage (its differential-update block map is embedded)
- Windows: Authenticode-signed NSIS installer and blockmap

Publish `latest-mac.yml`, `latest-linux.yml`, and Windows `latest.yml` last. Never overwrite artifacts
for an already published version. Roll back by publishing the known-good code
under a higher version.

## Update the supported fleet

GLaDOS checks 15 seconds after launch and every six hours. When a newer release
exists it shows a compact update banner. On each macOS, Linux, and Windows pilot:

1. Finish or stop every active agent run.
2. Press **Update GLaDOS** in the banner.
3. GLaDOS downloads, verifies, snapshots, installs, and restarts without a
   second approval dialog.
4. GLaDOS refuses installation while agents are active and creates a
   pre-install SQLite/config snapshot under the per-user GLaDOS runtime.
5. After restart, confirm v4.0.1, `/api/healthz`, proxy startup, model
   assignments, report counts, and the most recent investigation on each host.

Pilot one machine per platform first. After health and preservation checks pass,
update the rest of that platform's fleet. Update metadata is shared per
platform, so all clients on a platform see the same signed release.

## Production gates still requiring owner infrastructure

- Developer ID Application certificate and Apple notarization credentials
- The private HTTPS hostname/feed host and VPN-only DNS/routing
- A protected release runner and secret store
- Application-level detached signature verification for Linux payloads before
  treating the Linux channel as hardened against update-host compromise
- Clean Apple-silicon, Debian/Kali, Fedora, and Windows x64 acceptance/update tests
