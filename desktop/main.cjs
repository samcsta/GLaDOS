const path = require('node:path');
const os = require('node:os');
const { fork, spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

if (process.env.GLADOS_PACKAGED_SMOKE === '1') {
  app.setPath('userData', path.join(os.tmpdir(), `glados-packaged-smoke-${process.pid}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let dashboard = null;
let dashboardRestarting = false;

function repoRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.resolve(__dirname, '..');
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

function quitFromSignal() {
  stopDashboard();
  app.quit();
  setTimeout(() => process.exit(0), 500).unref();
}

function startDashboard() {
  return new Promise((resolve, reject) => {
    const root = repoRoot();
    const server = path.join(root, 'dashboard', 'server.js');
    const child = fork(server, [], {
      cwd: root,
      execPath: dashboardNodeExecPath(),
      env: { ...process.env, PORT: '0', GLADOS_DESKTOP: '1', GLADOS_BROWSER_MCP: process.env.GLADOS_BROWSER_MCP || '1' },
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
  const dashboardOrigin = new URL(url).origin;
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

app.on('before-quit', () => {
  stopDashboard();
});

process.on('SIGINT', quitFromSignal);
process.on('SIGTERM', quitFromSignal);

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
function sendUpdaterStatus(type, payload = {}) {
  mainWindow?.webContents.send('desktop-update-status', { type, ...payload });
}
autoUpdater.on('error', err => {
  mainWindow?.webContents.send('desktop-update-error', { message: err.message });
  sendUpdaterStatus('error', { message: err.message });
});
autoUpdater.on('checking-for-update', () => sendUpdaterStatus('checking'));
autoUpdater.on('update-available', info => sendUpdaterStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', info => sendUpdaterStatus('not-available', { version: info.version }));
autoUpdater.on('download-progress', progress => sendUpdaterStatus('progress', {
  percent: progress.percent,
  transferred: progress.transferred,
  total: progress.total,
}));
autoUpdater.on('update-downloaded', info => sendUpdaterStatus('downloaded', { version: info.version }));

ipcMain.handle('desktop:update:check', async () => {
  if (!app.isPackaged) return { packaged: false, reason: 'development builds use the source updater' };
  const result = await autoUpdater.checkForUpdates();
  return { packaged: true, version: result?.updateInfo?.version || null };
});
ipcMain.handle('desktop:update:download', async () => {
  if (!app.isPackaged) throw new Error('signed updater is only available in packaged builds');
  await autoUpdater.downloadUpdate();
  return { ok: true };
});
ipcMain.handle('desktop:update:install', () => {
  if (!app.isPackaged) return { ok: false };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});
