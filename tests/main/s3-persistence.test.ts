// @vitest-environment node
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, migrateDatabase } from '../../src/main/persistence/database';
import { CredentialService } from '../../src/main/security/credential-service';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { SqliteMultipartJournal } from '../../src/main/providers/s3/multipart-journal';
import type { WorkspaceRequest } from '../../src/shared/ipc/workspace';

const setup = () => {
  const database = openDatabase(':memory:');
  const key = randomBytes(32);
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString();
    },
  });
  const store = new ProfileStore(database, credentials);
  const service = new WorkspaceService(
    store,
    credentials,
    async () => [],
    async () => null,
  );
  return { database, credentials, store, service };
};
const draft: Extract<WorkspaceRequest, { action: 'save-s3-profile' }>['profile'] = {
  id: null,
  name: 'Disposable S3',
  endpoint: 'https://minio.example.test',
  bucket: 'fixture-bucket',
  initialPrefix: 'Unicode prefix/',
  region: 'us-east-1',
  forcePathStyle: true,
  accessKeyId: 'fixture-only',
};
describe('S3 credentials and durable cleanup journal', () => {
  it('stores secret and token encrypted, keeps or clears them explicitly, and deletes both with the profile', async () => {
    const { database, service, store, credentials } = setup();
    try {
      await service.execute({
        action: 'save-s3-profile',
        profile: draft,
        secretAccessKey: 'secret-fixture-only',
        sessionToken: 'token-fixture-only',
      });
      let profile = store.list()[0];
      if (profile?.kind !== 's3' || !profile.secret) throw new Error('Missing S3 profile.');
      expect(JSON.parse(credentials.read(profile.secret.id))).toEqual({
        secretAccessKey: 'secret-fixture-only',
        sessionToken: 'token-fixture-only',
      });
      const result = service.snapshot();
      expect(JSON.stringify(result)).not.toMatch(/secret-fixture-only|token-fixture-only/u);
      const blob = database.prepare('SELECT ciphertext FROM credentials').get()?.ciphertext;
      expect(Buffer.from(blob as Uint8Array).includes(Buffer.from('token-fixture-only'))).toBe(
        false,
      );
      await service.execute({
        action: 'save-s3-profile',
        profile: { ...draft, id: profile.id, name: 'Edited' },
      });
      profile = store.list()[0];
      if (profile?.kind !== 's3' || !profile.secret) throw new Error('Missing S3 profile.');
      expect(JSON.parse(credentials.read(profile.secret.id)).sessionToken).toBe(
        'token-fixture-only',
      );
      await service.execute({
        action: 'save-s3-profile',
        profile: { ...draft, id: profile.id },
        sessionToken: '',
      });
      profile = store.list()[0];
      if (profile?.kind !== 's3' || !profile.secret) throw new Error('Missing S3 profile.');
      expect(JSON.parse(credentials.read(profile.secret.id))).toEqual({
        secretAccessKey: 'secret-fixture-only',
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM credentials').get()?.count).toBe(1);
      await service.execute({ action: 'delete-profile', profileId: profile.id });
      expect(database.prepare('SELECT COUNT(*) AS count FROM credentials').get()?.count).toBe(0);
    } finally {
      service.dispose();
      database.close();
    }
  });
  it('upgrades v2, restores cleanup records, and blocks credential deletion or endpoint changes until cleanup', async () => {
    const { database, service, store } = setup();
    try {
      database.exec('DROP TABLE multipart_cleanup; PRAGMA user_version = 2;');
      migrateDatabase(database);
      migrateDatabase(database);
      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
      await service.execute({
        action: 'save-s3-profile',
        profile: draft,
        secretAccessKey: 'fixture-only',
      });
      const profile = store.list()[0];
      if (!profile) throw new Error('Missing profile.');
      const record = {
        uploadId: 'dummy-unfinished-upload',
        bucket: 'fixture-bucket',
        key: 'prefix/incomplete',
      };
      new SqliteMultipartJournal(database, profile.id).add(record);
      const restored = new SqliteMultipartJournal(database, profile.id);
      expect(restored.list()).toEqual([record]);
      expect(service.snapshot().cleanups).toEqual([{ profileId: profile.id, count: 1 }]);
      await expect(
        service.execute({ action: 'delete-profile', profileId: profile.id }),
      ).rejects.toMatchObject({ code: 'S3_CLEANUP' });
      await expect(
        service.execute({
          action: 'save-s3-profile',
          profile: { ...draft, id: profile.id, endpoint: 'https://other.example.test' },
        }),
      ).rejects.toMatchObject({ code: 'S3_CLEANUP' });
      restored.remove(record.uploadId);
      await service.execute({ action: 'delete-profile', profileId: profile.id });
      expect(store.list()).toHaveLength(0);
    } finally {
      service.dispose();
      database.close();
    }
  });
});
