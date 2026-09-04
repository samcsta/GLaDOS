# GLaDOS fleet update runbook

## Supported binary fleet

- macOS Apple Silicon (`arm64`)
- Debian/Kali/Ubuntu and Fedora (`x86_64`) running the AppImage
- macOS feed: `https://updates.r3dt34m.net/glados/macos/arm64`
- Linux feed: `https://updates.r3dt34m.net/glados/linux/x64`

Windows 11 x64 is source-build compatibility support, not part of the managed
binary fleet. Do not create or publish a Windows update feed or official
unsigned installer. Publish major-release source to GitHub and Gitea and follow
`WINDOWS_PLAN.md` for native acceptance.

Keep the app ID `com.glados.ops`, feed paths, and architectures stable.

## Build and publish a binary release

From a clean release revision, confirm both version sources agree:

```bash
test "$(sed 's/^v//' VERSION)" = "$(node -p 'require("./desktop/package.json").version')"
```

Build macOS on Apple Silicon with the Developer ID and notarization credentials
available only through the protected release environment:

```bash
npm run release:mac --prefix desktop
```

Build Linux x64 from the Debian 12 baseline and run the unchanged AppImage on
all supported distro families:

```bash
npm run dist:linux:docker --prefix desktop
npm run smoke:debian:gui:docker --prefix desktop
npm run smoke:kali:docker --prefix desktop
npm run smoke:fedora:docker --prefix desktop
```

Both binary builds must pass tests, recursive native-architecture audits,
packaged smoke tests, and clean-host acceptance. Publish immutable payloads
first:

- macOS: signed ZIP, ZIP blockmap, and DMG
- Linux: AppImage; its differential-update block map is embedded

Publish `latest-mac.yml` and `latest-linux.yml` last. Never overwrite an
artifact for a published version. Roll back by releasing known-good code under
a higher version.

## Windows major-release compatibility

On a native Windows x64 machine, clone the exact release revision from the
public GitHub repository and verify the revision and clean status. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-glados-windows.ps1 -PrerequisitesOnly
npm ci --prefix desktop
npm ci --prefix watchdog
npm ci --prefix dashboard
npm ci --prefix blackboard/blackboard-mcp
npm ci --prefix watchdog/watchdog-mcp
npm ci --prefix tools/glados-ops-mcp
npm test --prefix desktop
npm test --prefix dashboard
npm test --prefix services/private-update-feed
npm run pack:windows --prefix desktop
npm run smoke:windows --prefix desktop
```

Record the commit, test totals, PE audit, and packaged-smoke result with the
release notes. Do not upload `win-unpacked`, an `.exe`, or update metadata. The
output is an unsigned local build for the operator who compiled it.

## Deploy the VPN-only binary feed

1. Provision `updates.r3dt34m.net` through the split-DNS Red Team pattern and
   terminate TLS with the approved Caddy configuration.
2. Run `services/private-update-feed` on loopback behind Caddy.
3. Set `GLADOS_UPDATE_REQUIRE_AUTH=0` only when the firewall, routing, and split
   DNS restrict the host to the VPN.
4. Create `/srv/glados/releases/{macos/arm64,linux/x64}` and installer
   directories for macOS and Linux only.
5. Put first-install DMGs, AppImages, and the Linux easy installer under
   `/srv/glados/installers`.
6. No workstation feed setup is needed on the supported binary platforms.

## Update the managed fleet

GLaDOS checks after launch and every six hours. On each macOS and Linux pilot:

1. Finish or stop active agent runs.
2. Press **Update GLaDOS**.
3. Confirm the application snapshots runtime state, installs, and restarts.
4. Verify the version, `/api/healthz`, proxy, model assignments, reports, and
   most recent investigation after restart.

Pilot one machine per platform before widening the rollout. On Windows, pull
the next release source and repeat the local build instead; the packaged app
does not offer binary updates.

## Production gates requiring owner infrastructure

- Developer ID Application certificate and Apple notarization credentials
- Private HTTPS feed host and VPN-only DNS/routing
- Protected release runner and secret store
- Independent Linux payload signature verification before hardened broad use
- Clean Apple-silicon, Debian/Kali, Fedora, and Windows x64 acceptance hosts
