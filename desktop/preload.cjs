const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gladosDesktop', {
  isPackaged: process.env.NODE_ENV !== 'development' && !process.defaultApp,
  onDashboardExit(callback) {
    ipcRenderer.on('dashboard-exit', (_event, payload) => callback(payload));
  },
  getDashboardHealth() {
    return ipcRenderer.invoke('desktop:dashboard:health');
  },
  onUpdateStatus(callback) {
    ipcRenderer.on('desktop-update-status', (_event, payload) => callback(payload));
  },
  getSetupStatus() {
    return ipcRenderer.invoke('desktop:setup:status');
  },
  saveLiteLlmKey(input) {
    return ipcRenderer.invoke('desktop:setup:save-litellm', input);
  },
  saveLocalSecrets(input) {
    return ipcRenderer.invoke('desktop:setup:save-local-secrets', input);
  },
  generateProxyCa() {
    return ipcRenderer.invoke('desktop:setup:generate-ca');
  },
  trustProxyCa() {
    return ipcRenderer.invoke('desktop:setup:trust-ca');
  },
  verifySetup() {
    return ipcRenderer.invoke('desktop:setup:verify');
  },
  chooseSecurityReviewDirectory(input) {
    return ipcRenderer.invoke('desktop:security-review:choose-directory', input);
  },
  exportSecurityReviewPdf(input) {
    return ipcRenderer.invoke('desktop:security-review:export-pdf', input);
  },
  getUpdateStatus() {
    return ipcRenderer.invoke('desktop:update:status');
  },
  checkForUpdate() {
    return ipcRenderer.invoke('desktop:update:check');
  },
  applyUpdate() {
    return ipcRenderer.invoke('desktop:update:apply');
  },
});
