const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork, spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, net, session, shell } = require('electron');
const { AppImageUpdater, DebUpdater, MacUpdater } = require('electron-updater');
const { WINDOWS_SOURCE_URL, binaryUpdatesSupported, resolveUpdateAccess } = require('./lib/update-channel.cjs');
const { SetupAssistant } = require('./lib/setup-assistant.cjs');
const { systemNetworkEnvironment } = require('./lib/network-environment.cjs');
const { loadCompletedSecurityReview, resolveCompletedSecurityReview, safeEngagementId } = require('./lib/security-review-report.cjs');
const { writeDeliverablesManifest } = require('../dashboard/lib/security-review/deliverables');

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
let dashboardRestartTimer = null;
let dashboardStartedAt = 0;
let dashboardRestartAttempts = 0;
let quitInProgress = false;
let dashboardStoppedForQuit = false;
let dashboardUrl = null;
let dashboardOrigin = null;
let updater = null;
let lastUpdateCheck = null;
let downloadedUpdateVersion = null;
let updateCheckPromise = null;
let updateApplyPromise = null;
let automaticUpdateStartTimer = null;
let automaticUpdateInterval = null;
let lastSetupVerification = null;
let dashboardNetworkEnv = {};

const AUTOMATIC_UPDATE_INITIAL_DELAY_MS = 15_000;
const AUTOMATIC_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function dashboardLog(message) {
  try {
    const logsDir = path.join(runtimeDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(logsDir, 'dashboard.log'), `[${new Date().toISOString()}] ${String(message).trimEnd()}\n`, { mode: 0o600 });
  } catch {}
}

async function renderSecurityReviewPdf(engagementId, outputPath = null) {
  const id = safeEngagementId(engagementId);
  const investigationsRoot = path.resolve(process.env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations'));
  const reviewRoot = path.resolve(resolveCompletedSecurityReview(investigationsRoot, id));
  if (!reviewRoot.startsWith(`${investigationsRoot}${path.sep}`)) throw new Error('security-review path escapes investigations root');
  const completed = loadCompletedSecurityReview(reviewRoot);
  const destination = outputPath || path.join(reviewRoot, 'deliverables', 'security-review-report.pdf');
  const hidden = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await hidden.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(completed.html)}`);
    await hidden.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    const pdf = await hidden.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const outputs = new Set([
      path.resolve(destination),
      path.join(reviewRoot, 'deliverables', 'security-review-report.pdf'),
    ]);
    for (const output of outputs) {
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, pdf, { mode: 0o600 });
      fs.renameSync(temporary, output);
    }
    writeDeliverablesManifest(path.join(reviewRoot, 'deliverables'), {
      receipt: completed.receipt,
      completedAt: completed.run?.deepScan?.completedAt || null,
    });
    return { path: destination, bytes: pdf.length };
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

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
  if (dashboardRestartTimer) clearTimeout(dashboardRestartTimer);
  dashboardRestartTimer = null;
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

function scheduleDashboardRestart({ code = null, signal = null, error = null } = {}) {
  if (quitInProgress || dashboardStoppedForQuit || dashboardRestarting || dashboardRestartTimer) return;
  const stableRun = dashboardStartedAt && Date.now() - dashboardStartedAt >= 60_000;
  dashboardRestartAttempts = stableRun ? 1 : dashboardRestartAttempts + 1;
  const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, Math.max(0, dashboardRestartAttempts - 1))));
  const reason = error?.message || `dashboard exited unexpectedly (code=${code ?? 'null'}, signal=${signal || 'none'})`;
  dashboardLog(`${reason}; restarting in ${delayMs}ms`);
  mainWindow?.webContents.send('dashboard-exit', { code, signal, reason, restarting: true, delayMs });
  dashboardRestartTimer = setTimeout(() => {
    dashboardRestartTimer = null;
    restartDashboard(reason).catch(restartError => dashboardLog(`dashboard restart failed: ${restartError.message}`));
  }, delayMs);
  dashboardRestartTimer.unref?.();
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
        ...dashboardNetworkEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    dashboard = child;
    let settled = false;
    let readyTimeout = null;
    const failStartup = error => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimeout);
      reject(error);
    };
    child.stdout?.on('data', chunk => {
      process.stdout.write(`[dashboard] ${chunk}`);
      dashboardLog(`stdout: ${chunk}`);
    });
    child.stderr?.on('data', chunk => {
      process.stderr.write(`[dashboard] ${chunk}`);
      dashboardLog(`stderr: ${chunk}`);
    });
    child.once('error', error => {
      dashboardLog(`child process error: ${error.message}`);
      if (dashboard === child) dashboard = null;
      failStartup(error);
    });
    readyTimeout = setTimeout(() => failStartup(new Error('dashboard startup timed out')), 30000);
    child.on('message', msg => {
      if (msg?.type === 'glados-dashboard-ready' && msg.url) {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimeout);
        dashboardUrl = msg.url;
        dashboardStartedAt = Date.now();
        dashboardLog(`ready at ${msg.url} (pid=${child.pid})`);
        resolve(msg.url);
      }
      if (msg?.type === 'glados-dashboard-restart-request') restartDashboard(msg.reason).catch(() => {});
      if (msg?.type === 'glados-security-review-deliverables-ready' && msg.engagementId) {
        try {
          const investigationsRoot = path.resolve(process.env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations'));
          const reviewRoot = resolveCompletedSecurityReview(investigationsRoot, msg.engagementId);
          const pdf = path.join(reviewRoot, 'deliverables', 'security-review-report.pdf');
          if (!fs.existsSync(pdf)) renderSecurityReviewPdf(msg.engagementId).catch(error => process.stderr.write(`[security-review-pdf] ${error.message}\n`));
        } catch (error) { process.stderr.write(`[security-review-pdf] ${error.message}\n`); }
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(readyTimeout);
      const unexpected = dashboard === child;
      if (unexpected) dashboard = null;
      dashboardLog(`exit pid=${child.pid} code=${code ?? 'null'} signal=${signal || 'none'} unexpected=${unexpected}`);
      failStartup(new Error(`dashboard exited before startup completed (code=${code ?? 'null'}, signal=${signal || 'none'})`));
      if (unexpected) scheduleDashboardRestart({ code, signal });
    });
  });
}

async function restartDashboard(reason = 'dashboard restart') {
  if (dashboardRestarting) return;
  dashboardRestarting = true;
  let retryError = null;
  try {
    await stopDashboard();
    const url = await startDashboard();
    dashboardOrigin = new URL(url).origin;
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url);
    dashboardLog(`restart completed: ${reason}`);
  } catch (error) {
    retryError = error;
    mainWindow?.webContents.send('dashboard-exit', { code: null, reason, error: error.message });
  } finally {
    dashboardRestarting = false;
  }
  if (retryError) scheduleDashboardRestart({ error: retryError });
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
  mainWindow.webContents.on('did-finish-load', () => {
    if (lastUpdateCheck?.isUpdateAvailable) {
      sendUpdaterStatus('available', { version: lastUpdateCheck.updateInfo?.version || null });
    }
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
    dashboardNetworkEnv = await systemNetworkEnvironment({
      env: process.env,
      url: setupAssistant().gatewayUrl(),
      resolveProxy: target => session.defaultSession.resolveProxy(target),
    });
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
    scheduleAutomaticUpdateChecks();
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
  clearTimeout(automaticUpdateStartTimer);
  clearInterval(automaticUpdateInterval);
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
    useMultipleRangeRequest: true,
  };
  if (Object.keys(access.requestHeaders || {}).length) options.requestHeaders = access.requestHeaders;
  let next;
  if (process.platform === 'darwin') next = new MacUpdater(options);
  else if (process.platform === 'linux' && process.env.APPIMAGE) next = new AppImageUpdater(options);
  else if (process.platform === 'linux') next = new DebUpdater(options);
  else throw new Error(`private updater is not configured for ${process.platform}/${process.arch}`);
  next.autoDownload = false;
  next.autoInstallOnAppQuit = false;
  next.logger = null;
  if (options.requestHeaders) next.requestHeaders = options.requestHeaders;
  next.on('error', error => {
    dashboardLog(`desktop updater error: ${error.message}`);
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

function desktopUpdateStatus() {
  if (!binaryUpdatesSupported()) {
    return {
      packaged: app.isPackaged,
      currentVersion: app.getVersion(),
      supported: false,
      sourceUrl: WINDOWS_SOURCE_URL,
      reason: 'Windows binary updates are not published; build tagged releases from source',
      available: false,
      version: null,
      downloaded: null,
      checking: false,
      applying: false,
    };
  }
  const access = resolveUpdateAccess();
  return {
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    supported: true,
    feedUrl: access.feedUrl,
    source: access.source,
    available: Boolean(lastUpdateCheck?.isUpdateAvailable),
    version: lastUpdateCheck?.updateInfo?.version || null,
    downloaded: downloadedUpdateVersion,
    checking: Boolean(updateCheckPromise),
    applying: Boolean(updateApplyPromise),
  };
}

async function checkForDesktopUpdate({ automatic = false } = {}) {
  if (!app.isPackaged) return { packaged: false, reason: 'development builds use the source updater' };
  if (!binaryUpdatesSupported()) return desktopUpdateStatus();
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    try {
      if (!updater) updater = updaterForPlatform(resolveUpdateAccess());
      lastUpdateCheck = await updater.checkForUpdates();
      downloadedUpdateVersion = null;
      return desktopUpdateStatus();
    } catch (error) {
      dashboardLog(`desktop update check failed: ${error.message}`);
      sendUpdaterStatus(automatic ? 'check-failed' : 'error', { message: error.message });
      throw error;
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

async function applyAvailableDesktopUpdate() {
  if (!app.isPackaged) return { ok: false, reason: 'development builds use the source updater' };
  if (!binaryUpdatesSupported()) return { ok: false, reason: desktopUpdateStatus().reason, sourceUrl: WINDOWS_SOURCE_URL };
  if (updateApplyPromise) return updateApplyPromise;
  updateApplyPromise = (async () => {
    try {
      if (!lastUpdateCheck?.isUpdateAvailable) await checkForDesktopUpdate();
      if (!updater || !lastUpdateCheck?.isUpdateAvailable) throw new Error('GLaDOS is already up to date');
      const targetVersion = lastUpdateCheck.updateInfo?.version;
      const beforeDownload = await dashboardJson('/api/healthz');
      if (Number(beforeDownload.activeAgents || 0) > 0) {
        throw new Error(`finish or stop ${beforeDownload.activeAgents} active agent(s), then press Update GLaDOS again`);
      }
      sendUpdaterStatus('downloading', { version: targetVersion });
      await updater.downloadUpdate();
      downloadedUpdateVersion ||= targetVersion;
      if (!downloadedUpdateVersion) throw new Error('the downloaded update did not report a version');
      const beforeInstall = await dashboardJson('/api/healthz');
      if (Number(beforeInstall.activeAgents || 0) > 0) {
        throw new Error(`update downloaded, but ${beforeInstall.activeAgents} agent(s) became active; stop them and try again`);
      }
      sendUpdaterStatus('preparing', { version: downloadedUpdateVersion });
      const snapshot = await dashboardJson('/api/update/preservation-snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetVersion: downloadedUpdateVersion }),
      });
      sendUpdaterStatus('installing', { version: downloadedUpdateVersion });
      await stopDashboard();
      dashboardStoppedForQuit = true;
      setTimeout(() => updater.quitAndInstall(), 250).unref();
      return { ok: true, version: downloadedUpdateVersion, snapshotDir: snapshot.snapshotDir };
    } catch (error) {
      sendUpdaterStatus('error', { message: error.message, version: lastUpdateCheck?.updateInfo?.version || null });
      throw error;
    } finally {
      updateApplyPromise = null;
    }
  })();
  return updateApplyPromise;
}

function scheduleAutomaticUpdateChecks() {
  if (!app.isPackaged || !binaryUpdatesSupported() || process.env.GLADOS_DISABLE_AUTOMATIC_UPDATE_CHECKS === '1') return;
  clearTimeout(automaticUpdateStartTimer);
  clearInterval(automaticUpdateInterval);
  const run = () => checkForDesktopUpdate({ automatic: true }).catch(() => {});
  automaticUpdateStartTimer = setTimeout(run, AUTOMATIC_UPDATE_INITIAL_DELAY_MS);
  automaticUpdateStartTimer.unref?.();
  automaticUpdateInterval = setInterval(run, AUTOMATIC_UPDATE_INTERVAL_MS);
  automaticUpdateInterval.unref?.();
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

ipcMain.handle('desktop:dashboard:health', async event => {
  assertTrustedDashboardEvent(event);
  return dashboardJson('/api/health/proxy', { timeoutMs: 5000 });
});

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
ipcMain.handle('desktop:security-review:choose-directory', async (event, input = {}) => {
  assertTrustedDashboardEvent(event);
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const options = {
    title: input.full ? 'Choose a repository for a full security review' : 'Choose a repository for an expedited security review',
    buttonLabel: 'Review Repository',
    properties: ['openDirectory', 'createDirectory'],
  };
  const preferred = String(input.defaultPath || '').trim();
  if (preferred && fs.existsSync(preferred)) options.defaultPath = preferred;
  else options.defaultPath = app.getPath('desktop');
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return { canceled: result.canceled, path: result.canceled ? null : result.filePaths[0] || null };
});
ipcMain.handle('desktop:security-review:export-pdf', async (event, input = {}) => {
  assertTrustedDashboardEvent(event);
  const engagementId = safeEngagementId(input.engagementId);
  const reportsRoot = path.resolve(process.env.GLADOS_REPORTS_DIR || path.join(runtimeDir, 'reports'));
  fs.mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const selected = parent
    ? await dialog.showSaveDialog(parent, { title: 'Export Security Review PDF', defaultPath: path.join(reportsRoot, `${engagementId}-security-review.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    : await dialog.showSaveDialog({ title: 'Export Security Review PDF', defaultPath: path.join(reportsRoot, `${engagementId}-security-review.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  const exported = await renderSecurityReviewPdf(engagementId, selected.filePath);
  const investigationsRoot = path.resolve(process.env.GLADOS_INVESTIGATIONS_DIR || path.join(runtimeDir, 'investigations'));
  const artifactPdf = path.join(resolveCompletedSecurityReview(investigationsRoot, engagementId), 'deliverables', 'security-review-report.pdf');
  if (path.resolve(exported.path) !== path.resolve(artifactPdf)) {
    fs.copyFileSync(exported.path, artifactPdf);
    fs.chmodSync(artifactPdf, 0o600);
  }
  return { canceled: false, path: exported.path, bytes: exported.bytes, artifactPath: artifactPdf };
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
  const litellm = await verifyLiteLlm({
    env: process.env,
    fetchImpl: (url, options) => net.fetch(url, options),
    modelTimeoutMs: 30_000,
    messageTimeoutMs: 45_000,
  });
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

ipcMain.handle('desktop:update:status', event => {
  assertTrustedDashboardEvent(event);
  return desktopUpdateStatus();
});
ipcMain.handle('desktop:update:check', async event => {
  assertTrustedDashboardEvent(event);
  return checkForDesktopUpdate();
});
ipcMain.handle('desktop:update:apply', async event => {
  assertTrustedDashboardEvent(event);
  return applyAvailableDesktopUpdate();
});
