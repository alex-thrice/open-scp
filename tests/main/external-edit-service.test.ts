// @vitest-environment node
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalEditService } from '../../src/main/external/external-edit-service';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { CredentialService } from '../../src/main/security/credential-service';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import { createLocalProviderPath } from '../../src/shared/models/provider-path';

describe('remote external edits', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-edit-test-'));
    roots.push(root);
    const remotePath = join(root, 'remote.txt');
    await writeFile(remotePath, 'original');
    const remote = new LocalProvider({ rootPath: root });
    await remote.connect();
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
    const transfers = new TransferEngine();
    const launchEditor = vi.fn<(path: string, configuredPath: string | null) => Promise<void>>(
      async () => undefined,
    );
    const createService = () =>
      new ExternalEditService(
        store,
        transfers,
        launchEditor,
        async () => ({
          provider: remote,
          path: createLocalProviderPath(remotePath),
          profileId: 'profile-one',
        }),
        async (path) => {
          const provider = new LocalProvider({ rootPath: dirname(path) });
          await provider.connect();
          return provider;
        },
      );
    return { createService, database, launchEditor, remotePath, transfers };
  };

  it('detects a change and requires confirmation after a concurrent remote change', async () => {
    const { createService, database, launchEditor, remotePath, transfers } = await setup();
    const service = createService();
    await service.open('workspace-1:right', remotePath);
    const temporaryPath = launchEditor.mock.calls[0]?.[0];
    expect(temporaryPath).toBeTruthy();
    await writeFile(temporaryPath ?? '', 'edited locally');
    expect(service.snapshots()[0]?.state).toBe('changed');

    const originalTimes = await stat(remotePath);
    await writeFile(remotePath, 'remotely');
    await utimes(remotePath, originalTimes.atime, originalTimes.mtime);
    const id = service.snapshots()[0]?.id ?? '';
    await service.resolve(id, 'upload');
    expect(service.snapshots()[0]?.state).toBe('conflict');
    expect(await readFile(remotePath, 'utf8')).toBe('remotely');

    await service.resolve(id, 'overwrite');
    await vi.waitFor(() => {
      service.snapshots();
      expect(transfers.snapshots()[0]?.state).toBe('completed');
      expect(service.snapshots()).toEqual([]);
    });
    expect(await readFile(remotePath, 'utf8')).toBe('edited locally');
    service.dispose();
    transfers.dispose();
    database.close();
  });

  it('recovers an unfinished edit without exposing its temporary path', async () => {
    const { createService, database, launchEditor, remotePath, transfers } = await setup();
    const first = createService();
    await first.open('workspace-1:right', remotePath);
    const temporaryPath = launchEditor.mock.calls[0]?.[0] ?? '';
    await writeFile(temporaryPath, 'recovered edit');
    first.dispose();

    const recovered = createService();
    expect(recovered.snapshots()).toMatchObject([
      {
        workspaceId: 'workspace-1:right',
        remotePath,
        state: 'recovered',
      },
    ]);
    expect(JSON.stringify(recovered.snapshots())).not.toContain(dirname(temporaryPath));
    await recovered.resolve(recovered.snapshots()[0]?.id ?? '', 'discard');
    recovered.dispose();
    transfers.dispose();
    database.close();
  });
});
