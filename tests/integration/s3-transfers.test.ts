import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMultipartUploadsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMinioProvider, minioClient } from './s3-harness';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createLocalProviderPath,
  createS3ProviderPath,
} from '../../src/shared/models/provider-path';
import { ProviderError, providerErrorCodes } from '../../src/shared/providers/provider-error';

describe('Local ↔ MinIO transfer engine', () => {
  let root: string;
  let prefix: string;
  let local: LocalProvider;
  let remote: ReturnType<typeof createMinioProvider>;
  let engine: TransferEngine;
  const client = minioClient();
  const localPath = (name: string) => createLocalProviderPath(join(root, name));
  const remotePath = (name = '') => createS3ProviderPath('fixture-bucket', `${prefix}${name}`);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openscp-s3-transfer-'));
    prefix = `transfer-${randomUUID()}/`;
    local = new LocalProvider({ rootPath: root });
    remote = createMinioProvider();
    await local.connect();
    await remote.connect();
    await remote.createDirectory(remotePath());
    engine = new TransferEngine();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const item of remote.journal.list()) await remote.cleanupUpload(item.uploadId);
    await remote.delete(remotePath(), { recursive: true });
    await remote.disconnect();
    await local.disconnect();
    await rm(root, { recursive: true, force: true });
  });
  const wait = (id: string, state = 'completed') =>
    vi.waitFor(
      () => {
        const snapshot = engine.snapshots().find((item) => item.id === id);
        expect(snapshot?.state, snapshot?.errorKey ?? undefined).toBe(state);
      },
      { timeout: 55000, interval: 20 },
    );
  const upload = (
    name: string,
    conflictPolicy: 'ask' | 'overwrite' | 'skip' | 'rename' = 'overwrite',
  ) =>
    engine.enqueue({
      workspaceId: 's3-fixture',
      direction: 'upload',
      source: local,
      destination: remote,
      sourcePath: localPath(name),
      destinationPath: remotePath(name),
      conflictPolicy,
    });
  const download = (name: string) =>
    engine.enqueue({
      workspaceId: 's3-fixture',
      direction: 'download',
      source: remote,
      destination: local,
      sourcePath: remotePath(name),
      destinationPath: localPath(`download-${name}`),
      conflictPolicy: 'overwrite',
    });
  const hashFile = async (path: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  };
  it('round-trips 256 MiB with multipart and bounded memory, without treating ETag as MD5', async () => {
    const file = await open(join(root, 'large.bin'), 'w');
    await file.truncate(256 * 1048576);
    await file.close();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      await wait(upload('large.bin'));
      const entry = await remote.stat(remotePath('large.bin'));
      expect(entry.size).toBe(268435456n);
      expect(entry.versionTag).toMatch(/-32"$/u);
      await wait(download('large.bin'));
      expect(await hashFile(join(root, 'download-large.bin'))).toBe(
        await hashFile(join(root, 'large.bin')),
      );
      expect(peak - baseline).toBeLessThan(192 * 1048576);
      process.stdout.write(
        `S3 256 MiB roundtrip: peak RSS increase ${Math.ceil((peak - baseline) / 1048576)} MiB.\n`,
      );
      expect(remote.journal.list()).toHaveLength(0);
    } finally {
      clearInterval(timer);
    }
  });
  it('uses shared ask/skip/overwrite/rename policies for recursive copies and zero-byte objects', async () => {
    await mkdir(join(root, 'tree'));
    await writeFile(join(root, 'tree', 'Unicode файл.txt'), 'first');
    await writeFile(join(root, 'tree', 'empty.bin'), '');
    await wait(upload('tree'));
    await writeFile(join(root, 'tree', 'Unicode файл.txt'), 'second');
    const ask = upload('tree', 'ask');
    await wait(ask, 'requiring-review');
    void engine.resolveConflict(ask, 'skip', false);
    await wait(ask);
    await wait(download('tree/'));
    expect(await readFile(join(root, 'download-tree', 'Unicode файл.txt'), 'utf8')).toBe('first');
    await wait(upload('tree', 'overwrite'));
    await wait(upload('tree', 'rename'));
    expect(
      (await remote.list(remotePath()))
        .filter((entry) => entry.s3Kind === 'prefix')
        .map((entry) => entry.name),
    ).toEqual(['tree (1)', 'tree']);
    await wait(download('tree/'));
    expect(await readFile(join(root, 'download-tree', 'Unicode файл.txt'), 'utf8')).toBe('second');
  });
  it('aborts a cancelled multipart and restarts safely without duplicate objects', async () => {
    const file = await open(join(root, 'cancel.bin'), 'w');
    await file.truncate(40 * 1048576);
    await file.close();
    const original = remote.openWrite.bind(remote);
    let cancelled = false;
    let id = '';
    vi.spyOn(remote, 'openWrite').mockImplementation(async (path, options) => {
      const writer = (await original(path, options)).getWriter();
      let bytes = 0;
      return new WritableStream({
        write: async (chunk: Uint8Array) => {
          await writer.write(chunk);
          bytes += chunk.byteLength;
          if (!cancelled && bytes >= 10 * 1048576) {
            cancelled = true;
            engine.cancel(id);
          }
        },
        close: () => writer.close(),
        abort: () => writer.abort(),
      });
    });
    id = upload('cancel.bin');
    await wait(id, 'cancelled');
    expect(remote.journal.list()).toHaveLength(0);
    await expect(remote.stat(remotePath('cancel.bin'))).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
    expect(
      (
        await client.send(
          new ListMultipartUploadsCommand({ Bucket: 'fixture-bucket', Prefix: prefix }),
        )
      ).Uploads ?? [],
    ).toHaveLength(0);
    engine.retry(id, true);
    await wait(id);
    expect((await remote.list(remotePath())).map((entry) => entry.name)).toEqual(['cancel.bin']);
  });
  it('retries a transient upload from zero and verifies Range download resume with ETag', async () => {
    await writeFile(join(root, 'retry.bin'), Buffer.alloc(2 * 1048576, 0x37));
    const originalWrite = remote.openWrite.bind(remote);
    let interrupted = false;
    vi.spyOn(remote, 'openWrite').mockImplementation(async (path, options) => {
      const writer = (await originalWrite(path, options)).getWriter();
      return new WritableStream({
        write: async (chunk: Uint8Array) => {
          await writer.write(chunk);
          if (!interrupted) {
            interrupted = true;
            throw new ProviderError(providerErrorCodes.ioError, {
              provider: 's3',
              operation: 'write',
            });
          }
        },
        close: () => writer.close(),
        abort: () => writer.abort(),
      });
    });
    await wait(upload('retry.bin'));
    const originalLocalWrite = local.openWrite.bind(local);
    const reads = vi.spyOn(remote, 'openRead');
    let broken = false;
    vi.spyOn(local, 'openWrite').mockImplementation(async (path, options) => {
      const writer = (await originalLocalWrite(path, options)).getWriter();
      return new WritableStream({
        write: async (chunk: Uint8Array) => {
          await writer.write(chunk);
          if (!broken) {
            broken = true;
            throw new ProviderError(providerErrorCodes.ioError, {
              provider: 'local',
              operation: 'write',
            });
          }
        },
        close: () => writer.close(),
        abort: () => writer.abort(),
      });
    });
    await wait(download('retry.bin'));
    expect(
      reads.mock.calls.some(([, options]) => (options?.offset ?? 0) > 0 && !!options?.versionTag),
    ).toBe(true);
    const entry = await remote.stat(remotePath('retry.bin'));
    await client.send(
      new PutObjectCommand({
        Bucket: 'fixture-bucket',
        Key: `${prefix}retry.bin`,
        Body: 'modified',
      }),
    );
    await expect(
      remote.openRead(remotePath('retry.bin'), {
        ...(entry.versionTag ? { versionTag: entry.versionTag } : {}),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  });
  it('fails uploads with insufficient permissions without publishing data', async () => {
    const readonly = createMinioProvider(
      { accessKeyId: 'fixture-readonly' },
      'fixture-readonly-password-only',
    );
    await writeFile(join(root, 'denied.txt'), 'disposable');
    try {
      await readonly.connect();
      const id = engine.enqueue({
        workspaceId: 'read-only',
        direction: 'upload',
        source: local,
        destination: readonly,
        sourcePath: localPath('denied.txt'),
        destinationPath: remotePath('denied.txt'),
        conflictPolicy: 'overwrite',
      });
      await wait(id, 'failed');
      expect(engine.snapshots().find((item) => item.id === id)?.errorKey).toBe(
        'errors.provider.accessDenied',
      );
    } finally {
      await readonly.disconnect();
    }
  });
});
