// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalDragService } from '../../src/main/external/external-drag-service';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { createLocalProviderPath } from '../../src/shared/models/provider-path';
import { ProviderError, providerErrorCodes } from '../../src/shared/providers/provider-error';

const roots: string[] = [];
const services: ExternalDragService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    service.cancelWorkspace('workspace-1:right');
    await expect.poll(() => service.hasActive()).toBe(false);
    service.dispose();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscp-drag-test-'));
  roots.push(root);
  const source = new LocalProvider({ rootPath: root });
  await source.connect();
  const directory = join(root, 'cache');
  const service = new ExternalDragService(directory);
  services.push(service);
  const path = join(root, 'Отчёт.txt');
  await writeFile(path, 'remote contents');
  return { root, source, directory, service, path };
};

describe('external drag preparation', () => {
  it('cleans only expired preparation directories and keeps recent copies', async () => {
    const { directory, source, service, path } = await fixture();
    const old = join(directory, 'drag-old123');
    const recent = join(directory, 'drag-new123');
    const unrelated = join(directory, 'keep-this');
    for (const path of [old, recent, unrelated]) await mkdir(path, { recursive: true });
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(old, yesterday, yesterday);
    await utimes(unrelated, yesterday, yesterday);
    await service.prepare('workspace-1:right', [
      { provider: source, path: createLocalProviderPath(path) },
    ]);
    await expect.poll(() => service.hasActive()).toBe(false);
    const remaining = await readdir(directory);
    expect(remaining).not.toContain('drag-old123');
    expect(remaining).toContain('drag-new123');
    expect(remaining).toContain('keep-this');
  });

  it('cancels an active download without exposing partial files', async () => {
    const { source, service, path } = await fixture();
    vi.spyOn(source, 'openRead').mockImplementation(
      async (_path, options) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('part'));
            options?.signal?.addEventListener(
              'abort',
              () =>
                controller.error(
                  new ProviderError(providerErrorCodes.cancelled, {
                    operation: 'read',
                    provider: 'local',
                  }),
                ),
              { once: true },
            );
          },
        }),
    );
    await service.prepare('workspace-1:right', [
      { provider: source, path: createLocalProviderPath(path) },
    ]);
    await expect.poll(() => service.snapshots()[0]?.transferredBytes).toBe(4n);
    const id = service.snapshots()[0]?.id ?? '';
    await expect(service.files(id)).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    service.dismiss(id);
    await expect.poll(() => service.hasActive()).toBe(false);
    await expect(service.files(id)).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  });
  it('downloads all files, preserves their names and retains copies after dismissal and shutdown', async () => {
    const { root, source, directory, service, path } = await fixture();
    const second = join(root, 'second.txt');
    await writeFile(second, 'second contents');
    await service.prepare(
      'workspace-1:right',
      [path, second].map((path) => ({
        provider: source,
        path: createLocalProviderPath(path),
      })),
    );
    await expect.poll(() => service.snapshots()[0]?.state).toBe('ready');
    const snapshot = service.snapshots()[0];
    expect(snapshot).toMatchObject({ fileCount: 2, transferredBytes: 30n, totalBytes: 30n });
    const files = await service.files(snapshot?.id ?? '');
    expect(files.map((path) => basename(path))).toEqual(['Отчёт.txt', 'second.txt']);
    expect(await readFile(files[0] ?? '', 'utf8')).toBe('remote contents');
    expect(await readFile(files[1] ?? '', 'utf8')).toBe('second contents');
    service.dismiss(snapshot?.id ?? '');
    expect(service.snapshots()).toEqual([]);
    service.dispose();
    expect(await readFile(files[0] ?? '', 'utf8')).toBe('remote contents');
    expect(await readdir(directory)).toHaveLength(1);
  });

  it('keeps completed batches usable while preparing another workspace', async () => {
    const { source, service, path } = await fixture();
    const endpoints = [{ provider: source, path: createLocalProviderPath(path) }];
    await service.prepare('workspace-1:right', endpoints);
    await expect.poll(() => service.snapshots()[0]?.state).toBe('ready');
    const id = service.snapshots()[0]?.id ?? '';
    await service.prepare('workspace-2:right', endpoints);
    await expect.poll(() => service.hasActive()).toBe(false);
    expect(await readFile((await service.files(id))[0] ?? '', 'utf8')).toBe('remote contents');
  });

  it('rejects folders before creating temporary copies', async () => {
    const { root, source, directory, service } = await fixture();
    await expect(
      service.prepare('workspace-1:right', [
        {
          provider: source,
          path: createLocalProviderPath(root),
        },
      ]),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.hasActive()).toBe(false);
  });

  it('exposes preparation before stat completes and cancels it when the workspace closes', async () => {
    const { source, service, path } = await fixture();
    vi.spyOn(source, 'stat').mockImplementation(
      (_path, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), {
            once: true,
          });
        }),
    );
    const preparing = service.prepare('workspace-1:right', [
      { provider: source, path: createLocalProviderPath(path) },
    ]);
    const rejected = expect(preparing).rejects.toThrow('Cancelled');
    expect(service.hasActive('workspace-1:right')).toBe(true);
    expect(service.snapshots()[0]?.state).toBe('preparing');
    service.cancelWorkspace('workspace-1:right');
    await rejected;
    expect(service.hasActive()).toBe(false);
    expect(service.snapshots()).toEqual([]);
  });

  it('never exposes incomplete downloads after a read failure', async () => {
    const { source, service, path } = await fixture();
    vi.spyOn(source, 'openRead').mockRejectedValue(
      new ProviderError(providerErrorCodes.accessDenied, {
        operation: 'read',
        provider: 'local',
      }),
    );
    await service.prepare('workspace-1:right', [
      { provider: source, path: createLocalProviderPath(path) },
    ]);
    await expect.poll(() => service.snapshots()[0]?.state).toBe('failed');
    await expect(service.files(service.snapshots()[0]?.id ?? '')).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
  });
});
