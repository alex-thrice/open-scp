const DevelopmentAppId = 'com.electron.openscp';

const requireValue = (environment, name) => {
  if (!environment[name]?.trim()) throw new Error(`Signed builds require ${name}.`);
  return environment[name];
};

function createPackageConfig(environment, platform) {
  const signed = environment.OPENSCP_SIGNED_BUILD === '1';
  if (signed) {
    if (!['darwin', 'win32'].includes(platform))
      throw new Error('Signing is configured only for native macOS and Windows builds.');
    const appId = requireValue(environment, 'APP_BUNDLE_ID');
    if (appId === DevelopmentAppId || !/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+){2,}$/.test(appId))
      throw new Error('APP_BUNDLE_ID must be an owner-approved reverse-DNS identifier.');
    requireValue(environment, 'APP_PRODUCT_NAME');
    requireValue(environment, 'APP_PUBLISHER');
    requireValue(environment, 'APP_HOMEPAGE');
    requireValue(environment, 'CSC_LINK');
    requireValue(environment, 'CSC_KEY_PASSWORD');
    if (platform === 'darwin') {
      requireValue(environment, 'APPLE_API_KEY');
      requireValue(environment, 'APPLE_API_KEY_ID');
      requireValue(environment, 'APPLE_API_ISSUER');
    }
  }
  return {
    appId: signed ? environment.APP_BUNDLE_ID : DevelopmentAppId,
    productName: signed ? environment.APP_PRODUCT_NAME : 'OpenSCP',
    asar: true,
    asarUnpack: ['**/*.node', '**/ssh2/util/pagent.exe'],
    forceCodeSigning: signed,
    directories: { output: 'release', buildResources: 'build-resources' },
    files: ['out/**/*', 'package.json'],
    extraResources: [
      { from: 'build-resources/generated/icon.png', to: 'icon.png' },
      { from: 'LICENSE', to: 'LICENSE' },
      { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
      { from: 'src/renderer/src/components/LICENSE.lucide', to: 'licenses/LICENSE.lucide' },
      { from: 'build-resources/generated/licenses', to: 'licenses' },
    ],
    extraMetadata: {
      productName: signed ? environment.APP_PRODUCT_NAME : 'OpenSCP',
      desktopName: 'openscp.desktop',
      author: signed ? environment.APP_PUBLISHER : 'OpenSCP contributors',
      license: 'MIT',
      homepage: signed ? environment.APP_HOMEPAGE : 'https://github.com/AlextThice/open-csp',
    },
    mac: {
      target: [
        { target: 'dmg', arch: ['arm64'] },
        { target: 'zip', arch: ['arm64'] },
      ],
      artifactName: 'openscp-${version}-mac-${arch}.${ext}',
      icon: 'build-resources/generated/icon.icns',
      category: 'public.app-category.utilities',
      // Ad-hoc packages are CI/development artifacts, never notarized releases.
      ...(signed ? {} : { identity: '-' }),
      hardenedRuntime: signed,
      entitlements: 'build-resources/entitlements.mac.plist',
      entitlementsInherit: 'build-resources/entitlements.mac.plist',
      preAutoEntitlements: false,
      strictVerify: true,
      notarize: signed,
    },
    dmg: { sign: signed },
    win: {
      target: [
        { target: 'nsis', arch: ['x64'] },
        { target: 'portable', arch: ['x64'] },
      ],
      icon: 'build-resources/generated/icon.ico',
      // Keep icon/resource editing enabled even in unsigned packages.
      signAndEditExecutable: true,
    },
    nsis: {
      artifactName: 'openscp-${version}-win-${arch}-setup.${ext}',
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
    },
    portable: { artifactName: 'openscp-${version}-win-${arch}-portable.${ext}' },
    linux: {
      target: [
        { target: 'AppImage', arch: ['x64'] },
        { target: 'deb', arch: ['x64'] },
      ],
      artifactName: 'openscp-${version}-linux-${arch}.${ext}',
      executableName: 'openscp',
      syncDesktopName: true,
      icon: 'build-resources/generated/icons',
      category: 'Utility;Network;FileTransfer',
      synopsis: 'Two-panel SFTP and S3 file client',
      description: 'Independent cross-platform desktop file client. Development build.',
      // A reserved example-domain address, not a real publisher/contact.
      maintainer: 'openscp contributors <noreply@example.invalid>',
    },
    deb: {
      depends: [
        'libgtk-3-0',
        'libnotify4',
        'libnss3',
        'libxss1',
        'libxtst6',
        'xdg-utils',
        'libatspi2.0-0',
        'libuuid1',
        'libsecret-1-0',
      ],
      afterInstall: 'build-resources/linux-after-install.sh',
      afterRemove: 'build-resources/linux-after-remove.sh',
    },
  };
}

module.exports = { createPackageConfig, DevelopmentAppId };
