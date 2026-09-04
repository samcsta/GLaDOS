# Windows desktop build

## Supported target

- Windows 11 on Intel/AMD 64-bit (`x64`)
- Per-user NSIS installation and in-app self-update
- Red Team VPN connectivity to the built-in
  `https://updates.r3dt34m.net/glados/windows/x64` feed

The Windows package includes Electron, the Windows x64 Claude Agent SDK
launcher, and Electron-ABI builds of `better-sqlite3` and `node-pty`. The
first-time PowerShell installer provisions Git for Windows, SQLite, OpenSSL,
Python/pipx, mitmproxy, jq, and Nmap. GLaDOS defaults its terminal to
PowerShell, discovers `.exe` commands through `PATHEXT`, and installs its
workstation proxy CA into the current user's Windows Root certificate store.
macOS Full Access remains a macOS-only capability.

## Compatibility build

The unsigned compatibility build runs on a native Windows x64 host or the
`windows-x64` job in `.github/workflows/platform-compatibility.yml`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-glados-windows.ps1 -PrerequisitesOnly
# Open a new PowerShell window after prerequisite installation.
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

Dashboard-only QA from a fresh checkout or extracted source bundle still
requires the source-tree watchdog dependencies. The dashboard imports
`../watchdog` directly, and installing only the dashboard package does not
install watchdog's native `better-sqlite3` dependency in that directory:

```powershell
npm ci --prefix watchdog
npm ci --prefix dashboard
npm test --prefix dashboard
```

`pack:windows` recursively audits every packaged PE file as x64 and requires
the Windows `better_sqlite3.node`, `pty.node`, `conpty.node`,
`conpty_console_list.node`, and Claude SDK executable. It is a compatibility
check only and must never be published.

After the smoke succeeds, launch `artifacts\desktop\win-unpacked\GLaDOS.exe`
and complete the manual setup, CA-trust, proxy-capture, PowerShell PTY, and
harmless assessment-fixture checks. This unpacked application is unsigned and
is only for a controlled compatibility test.

## Signed production release

Run the release on a protected native Windows x64 host. Keep the code-signing
certificate and password out of the repository and update server:

```powershell
$env:CSC_LINK = 'C:\secure\path\to\codesigning.pfx'
$env:CSC_KEY_PASSWORD = '<from the protected secret store>'
npm run release:windows --prefix desktop
npm run smoke:windows --prefix desktop
```

The release command fails closed without those credentials. It builds the NSIS
installer with forced code signing, performs the recursive PE audit, requires
the installer and its blockmap/metadata, and checks both the installer and
unpacked application with `Get-AuthenticodeSignature`.

Publish `GLaDOS-<version>-x64.exe` and its blockmap before atomically publishing
`latest.yml`. Publish the same signed installer and
`install-glados-windows.ps1` under `/installers/windows/` for first-time users.
Never replace a versioned installer.

## Remaining owner gates

1. Provision the Windows Authenticode identity in a protected release runner.
2. Complete a clean Windows x64 first-install test, including setup assistant,
   CA trust, proxy capture, terminal PTY, and a harmless assessment fixture.
3. Complete an update from the previous stable version and verify the
   `%USERPROFILE%\.glados` data and update backup are preserved.
4. Verify uninstall/reinstall leaves operator data intact.
