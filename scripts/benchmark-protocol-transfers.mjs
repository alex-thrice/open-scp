import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sizeMiB = Number(process.argv[2] ?? 200);
assert(Number.isInteger(sizeMiB) && sizeMiB > 0 && sizeMiB <= 512);
const protocols = process.argv[3] ? [process.argv[3]] : ['sftp', 'ftp', 's3'];
assert(protocols.every((protocol) => ['sftp', 'ftp', 's3'].includes(protocol)));
const runWinScp = process.argv[4] !== 'skip-winscp';
const require = createRequire(import.meta.url);
const { build, stop } = createRequire(require.resolve('vite/package.json'))('esbuild');
await mkdir(join(projectRoot, 'test-results'), { recursive: true });
const directory = await mkdtemp(join(projectRoot, 'test-results', 'protocol-throughput-'));
const bundlePath = join(directory, 'providers.cjs');
const sourcePath = join(directory, 'payload.bin');
const results = [];
const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

try {
  await build({
    stdin: {
      contents: [
        "export * from './tests/integration/sftp-harness';",
        "export * from './tests/integration/ftp-harness';",
        "export * from './tests/integration/s3-harness';",
        "export { LocalProvider } from './src/main/providers/local/local-provider';",
        "export { TransferEngine } from './src/main/transfers/transfer-engine';",
        "export * from './src/shared/models/provider-path';",
      ].join('\n'),
      resolveDir: projectRoot,
      loader: 'ts',
    },
    alias: { '@shared': join(projectRoot, 'src/shared') },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
  });
  const modules = (await import(pathToFileURL(bundlePath).href)).default;
  await writeFile(sourcePath, randomBytes(sizeMiB * 1024 * 1024));
  const expectedHash = await hashFile(sourcePath);
  const local = new modules.LocalProvider({ rootPath: directory });
  await local.connect();
  for (const protocol of protocols) {
    let remote;
    let remotePath;
    const name = `openscp-benchmark-${randomUUID()}.bin`;
    if (protocol === 'sftp') {
      const fixture = modules.createFixtureProvider();
      await modules.trustFixture(fixture);
      remote = fixture.provider;
      remotePath = modules.createSftpProviderPath(`/home/fixture/data/${name}`);
    } else if (protocol === 'ftp') {
      remote = modules.createFtpFixtureProvider().provider;
      remotePath = modules.createFtpProviderPath(`/data/${name}`);
    } else {
      remote = modules.createMinioProvider();
      remotePath = modules.createS3ProviderPath('fixture-bucket', name);
    }
    const downloaded = join(directory, `${protocol}-download.bin`);
    const engine = new modules.TransferEngine();
    let uploaded = false;
    try {
      await remote.connect();
      const transfer = async (direction) => {
        console.log(`OpenSCP ${protocol} ${direction}: ${sizeMiB} MiB`);
        const started = performance.now();
        const id = engine.enqueue({
          source: direction === 'upload' ? local : remote,
          destination: direction === 'upload' ? remote : local,
          sourcePath:
            direction === 'upload' ? modules.createLocalProviderPath(sourcePath) : remotePath,
          destinationPath:
            direction === 'upload' ? remotePath : modules.createLocalProviderPath(downloaded),
          direction,
          workspaceId: 'benchmark',
          conflictPolicy: 'fail',
        });
        while (true) {
          const snapshot = engine.snapshots().find((entry) => entry.id === id);
          assert(snapshot);
          if (snapshot.state === 'completed') {
            assert.equal(snapshot.transferredBytes, BigInt(sizeMiB * 1024 * 1024));
            return (performance.now() - started) / 1000;
          }
          if (!['running', 'queued'].includes(snapshot.state))
            throw new Error(
              JSON.stringify(snapshot, (_key, value) =>
                typeof value === 'bigint' ? String(value) : value,
              ),
            );
          if (performance.now() - started > 240000)
            throw new Error('Benchmark transfer timed out.');
          await setTimeout(5);
        }
      };
      const uploadSeconds = await transfer('upload');
      uploaded = true;
      const downloadSeconds = await transfer('download');
      assert.equal(await hashFile(downloaded), expectedHash);
      const result = {
        client: 'OpenSCP',
        protocol,
        sizeMiB,
        uploadSeconds: Number(uploadSeconds.toFixed(3)),
        uploadMiBPerSecond: Number((sizeMiB / uploadSeconds).toFixed(2)),
        downloadSeconds: Number(downloadSeconds.toFixed(3)),
        downloadMiBPerSecond: Number((sizeMiB / downloadSeconds).toFixed(2)),
        sha256Verified: true,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      engine.dispose();
      if (uploaded) await remote.delete(remotePath, { recursive: false });
      await remote.disconnect();
      await unlink(downloaded).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    if (runWinScp) {
      console.log(`WinSCP ${protocol} upload/download: ${sizeMiB} MiB`);
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(projectRoot, 'scripts/benchmark-winscp-transfers.ps1'),
          '-SourcePath',
          sourcePath,
          '-OutputDirectory',
          directory,
          '-Protocol',
          protocol,
        ],
        { windowsHide: true, timeout: 480000 },
      );
      const result = JSON.parse(stdout.trim());
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  await local.disconnect();
  const report = { node: process.version, date: new Date().toISOString(), results };
  await writeFile(
    join(projectRoot, 'test-results', `protocol-throughput-${sizeMiB}MiB.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await unlink(sourcePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await unlink(bundlePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rmdir(directory);
  stop();
}
