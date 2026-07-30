# GLaDOS Desktop

Electron shell for GLaDOS v4.4.1. The bundle is named `GLaDOS.app`.

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
- App updates must never write local operator state; runtime data is not app
  payload.
- Source checkouts use the SSE git updater and restart the supervised dashboard
  child. Packaged apps use the authenticated generic HTTPS feed documented in
  `services/private-update-feed/README.md`.
- Private-feed tokens are encrypted by the OS credential store under
  `~/.glados/electron/private-update-auth.json`; they are never bundled or
  returned to the dashboard renderer. Ubuntu refuses Electron's `basic_text`
  password backend.
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
