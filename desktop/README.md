# GLaDOS Desktop

Electron shell for GLaDOS v4.5.6. The macOS bundle is named `GLaDOS.app`; the
Ubuntu package is `GLaDOS-4.5.6-x86_64.AppImage`.

See [DISTRIBUTION_PLAN.md](DISTRIBUTION_PLAN.md) for the Developer ID,
notarization, Apple-silicon/Ubuntu architecture, first-run dependency, and
installed-user update rollout gates.

The `desktop/` directory contains source only. Generated packages are written
to `artifacts/desktop/`, and an installed build belongs at
`/Applications/GLaDOS.app`. Electron cache/state is stored under
`~/.glados/electron`; operator data never lives in the source checkout or app
bundle.

- The main process starts `dashboard/server.js` with `PORT=0` and waits for the
  dashboard-ready IPC message before opening a window.
- Renderer hardening is intentional: `contextIsolation: true` and
  `nodeIntegration: false`; preload exposes only narrow status events.
- Packaging is configured for Developer ID, hardened runtime, notarytool, and
  disable-library-validation so native modules such as `node-pty` and
  `better-sqlite3` can be deep-signed.
- The macOS app includes the official mitmproxy 12.2.3 arm64 app bundle, pinned
  by SHA-256 and upstream signing team. Packaged smoke tests require this copy
  and remove Homebrew from `PATH`, so a release cannot pass by using a tool
  installed only on the build Mac.
- App updates must never write local operator state; runtime data is not app
  payload.
- The DMG includes a native **Uninstall GLaDOS.app**, signed and notarized
  independently before it is placed in the notarized DMG. Its default mode
  moves only the app to Trash, removes GLaDOS MITM CA trust, and preserves
  `~/.glados`; its purge option also trashes runtime data and removes the
  LiteLLM Keychain item. Both modes unregister GLaDOS from Launch Services and
  refresh Spotlight metadata after moving the application to Trash.
- Settings includes a four-step Setup Assistant for first install and
  credential rotation. It stores the LiteLLM key directly in macOS Keychain,
  supports optional allowlisted local credential profiles, manages the unique
  workstation proxy CA, and performs live LiteLLM and proxy verification.
  Secret values are never returned to the dashboard after saving.
- Source checkouts use the SSE git updater and restart the supervised dashboard
  child. Packaged apps automatically use the Red Team VPN-only HTTPS feed
  documented in `services/private-update-feed/README.md`; users do not enter a
  feed URL or credential.
- Packaged GLaDOS checks after startup and every six hours. A compact update
  banner provides one action that downloads, verifies, snapshots, installs,
  and restarts the app.
- Before installation, the main process checks that no agents are active and
  requests a SQLite/config snapshot under `~/.glados/backups/updates/`.
  Reports, investigations, evidence, model assignments, and workspaces remain
  outside the replaceable application bundle.
- App Sandbox is disabled because the local server and tools spawn child
  processes. The renderer's Chromium sandbox remains enabled.

Development:

```bash
npm install --prefix desktop
npm start --prefix desktop
npm run pack:mac:arm64 --prefix desktop
npm run verify:native:mac --prefix desktop
npm run verify:pack --prefix desktop
scripts/install-desktop-app.sh
```
