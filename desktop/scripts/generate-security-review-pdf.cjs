const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

async function main() {
  const htmlPath = path.resolve(process.argv[2] || '');
  const outputPath = path.resolve(process.argv[3] || '');
  if (!fs.existsSync(htmlPath) || !outputPath) throw new Error('usage: electron generate-security-review-pdf.cjs <html> <pdf>');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'glados-pdf-')));
  await app.whenReady();
  const window = new BrowserWindow({ show: false, backgroundColor: '#ffffff', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await window.loadFile(htmlPath);
    await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    const pdf = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(outputPath, pdf, { mode: 0o600 });
    if (path.basename(path.dirname(htmlPath)) === 'deliverables') {
      const reviewRoot = path.dirname(path.dirname(htmlPath));
      fs.writeFileSync(path.join(reviewRoot, 'security-review-report.pdf'), pdf, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify({ outputPath, bytes: pdf.length })}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
