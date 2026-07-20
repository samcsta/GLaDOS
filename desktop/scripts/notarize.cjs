const { notarize } = require('@electron/notarize');

exports.default = async function notarizeMac(context) {
  if (process.platform !== 'darwin') return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  let credentials = null;
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER) {
    credentials = { appleApiKey: process.env.APPLE_API_KEY, appleApiIssuer: process.env.APPLE_API_ISSUER };
  } else if (process.env.APPLE_KEYCHAIN_PROFILE) {
    credentials = { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE };
  } else if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    credentials = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }
  if (!credentials) {
    if (process.env.GLADOS_RELEASE_BUILD === '1') throw new Error('release build requires Apple notarization credentials');
    console.log('[notarize] Apple credentials not set; skipping notarization');
    return;
  }
  await notarize({
    appBundleId: 'com.glados.ops',
    appPath,
    ...credentials,
  });
};
