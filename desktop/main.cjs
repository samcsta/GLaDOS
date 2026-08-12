const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork, spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { AppImageUpdater, DebUpdater, MacUpdater } = require('electron-updater');
const { UpdateCredentialStore } = require('./lib/private-update.cjs');
const { SetupAssistant } = require('./lib/setup-assistant.cjs');

const runtimeDir = path.resolve(process.env.GLADOS_RUNTIME_DIR || path.join(os.homedir(), '.glados'));

if (process.env.GLADOS_PACKAGED_SMOKE === '1') {
  app.setPath('userData', path.join(os.tmpdir(), `glados-packaged-smoke-${process.pid}`));
} else {
  const electronDataDir = path.join(runtimeDir, 'electron');
  fs.mkdirSync(electronDataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(electronDataDir, 0o700);
  app.setPath('userData', electronDataDir);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let dashboard = null;
let dashboardRestarting = false;
let quitInProgress = false;
let dashboardStoppedForQuit = false;
let dashboardUrl = null;
let dashboardOrigin = null;
let updater = null;
let lastUpdateCheck = null;
let downloadedUpdateVersion = null;
let lastSetupVerification = null;

const updateCredentials = new UpdateCredentialStore({ runtimeDir, safeStorage, platform: process.platform });

function repoRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.resolve(__dirname, '..');
}

function setupAssistant() {
  return new SetupAssistant({ runtimeDir, appRoot: repoRoot(), env: process.env });
}

function dashboardNodeExecPath() {
  if (app.isPackaged) return process.execPath;
  const candidates = [
    process.env.GLADOS_NODE_PATH,
    process.env.npm_node_execpath,
    process.env.NODE,
  ].filter(Boolean);
  for (const candidate of candidates) return candidate;
  const resolved = spawnSync('which', ['node'], { encoding: 'utf8' });
  const nodePath = resolved.stdout?.trim();
  return nodePath || 'node';
}

function stopDashboard() {
  const child = dashboard;
  dashboard = null;
  if (!child || child.killed || child.exitCode != null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

async function quitFromSignal() {
  await stopDashboard();
  dashboardStoppedForQuit = true;
  app.exit(0);
}

function startDashboard() {
  return new Promise((resolve, reject) => {
    const root = repoRoot();
    const server = path.join(root, 'dashboard', 'server.js');
    const child = fork(server, [], {
      cwd: root,
      execPath: dashboardNodeExecPath(),
      env: {
        ...process.env,
        PORT: '0',
        GLADOS_DESKTOP: '1',
        GLADOS_DESKTOP_RESOURCES: root,
        GLADOS_BROWSER_MCP: process.env.GLADOS_BROWSER_MCP || '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    dashboard = child;
    child.stdout?.on('data', chunk => process.stdout.write(`[dashboard] ${chunk}`));
    child.stderr?.on('data', chunk => process.stderr.write(`[dashboard] ${chunk}`));
    child.once('error', reject);
    const readyTimeout = setTimeout(() => reject(new Error('dashboard startup timed out')), 30000);
    child.on('message', msg => {
      if (msg?.type === 'glados-dashboard-ready' && msg.url) {
        clearTimeout(readyTimeout);
        dashboardUrl = msg.url;
        resolve(msg.url);
      }
      if (msg?.type === 'glados-dashboard-restart-request') restartDashboard(msg.reason).catch(() => {});
    });
    child.once('exit', code => {
      clearTimeout(readyTimeout);
      if (dashboard === child) dashboard = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dashboard-exit', { code });
      }
    });
  });
}

async function restartDashboard(reason = 'dashboard restart') {
  if (dashboardRestarting) return;
  dashboardRestarting = true;
  try {
    await stopDashboard();
    const url = await startDashboard();
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url);
  } catch (error) {
    mainWindow?.webContents.send('dashboard-exit', { code: null, reason, error: error.message });
    dialog.showErrorBox('GLaDOS dashboard restart failed', error.message);
  } finally {
    dashboardRestarting = false;
  }
}

function createWindow(url) {
  dashboardOrigin = new URL(url).origin;
  const iconPath = path.join(__dirname, 'build', 'icon-source.png');
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: 'GLaDOS Ops',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(url);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => {
    const target = event.url;
    try {
      if (new URL(target).origin === dashboardOrigin) return;
    } catch {}
    event.preventDefault();
    shell.openExternal(target).catch(() => {});
  });
}

app.whenReady().then(async () => {
  try {
    const url = await startDashboard();
    if (process.env.GLADOS_PACKAGED_SMOKE === '1') {
      const response = await fetch(`${url}/api/healthz`);
      if (!response.ok) throw new Error(`packaged dashboard health check returned ${response.status}`);
      process.stdout.write(`GLADOS_PACKAGED_SMOKE_OK ${url}\n`);
      await stopDashboard();
      app.quit();
      return;
    }
    createWindow(url);
  } catch (e) {
    dialog.showErrorBox('GLaDOS failed to start', e.message);
    app.quit();
  }
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
  if (dashboardStoppedForQuit) return;
  event.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  stopDashboard().finally(() => {
    dashboardStoppedForQuit = true;
    app.quit();
  });
});

process.on('SIGINT', quitFromSignal);
process.on('SIGTERM', quitFromSignal);

function sendUpdaterStatus(type, payload = {}) {
  mainWindow?.webContents.send('desktop-update-status', { type, ...payload });
}

function assertTrustedDashboardEvent(event) {
  let sourceOrigin = null;
  try { sourceOrigin = new URL(event.senderFrame?.url || '').origin; } catch {}
  if (!dashboardOrigin || sourceOrigin !== dashboardOrigin) throw new Error('untrusted update request origin');
}

function updaterForPlatform(access) {
  const options = {
    provider: 'generic',
    url: access.feedUrl,
    channel: process.env.GLADOS_UPDATE_CHANNEL || 'latest',
    requestHeaders: { Authorization: `Bearer ${access.token}` },
    useMultipleRangeRequest: true,
  };
  let next;
  if (process.platform === 'darwin') next = new MacUpdater(options);
  else if (process.platform === 'linux' && process.env.APPIMAGE) next = new AppImageUpdater(options);
  else if (process.platform === 'linux') next = new DebUpdater(options);
  else throw new Error(`private updater is not configured for ${process.platform}`);
  next.autoDownload = false;
  next.autoInstallOnAppQuit = false;
  next.logger = null;
  next.requestHeaders = options.requestHeaders;
  next.on('error', error => {
    mainWindow?.webContents.send('desktop-update-error', { message: error.message });
    sendUpdaterStatus('error', { message: error.message });
  });
  next.on('checking-for-update', () => sendUpdaterStatus('checking'));
  next.on('update-available', info => sendUpdaterStatus('available', { version: info.version }));
  next.on('update-not-available', info => sendUpdaterStatus('not-available', { version: info.version }));
  next.on('download-progress', progress => sendUpdaterStatus('progress', {
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
  }));
  next.on('update-downloaded', info => {
    downloadedUpdateVersion = info.version;
    sendUpdaterStatus('downloaded', { version: info.version });
  });
  return next;
}

async function dashboardJson(pathname, options = {}) {
  if (!dashboardUrl) throw new Error('dashboard is not ready');
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const response = await fetch(new URL(pathname, dashboardUrl), {
    ...fetchOptions,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `dashboard returned HTTP ${response.status}`);
  return body;
}

async function setupStatus() {
  const status = setupAssistant().status();
  let proxy = { healthy: false, processStatus: 'unknown', error: 'proxy health is unavailable' };
  try {
    const current = await dashboardJson('/api/health/proxy');
    proxy = {
      healthy: Boolean(current.healthy),
      backend: current.backend || null,
      processStatus: current.processStatus || null,
      error: current.error || null,
    };
  } catch (error) {
    proxy.error = error.message;
  }
  return { ...status, proxy, lastVerification: lastSetupVerification };
}

ipcMain.handle('desktop:setup:status', async event => {
  assertTrustedDashboardEvent(event);
  return setupStatus();
});
ipcMain.handle('desktop:setup:save-litellm', async (event, input) => {
  assertTrustedDashboardEvent(event);
  lastSetupVerification = null;
  setupAssistant().saveLiteLlmKey(input);
  return setupStatus();
});
ipcMain.handle('desktop:setup:save-local-secrets', async (event, input) => {
  assertTrustedDashboardEvent(event);
  setupAssistant().saveLocalSecrets(input);
  return setupStatus();
});
ipcMain.handle('desktop:setup:generate-ca', async event => {
  assertTrustedDashboardEvent(event);
  await setupAssistant().runCaAction('generate');
  return setupStatus();
});
ipcMain.handle('desktop:setup:trust-ca', async event => {
  assertTrustedDashboardEvent(event);
  await setupAssistant().runCaAction('trust');
  return setupStatus();
});
ipcMain.handle('desktop:setup:verify', async event => {
  assertTrustedDashboardEvent(event);
  const { verifyLiteLlm } = require(path.join(repoRoot(), 'dashboard', 'lib', 'litellm-setup.js'));
  const litellm = await verifyLiteLlm({ env: process.env });
  const status = await setupStatus();
  lastSetupVerification = {
    ...litellm,
    ca: { ok: status.ca.generated && status.ca.trusted },
    proxy: {
      ok: status.proxy.healthy,
      processStatus: status.proxy.processStatus,
      message: status.proxy.healthy
        ? 'The bundled proxy is running.'
        : (status.proxy.error || 'The bundled proxy is not healthy.'),
    },
  };
  return { ...status, lastVerification: lastSetupVerification };
});

ipcMain.handle('desktop:update-auth:status', event => {
  assertTrustedDashboardEvent(event);
  return updateCredentials.status();
});
ipcMain.handle('desktop:update-auth:save', (event, input) => {
  assertTrustedDashboardEvent(event);
  return updateCredentials.save({ feedUrl: input?.feedUrl, token: input?.token });
});
ipcMain.handle('desktop:update-auth:clear', event => {
  assertTrustedDashboardEvent(event);
  updater = null;
  lastUpdateCheck = null;
  downloadedUpdateVersion = null;
  return updateCredentials.clear();
});

ipcMain.handle('desktop:update:check', async event => {
  assertTrustedDashboardEvent(event);
  if (!app.isPackaged) return { packaged: false, reason: 'development builds use the source updater' };
  updater = updaterForPlatform(updateCredentials.load());
  lastUpdateCheck = await updater.checkForUpdates();
  downloadedUpdateVersion = null;
  return {
    packaged: true,
    currentVersion: app.getVersion(),
    available: !!lastUpdateCheck?.isUpdateAvailable,
    version: lastUpdateCheck?.updateInfo?.version || null,
  };
});
ipcMain.handle('desktop:update:download', async event => {
  assertTrustedDashboardEvent(event);
  if (!app.isPackaged) throw new Error('signed updater is only available in packaged builds');
  if (!updater || !lastUpdateCheck?.isUpdateAvailable) throw new Error('no newer update is available to download');
  await updater.downloadUpdate();
  return { ok: true, version: lastUpdateCheck.updateInfo.version };
});
ipcMain.handle('desktop:update:install', async event => {
  assertTrustedDashboardEvent(event);
  if (!app.isPackaged) return { ok: false };
  if (!updater || !downloadedUpdateVersion) throw new Error('no verified update has been downloaded');
  const health = await dashboardJson('/api/healthz');
  if (Number(health.activeAgents || 0) > 0) {
    throw new Error(`cannot install while ${health.activeAgents} agent(s) are active`);
  }
  const snapshot = await dashboardJson('/api/update/preservation-snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetVersion: downloadedUpdateVersion }),
  });
  await stopDashboard();
  dashboardStoppedForQuit = true;
  setTimeout(() => updater.quitAndInstall(), 250).unref();
  return { ok: true, version: downloadedUpdateVersion, snapshotDir: snapshot.snapshotDir };
});
