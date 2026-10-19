// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine, type TransferRequest } from '../../src/main/transfers/transfer-engine';
import {
  createLocalProviderPath,
  createRemoteProviderPath,
} from '../../src/shared/models/provider-path';
import { startICloudFixture } from '../fixtures/icloud-harness';
import type { ICloudProvider } from '../../src/main/providers/icloud/icloud-provider';
import { createYandexHarness } from '../fixtures/yandex-harness';
import { createGoogleHarness } from '../fixtures/google-harness';
import { googleChildPath, googleRootPath } from '../../src/shared/models/google-path';

const path = (value: string) => createRemoteProviderPath('icloud', value);
describe('iCloud common transfer queue', () => {
  let fixture: Awaited<ReturnType<typeof startICloudFixture>>;
  let cloud: ICloudProvider;
  let local: LocalProvider;
  let engine: TransferEngine;
  let root: string;
  beforeEach(async () => {
    fixture = await startICloudFixture();
    cloud = fixture.create();
    root = join(fixture.root, 'local');
    await mkdir(root);
    local = new LocalProvider({ rootPath: root });
    engine = new TransferEngine();
    await cloud.connect();
    await local.connect();
  });
  afterEach(async () => {
    engine.dispose();
    await cloud.disconnect();
    await local.disconnect();
    await fixture.close();
  });
  const wait = (id: string, state = 'completed') =>
    vi.waitFor(
      () => {
        const snapshot = engine.snapshots().find((item) => item.id === id);
        expect(snapshot?.state, snapshot?.errorKey ?? '').toBe(state);
      },
      { timeout: 10000, interval: 20 },
    );
  const copy = (
    request: Omit<TransferRequest, 'workspaceId' | 'direction' | 'conflictPolicy'>,
    conflictPolicy: TransferRequest['conflictPolicy'] = 'ask',
  ) =>
    engine.enqueue({
      ...request,
      workspaceId: 'one',
      direction: 'remote',
      conflictPolicy,
    });

  it('round-trips nested Unicode, empty directories and a 32 MiB file', async () => {
    await mkdir(join(root, 'source', 'empty'), { recursive: true });
    await writeFile(join(root, 'source', 'Привет #%&.txt'), 'Unicode content');
    await writeFile(join(root, 'source', 'zero'), '');
    const content = Buffer.alloc(32 * 1048576, 0x5a);
    await writeFile(join(root, 'source', 'large'), content);
    await wait(
      copy({
        source: local,
        sourcePath: createLocalProviderPath(join(root, 'source')),
        destination: cloud,
        destinationPath: path('/source'),
      }),
    );
    await wait(
      copy({
        source: cloud,
        sourcePath: path('/source'),
        destination: local,
        destinationPath: createLocalProviderPath(join(root, 'returned')),
      }),
    );
    expect((await readFile(join(root, 'returned', 'large'))).equals(content)).toBe(true);
    expect(await readFile(join(root, 'returned', 'zero'))).toHaveLength(0);
    expect(await readFile(join(root, 'returned', 'Привет #%&.txt'), 'utf8')).toBe(
      'Unicode content',
    );
    expect(await cloud.list(path('/source/empty'))).toEqual([]);
  }, 60000);

  it('handles conflict policies and copies between independent iCloud accounts', async () => {
    await writeFile(join(root, 'file.txt'), 'new');
    await writeFile(join(fixture.root, 'icloud', 'file.txt'), 'old');
    const request = {
      source: local,
      sourcePath: createLocalProviderPath(join(root, 'file.txt')),
      destination: cloud,
      destinationPath: path('/file.txt'),
    };
    await wait(copy(request, 'skip'));
    expect(await readFile(join(fixture.root, 'icloud', 'file.txt'), 'utf8')).toBe('old');
    await wait(copy(request, 'overwrite'));
    expect(await readFile(join(fixture.root, 'icloud', 'file.txt'), 'utf8')).toBe('new');
    await wait(copy(request, 'rename'));
    expect((await cloud.list(path('/'))).filter((entry) => entry.kind === 'file')).toHaveLength(2);
    const other = fixture.create('second');
    try {
      await other.connect();
      await wait(
        copy({
          source: cloud,
          sourcePath: path('/file.txt'),
          destination: other,
          destinationPath: path('/copied.txt'),
          destinationWorkspaceId: 'two',
        }),
      );
      expect(await readFile(join(fixture.root, 'second', 'copied.txt'), 'utf8')).toBe('new');
    } finally {
      await other.disconnect();
    }
  }, 30000);

  it('copies both ways with existing Yandex and Google providers', async () => {
    const yandexHarness = await createYandexHarness();
    const googleHarness = await createGoogleHarness();
    const yandex = yandexHarness.provider();
    const google = googleHarness.provider();
    try {
      await yandexHarness.authorize();
      await googleHarness.authorize();
      await yandex.connect();
      await google.connect();
      await writeFile(join(fixture.root, 'icloud', 'sample.txt'), 'cross-cloud content');
      const yandexPath = createRemoteProviderPath('yandex', '/sample.txt');
      const googlePath = createRemoteProviderPath(
        'google',
        googleChildPath(googleRootPath, 'sample.txt'),
      );
      for (const [provider, destinationPath] of [
        [yandex, yandexPath],
        [google, googlePath],
      ] as const) {
        await wait(
          copy({
            source: cloud,
            sourcePath: path('/sample.txt'),
            destination: provider,
            destinationPath,
          }),
        );
        const uploaded = (
          await provider.list(
            provider.kind === 'google'
              ? createRemoteProviderPath('google', googleRootPath)
              : createRemoteProviderPath('yandex', '/'),
          )
        ).find((entry) => entry.name === 'sample.txt');
        if (!uploaded) throw new Error('Uploaded cloud file missing.');
        await wait(
          copy({
            source: provider,
            sourcePath: uploaded.path,
            destination: cloud,
            destinationPath: path(`/${provider.kind}.txt`),
          }),
        );
        expect(await readFile(join(fixture.root, 'icloud', `${provider.kind}.txt`), 'utf8')).toBe(
          'cross-cloud content',
        );
      }
    } finally {
      await yandex.disconnect();
      await google.disconnect();
      await yandexHarness.close();
      await googleHarness.close();
    }
  }, 30000);
});
