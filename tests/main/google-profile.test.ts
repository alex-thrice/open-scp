// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { CredentialService } from '../../src/main/security/credential-service';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { workspaceRequestSchema, workspaceSnapshotSchema } from '../../src/shared/ipc/workspace';
import { startGoogleFixture } from '../fixtures/google-fixture';

const setup = () => {
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('Unexpected credential encryption.');
    },
    decryptString: () => {
      throw new Error('Unexpected credential decryption.');
    },
  });
  return { database, credentials, store: new ProfileStore(database, credentials) };
};
const draft = {
  id: null,
  name: 'Personal Google',
  remote: 'google',
  initialDirectory: '/',
  timeout: 3000,
};

describe('Google rclone workspace profiles', () => {
  let fixture: Awaited<ReturnType<typeof startGoogleFixture>>;
  let data: ReturnType<typeof setup>;
  let service: WorkspaceService;
  beforeEach(async () => {
    fixture = await startGoogleFixture();
    data = setup();
    service = new WorkspaceService(
      data.store,
      data.credentials,
      async () => [],
      async () => null,
      undefined,
      undefined,
      { googleLaunch: fixture.launch, icloudLaunch: fixture.launch },
    );
  });
  afterEach(async () => {
    service.dispose();
    await fixture.close();
    data.database.close();
  });

  it('discovers backend types independently and saves/clones/exports Google without OAuth secrets', async () => {
    const refreshed = await service.execute({ action: 'refresh-rclone' });
    expect(refreshed.snapshot).toMatchObject({
      rcloneAvailable: true,
      googleRemotes: ['google', 'google-work'],
      icloudRemotes: ['icloud', 'second'],
    });
    const saved = await service.execute({ action: 'save-google-profile', profile: draft });
    const profileId = saved.savedProfileId ?? '';
    expect((await service.execute({ action: 'test-profile', profileId })).connectionTest).toEqual({
      status: 'success',
    });
    await service.execute({ action: 'clone-profile', profileId, name: 'Second view' });
    const archive = exportProfiles(data.store);
    expect(archive).not.toMatch(/authentication|accountId|accountName|token|safe-storage/u);
    const imported = setup();
    try {
      expect(importProfiles(imported.store, archive)).toBe(2);
      expect(imported.store.list()[0]).toMatchObject({ kind: 'google', remote: 'google' });
    } finally {
      imported.database.close();
    }
    expect(data.database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(0);
    expect(workspaceSnapshotSchema.safeParse(service.snapshot()).success).toBe(true);
  });

  it('uses absolute paths and prevents copying a folder inside itself through two profiles of the same remote', async () => {
    const first = await service.execute({ action: 'save-google-profile', profile: draft });
    const second = await service.execute({
      action: 'save-google-profile',
      profile: { ...draft, name: 'Same remote' },
    });
    await service.execute({
      action: 'connect',
      workspaceId: 'one',
      profileId: first.savedProfileId ?? '',
    });
    await service.execute({
      action: 'connect',
      workspaceId: 'two',
      profileId: second.savedProfileId ?? '',
    });
    await service.execute({ action: 'mkdir', workspaceId: 'one', path: '/Nested' });
    const listed = await service.execute({ action: 'list', workspaceId: 'one', path: '/Nested' });
    expect(listed.listing).toMatchObject({ currentPath: '/Nested', parentPath: '/' });
    expect(listed.snapshot.sessions[0]).toMatchObject({
      kind: 'google',
      passwordRequired: false,
      state: 'connected',
    });
    await expect(
      service.execute({
        action: 'remote-transfer',
        workspaceId: 'one',
        destinationWorkspaceId: 'two',
        sourcePath: '/Nested',
        destinationDirectory: '/Nested',
        conflictPolicy: 'ask',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  });

  it('rejects remote/path injection and retired OAuth actions at the IPC boundary', () => {
    for (const remote of [':local:', '--config', 'google:', '../google', 'x\ny'])
      expect(
        workspaceRequestSchema.safeParse({
          action: 'save-google-profile',
          profile: { ...draft, remote },
        }).success,
      ).toBe(false);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'save-google-profile',
        profile: { ...draft, initialDirectory: 'gdrive:/id~name' },
      }).success,
    ).toBe(false);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'authorize-google-profile',
        profileId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('keeps the configured rclone executable fixed while a Google profile is being tested', async () => {
    const saved = await service.execute({ action: 'save-google-profile', profile: draft });
    const pending = service.execute({
      action: 'test-profile',
      profileId: saved.savedProfileId ?? '',
    });
    await expect(service.execute({ action: 'set-rclone-path', path: null })).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
    await pending;
  });

  it('imports legacy Google archives as profiles requiring remote selection', () => {
    importProfiles(
      data.store,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            kind: 'google',
            group: '',
            profile: {
              id: null,
              name: 'Legacy Google',
              initialDirectory: 'gdrive:/folder~Docs',
              timeout: 20000,
            },
          },
        ],
      }),
    );
    expect(data.store.list()[0]).toMatchObject({ kind: 'google', initialDirectory: '/' });
    expect(data.store.list()[0]).not.toHaveProperty('remote');
    expect(data.store.list()[0]).not.toHaveProperty('authentication');
  });
});

it('migrates legacy Google profiles transactionally and removes only their OAuth credentials and paths', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE profiles (id TEXT PRIMARY KEY, metadata TEXT NOT NULL); CREATE TABLE credentials (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, ciphertext BLOB NOT NULL); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE trusted_hosts (host TEXT NOT NULL, port INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(host, port)); CREATE TABLE multipart_cleanup (upload_id TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id), bucket TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(profile_id, upload_id)); PRAGMA user_version = 3;',
  );
  const googleId = randomUUID();
  const yandexId = randomUUID();
  const googleSecret = randomUUID();
  const yandexSecret = randomUUID();
  const insert = database.prepare('INSERT INTO profiles VALUES (?, ?)');
  insert.run(
    googleId,
    JSON.stringify({
      id: googleId,
      name: 'Google profile',
      kind: 'google',
      initialDirectory: 'gdrive:/folder~Docs',
      accountId: 'old-account',
      accountName: 'old@example.invalid',
      authentication: { method: 'oauth', secret: { id: googleSecret, storage: 'safe-storage' } },
    }),
  );
  insert.run(
    yandexId,
    JSON.stringify({
      id: yandexId,
      name: 'Yandex profile',
      kind: 'yandex',
      authentication: { method: 'oauth', secret: { id: yandexSecret, storage: 'safe-storage' } },
    }),
  );
  database
    .prepare('INSERT INTO credentials VALUES (?, ?, ?)')
    .run(googleSecret, googleId, Buffer.from('google-ciphertext'));
  database
    .prepare('INSERT INTO credentials VALUES (?, ?, ?)')
    .run(yandexSecret, yandexId, Buffer.from('yandex-ciphertext'));
  database.prepare('INSERT INTO settings VALUES (?, ?)').run('recent:' + googleId, '["gdrive:/"]');
  migrateDatabase(database);
  migrateDatabase(database);
  expect(
    JSON.parse(
      String(
        database.prepare('SELECT metadata FROM profiles WHERE id = ?').get(googleId)?.metadata,
      ),
    ),
  ).toEqual({
    id: googleId,
    name: 'Google profile',
    kind: 'google',
    initialDirectory: '/',
  });
  expect(database.prepare('SELECT id FROM credentials').all()).toEqual([{ id: yandexSecret }]);
  expect(
    database.prepare('SELECT value FROM settings WHERE key = ?').get('recent:' + googleId),
  ).toBeUndefined();
  expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  database.close();
});
