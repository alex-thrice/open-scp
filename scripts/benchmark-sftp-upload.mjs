import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import ssh2 from 'ssh2';

// Локальный стенд измеряет влияние ожидания SFTP-подтверждений без удалённого сервера.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sizeMiB = Number(process.argv[2] ?? 200);
const acknowledgementDelayMs = Number(process.argv[3] ?? 10);
assert(Number.isSafeInteger(sizeMiB) && sizeMiB > 0 && sizeMiB <= 512);
assert(Number.isFinite(acknowledgementDelayMs) && acknowledgementDelayMs >= 0);
const byteLength = sizeMiB * 1024 * 1024;
const chunkSize = 64 * 1024;
const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;
const require = createRequire(import.meta.url);
const { build, stop } = createRequire(require.resolve('vite/package.json'))('esbuild');
await mkdir(join(projectRoot, 'test-results'), { recursive: true });
const directory = await mkdtemp(join(projectRoot, 'test-results', 'sftp-throughput-'));
const bundlePath = join(directory, 'providers.cjs');
const sourcePath = join(directory, 'payload.bin');
const clients = new Set();
let connection;
let server;
let stopping = false;

try {
  await build({
    stdin: {
      contents: [
        "export { SftpConnection } from './src/main/providers/sftp/sftp-connection';",
        "export { SftpProvider } from './src/main/providers/sftp/sftp-provider';",
        "export { LocalProvider } from './src/main/providers/local/local-provider';",
        "export { createLocalProviderPath, createSftpProviderPath } from './src/shared/models/provider-path';",
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
    SftpConnection,
    SftpProvider,
    LocalProvider,
    createLocalProviderPath,
    createSftpProviderPath,
  } = (await import(pathToFileURL(bundlePath).href)).default;
  const payload = randomBytes(byteLength);
  await writeFile(sourcePath, payload);
  const expectedHash = createHash('sha256').update(payload).digest('hex');
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  });
  const parsedKey = utils.parseKey(privateKey);
  assert(!(parsedKey instanceof Error));
  const fingerprint = `SHA256:${createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64').replace(/=+$/u, '')}`;
  let run;
  let negotiated;
  server = new Server(
    {
      hostKeys: [privateKey],
      // Идентификатор включает OpenSSH, чтобы ssh2 разрешал блоки 64 КиБ без дробления.
      ident: 'OpenSSH_9.6-OpenSCP-benchmark',
    },
    (client) => {
      clients.add(client);
      client.on('error', (error) => {
        if (!stopping) console.error(error.message);
      });
      client.once('close', () => clients.delete(client));
      client.on('handshake', (result) => {
        negotiated = result;
      });
      client.on('authentication', (context) => {
        if (
          context.method === 'password' &&
          context.username === 'benchmark' &&
          context.password === 'local-only'
        ) {
          context.accept();
        } else context.reject();
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          accept().on('sftp', (acceptSftp) => {
            const channel = acceptSftp();
            channel.on('OPEN', (requestId) => channel.handle(requestId, Buffer.from('bench')));
            channel.on('WRITE', (requestId, _handle, offset, data) => {
              const state = run;
              assert(state);
              assert(offset >= 0 && offset + data.length <= byteLength);
              data.copy(state.received, offset);
              state.bytes += data.length;
              state.requests += 1;
              state.pending += 1;
              state.maxPending = Math.max(state.maxPending, state.pending);
              const acknowledge = () => {
                state.pending -= 1;
                channel.status(requestId, STATUS_CODE.OK);
              };
              if (acknowledgementDelayMs > 0) setTimeout(acknowledge, acknowledgementDelayMs);
              else acknowledge();
            });
            channel.on('CLOSE', (requestId) => {
              assert.equal(run.pending, 0);
              channel.status(requestId, STATUS_CODE.OK);
            });
          });
        }),
      );
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  connection = new SftpConnection(
    {
      id: 'local-benchmark',
      kind: 'sftp',
      name: 'Local benchmark',
      host: '127.0.0.1',
      port: server.address().port,
      username: 'benchmark',
      authentication: { method: 'agent' },
      timeout: 20000,
    },
    async () => ({ password: 'local-only' }),
    { getHostKey: () => fingerprint },
  );
  await connection.connect();
  const local = new LocalProvider({ rootPath: directory });
  await local.connect();
  const channel = await connection.data();
  const results = [];
  for (const mode of ['provider-1', 'provider-64', 'fastPut-64']) {
    run = { received: Buffer.alloc(byteLength), bytes: 0, requests: 0, pending: 0, maxPending: 0 };
    console.log(
      `Starting ${mode}: ${sizeMiB} MiB, WRITE acknowledgement delay ${acknowledgementDelayMs} ms`,
    );
    const start = performance.now();
    if (mode.startsWith('provider-')) {
      const provider = new SftpProvider(connection, () => ({
        sftpUploadConcurrency: Number(mode.split('-')[1]),
        sftpDownloadConcurrency: 32,
      }));
      const reader = (await local.openRead(createLocalProviderPath(sourcePath))).getReader();
      const writer = (
        await provider.openWrite(createSftpProviderPath('/payload.bin'), { overwrite: true })
      ).getWriter();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          await writer.write(part.value);
        }
        await writer.close();
      } finally {
        await reader.cancel();
        reader.releaseLock();
        writer.releaseLock();
      }
    } else {
      await new Promise((resolve, reject) =>
        channel.fastPut(
          sourcePath,
          '/payload.bin',
          {
            chunkSize,
            concurrency: Number(mode.split('-')[1]),
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
    const seconds = (performance.now() - start) / 1000;
    assert.equal(run.bytes, byteLength);
    assert.equal(run.pending, 0);
    assert.equal(createHash('sha256').update(run.received).digest('hex'), expectedHash);
    const result = {
      mode,
      seconds: Number(seconds.toFixed(3)),
      MiBPerSecond: Number((sizeMiB / seconds).toFixed(2)),
      requests: run.requests,
      maxPending: run.maxPending,
      sha256Verified: true,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        ssh2: require('ssh2/package.json').version,
        nativeSshBinding: require('ssh2/lib/protocol/crypto.js').bindingAvailable,
        sizeMiB,
        acknowledgementDelayMs,
        chunkSize,
        negotiated,
        results,
      },
      null,
      2,
    ),
  );
  await local.disconnect();
} finally {
  stopping = true;
  connection?.disconnect();
  for (const client of clients) client.end();
  if (server?.address()) await new Promise((resolve) => server.close(resolve));
  await unlink(sourcePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await unlink(bundlePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rmdir(directory);
  stop();
}
