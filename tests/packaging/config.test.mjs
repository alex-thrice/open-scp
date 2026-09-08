import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { generateIcons } from '../../scripts/generate-icons.mjs';

const require = createRequire(import.meta.url);
const { createPackageConfig, DevelopmentAppId } = require('../../scripts/package-config.cjs');
const signedEnvironment = {
  OPENSCP_SIGNED_BUILD: '1',
  APP_BUNDLE_ID: 'org.example.fileclient',
  APP_PRODUCT_NAME: 'Fixture App',
  APP_PUBLISHER: 'Fixture Owner',
  APP_HOMEPAGE: 'https://example.invalid',
  CSC_LINK: '/fixture/cert.p12',
  CSC_KEY_PASSWORD: 'dummy-only',
  APPLE_API_KEY: '/fixture/key.p8',
  APPLE_API_KEY_ID: 'DUMMY',
  APPLE_API_ISSUER: 'dummy',
};
test('development metadata is stable and distinct from release signing', () => {
  const config = createPackageConfig({}, 'darwin');
  assert.equal(config.appId, DevelopmentAppId);
  assert.equal(config.productName, 'OpenSCP');
  assert.equal(config.extraMetadata.license, 'MIT');
  assert.equal(config.extraMetadata.homepage, 'https://github.com/alex-thrice/open-scp');
  assert.deepEqual(config.publish, {
    provider: 'github',
    owner: 'alex-thrice',
    repo: 'open-scp',
  });
  assert.ok(config.extraResources.some((resource) => resource.to === 'LICENSE'));
  assert.ok(config.extraResources.some((resource) => resource.to === 'licenses'));
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.forceCodeSigning, false);
  assert.deepEqual(
    config.mac.target.map((target) => target.arch),
    [['arm64'], ['arm64']],
  );
});
test('signed macOS builds require every identity, certificate and notary input', () => {
  for (const name of Object.keys(signedEnvironment).filter(
    (name) => name !== 'OPENSCP_SIGNED_BUILD',
  )) {
    const environment = { ...signedEnvironment };
    Reflect.deleteProperty(environment, name);
    assert.throws(() => createPackageConfig(environment, 'darwin'), new RegExp(name));
  }
  const config = createPackageConfig(signedEnvironment, 'darwin');
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.preAutoEntitlements, false);
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.strictVerify, true);
  assert.throws(() =>
    createPackageConfig({ ...signedEnvironment, APP_BUNDLE_ID: DevelopmentAppId }, 'darwin'),
  );
  assert.throws(() => createPackageConfig(signedEnvironment, 'linux'));
});
test('Windows installer preserves user data; platforms carry native icons and unpack Pageant helper', () => {
  const config = createPackageConfig({}, 'win32');
  assert.deepEqual(
    config.win.target.map((target) => target.target),
    ['nsis', 'portable'],
  );
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.notEqual(config.nsis.artifactName, config.portable.artifactName);
  assert.deepEqual(
    config.linux.target.map((target) => target.target),
    ['AppImage', 'deb'],
  );
  assert.ok(config.asarUnpack.includes('**/ssh2/util/pagent.exe'));
  assert.ok(config.deb.depends.includes('libsecret-1-0'));
});
test('entitlements grant only JIT; Linux installer does not introduce sandbox bypasses', async () => {
  const plist = await readFile('build-resources/entitlements.mac.plist', 'utf8');
  assert.deepEqual(
    [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]),
    ['com.apple.security.cs.allow-jit'],
  );
  const install = await readFile('build-resources/linux-after-install.sh', 'utf8');
  assert.doesNotMatch(install, /--no-sandbox|chmod 4755|sysctl/);
});
test('original icon generator produces deterministic PNG, ICO and ICNS assets', async () => {
  await generateIcons();
  const first = await readFile('build-resources/generated/icon.png');
  assert.equal(first.readUInt32BE(16), 512);
  assert.equal(first.readUInt32BE(20), 512);
  const ico = await readFile('build-resources/generated/icon.ico');
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 6);
  const icns = await readFile('build-resources/generated/icon.icns');
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  await generateIcons();
  assert.deepEqual(await readFile('build-resources/generated/icon.png'), first);
});
