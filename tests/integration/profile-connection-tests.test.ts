import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { fixtureProfile } from './sftp-harness';
import { ftpFixtureProfile } from './ftp-harness';
import { minioProfile } from './s3-harness';
import type { SftpConnectionProfile } from '../../src/shared/models/connection-profile';

const setup = () => {
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  });
  const store = new ProfileStore(database, credentials);
  const service = new WorkspaceService(
    store,
    credentials,
    async () => [],
    async () => null,
  );
  return { database, store, service };
};
const reference = () => ({ id: randomUUID(), storage: 'safe-storage' as const });

describe('Saved profile connection checks against protocol fixtures', () => {
  let data: ReturnType<typeof setup>;
  beforeEach(() => {
    data = setup();
  });
  afterEach(() => {
    data.service.dispose();
    data.database.close();
  });
  const saveSftp = () => {
    const profile = data.store.save(
      { ...fixtureProfile(), authentication: { method: 'password', secret: reference() } },
      'fixture-password-only',
    );
    if (profile.kind !== 'sftp') throw new Error('SFTP profile missing.');
    return profile;
  };
  const hostChallenge = async (profile: SftpConnectionProfile) => {
    const response = await data.service.execute({ action: 'test-profile', profileId: profile.id });
    if (response.connectionTest?.status !== 'host-key-required')
      throw new Error('Expected an unknown host key.');
    expect(response.snapshot.sessions).toHaveLength(0);
    expect(data.store.getHostKey(profile.host, profile.port)).toBeUndefined();
    return response.connectionTest;
  };

  it('tests FTP credentials and the initial directory without disturbing an open panel', async () => {
    const profile = data.store.save(ftpFixtureProfile(), 'fixture-ftp-password-only');
    await data.service.execute({ action: 'connect', workspaceId: 'panel', profileId: profile.id });
    const before = data.service.snapshot();
    const result = await data.service.execute({ action: 'test-profile', profileId: profile.id });
    expect(result.connectionTest).toEqual({ status: 'success' });
    expect(result.snapshot.sessions).toEqual(before.sessions);
    expect(result.snapshot.transfers).toEqual(before.transfers);
    expect(result.listing).toBeNull();
    const missing = data.store.save(
      { ...ftpFixtureProfile(), initialDirectory: '/does-not-exist' },
      'fixture-ftp-password-only',
    );
    await expect(
      data.service.execute({ action: 'test-profile', profileId: missing.id }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    expect(data.service.snapshot().sessions).toEqual(before.sessions);
  });

  it('rejects an incorrect FTP password and succeeds after correction', async () => {
    const profile = data.store.save(ftpFixtureProfile(), 'wrong-fixture-password');
    await expect(
      data.service.execute({ action: 'test-profile', profileId: profile.id }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    data.store.save(profile, 'fixture-ftp-password-only');
    expect(
      (await data.service.execute({ action: 'test-profile', profileId: profile.id }))
        .connectionTest,
    ).toEqual({ status: 'success' });
    expect(data.service.snapshot().sessions).toHaveLength(0);
  });

  it('tests an S3 bucket/prefix and the bucket list and rejects invalid credentials', async () => {
    const profile = data.store.save(
      minioProfile({ secret: reference(), initialPrefix: 'prefix/' }),
      JSON.stringify({ secretAccessKey: 'fixture-secret-only-not-production' }),
    );
    expect(
      (await data.service.execute({ action: 'test-profile', profileId: profile.id }))
        .connectionTest,
    ).toEqual({ status: 'success' });
    const { bucket, ...rootSettings } = minioProfile({ secret: reference() });
    expect(bucket).toBe('fixture-bucket');
    const root = data.store.save(
      rootSettings,
      JSON.stringify({ secretAccessKey: 'fixture-secret-only-not-production' }),
    );
    expect(
      (await data.service.execute({ action: 'test-profile', profileId: root.id })).connectionTest,
    ).toEqual({ status: 'success' });
    data.store.save(profile, JSON.stringify({ secretAccessKey: 'wrong-fixture-secret' }));
    await expect(
      data.service.execute({ action: 'test-profile', profileId: profile.id }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(data.service.snapshot().sessions).toHaveLength(0);
  });

  it('requires explicit SSH key confirmation and then checks the initial directory', async () => {
    const profile = saveSftp();
    const challenge = await hostChallenge(profile);
    expect(challenge).toMatchObject({ host: profile.host, port: profile.port });
    const result = await data.service.execute({
      action: 'test-profile',
      profileId: profile.id,
      trustFingerprint: challenge.fingerprint,
    });
    expect(result.connectionTest).toEqual({ status: 'success' });
    expect(data.store.getHostKey(profile.host, profile.port)).toBe(challenge.fingerprint);
    expect(result.snapshot.sessions).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('fixture-password-only');
    data.store.save({ ...profile, initialDirectory: '/does-not-exist' });
    await expect(
      data.service.execute({ action: 'test-profile', profileId: profile.id }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
  });

  it('does not trust a forged fingerprint, a changed profile or a changed server key', async () => {
    const profile = saveSftp();
    const forged = `SHA256:${'A'.repeat(43)}`;
    await expect(
      data.service.execute({
        action: 'test-profile',
        profileId: profile.id,
        trustFingerprint: forged,
      }),
    ).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' });
    const challenge = await hostChallenge(profile);
    await expect(
      data.service.execute({
        action: 'test-profile',
        profileId: profile.id,
        trustFingerprint: forged,
      }),
    ).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' });
    await hostChallenge(profile);
    data.store.save({ ...profile, name: 'Changed profile' });
    await expect(
      data.service.execute({
        action: 'test-profile',
        profileId: profile.id,
        trustFingerprint: challenge.fingerprint,
      }),
    ).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' });
    expect(data.store.getHostKey(profile.host, profile.port)).toBeUndefined();
    data.store.trustHost(profile.host, profile.port, forged);
    await expect(
      data.service.execute({ action: 'test-profile', profileId: profile.id }),
    ).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' });
    expect(data.store.getHostKey(profile.host, profile.port)).toBe(forged);
    expect(data.service.snapshot().sessions).toHaveLength(0);
  });

  it('supports encrypted SSH private keys through the existing credential service', async () => {
    const profile = data.store.save(
      {
        ...fixtureProfile(),
        authentication: {
          method: 'private-key',
          privateKeyPath: resolve('tests/fixtures/runtime/id_ed25519'),
          passphrase: reference(),
        },
      },
      'fixture-passphrase-only',
    );
    if (profile.kind !== 'sftp') throw new Error('SFTP profile missing.');
    const challenge = await hostChallenge(profile);
    expect(
      (
        await data.service.execute({
          action: 'test-profile',
          profileId: profile.id,
          trustFingerprint: challenge.fingerprint,
        })
      ).connectionTest,
    ).toEqual({ status: 'success' });
    expect(data.service.snapshot().sessions).toHaveLength(0);
  });
});
