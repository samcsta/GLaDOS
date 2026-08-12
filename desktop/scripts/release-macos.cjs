const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { notarize } = require('@electron/notarize');
const { credentialsFromEnv } = require('./notarize.cjs');

const desktopDir = path.resolve(__dirname, '..');
const root = path.resolve(desktopDir, '..');
const artifacts = path.join(root, 'artifacts', 'desktop');
const appPath = path.join(artifacts, 'mac-arm64', 'GLaDOS.app');
const uninstallerApp = path.join(desktopDir, '.release-tools', 'Uninstall GLaDOS.app');

function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: desktopDir, stdio: 'inherit', ...options });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS releases must be built on macOS');
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const displayVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const version = displayVersion.replace(/^v/, '');
  if (pkg.version !== version) throw new Error(`VERSION (${displayVersion}) and desktop/package.json (${pkg.version}) do not match`);
  if (!process.env.CSC_NAME && !process.env.CSC_LINK) {
    throw new Error('release build requires a Developer ID Application identity via CSC_NAME or CSC_LINK');
  }
  const notaryCredentials = credentialsFromEnv();
  if (!notaryCredentials) throw new Error('release build requires App Store Connect, Keychain-profile, or Apple ID notarization credentials');

  const releaseEnv = { ...process.env, GLADOS_RELEASE_BUILD: '1' };
  run(process.execPath, ['scripts/prepare-macos-vendor.cjs'], { env: releaseEnv });
  run(process.execPath, ['scripts/prepare-uninstaller-app.cjs'], { env: releaseEnv });

  run('npm', ['test']);
  run('npm', ['test', '--prefix', path.join(root, 'dashboard')]);
  run('npm', ['test', '--prefix', path.join(root, 'services', 'private-update-feed')]);
  await notarize({ appPath: uninstallerApp, ...notaryCredentials });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', uninstallerApp]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '--verbose=2', uninstallerApp]);
  run('/usr/bin/xcrun', ['stapler', 'validate', uninstallerApp]);
  run('npm', ['run', 'dist:mac:arm64', '--', '-c.forceCodeSigning=true'], {
    env: releaseEnv,
  });
  const dmgPath = path.join(artifacts, `GLaDOS-${version}-arm64.dmg`);
  if (!fs.existsSync(dmgPath)) throw new Error(`release DMG is missing: ${dmgPath}`);
  await notarize({ appPath: dmgPath, ...notaryCredentials });
  run(process.execPath, ['scripts/verify-packaged.cjs', appPath]);
  run(process.execPath, ['scripts/verify-native-architectures.cjs', appPath], {
    env: { ...process.env, GLADOS_REQUIRE_SIGNED: '1' },
  });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '--verbose=2', appPath]);
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  run('/usr/bin/codesign', ['--verify', '--verbose=2', dmgPath]);
  run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmgPath]);
  run('/usr/bin/hdiutil', ['verify', dmgPath]);

  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-release-dmg-'));
  const dryInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-uninstall-root-'));
  const dryRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-uninstall-runtime-'));
  try {
    run('/usr/bin/hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-mountpoint', mountDir]);
    const mountedApp = path.join(mountDir, 'GLaDOS.app');
    const mountedUninstaller = path.join(mountDir, 'Uninstall GLaDOS.app');
    const mountedUninstallerExecutable = path.join(mountedUninstaller, 'Contents', 'MacOS', 'Uninstall GLaDOS');
    if (!fs.existsSync(mountedApp)) throw new Error('mounted release DMG is missing GLaDOS.app');
    if (!fs.existsSync(mountedUninstallerExecutable)) throw new Error('mounted release DMG is missing the native uninstaller app');
    if (fs.existsSync(path.join(mountDir, 'Uninstall GLaDOS.command'))) {
      throw new Error('mounted release DMG still contains the Gatekeeper-blocked .command launcher');
    }
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', mountedUninstaller]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '--verbose=2', mountedUninstaller]);
    run('/usr/bin/xcrun', ['stapler', 'validate', mountedUninstaller]);
    run(mountedUninstallerExecutable, ['--dry-run', '--yes'], {
      env: {
        ...process.env,
        GLADOS_INSTALL_ROOT: dryInstallRoot,
        GLADOS_RUNTIME_DIR: dryRuntimeDir,
      },
    });
    run(process.execPath, ['scripts/verify-packaged.cjs', mountedApp]);
  } finally {
    try { execFileSync('/usr/bin/hdiutil', ['detach', mountDir], { stdio: 'inherit' }); } catch {}
    fs.rmSync(mountDir, { recursive: true, force: true });
    fs.rmSync(dryInstallRoot, { recursive: true, force: true });
    fs.rmSync(dryRuntimeDir, { recursive: true, force: true });
  }

  const releaseFiles = fs.readdirSync(artifacts)
    .filter(name => name.includes(`-${version}-arm64.`) || name === 'latest-mac.yml')
    .sort();
  const sums = releaseFiles.map(name => {
    const sum = execFileSync('/usr/bin/shasum', ['-a', '256', path.join(artifacts, name)], { encoding: 'utf8' }).split(/\s+/)[0];
    return `${sum}  ${name}`;
  });
  fs.writeFileSync(path.join(artifacts, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  process.stdout.write(`GLaDOS ${version} Apple-silicon release passed signing, notarization, native, and checksum gates.\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
