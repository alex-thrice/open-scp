import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Измеряем настоящую очередь на локальном API, без доступа к аккаунту Google.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sizeMiB = Number(process.argv[2] ?? 64);
const acknowledgementDelayMs = Number(process.argv[3] ?? 40);
assert(Number.isSafeInteger(sizeMiB) && sizeMiB > 0 && sizeMiB <= 256);
assert(Number.isFinite(acknowledgementDelayMs) && acknowledgementDelayMs >= 0);
const require = createRequire(import.meta.url);
const { build, stop } = createRequire(require.resolve('vite/package.json'))('esbuild');
await mkdir(join(projectRoot, 'test-results'), { recursive: true });
const directory = await mkdtemp(join(projectRoot, 'test-results', 'google-throughput-'));
const bundlePath = join(directory, 'providers.cjs');
const sourceFile = join(directory, 'payload.bin');
let harness;
let provider;
let engine;
let source;
try {
  await build({
    stdin: {
      contents: [
        "export { createGoogleHarness, required } from './tests/fixtures/google-harness';",
        "export { TransferEngine } from './src/main/transfers/transfer-engine';",
        "export { LocalProvider } from './src/main/providers/local/local-provider';",
        "export { createGoogleProviderPath, createLocalProviderPath } from './src/shared/models/provider-path';",
        "export { googleChildPath, googleRootPath } from './src/shared/models/google-path';",
        "export { googleChunkSize } from './src/main/providers/google/google-upload';",
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
  const {
    createGoogleHarness,
    required,
    TransferEngine,
    LocalProvider,
    createGoogleProviderPath,
    createLocalProviderPath,
    googleChildPath,
    googleRootPath,
    googleChunkSize,
  } = (await import(pathToFileURL(bundlePath).href)).default;
  harness = await createGoogleHarness();
  await harness.authorize();
  provider = harness.provider();
  await provider.connect();
  harness.fixture.chunkDelay = acknowledgementDelayMs;
  source = new LocalProvider({ rootPath: directory });
  await source.connect();
  const payload = randomBytes(sizeMiB * 1024 * 1024);
  const sourcePath = createLocalProviderPath(sourceFile);
  await writeFile(sourceFile, payload);
  engine = new TransferEngine();
  const start = performance.now();
  const id = engine.enqueue({
    source,
    destination: provider,
    sourcePath,
    destinationPath: createGoogleProviderPath(googleChildPath(googleRootPath, 'payload.bin')),
    workspaceId: 'benchmark',
    direction: 'upload',
    conflictPolicy: 'ask',
  });
  const deadline = start + 120000;
  while (true) {
    const snapshot = required(engine.snapshots().find((entry) => entry.id === id));
    if (snapshot.state === 'completed') break;
    assert(['queued', 'running'].includes(snapshot.state), snapshot.errorKey ?? snapshot.state);
    assert(performance.now() < deadline, 'Benchmark timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const seconds = (performance.now() - start) / 1000;
  const entry = required(
    [...required(harness.fixture.accounts.get('one')).values()].find(
      (entry) => entry.name === 'payload.bin',
    ),
  );
  assert.equal(
    createHash('sha256').update(entry.content).digest('hex'),
    createHash('sha256').update(payload).digest('hex'),
  );
  console.log(
    JSON.stringify({
      node: process.version,
      sizeMiB,
      acknowledgementDelayMs,
      chunkSize: googleChunkSize,
      uploadRequests: harness.fixture.chunkSizes.length,
      seconds: Number(seconds.toFixed(3)),
      MiBPerSecond: Number((sizeMiB / seconds).toFixed(2)),
      sha256Verified: true,
    }),
  );
} finally {
  engine?.dispose();
  await provider?.disconnect();
  await source?.disconnect();
  await harness?.close();
  await unlink(sourceFile).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await unlink(bundlePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rmdir(directory);
  stop();
}
