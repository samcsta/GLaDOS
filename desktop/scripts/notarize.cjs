const { notarize } = require('@electron/notarize');

exports.default = async function notarizeMac(context) {
  if (process.platform !== 'darwin') return;
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set; skipping notarization');
    return;
  }
  await notarize({
    appBundleId: 'com.glados.ops',
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
    tool: 'notarytool',
  });
};
