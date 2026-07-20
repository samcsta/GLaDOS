const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gladosDesktop', {
  isPackaged: process.env.NODE_ENV !== 'development' && !process.defaultApp,
  onDashboardExit(callback) {
    ipcRenderer.on('dashboard-exit', (_event, payload) => callback(payload));
  },
  onUpdateError(callback) {
    ipcRenderer.on('desktop-update-error', (_event, payload) => callback(payload));
  },
  onUpdateStatus(callback) {
    ipcRenderer.on('desktop-update-status', (_event, payload) => callback(payload));
  },
  getUpdateAccessStatus() {
    return ipcRenderer.invoke('desktop:update-auth:status');
  },
  saveUpdateAccess(input) {
    return ipcRenderer.invoke('desktop:update-auth:save', input);
  },
  clearUpdateAccess() {
    return ipcRenderer.invoke('desktop:update-auth:clear');
  },
  checkForUpdate() {
    return ipcRenderer.invoke('desktop:update:check');
  },
  downloadUpdate() {
    return ipcRenderer.invoke('desktop:update:download');
  },
  installUpdate() {
    return ipcRenderer.invoke('desktop:update:install');
  },
});
