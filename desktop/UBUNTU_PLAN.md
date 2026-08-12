# Ubuntu desktop build

Ubuntu uses the same Electron shell and `~/.glados` runtime boundary as macOS.
Reports, investigations, model assignments, credentials, proxy history, and
operator workspaces therefore survive AppImage or DEB upgrades.

## Supported first target

- Ubuntu 24.04, x86-64
- AppImage for installation and in-app self-update
- Electron `safeStorage` backed by GNOME Secret Service or KWallet; GLaDOS
  refuses to persist the private-feed token when Electron reports
  `basic_text`

Build the production release on Ubuntu itself. The Docker command below can
produce an isolated x86-64 Linux build candidate and recursive native audit on
an Apple-silicon Mac, but Electron/Chromium is not a reliable QEMU GUI smoke
target. Both `better-sqlite3` and `node-pty` must be rebuilt against the
packaged Electron ABI on Linux, and the final AppImage must launch on native
Ubuntu 24.04 x86-64 hardware.

```bash
npm run dist:ubuntu:docker --prefix desktop
```

```bash
scripts/bootstrap-ubuntu.sh
scripts/install-desktop-app-ubuntu.sh
```

The bootstrap installs Node 22, Ubuntu/AppImage prerequisites, the required
core command-line tools, mitmproxy, application dependencies, and initializes
the per-user runtime. The installer builds and audits the current release, installs it under
`~/.local/opt/glados/`, and registers `glados.desktop` for the current user.
Set `GLADOS_APPIMAGE=/path/to/GLaDOS-4.5.1-x86_64.AppImage` to install an
already-built artifact instead.

`pack:ubuntu` creates `artifacts/desktop/linux-unpacked` and audits every ELF
helper and native Node module as x86-64 before a distributable is accepted.
Run a packaged smoke test on a clean Ubuntu 24.04 workstation, including terminal PTY,
proxy startup, browser MCP, report persistence, and an upgrade from the prior
release.

## Update feed

Publish Linux metadata and artifacts below the private feed's `linux/x64/`
directory and configure the app with
`https://updates.redteam.example/glados/linux/x64`. AppImage is the supported
self-update format. A DEB can be added later as a separately managed channel
after package-owner metadata and its privilege/policy experience are defined.

Before production, add an embedded Ed25519/minisign public key and verify a
detached signature for the Linux payload before installation. HTTPS, bearer
authentication, and electron-builder's SHA-512 metadata protect transport and
integrity, but Linux has no Developer ID equivalent that independently proves
publisher identity after a feed compromise.

## Remaining Ubuntu acceptance gates

1. Build and native audit on clean Ubuntu 24.04 x86-64.
2. Verify Secret Service is unlocked and the token survives logout/reboot.
3. Validate the system MITM CA flow and Chromium trust behavior.
4. Add and test application-level release signature verification.
5. Exercise an AppImage update while checking hashes/counts for
   `~/.glados/reports`, `investigations`, `model-overrides.json`, and agent
   workspaces before and after.
