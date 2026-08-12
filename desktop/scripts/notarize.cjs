const { notarize } = require('@electron/notarize');

function credentialsFromEnv(env = process.env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID) {
    return {
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      ...(env.APPLE_API_ISSUER ? { appleApiIssuer: env.APPLE_API_ISSUER } : {}),
    };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return { keychainProfile: env.APPLE_KEYCHAIN_PROFILE };
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    };
  }
  return null;
}

exports.default = async function notarizeMac(context) {
  if (process.platform !== 'darwin') return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  const credentials = credentialsFromEnv();
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

exports.credentialsFromEnv = credentialsFromEnv;
