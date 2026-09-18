// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { workspaceRequestSchema, workspaceSnapshotSchema } from '../../src/shared/ipc/workspace';
import {
  defaultTransferSettings,
  readTransferSettings,
} from '../../src/shared/models/transfer-settings';

describe('transfer settings', () => {
  it.each([0, -1, 129, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '64'])(
    'rejects invalid concurrency %s at the IPC boundary',
    (value) => {
      expect(
        workspaceRequestSchema.safeParse({
          action: 'set-transfer-settings',
          settings: { ...defaultTransferSettings, sftpUploadConcurrency: value },
        }).success,
      ).toBe(false);
    },
  );

  it('uses WinSCP defaults for old or invalid saved settings', () => {
    for (const value of [
      undefined,
      '{broken',
      '{}',
      '{"sftpUploadConcurrency":0,"sftpDownloadConcurrency":32}',
    ])
      expect(readTransferSettings(value)).toEqual({
        sftpUploadConcurrency: 64,
        sftpDownloadConcurrency: 32,
      });
  });

  it('persists settings across service recreation and includes them in validated snapshots', async () => {
    const database = openDatabase(':memory:');
    const credentials = new CredentialService(database, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => Buffer.from(value).toString(),
    });
    const store = new ProfileStore(database, credentials);
    const createService = () =>
      new WorkspaceService(
        store,
        credentials,
        async () => [],
        async () => null,
      );
    let service = createService();
    try {
      expect((await service.execute({ action: 'snapshot' })).snapshot.transferSettings).toEqual(
        defaultTransferSettings,
      );
      const settings = { sftpUploadConcurrency: 1, sftpDownloadConcurrency: 128 };
      await service.execute({ action: 'set-transfer-settings', settings });
      service.dispose();
      service = createService();
      const { snapshot } = await service.execute({ action: 'snapshot' });
      expect(workspaceSnapshotSchema.parse(snapshot).transferSettings).toEqual(settings);
    } finally {
      service.dispose();
      database.close();
    }
  });
});
