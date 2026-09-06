import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createLocalProviderPath,
  createSftpProviderPath,
} from '../../src/shared/models/provider-path';
import { ProviderError, providerErrorCodes } from '../../src/shared/providers/provider-error';
import { createFixtureProvider, trustFixture } from './sftp-harness';

describe('Local ↔ OpenSSH transfers', () => {
  let localRoot: string;
  let remoteRoot: string;
  let local: LocalProvider;
  let fixture: ReturnType<typeof createFixtureProvider>;
  let engine: TransferEngine;
  beforeEach(async () => {
    localRoot = await mkdtemp(join(tmpdir(), 'openscp-transfer-'));
    local = new LocalProvider({ rootPath: localRoot });
    await local.connect();
    fixture = createFixtureProvider();
    await trustFixture(fixture);
    await fixture.provider.connect();
    remoteRoot = `/home/fixture/data/transfer-${randomUUID()}`;
    await fixture.provider.createDirectory(createSftpProviderPath(remoteRoot));
    engine = new TransferEngine();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.provider.connect();
    await fixture.provider.delete(createSftpProviderPath(remoteRoot), { recursive: true });
    await fixture.provider.disconnect();
    await local.disconnect();
    await rm(localRoot, { recursive: true, force: true });
  });
  const wait = async (id: string, state = 'completed') => {
    await vi.waitFor(
      () => {
        const item = engine.snapshots().find((entry) => entry.id === id);
        if (item?.state === 'failed' && state !== 'failed')
          throw new Error(`Transfer failed: ${item.errorKey}`);
        expect(item?.state).toBe(state);
      },
      { timeout: 180000, interval: 20 },
    );
  };
  const upload = (name: string, policy: 'ask' | 'overwrite' | 'skip' | 'rename' = 'overwrite') =>
    engine.enqueue({
      source: local,
      destination: fixture.provider,
      sourcePath: createLocalProviderPath(join(localRoot, name)),
      destinationPath: createSftpProviderPath(`${remoteRoot}/${name}`),
      direction: 'upload',
      workspaceId: 'fixture',
      conflictPolicy: policy,
    });
  const download = (name: string) =>
    engine.enqueue({
      source: fixture.provider,
      destination: local,
      sourcePath: createSftpProviderPath(`${remoteRoot}/${name}`),
      destinationPath: createLocalProviderPath(join(localRoot, `download-${name}`)),
      direction: 'download',
      workspaceId: 'fixture',
      conflictPolicy: 'overwrite',
    });

  it('round-trips a file with bounded chunks and preserves its content', async () => {
    const content = Buffer.alloc(4 * 1024 * 1024, 0x75);
    await writeFile(join(localRoot, 'large.bin'), content);
    const reads = vi.spyOn(local, 'openRead');
    await wait(upload('large.bin'));
    await wait(download('large.bin'));
    expect(
      createHash('sha256')
        .update(await readFile(join(localRoot, 'download-large.bin')))
        .digest('hex'),
    ).toBe(createHash('sha256').update(content).digest('hex'));
    expect(reads).toHaveBeenCalled();
    expect(
      (await fixture.provider.list(createSftpProviderPath(remoteRoot))).every(
        (entry) => !entry.name.startsWith('.openscp-part-'),
      ),
    ).toBe(true);
  });

  it('streams the 256 MiB sparse fixture without buffering the whole file', async () => {
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 25);
    try {
      const id = engine.enqueue({
        source: fixture.provider,
        destination: local,
        sourcePath: createSftpProviderPath('/home/fixture/data/large-sparse.bin'),
        destinationPath: createLocalProviderPath(join(localRoot, 'large-sparse.bin')),
        direction: 'download',
        workspaceId: 'fixture',
        conflictPolicy: 'overwrite',
      });
      await wait(id);
      expect(
        (await local.stat(createLocalProviderPath(join(localRoot, 'large-sparse.bin')))).size,
      ).toBe(268435456n);
      expect(peak - baseline).toBeLessThan(192 * 1024 * 1024);
      process.stdout.write(
        `Sparse 256 MiB transfer: peak RSS increase ${Math.ceil((peak - baseline) / 1048576)} MiB.\n`,
      );
    } finally {
      clearInterval(timer);
    }
  });
  it('handles ask, overwrite, skip, rename and recursive directories', async () => {
    await mkdir(join(localRoot, 'tree'));
    await writeFile(join(localRoot, 'tree', 'Unicode файл.txt'), 'first');
    await wait(upload('tree'));
    await writeFile(join(localRoot, 'tree', 'Unicode файл.txt'), 'second');
    const ask = upload('tree', 'ask');
    await wait(ask, 'requiring-review');
    void engine.resolveConflict(ask, 'skip', false);
    await wait(ask);
    await wait(download('tree'));
    expect(await readFile(join(localRoot, 'download-tree', 'Unicode файл.txt'), 'utf8')).toBe(
      'first',
    );
    await wait(upload('tree', 'overwrite'));
    await wait(upload('tree', 'rename'));
    const entries = await fixture.provider.list(createSftpProviderPath(remoteRoot));
    expect(entries.some((entry) => entry.name === 'tree (1)')).toBe(true);
    await wait(download('tree'));
    expect(await readFile(join(localRoot, 'download-tree', 'Unicode файл.txt'), 'utf8')).toBe(
      'second',
    );
  });
  it('recovers an interrupted SSH stream using verified offsets without duplicate files', async () => {
    await writeFile(join(localRoot, 'resume.bin'), Buffer.alloc(2 * 1024 * 1024, 0x42));
    const reads = vi.spyOn(local, 'openRead');
    const original = fixture.provider.openWrite.bind(fixture.provider);
    let interrupted = false;
    vi.spyOn(fixture.provider, 'openWrite').mockImplementation(async (path, options) => {
      const writer = (await original(path, options)).getWriter();
      return new WritableStream({
        write: async (chunk: Uint8Array) => {
          await writer.write(chunk);
          if (!interrupted) {
            interrupted = true;
            fixture.connection.disconnect();
            throw new ProviderError(providerErrorCodes.ioError, {
              provider: 'sftp',
              operation: 'write',
            });
          }
        },
        close: () => writer.close(),
        abort: () => writer.abort().catch(() => undefined),
      });
    });
    await wait(upload('resume.bin'));
    expect(reads.mock.calls.some(([, options]) => (options?.offset ?? 0) > 0)).toBe(true);
    expect(
      (await fixture.provider.list(createSftpProviderPath(remoteRoot))).map((entry) => entry.name),
    ).toEqual(['resume.bin']);
  });
  it('never publishes a cancelled upload and rejects unsafe resume before allowing a restart', async () => {
    await writeFile(join(localRoot, 'cancel.bin'), Buffer.alloc(1048576, 0x11));
    const original = fixture.provider.openWrite.bind(fixture.provider);
    let cancelled = false;
    let id = '';
    vi.spyOn(fixture.provider, 'openWrite').mockImplementation(async (path, options) => {
      const writer = (await original(path, options)).getWriter();
      return new WritableStream({
        write: async (chunk: Uint8Array) => {
          await writer.write(chunk);
          if (!cancelled) {
            cancelled = true;
            engine.cancel(id);
          }
        },
        close: () => writer.close(),
        abort: () => writer.abort().catch(() => undefined),
      });
    });
    id = upload('cancel.bin');
    await wait(id, 'cancelled');
    await expect(
      fixture.provider.stat(createSftpProviderPath(`${remoteRoot}/cancel.bin`)),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    await writeFile(join(localRoot, 'cancel.bin'), Buffer.alloc(1048576, 0x22));
    engine.retry(id, true);
    await wait(id, 'failed');
    expect(engine.snapshots().find((item) => item.id === id)?.errorKey).toBe(
      'errors.transfer.unsafeResume',
    );
    engine.retry(id, false);
    await wait(id);
    await wait(download('cancel.bin'));
    expect((await readFile(join(localRoot, 'download-cancel.bin')))[0]).toBe(0x22);
  });
});
