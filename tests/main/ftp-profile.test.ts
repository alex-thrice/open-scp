// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import { Diagnostics } from '../../src/main/security/diagnostics';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { workspaceRequestSchema } from '../../src/shared/ipc/workspace';

const setup = () => {
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  });
  const store = new ProfileStore(database, credentials);
  return { database, credentials, store };
};

describe('FTP profiles', () => {
  it('persists the password only in secure storage and keeps it when metadata is edited', async () => {
    const { database, credentials, store } = setup();
    const service = new WorkspaceService(
      store,
      credentials,
      async () => [],
      async () => null,
    );
    const created = await service.execute({
      action: 'save-ftp-profile',
      profile: {
        id: null,
        name: 'Legacy server',
        host: 'ftp.example.test',
        port: 21,
        username: 'fixture',
        initialDirectory: '/incoming',
        timeout: 20000,
      },
      password: 'ftp-password-canary',
    });
    const saved = created.snapshot.profiles.find((item) => item.id === created.savedProfileId);
    if (saved?.kind !== 'ftp') throw new Error('FTP profile was not saved.');
    expect(credentials.read(saved.authentication.secret.id)).toBe('ftp-password-canary');
    expect(JSON.stringify(created.snapshot)).not.toContain('ftp-password-canary');
    const credentialRow = database.prepare('SELECT ciphertext FROM credentials').get() as {
      ciphertext: Uint8Array;
    };
    expect(Buffer.from(credentialRow.ciphertext).includes(Buffer.from('ftp-password-canary'))).toBe(
      false,
    );
    const updated = await service.execute({
      action: 'save-ftp-profile',
      profile: {
        id: saved.id,
        name: 'Renamed legacy server',
        host: saved.host,
        port: saved.port,
        username: saved.username,
        initialDirectory: saved.initialDirectory ?? '/',
        timeout: saved.timeout ?? 20000,
      },
    });
    const updatedProfile = updated.snapshot.profiles.find((item) => item.id === saved.id);
    expect(updatedProfile?.name).toBe('Renamed legacy server');
    expect(credentials.read(saved.authentication.secret.id)).toBe('ftp-password-canary');
    expect(database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(1);
    service.dispose();
    database.close();
  });

  it('exports and imports FTP metadata without credentials and counts FTP in diagnostics', () => {
    const source = setup();
    const id = randomUUID();
    source.store.save(
      {
        id,
        name: 'FTP archive fixture',
        kind: 'ftp',
        host: 'archive.example.test',
        port: 2121,
        username: 'archive-user',
        initialDirectory: '/archive',
        timeout: 10000,
        authentication: {
          method: 'password',
          secret: { id: randomUUID(), storage: 'safe-storage' },
        },
      },
      'archive-password-canary',
    );
    const archive = exportProfiles(source.store);
    expect(archive).not.toMatch(/archive-password-canary|safe-storage/iu);
    const target = setup();
    expect(importProfiles(target.store, archive)).toBe(1);
    const imported = target.store.list()[0];
    expect(imported).toMatchObject({
      kind: 'ftp',
      host: 'archive.example.test',
      port: 2121,
      initialDirectory: '/archive',
    });
    expect(target.database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(
      0,
    );
    const report = new Diagnostics().report({
      profiles: [...target.store.list()],
      sessions: [],
      transfers: [],
      language: 'en',
    });
    expect(JSON.parse(report)).toMatchObject({ profileCounts: { ftp: 1, s3: 0, sftp: 0 } });
    expect(report).not.toContain('archive.example.test');
    source.database.close();
    target.database.close();
  });

  it('validates FTP fields and rejects control-channel injection at IPC', () => {
    const valid = {
      action: 'save-ftp-profile',
      profile: {
        id: null,
        name: 'Fixture',
        host: '127.0.0.1',
        port: 21,
        username: 'fixture',
        initialDirectory: '/',
        timeout: 20000,
      },
    } as const;
    expect(workspaceRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      workspaceRequestSchema.safeParse({
        ...valid,
        profile: { ...valid.profile, host: 'host\r\nDELE /data' },
      }).success,
    ).toBe(false);
    expect(
      workspaceRequestSchema.safeParse({
        ...valid,
        profile: { ...valid.profile, initialDirectory: 'relative' },
      }).success,
    ).toBe(false);
  });
});
