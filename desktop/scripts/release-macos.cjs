const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const root = path.resolve(desktopDir, '..');
const artifacts = path.join(root, 'artifacts', 'desktop');
const appPath = path.join(artifacts, 'mac-arm64', 'GLaDOS.app');

function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: desktopDir, stdio: 'inherit', ...options });
}

function main() {
  if (process.platform !== 'darwin') throw new Error('macOS releases must be built on macOS');
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const displayVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const version = displayVersion.replace(/^v/, '');
  if (pkg.version !== version) throw new Error(`VERSION (${displayVersion}) and desktop/package.json (${pkg.version}) do not match`);
  if (!process.env.CSC_NAME && !process.env.CSC_LINK) {
    throw new Error('release build requires a Developer ID Application identity via CSC_NAME or CSC_LINK');
  }
  const hasNotary = (process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER)
    || process.env.APPLE_KEYCHAIN_PROFILE
    || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  if (!hasNotary) throw new Error('release build requires App Store Connect, Keychain-profile, or Apple ID notarization credentials');

  run('npm', ['test']);
  run('npm', ['test', '--prefix', path.join(root, 'dashboard')]);
  run('npm', ['test', '--prefix', path.join(root, 'services', 'private-update-feed')]);
  run('npm', ['run', 'dist:mac:arm64', '--', '-c.forceCodeSigning=true'], {
    env: { ...process.env, GLADOS_RELEASE_BUILD: '1' },
  });
  run(process.execPath, ['scripts/verify-native-architectures.cjs', appPath], {
    env: { ...process.env, GLADOS_REQUIRE_SIGNED: '1' },
  });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '--verbose=2', appPath]);
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);

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

try { main(); }
catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
