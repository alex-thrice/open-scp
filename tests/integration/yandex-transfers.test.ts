import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import { MailruConnection } from '../../src/main/providers/mailru/mailru-connection';
import { MailruProvider } from '../../src/main/providers/mailru/mailru-provider';
import {
  createLocalProviderPath,
  createYandexProviderPath,
  createMailruProviderPath,
  createFtpProviderPath,
  createS3ProviderPath,
  createSftpProviderPath,
  type ProviderPath,
} from '../../src/shared/models/provider-path';
import type { FileSystemProvider } from '../../src/shared/providers/file-system-provider';
import { createYandexHarness, required } from '../fixtures/yandex-harness';
import { yandexFixtureEntry } from '../fixtures/yandex-fixture';
import { startWebDavFixture, fixtureMailruPassword } from '../fixtures/webdav-fixture';
import { createFtpFixtureProvider } from './ftp-harness';
import { createMinioProvider } from './s3-harness';
import { createFixtureProvider, trustFixture } from './sftp-harness';

describe('Yandex shared transfer queue', () => {
  let harness: Awaited<ReturnType<typeof createYandexHarness>>;
  let yandex: ReturnType<typeof harness.provider>;
  let engine: TransferEngine;
  let root: string;
  let local: LocalProvider;
  const wait = (id: string, state = 'completed') =>
    vi.waitFor(
      () => {
        const snapshot = engine.snapshots().find((item) => item.id === id);
        expect(snapshot?.state, snapshot?.errorKey ?? '').toBe(state);
      },
      { timeout: 30000, interval: 20 },
    );
  beforeEach(async () => {
    harness = await createYandexHarness();
    await harness.authorize();
    yandex = harness.provider();
    await yandex.connect();
    engine = new TransferEngine();
    root = await mkdtemp(join(tmpdir(), 'openscp-yandex-'));
    local = new LocalProvider({ rootPath: root });
    await local.connect();
  });
  afterEach(async () => {
    engine.dispose();
    await yandex.disconnect();
    await local.disconnect();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });
  const enqueue = (
    source: FileSystemProvider,
    sourcePath: ProviderPath,
    destination: FileSystemProvider,
    destinationPath: ProviderPath,
    policy: 'ask' | 'overwrite' | 'skip' | 'rename' = 'ask',
  ) =>
    engine.enqueue({
      source,
      sourcePath,
      destination,
      destinationPath,
      workspaceId: 'source',
      destinationWorkspaceId: 'destination',
      direction: 'remote',
      conflictPolicy: policy,
    });
  const copy = async (
    source: FileSystemProvider,
    sourcePath: ProviderPath,
    destination: FileSystemProvider,
    destinationPath: ProviderPath,
  ) => {
    const id = enqueue(source, sourcePath, destination, destinationPath);
    await wait(id);
    return id;
  };
  it('round-trips nested Unicode, empty files and 32 MiB through Local ↔ Yandex', async () => {
    await mkdir(join(root, 'source', 'empty'), { recursive: true });
    await writeFile(join(root, 'source', 'Привет #%&.txt'), 'Unicode roundtrip');
    await writeFile(join(root, 'source', 'empty.txt'), '');
    const content = Buffer.alloc(32 * 1048576, 0x5a);
    await writeFile(join(root, 'source', 'large.bin'), content);
    await copy(
      local,
      createLocalProviderPath(join(root, 'source')),
      yandex,
      createYandexProviderPath('/source'),
    );
    await copy(
      yandex,
      createYandexProviderPath('/source'),
      local,
      createLocalProviderPath(join(root, 'returned')),
    );
    expect(
      createHash('sha256')
        .update(await readFile(join(root, 'returned', 'large.bin')))
        .digest('hex'),
    ).toBe(createHash('sha256').update(content).digest('hex'));
    expect(await readFile(join(root, 'returned', 'Привет #%&.txt'), 'utf8')).toBe(
      'Unicode roundtrip',
    );
    expect(await readFile(join(root, 'returned', 'empty.txt'))).toHaveLength(0);
    const requests = harness.fixture.requests;
    expect(
      requests
        .filter((entry) => entry.path === '/v1/disk/resources/upload')
        .every((entry) => entry.query.get('path')?.includes('.openscp-part-')),
    ).toBe(true);
    expect(
      requests
        .filter((entry) => entry.path.startsWith('/transfer/'))
        .every((entry) => !entry.headers.authorization),
    ).toBe(true);
  });
  it.each(['skip', 'rename', 'overwrite'] as const)(
    'waits for explicit %s conflict resolution',
    async (policy) => {
      await writeFile(join(root, 'source'), 'new');
      const tree = required(harness.fixture.accounts.get('one'));
      tree.set('/target', yandexFixtureEntry('old'));
      const id = enqueue(
        local,
        createLocalProviderPath(join(root, 'source')),
        yandex,
        createYandexProviderPath('/target'),
      );
      await wait(id, 'requiring-review');
      expect(tree.get('/target')?.content.toString()).toBe('old');
      await engine.resolveConflict(id, policy, false);
      await wait(id);
      expect(tree.get('/target')?.content.toString()).toBe(policy === 'overwrite' ? 'new' : 'old');
      if (policy === 'rename') expect(tree.get('/target (1)')?.content.toString()).toBe('new');
    },
  );
  it('requires review after an ambiguous publication without deleting the previous destination', async () => {
    await writeFile(join(root, 'source'), 'new');
    const tree = required(harness.fixture.accounts.get('one'));
    tree.set('/target', yandexFixtureEntry('old'));
    harness.fixture.overrides.set('POST /v1/disk/resources/move', { status: 503 });
    const id = enqueue(
      local,
      createLocalProviderPath(join(root, 'source')),
      yandex,
      createYandexProviderPath('/target'),
      'overwrite',
    );
    await wait(id, 'requiring-review');
    expect(tree.get('/target')?.content.toString()).toBe('old');
    expect(
      harness.fixture.requests.filter((entry) => entry.path === '/v1/disk/resources/move'),
    ).toHaveLength(1);
  });

  it('cancels a running upload and explicitly restarts from zero while preserving the previous file', async () => {
    const content = Buffer.alloc(4 * 1048576, 0x38);
    await writeFile(join(root, 'source'), content);
    const tree = required(harness.fixture.accounts.get('one'));
    tree.set('/target', yandexFixtureEntry('old'));
    const openRead = local.openRead.bind(local);
    const delayed = vi.spyOn(local, 'openRead').mockImplementation(async (source, options) =>
      (await openRead(source, options)).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(chunk);
          },
        }),
      ),
    );
    const id = enqueue(
      local,
      createLocalProviderPath(join(root, 'source')),
      yandex,
      createYandexProviderPath('/target'),
      'overwrite',
    );
    await vi.waitFor(
      () =>
        expect(
          engine.snapshots().find((entry) => entry.id === id)?.transferredBytes,
        ).toBeGreaterThan(0n),
      { timeout: 5000 },
    );
    engine.cancel(id);
    await wait(id, 'cancelled');
    delayed.mockRestore();
    expect(tree.get('/target')?.content.toString()).toBe('old');
    await engine.retry(id, false);
    await wait(id);
    expect(tree.get('/target')?.content).toEqual(content);
  });
  it.each(['mailru', 'sftp', 'ftp', 's3'] as const)(
    'round-trips Yandex ↔ %s without staging a local file',
    async (kind) => {
      const name = `yandex-${randomUUID()}.bin`;
      const content = Buffer.alloc(2 * 1048576, 0x37);
      required(harness.fixture.accounts.get('one')).set('/original', yandexFixtureEntry(content));
      let remote: FileSystemProvider;
      let target: ProviderPath;
      let close = () => Promise.resolve();
      if (kind === 'mailru') {
        const fixture = await startWebDavFixture();
        close = fixture.close;
        remote = new MailruProvider(
          new MailruConnection(
            {
              id: randomUUID(),
              name: 'Mailru fixture',
              kind: 'mailru',
              username: 'fixture@example.test',
              timeout: 5000,
              authentication: {
                method: 'password',
                secret: { id: randomUUID(), storage: 'safe-storage' },
              },
            },
            async () => ({ password: fixtureMailruPassword }),
            fixture.endpoint,
          ),
        );
        target = createMailruProviderPath(`/${name}`);
      } else if (kind === 'sftp') {
        const fixture = createFixtureProvider();
        await trustFixture(fixture);
        remote = fixture.provider;
        target = createSftpProviderPath(`/home/fixture/data/${name}`);
      } else if (kind === 'ftp') {
        remote = createFtpFixtureProvider().provider;
        target = createFtpProviderPath(`/data/${name}`);
      } else {
        remote = createMinioProvider();
        target = createS3ProviderPath('fixture-bucket', name);
      }
      try {
        await remote.connect();
        await copy(yandex, createYandexProviderPath('/original'), remote, target);
        await copy(remote, target, yandex, createYandexProviderPath('/returned'));
        expect(required(harness.fixture.accounts.get('one')).get('/returned')?.content).toEqual(
          content,
        );
      } finally {
        await remote.delete(target, { recursive: false }).catch(() => undefined);
        await remote.disconnect();
        await close();
      }
    },
  );
});
