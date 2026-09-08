import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const allowedLicenses = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'Python-2.0',
  '0BSD',
  'Unlicense',
]);
// These AWS SDK tarballs omit LICENSE; use the same repository's Apache-2.0 text.
const awsLicenseFallbacks = new Set([
  '@aws-sdk/credential-provider-http@3.972.72',
  '@aws-sdk/credential-provider-login@3.972.77',
  '@aws-sdk/nested-clients@3.997.44',
]);
const mitLicenseFallbacks = new Set(['lazy-val@1.0.5']);

const findPackage = (name, directory) => {
  const require = createRequire(join(directory, 'package.json'));
  return require.resolve
    .paths(name)
    ?.map((base) => join(base, name, 'package.json'))
    .find((path) => existsSync(path));
};

export async function generateLicenseNotices() {
  const root = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const packages = new Map();
  const visit = async (name, directory, optional = false) => {
    const manifest = findPackage(name, directory);
    if (!manifest) {
      if (optional) return;
      throw new Error(`Missing runtime dependency: ${name}`);
    }
    const packageDirectory = await realpath(dirname(manifest));
    if (packages.has(packageDirectory)) return;
    const metadata = JSON.parse(await readFile(manifest, 'utf8'));
    const license = metadata.license ?? metadata.licenses?.[0]?.type;
    if (!allowedLicenses.has(license))
      throw new Error(`Review the license of ${metadata.name}@${metadata.version}: ${license}`);
    packages.set(packageDirectory, { metadata, license });
    for (const dependency of Object.keys(metadata.dependencies ?? {}))
      await visit(
        dependency,
        packageDirectory,
        dependency in (metadata.optionalDependencies ?? {}),
      );
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {}))
      await visit(dependency, packageDirectory, true);
    for (const dependency of Object.keys(metadata.peerDependencies ?? {})) {
      if (!metadata.peerDependenciesMeta?.[dependency]?.optional)
        await visit(dependency, packageDirectory);
    }
  };
  for (const name of Object.keys(root.dependencies)) await visit(name, projectRoot);

  const notices = ['OpenSCP runtime dependency notices', 'See THIRD_PARTY_NOTICES.md for scope.'];
  const inventory = [];
  const sorted = [...packages.entries()].sort((left, right) => {
    const leftId = `${left[1].metadata.name}@${left[1].metadata.version}`;
    const rightId = `${right[1].metadata.name}@${right[1].metadata.version}`;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  for (const [directory, { metadata, license }] of sorted) {
    const identifier = `${metadata.name}@${metadata.version}`;
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /license|notice|copying/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    inventory.push({ name: metadata.name, version: metadata.version, license });
    notices.push(`\n${'='.repeat(72)}\n${identifier} (${license})`);
    if (!files.length) {
      if (mitLicenseFallbacks.has(identifier)) {
        const license = await readFile(join(projectRoot, 'LICENSE'), 'utf8');
        notices.push(
          license.replace(
            /^Copyright \(c\).*$/mu,
            `Copyright (c) ${metadata.author ?? metadata.name}`,
          ),
        );
      } else if (awsLicenseFallbacks.has(identifier)) {
        const awsManifest = findPackage('@aws-sdk/client-s3', projectRoot);
        notices.push(await readFile(join(dirname(awsManifest), 'LICENSE'), 'utf8'));
      } else {
        throw new Error(`Missing license text for ${identifier}; review before packaging.`);
      }
    }
    for (const file of files)
      notices.push(`--- ${file} ---\n${await readFile(join(directory, file), 'utf8')}`);
  }

  const outputDirectory = join(projectRoot, 'build-resources/generated/licenses');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'DEPENDENCIES.txt'), `${notices.join('\n')}\n`);
  await writeFile(
    join(outputDirectory, 'dependencies.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  const electronDirectory = dirname(findPackage('electron', projectRoot));
  // Electron 44 downloads its runtime on first require, not during pnpm install.
  createRequire(import.meta.url)('electron');
  await copyFile(join(electronDirectory, 'LICENSE'), join(outputDirectory, 'LICENSE.electron'));
  await copyFile(
    join(electronDirectory, 'dist/LICENSES.chromium.html'),
    join(outputDirectory, 'LICENSES.chromium.html'),
  );
  process.stdout.write(
    `Checked ${inventory.length} runtime dependencies; license notices generated.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateLicenseNotices();
