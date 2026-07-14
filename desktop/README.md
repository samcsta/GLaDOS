# GLaDOS Desktop

Electron shell for GLaDOS v4.0.0. The bundle is named `GLaDOS.app`.

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
  child. Packaged apps use signed GitHub release artifacts via electron-updater.
- App Sandbox is disabled because the local server and tools spawn child
  processes. The renderer's Chromium sandbox remains enabled.

Development:

```bash
cd desktop
npm install
npm start
```
