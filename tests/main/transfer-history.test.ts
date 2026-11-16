// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '../../src/main/ipc/application-error';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { CredentialService } from '../../src/main/security/credential-service';
import { QueueJournal, type QueueRecord } from '../../src/main/transfers/queue-journal';
import { TransferEngine, type TransferRequest } from '../../src/main/transfers/transfer-engine';
import { applicationErrorCodes } from '../../src/shared/errors/application-error';
import { createLocalProviderPath } from '../../src/shared/models/provider-path';

describe('clearing transfer history', () => {
  const roots: string[] = [];
  const databases: ReturnType<typeof openDatabase>[] = [];
  const engines: TransferEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-transfer-history-'));
    roots.push(root);
    const provider = new LocalProvider({ rootPath: root });
    await provider.connect();
    await writeFile(join(root, 'source.txt'), 'history fixture content');
    const database = openDatabase(':memory:');
    databases.push(database);
    const credentials = new CredentialService(database, {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error();
      },
      decryptString: () => {
        throw new Error();
      },
    });
    const journal = new QueueJournal(new ProfileStore(database, credentials));
    const request: TransferRequest = {
      source: provider,
      destination: provider,
      sourcePath: createLocalProviderPath(join(root, 'source.txt')),
      destinationPath: createLocalProviderPath(join(root, 'target.txt')),
      workspaceId: 'workspace-1',
      direction: 'download',
      conflictPolicy: 'ask',
    };
    const persistence = {
      load: () => journal.load(),
      save: (records: readonly QueueRecord[]) => journal.save(records),
      resolve: async () => request,
    };
    const engine = new TransferEngine(persistence);
    engines.push(engine);
    return { root, provider, journal, request, persistence, engine };
  };

  const waitFor = async (engine: TransferEngine, id: string, state: string) => {
    await vi.waitFor(
      () => expect(engine.snapshots().find((entry) => entry.id === id)?.state).toBe(state),
      { timeout: 5000, interval: 20 },
    );
  };

  it('removes a failed attempt from the journal while preserving its partial file and source', async () => {
    const { root, provider, journal, request, persistence, engine } = await setup();
    const openWrite = provider.openWrite.bind(provider);
    vi.spyOn(provider, 'openWrite').mockImplementationOnce(async (path, options) => {
      const writer = (await openWrite(path, options)).getWriter();
      return new WritableStream<Uint8Array>({
        async write(chunk) {
          await writer.write(chunk.subarray(0, 4));
          throw new ApplicationError(applicationErrorCodes.providerUnsupported);
        },
        close: () => writer.close(),
        abort: () => writer.abort(),
      });
    });
    const removeFile = vi.spyOn(provider, 'delete');
    const id = engine.enqueue(request);
    await waitFor(engine, id, 'failed');
    const partial = (await readdir(root)).find((name) => name.startsWith('.openscp-part-'));
    if (!partial) throw new Error('Expected retained transfer partial');
    expect(await readFile(join(root, partial), 'utf8')).toBe('hist');

    engine.clearHistory();

    expect(engine.snapshots()).toEqual([]);
    expect(journal.load()).toEqual([]);
    expect(removeFile).not.toHaveBeenCalled();
    expect(await readFile(join(root, partial), 'utf8')).toBe('hist');
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('history fixture content');
    await expect(readFile(join(root, 'target.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = new TransferEngine(persistence);
    engines.push(reopened);
    expect(reopened.snapshots()).toEqual([]);
  });

  it('clears finished attempts while retaining running, queued and conflict-review jobs', async () => {
    const { root, provider, journal, request, engine } = await setup();
    const completed = engine.enqueue(request);
    await waitFor(engine, completed, 'completed');
    const failed = engine.enqueue({
      ...request,
      sourcePath: createLocalProviderPath(join(root, 'missing.txt')),
    });
    await waitFor(engine, failed, 'failed');
    const review = engine.enqueue(request);
    await waitFor(engine, review, 'requiring-review');
    const blockedSource = new LocalProvider({ rootPath: root });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(blockedSource, 'connect').mockImplementation(() => blocked);
    const running = engine.enqueue({
      ...request,
      source: blockedSource,
      destinationPath: createLocalProviderPath(join(root, 'running.txt')),
    });
    await waitFor(engine, running, 'running');
    const queued = engine.enqueue({
      ...request,
      destinationPath: createLocalProviderPath(join(root, 'queued.txt')),
    });
    const cancelled = engine.enqueue(request);
    engine.cancel(cancelled);
    const removeFile = vi.spyOn(provider, 'delete');

    try {
      engine.clearHistory();

      expect(engine.snapshots().map(({ id, state }) => ({ id, state }))).toEqual([
        { id: review, state: 'requiring-review' },
        { id: running, state: 'running' },
        { id: queued, state: 'queued' },
      ]);
      expect(journal.load().map(({ snapshot }) => snapshot.id)).toEqual([review, running, queued]);
      expect(removeFile).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('history fixture content');
    } finally {
      engine.dispose();
      release();
      await waitFor(engine, running, 'cancelled');
      await waitFor(engine, queued, 'cancelled');
    }
  });

  it('clears restored finished records while retaining unfinished work restored for review', async () => {
    const { root, journal, request, persistence, engine } = await setup();
    const completed = engine.enqueue(request);
    await waitFor(engine, completed, 'completed');
    const record = journal.load()[0];
    if (!record) throw new Error('Expected completed transfer in journal');
    engine.dispose();
    const cancelled = randomUUID();
    const failed = randomUUID();
    journal.save([
      record,
      { ...record, snapshot: { ...record.snapshot, id: cancelled, state: 'cancelled' } },
      { ...record, snapshot: { ...record.snapshot, id: failed, state: 'failed' } },
    ]);
    const reopened = new TransferEngine(persistence);
    engines.push(reopened);
    const removeFile = vi.spyOn(request.destination, 'delete');

    reopened.clearHistory();

    expect(reopened.snapshots()).toEqual([
      expect.objectContaining({ id: failed, state: 'requiring-review', reviewReason: 'restart' }),
    ]);
    expect(journal.load().map(({ snapshot }) => snapshot.id)).toEqual([failed]);
    expect(removeFile).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('history fixture content');
  });
});
