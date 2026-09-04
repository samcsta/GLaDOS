# Windows source-build support

## Supported target

- Windows 11 on Intel/AMD 64-bit (`x64`)
- Compatibility-tested source builds from tagged or release-branch revisions
- No official Windows installer, binary download, or automatic update feed

Major GLaDOS releases are published from the shared codebase to the public
GitHub repository and the private Gitea mirror. Windows does not have a
diverging product branch: operators select an exact tag or release commit,
verify it, and build that same source locally. This keeps Windows fixes aligned
with the maintained macOS and Linux versions.

The Windows build includes Electron, the Windows x64 Claude Agent SDK launcher,
and Electron-ABI builds of `better-sqlite3` and `node-pty`. The prerequisite
script provisions Git for Windows, SQLite, OpenSSL, Python/pipx, mitmproxy, jq,
and Nmap. GLaDOS defaults its terminal to PowerShell, discovers `.exe` commands
through `PATHEXT`, and installs its workstation proxy CA into the current
user's Windows Root certificate store. macOS Full Access remains macOS-only.

## Build a release from source

Clone or update the public repository, select the documented release tag or
commit, verify `git status` is clean, and run these commands on Windows x64:

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

The watchdog install is required before dashboard tests because the dashboard
imports watchdog and its native `better-sqlite3` dependency.

`pack:windows` recursively audits every packaged PE file as x64 and requires
the Windows `better_sqlite3.node`, `pty.node`, `conpty.node`,
`conpty_console_list.node`, and Claude SDK executable. Launch the result at
`artifacts\desktop\win-unpacked\GLaDOS.exe` only on the machine that built it
from verified source. It is unsigned and must not be redistributed as an
official GLaDOS binary.

The packaged Windows app deliberately disables the binary updater. Settings
links operators to the source repository when a new source release is needed.
Pull the next tagged release, repeat the clean build and tests, then replace the
local unpacked application; `%USERPROFILE%\.glados` remains outside the build.

## Release acceptance

For each major Windows-compatible release:

1. Verify the source tag/commit and clean Git state on a native Windows x64 host.
2. Run the locked dependency installs, full tests, PE audit, and packaged smoke.
3. Complete setup assistant, CA trust, proxy capture, PowerShell PTY, and a
   harmless assessment fixture with an authorized LiteLLM credential.
4. Confirm rebuilding from the next release preserves `%USERPROFILE%\.glados`.

`release:windows` remains dormant for a future signed-binary channel. It must
not be used or published unless the project later provisions trusted
Authenticode credentials and explicitly changes this policy.
