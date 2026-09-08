// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine, type TransferRequest } from '../../src/main/transfers/transfer-engine';
import { QueueJournal, type QueueRecord } from '../../src/main/transfers/queue-journal';
import { classifyTransferError, reconnectDelay } from '../../src/main/transfers/reconnect-policy';
import { createLocalProviderPath } from '../../src/shared/models/provider-path';
import { ApplicationError } from '../../src/main/ipc/application-error';
import { applicationErrorCodes } from '../../src/shared/errors/application-error';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';

describe('durable queue and finite reconnect', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-queue-test-'));
    roots.push(root);
    const provider = new LocalProvider({ rootPath: root });
    await provider.connect();
    await writeFile(join(root, 'source.txt'), 'queue fixture content');
    const request: TransferRequest = {
      source: provider,
      destination: provider,
      sourcePath: createLocalProviderPath(join(root, 'source.txt')),
      destinationPath: createLocalProviderPath(join(root, 'target.txt')),
      workspaceId: 'workspace-1',
      direction: 'upload',
      conflictPolicy: 'ask',
    };
    return { root, provider, request };
  };
  it('persists only intents, restores unfinished work for review and restarts only on request', async () => {
    const { request, root } = await setup();
    const database = openDatabase(':memory:');
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
    const original: QueueRecord = {
      intent: { sourcePath: request.sourcePath, destinationPath: request.destinationPath },
      snapshot: {
        id: randomUUID(),
        workspaceId: 'workspace-1',
        sourcePath: join(root, 'source.txt'),
        destinationPath: join(root, 'target.txt'),
        direction: 'upload',
        state: 'running',
        conflictPolicy: 'overwrite',
        transferredBytes: 8n,
        totalBytes: 21n,
        speed: 2,
        elapsed: 4,
        remaining: 2,
        errorKey: null,
        conflictPath: null,
      },
    };
    journal.save([original]);
    const resolve = vi.fn(async () => request);
    const engine = new TransferEngine({
      load: () => journal.load(),
      save: (records) => journal.save(records),
      resolve,
    });
    expect(engine.snapshots()[0]).toMatchObject({
      state: 'requiring-review',
      reviewReason: 'restart',
      conflictPolicy: 'ask',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(engine.hasActive('workspace-1')).toBe(false);
    await expect(readFile(join(root, 'target.txt'))).rejects.toThrow();
    await Promise.all([
      engine.retry(original.snapshot.id, false),
      engine.retry(original.snapshot.id, false),
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(engine.snapshots()[0]?.state).toBe('completed'));
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('queue fixture content');
    expect(journal.load()[0]?.snapshot.state).toBe('completed');
    expect(JSON.stringify(journal.load()[0]?.intent)).not.toMatch(
      /password|secret|credentials|connection/iu,
    );
    engine.clearHistory();
    expect(journal.load()).toEqual([]);
    engine.dispose();
    journal.save([original]);
    let finishResolution: (request: TransferRequest) => void = () => undefined;
    const pending = new Promise<TransferRequest>((resolve) => {
      finishResolution = resolve;
    });
    const cancelled = new TransferEngine({
      load: () => journal.load(),
      save: (records) => journal.save(records),
      resolve: () => pending,
    });
    const restarting = cancelled.retry(original.snapshot.id, false);
    cancelled.cancel(original.snapshot.id);
    finishResolution(request);
    await restarting;
    expect(cancelled.snapshots()[0]?.state).toBe('cancelled');
    expect(cancelled.hasActive('workspace-1')).toBe(false);
    cancelled.dispose();
    database.close();
  });
  it('does not retry an ambiguous final rename and checks for conflict on explicit restart', async () => {
    const { request, provider, root } = await setup();
    const original = provider.rename.bind(provider);
    const rename = vi.spyOn(provider, 'rename').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new ApplicationError(applicationErrorCodes.providerIoError);
    });
    const engine = new TransferEngine();
    const id = engine.enqueue(request);
    await vi.waitFor(() =>
      expect(engine.snapshots()[0]).toMatchObject({
        state: 'requiring-review',
        reviewReason: 'uncertain',
      }),
    );
    expect(rename).toHaveBeenCalledTimes(1);
    await engine.retry(id, false);
    await vi.waitFor(() =>
      expect(engine.snapshots()[0]).toMatchObject({
        state: 'requiring-review',
        conflictPath: join(root, 'target.txt'),
      }),
    );
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('queue fixture content');
    engine.cancel(id);
    engine.dispose();
  });
  it('restores a pending conflict without changing the destination before a decision', async () => {
    const { request, root } = await setup();
    await writeFile(join(root, 'target.txt'), 'existing content');
    const database = openDatabase(':memory:');
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
    const id = randomUUID();
    journal.save([
      {
        intent: { sourcePath: request.sourcePath, destinationPath: request.destinationPath },
        snapshot: {
          id,
          workspaceId: request.workspaceId,
          sourcePath: join(root, 'source.txt'),
          destinationPath: join(root, 'target.txt'),
          direction: request.direction,
          state: 'requiring-review',
          conflictPolicy: 'ask',
          transferredBytes: 0n,
          totalBytes: 21n,
          speed: 0,
          elapsed: 0,
          remaining: null,
          errorKey: null,
          conflictPath: join(root, 'target.txt'),
          conflictSourcePath: join(root, 'source.txt'),
        },
      },
    ]);
    const engine = new TransferEngine({
      load: () => journal.load(),
      save: (records) => journal.save(records),
      resolve: async () => request,
    });

    expect(engine.snapshots()[0]).toMatchObject({
      state: 'requiring-review',
      conflictPath: join(root, 'target.txt'),
    });
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('existing content');
    await engine.resolveConflict(id, 'overwrite', false);
    await vi.waitFor(() => expect(engine.snapshots()[0]?.state).toBe('completed'));
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('queue fixture content');

    engine.dispose();
    database.close();
  });
  it('starts a workspace with an empty queue and clears the previous session journal', async () => {
    const { request, root } = await setup();
    const database = openDatabase(':memory:');
    const credentials = new CredentialService(database, {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error();
      },
      decryptString: () => {
        throw new Error();
      },
    });
    const store = new ProfileStore(database, credentials);
    const journal = new QueueJournal(store);
    journal.save([
      {
        intent: { sourcePath: request.sourcePath, destinationPath: request.destinationPath },
        snapshot: {
          id: randomUUID(),
          workspaceId: request.workspaceId,
          sourcePath: join(root, 'source.txt'),
          destinationPath: join(root, 'target.txt'),
          direction: request.direction,
          state: 'completed',
          conflictPolicy: 'ask',
          transferredBytes: 21n,
          totalBytes: 21n,
          speed: 0,
          elapsed: 1,
          remaining: 0,
          errorKey: null,
          conflictPath: null,
        },
      },
    ]);

    const service = new WorkspaceService(
      store,
      credentials,
      async () => [{ label: root, path: root }],
      async () => null,
    );

    expect(service.snapshot().transfers).toEqual([]);
    expect(journal.load()).toEqual([]);
    service.dispose();
    database.close();
  });
  it('bounds transient retries, classifies authentication and conflict failures, and adds jitter', async () => {
    const { request, provider } = await setup();
    const connect = vi
      .spyOn(provider, 'connect')
      .mockRejectedValue(new ApplicationError(applicationErrorCodes.connectionFailed));
    const engine = new TransferEngine();
    engine.enqueue(request);
    await vi.waitFor(
      () =>
        expect(engine.snapshots()[0]).toMatchObject({
          state: 'failed',
          errorCategory: 'transient',
        }),
      { timeout: 3000 },
    );
    expect(connect).toHaveBeenCalledTimes(3);
    expect(
      classifyTransferError(new ApplicationError(applicationErrorCodes.authenticationFailed)),
    ).toBe('auth');
    expect(
      classifyTransferError(new ApplicationError(applicationErrorCodes.providerConflict)),
    ).toBe('conflict');
    expect(classifyTransferError(new Error('unknown SDK details'))).toBe('permanent');
    expect(reconnectDelay(2, () => 0)).toBe(750);
    expect(reconnectDelay(2, () => 1)).toBe(1250);
    expect(reconnectDelay(100, () => 1)).toBe(5000);
    engine.dispose();
  });
});
