# GLaDOS Desktop Distribution Plan

## Recommended channel

Ship GLaDOS directly as a Developer ID-signed and Apple-notarized DMG. Use the
DMG for first installation and the signed ZIP plus `latest-mac.yml` for
`electron-updater` updates. This stays outside the Mac App Store while giving
Gatekeeper a verifiable developer identity and notarization ticket.

Use a dedicated HTTPS update origin as the production feed. A public GitHub
Release is acceptable if the binaries are not sensitive. Do not embed a GitHub
token in the app to access a private repository; use an authenticated update
service or CDN with short-lived operator credentials instead.

References:

- [Apple Developer ID](https://developer.apple.com/developer-id/)
- [Apple notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [electron-builder macOS auto-update](https://www.electron.build/docs/features/auto-update/)

## Release-readiness gates

1. **Apple identity**
   - Enroll the release owner in the Apple Developer Program.
   - Create a `Developer ID Application` certificate.
   - Create an App Store Connect API key for CI notarization.
   - Keep `com.glados.ops` stable; changing the bundle ID after release breaks
     upgrade and data-path continuity.

2. **Supported architecture matrix**
   - macOS: Apple Silicon (`arm64`) only.
   - Debian-family Linux (Debian, Kali, and Ubuntu): Intel/AMD (`x86_64`) only,
     using AppImage for installation and in-app self-update.
   - Fedora Linux: Intel/AMD (`x86_64`) only, using the same AppImage.
   - Windows: Intel/AMD (`x64`) only, using a per-user NSIS installer and
     in-app self-update.
   - Publish separate `/macos/arm64`, `/linux/x64`, and `/windows/x64` feeds.
     Recursively audit `better-sqlite3`, `node-pty`, Electron, and every
     packaged helper for the target architecture before publishing.

3. **First-run prerequisites**
   - The macOS package bundles the official signed mitmproxy arm64 app and
     launches its `mitmdump`, so proxy startup does not depend on Homebrew.
     Broader assessment tools remain machine-level prerequisites and should be
     handled by the existing doctor/bootstrap flow with explicit operator
     consent.
   - First launch must stop with a clear actionable diagnostic when a required
     dependency is missing. It must not present a healthy proxy or assessment
     state when the dependency failed.
   - Linux and Windows first-time installers provision mitmproxy and the core
     command-line tools. The Setup Assistant installs the per-workstation CA
     in the Debian/Fedora trust store or the Windows current-user Root store.

4. **Release build must fail closed**
   - Add `forceCodeSigning: true`; never publish when signing credentials are
     missing.
   - Use hardened runtime and only the entitlements that are required.
   - Notarize with `notarytool`, staple the ticket, and inspect the notary log.
   - Keep signing and notarization credentials only in the protected CI release
     environment.
   - Windows release builds require Authenticode credentials and must reject an
     installer whose `Get-AuthenticodeSignature` status is not `Valid`.

## CI release pipeline

Trigger the production job only from a protected semantic-version tag such as
`v4.0.1`, with a manual production-environment approval.

1. Check that `VERSION` and `desktop/package.json` match the tag.
2. Install locked dependencies and run the complete dashboard test suite.
3. Build macOS arm64 on an Apple-silicon macOS runner, the Linux x64 AppImage
   from a Debian 12 baseline, and Windows x64 on a native Windows runner.
4. Sign every executable/native module with Developer ID and hardened runtime.
5. Notarize and staple the application/distribution artifact.
6. Run all release verification gates:
   - `codesign --verify --deep --strict --verbose=2 GLaDOS.app`
   - `spctl --assess --verbose --type exec GLaDOS.app`
   - `xcrun stapler validate GLaDOS.app`
   - packaged dashboard/proxy smoke test
   - clean-Mac first-install test
   - upgrade test from the previous stable release while preserving
     `~/.glados`
   - Debian, Kali, and Fedora packaged GUI smoke tests
   - Windows PE architecture audit, packaged dashboard smoke test, and
     Authenticode verification
7. Generate the DMG, update ZIP, AppImage, NSIS installer, blockmaps, platform channel
   metadata, SHA-256 manifests, and release notes.
8. Upload artifacts first and publish the channel metadata last. This prevents
   clients from seeing an update whose payload is not available yet.

## Installed-user update flow

The `electron-updater` integration uses a generic HTTPS feed reachable only
through the Red Team VPN. The platform-specific URL is built into GLaDOS, so
operators do not configure a feed or token. An optional bearer token can still
be supplied through the process environment for deployments outside the VPN
boundary; it is never compiled into the app.

- Check the stable feed 15 seconds after launch and every six hours, with a
  manual **Check for updates** action retained.
- Show a compact banner when a newer release exists. One **Update GLaDOS**
  action downloads, verifies, snapshots, installs, and restarts. Never install
  while an assessment agent is active.
- Persist the downloaded-update state, then ask the operator to restart and
  install at a safe point.
- Back up the SQLite runtime and model/config state before installation. The
  implemented preservation snapshot lives under `~/.glados/backups/updates/`.
  Migrations must remain forward-only, transactional, and tested from the
  oldest supported release.
- Preserve `~/.glados`, reports, evidence, credentials, proxy history, and
  operator-edited agent workspaces. They are runtime data, never update
  payload.
- Support `beta` and `latest` channels. Promote an identical signed artifact
  from beta to stable instead of rebuilding it.
- Use staged rollout metadata: internal pilot, 10%, 50%, then 100% after health
  review. A rollback is a new higher patch version containing the prior known-
  good code; never replace an already published version in place.

## Update-origin choice

### Preferred for an internal/private app

Use a generic HTTPS feed restricted to the Red Team VPN and publish channel
metadata only after every referenced artifact is available. Platform signing
remains the artifact trust boundary. If the feed ever becomes reachable beyond
the VPN, add organizational authentication or short-lived download credentials
without placing a reusable credential in every installed app.

### Acceptable for non-sensitive public binaries

Keep the existing GitHub provider and publish signed release assets from CI.
GitHub is simple, but the electron-builder private-GitHub client mode expects a
token on each user machine and is explicitly not intended for general users.

## Rollout and support

1. Test on a clean Apple-silicon Mac, Debian/Kali x64, Fedora x64, and Windows
   x64 workstations, including first launch, proxy startup, browser MCP, one
   harmless assessment fixture, update, rollback release, and
   uninstall/reinstall with data preservation.
2. Pilot with two or three internal operators for at least one complete
   investigation each.
3. Review crash logs, dashboard health latency, first-activity timeouts, update
   failures, and migration failures before each rollout increase.
4. Publish a support bundle action that exports version, architecture, signing
   status, sanitized health data, dependency doctor results, and recent app
   errors without credentials or target evidence.

## Remaining rollout gates

- The compatibility workflow is intentionally unsigned; production signing
  belongs in a protected, manually approved release environment.
- Linux packaging, dependency-provisioning smokes, and native-module audits are
  configured. The channel still relies on the SHA-512 value in HTTPS metadata;
  add independent Ed25519/minisign verification before a hardened broad rollout.
- Windows packaging, native PE auditing, packaged smoke testing, and fail-closed
  Authenticode checks are configured. A protected Windows signing identity and
  clean Windows release/pilot machines remain owner infrastructure.
- Complete clean physical/VM first-install and previous-version update pilots on
  Debian/Kali, Fedora, and Windows before enabling those production channels.
