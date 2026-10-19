import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailruConnection } from '../../src/main/providers/mailru/mailru-connection';
import { MailruProvider } from '../../src/main/providers/mailru/mailru-provider';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createLocalProviderPath,
  createMailruProviderPath,
  createFtpProviderPath,
  createS3ProviderPath,
  createSftpProviderPath,
  type ProviderPath,
} from '../../src/shared/models/provider-path';
import type { FileSystemProvider } from '../../src/shared/providers/file-system-provider';
import {
  fixtureMailruPassword,
  fixtureMailruUsername,
  startWebDavFixture,
  type WebDavFixture,
} from '../fixtures/webdav-fixture';
import { createFtpFixtureProvider } from './ftp-harness';
import { createMinioProvider } from './s3-harness';
import { createFixtureProvider, trustFixture } from './sftp-harness';

describe('Mail.ru WebDAV shared transfer queue', () => {
  let fixture: WebDavFixture;
  let mailru: MailruProvider;
  let engine: TransferEngine;
  let root: string;
  let local: LocalProvider;
  const wait = async (id: string, state = 'completed') =>
    vi.waitFor(
      () => {
        const snapshot = engine.snapshots().find((item) => item.id === id);
        expect(snapshot?.state, snapshot?.errorKey ?? '').toBe(state);
      },
      { timeout: 30000, interval: 20 },
    );
  beforeEach(async () => {
    fixture = await startWebDavFixture();
    root = await mkdtemp(join(tmpdir(), 'openscp-mailru-'));
    engine = new TransferEngine();
    mailru = new MailruProvider(
      new MailruConnection(
        {
          id: randomUUID(),
          name: 'Disposable WebDAV',
          kind: 'mailru',
          username: fixtureMailruUsername,
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
    local = new LocalProvider({ rootPath: root });
    await mailru.connect();
    await local.connect();
  });
  afterEach(async () => {
    engine.dispose();
    await mailru.disconnect();
    await local.disconnect();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  const copy = async (
    source: FileSystemProvider,
    sourcePath: ProviderPath,
    destination: FileSystemProvider,
    destinationPath: ProviderPath,
    policy: 'ask' | 'overwrite' | 'skip' | 'rename' = 'ask',
  ) => {
    const id = engine.enqueue({
      source,
      sourcePath,
      destination,
      destinationPath,
      workspaceId: 'source',
      destinationWorkspaceId: 'destination',
      direction: 'remote',
      conflictPolicy: policy,
    });
    await wait(id);
    return id;
  };

  it('round-trips nested directories, empty files and a 32 MiB file through Local ↔ Mail.ru', async () => {
    await mkdir(join(root, 'source', 'empty'), { recursive: true });
    await writeFile(join(root, 'source', 'Привет #%&.txt'), 'Unicode roundtrip');
    await writeFile(join(root, 'source', 'empty.txt'), '');
    const content = Buffer.alloc(32 * 1048576, 0x5a);
    await writeFile(join(root, 'source', 'large.bin'), content);
    await copy(
      local,
      createLocalProviderPath(join(root, 'source')),
      mailru,
      createMailruProviderPath('/source'),
    );
    expect(
      fixture.requests
        .filter((request) => request.method === 'PUT')
        .every((request) => request.path.includes('.openscp-part-')),
    ).toBe(true);
    const largePut = fixture.requests.find(
      (request) =>
        request.method === 'PUT' && request.headers['content-length'] === String(content.length),
    );
    expect(largePut).toBeDefined();
    await copy(
      mailru,
      createMailruProviderPath('/source'),
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
  });

  it.each(['skip', 'rename', 'overwrite'] as const)(
    'waits for an explicit %s resolution before changing an existing destination',
    async (policy) => {
      await writeFile(join(root, 'source'), 'new');
      fixture.entries.set('/target', { kind: 'file', content: Buffer.from('old') });
      const id = engine.enqueue({
        source: local,
        sourcePath: createLocalProviderPath(join(root, 'source')),
        destination: mailru,
        destinationPath: createMailruProviderPath('/target'),
        workspaceId: 'source',
        direction: 'upload',
        conflictPolicy: 'ask',
      });
      await wait(id, 'requiring-review');
      expect(fixture.entries.get('/target')?.content.toString()).toBe('old');
      expect(fixture.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
      await engine.resolveConflict(id, policy, false);
      await wait(id);
      expect(fixture.entries.get('/target')?.content.toString()).toBe(
        policy === 'overwrite' ? 'new' : 'old',
      );
      if (policy === 'rename')
        expect(fixture.entries.get('/target (1)')?.content.toString()).toBe('new');
    },
  );

  it('does not retry an ambiguous MOVE or delete the previous destination', async () => {
    await writeFile(join(root, 'source'), 'new');
    fixture.entries.set('/target', { kind: 'file', content: Buffer.from('old') });
    const rename = mailru.rename.bind(mailru);
    vi.spyOn(mailru, 'rename').mockImplementation(async (source, destination, options) => {
      if (source.provider !== 'mailru') throw new Error('Wrong provider.');
      fixture.overrides.set(`MOVE ${source.path}`, { status: 503 });
      await rename(source, destination, options);
    });
    const id = engine.enqueue({
      source: local,
      sourcePath: createLocalProviderPath(join(root, 'source')),
      destination: mailru,
      destinationPath: createMailruProviderPath('/target'),
      workspaceId: 'source',
      direction: 'upload',
      conflictPolicy: 'overwrite',
    });
    await wait(id, 'requiring-review');
    expect(fixture.requests.filter((request) => request.method === 'MOVE')).toHaveLength(1);
    expect(fixture.entries.get('/target')?.content.toString()).toBe('old');
  });

  it.each(['sftp', 's3', 'ftp'] as const)(
    'streams Mail.ru ↔ %s through the existing protocol adapter',
    async (kind) => {
      const name = `mailru-${randomUUID()}.bin`;
      const content = Buffer.alloc(2 * 1048576, 0x37);
      fixture.entries.set('/original', { kind: 'file', content });
      let remote: FileSystemProvider;
      let target: ProviderPath;
      if (kind === 'sftp') {
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
        await copy(mailru, createMailruProviderPath('/original'), remote, target);
        await copy(remote, target, mailru, createMailruProviderPath('/returned'));
        expect(
          createHash('sha256')
            .update(fixture.entries.get('/returned')?.content ?? '')
            .digest('hex'),
        ).toBe(createHash('sha256').update(content).digest('hex'));
      } finally {
        await remote.delete(target, { recursive: false }).catch(() => undefined);
        await remote.disconnect();
      }
    },
  );
});
