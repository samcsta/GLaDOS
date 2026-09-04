# Linux desktop build

This legacy-named document covers the shared Debian/Kali/Ubuntu and Fedora
build. Linux uses the same Electron shell and `~/.glados` runtime boundary as
macOS. Reports, investigations, model assignments, credentials, proxy history,
and operator workspaces therefore survive AppImage upgrades.

## Supported targets

- Debian-family Linux, including Debian, Kali, and Ubuntu, on x86-64
- Fedora Linux on x86-64
- AppImage for installation and in-app self-update
- Red Team VPN connectivity to the built-in HTTPS update feed

Build one AppImage from the Debian 12 baseline so its glibc requirement remains
compatible with the supported distributions. The build uses Clang 19 for
Electron 43's C++20 headers, rebuilds `better-sqlite3` and `node-pty` against
the packaged Electron ABI, and recursively audits every ELF file as x86-64.
The same unpacked payload is then launched under Xvfb on Debian, current Kali
rolling, and current Fedora:

```bash
npm run dist:linux:docker --prefix desktop
npm run smoke:debian:backend:docker --prefix desktop
npm run smoke:debian:gui:docker --prefix desktop
npm run smoke:kali:docker --prefix desktop
npm run smoke:fedora:docker --prefix desktop
```

For a source checkout on any supported Linux distribution:

```bash
scripts/bootstrap-linux.sh
scripts/install-desktop-app-linux.sh
```

The compatibility aliases `bootstrap-ubuntu.sh` and
`install-desktop-app-ubuntu.sh` remain available for existing automation. The
bootstrap detects the apt or dnf family, installs Node 22 and the required
runtime tools, and initializes the per-user runtime. The installer builds and
audits the current release, installs it under `~/.local/opt/glados/`, and
registers `glados.desktop` for the current user. Set
`GLADOS_APPIMAGE=/path/to/GLaDOS-4.5.8-x86_64.AppImage` to install an existing
artifact instead.

## Update feed

Publish Linux metadata and artifacts below the private feed's `linux/x64/`
directory. Packaged GLaDOS automatically uses
`https://updates.r3dt34m.net/glados/linux/x64`. AppImage is the supported
self-update format. A distro-specific package can be added later as a separate
channel after package-owner metadata and its privilege/policy experience are
defined.

Before a hardened rollout, add an embedded Ed25519/minisign public key and
verify a detached signature for the Linux payload before installation. HTTPS,
the VPN boundary, and electron-builder's SHA-512 metadata protect transport and
integrity, but Linux has no Developer ID equivalent that independently proves
publisher identity after a feed compromise.

## Remaining Linux acceptance gates

1. Complete clean-host first-install tests on Debian/Kali and Fedora x86-64.
2. Validate the system MITM CA flow and Chromium trust behavior on both distro
   families.
3. Add and test application-level release signature verification.
4. Exercise an AppImage update while checking hashes/counts for
   `~/.glados/reports`, `investigations`, `model-overrides.json`, and agent
   workspaces before and after.
