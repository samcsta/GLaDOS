# GLaDOS Desktop Distribution Plan

## Supported channels

GLaDOS regularly publishes maintained binaries for:

- macOS Apple Silicon (`arm64`): Developer ID-signed and Apple-notarized DMG,
  with signed ZIP updates through `/macos/arm64`.
- Debian-family Linux (Debian, Kali, and Ubuntu) and Fedora (`x86_64`): the
  same AppImage through `/linux/x64`.

Windows 11 x64 remains compatibility-tested but source-build only. Major
release source is published to GitHub and Gitea; no official Windows binary,
NSIS installer, or `/windows/x64` update channel is published. Windows
operators build a verified tag or release commit locally. See
`WINDOWS_PLAN.md`.

Use the dedicated HTTPS origin as the macOS/Linux production feed. Never embed
a reusable repository or feed credential in the application.

## Release-readiness gates

1. **Apple identity**
   - Keep `com.glados.ops` stable.
   - Sign with a Developer ID Application certificate.
   - Notarize through a protected App Store Connect credential and staple the ticket.
2. **Architecture and native payloads**
   - Audit Electron, `better-sqlite3`, `node-pty`, and packaged helpers
     recursively for each target architecture.
   - Build Linux from the Debian 12 baseline and run the unchanged AppImage on
     Debian, Kali, and Fedora.
   - Run Windows x64 source/package compatibility QA for major releases, but do
     not upload its unsigned output.
3. **First-run dependencies**
   - macOS bundles the pinned official mitmproxy arm64 application.
   - The Linux easy installer provisions mitmproxy and core CLI tools.
   - The Windows prerequisite script prepares a local source-build host.
4. **Fail closed**
   - macOS production builds fail if signing or notarization is unavailable.
   - Linux production publication requires its configured integrity checks.
   - Windows artifacts are never treated as a production distribution output.

## Release pipeline

Trigger production publication only from a protected semantic-version release
revision with manual approval.

1. Verify `VERSION`, `desktop/package.json`, and the release revision agree.
2. Install locked dependencies and run the complete desktop, dashboard, and
   private-feed test suites.
3. Build/sign/notarize macOS arm64 and build Linux x64 from Debian 12.
4. Run native audits, packaged smokes, distro GUI smokes, and clean-host/upgrade
   preservation checks.
5. Generate the macOS DMG/update ZIP and Linux AppImage, blockmaps, channel
   metadata, checksums, and release notes.
6. Upload immutable payloads first and publish `latest-mac.yml` and
   `latest-linux.yml` last.
7. Separately run the Windows compatibility workflow against the same release
   revision. Publish source and QA status, never its unsigned package.

## Installed-user update flow

The packaged binary updater is enabled only on macOS arm64 and Linux x64. It
uses the generic HTTPS feed reachable through the Red Team VPN, checks shortly
after launch and every six hours, and provides one guarded **Update GLaDOS**
action. Installation is blocked while agents are active, and a runtime snapshot
is written under `~/.glados/backups/updates/` first.

Runtime data—including reports, evidence, credentials, proxy history, model
assignments, and workspaces—never belongs in an application payload. Rollbacks
are new higher versions containing known-good code; published artifacts are
never overwritten.

On Windows, the Settings update view states that binary updates are unsupported
and links to the source repository. Operators pull a newer tagged source
release and rebuild locally. `%USERPROFILE%\.glados` remains external to the
checkout and packaged application.

## Rollout and support

Pilot macOS and Linux binaries on clean hosts before broad rollout. Exercise
first launch, proxy startup, a harmless assessment fixture, update, rollback,
and uninstall/reinstall preservation. For every major release advertised as
Windows-compatible, separately repeat the clean Windows source build, tests,
native PE audit, packaged smoke, and manual runtime acceptance.

## Remaining rollout gates

- The private HTTPS hostname/feed host and VPN-only DNS/routing remain owner
  infrastructure.
- Linux currently relies on HTTPS channel metadata hashes; add independent
  Ed25519/minisign verification before treating it as hardened against update-
  host compromise.
- Keep clean Apple-silicon, Debian/Kali, Fedora, and Windows x64 pilot hosts
  available for release acceptance.
