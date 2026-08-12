# GLaDOS fleet update runbook

## Supported fleet

- Mac 1: macOS Apple Silicon (`arm64`)
- Mac 2: macOS Apple Silicon (`arm64`)
- Ubuntu 1: Ubuntu 24.04 (`x86_64`) running the AppImage
- macOS feed: `https://updates.redteam.example/glados/macos/arm64`
- Ubuntu feed: `https://updates.redteam.example/glados/linux/x64`

Replace `updates.redteam.example` with the private update hostname. Keep the app ID
`com.glados.ops`, signing identity, feed paths, and architecture stable.

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
v4.0.0 AppImage baseline on Ubuntu. After that bootstrap, updates are delivered
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

For Ubuntu, install and launch the AppImage rather than the DEB when in-app
self-update is required:

```bash
chmod 0755 GLaDOS-4.0.0-x86_64.AppImage
./GLaDOS-4.0.0-x86_64.AppImage
```

GNOME Secret Service or KWallet must be installed and unlocked. GLaDOS refuses
to save the feed bearer token if Electron falls back to plaintext storage.

## Deploy the authenticated HTTPS feed

1. Provision a private DNS hostname and valid TLS certificate.
2. Install `services/private-update-feed` on the feed host and use the supplied
   systemd and Caddy templates.
3. Generate three credentials so each workstation can be revoked separately:

   ```bash
   npm run token --prefix services/private-update-feed
   npm run token --prefix services/private-update-feed
   npm run token --prefix services/private-update-feed
   ```

4. Give one plaintext `token=` value to each workstation through the team's
   secret-sharing channel. Put only the three `sha256=` values in the server's
   `GLADOS_UPDATE_TOKEN_HASHES` setting.
5. Create `/srv/glados/releases/macos/arm64` and
   `/srv/glados/releases/linux/x64`. Keep the feed service on loopback behind
   Caddy and expose only HTTPS.
6. In the GLaDOS Update settings, configure both Macs with the macOS feed URL
   and Ubuntu with the Linux feed URL, plus each machine's unique token.

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

Build Ubuntu x64 in the isolated Ubuntu 24.04 container, or run the same build
on a native protected Ubuntu 24.04 x64 CI runner:

```bash
npm run dist:ubuntu:docker --prefix desktop
```

Both builds must pass tests, recursive native-architecture audits, and packaged
smoke tests. Then perform a clean-host smoke test and an upgrade test from the
signed/updater-enabled v4.0.0 baseline.

Publish immutable payloads first:

- macOS: signed ZIP, ZIP blockmap, and optional DMG
- Ubuntu: AppImage (its differential-update block map is embedded)

Publish `latest-mac.yml` and `latest-linux.yml` last. Never overwrite artifacts
for an already published version. Roll back by publishing the known-good code
under a higher version.

## Update all three machines

On Mac 1, Mac 2, and Ubuntu 1:

1. Finish or stop every active agent run.
2. Open Update and select **Check for updates**.
3. Download v4.0.1, then approve restart and installation.
4. GLaDOS refuses installation while agents are active and creates a
   pre-install SQLite/config snapshot under `~/.glados/backups/updates/`.
5. After restart, confirm v4.0.1, `/api/healthz`, proxy startup, model
   assignments, report counts, and the most recent investigation on each host.

Pilot Mac 1 first. After its health and preservation checks pass, update Mac 2
and Ubuntu 1. The update metadata is shared per platform, so all clients see the
same release; the per-machine bearer tokens only control access and revocation.

## Production gates still requiring owner infrastructure

- Developer ID Application certificate and Apple notarization credentials
- The private HTTPS hostname/feed host and three issued bearer tokens
- A protected release runner and secret store
- Application-level detached signature verification for Linux payloads before
  treating the Ubuntu channel as hardened against update-host compromise
- Clean Apple-silicon and Ubuntu 24.04 acceptance/update tests
