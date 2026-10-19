// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { CredentialService } from '../../src/main/security/credential-service';
import { Diagnostics } from '../../src/main/security/diagnostics';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { workspaceRequestSchema } from '../../src/shared/ipc/workspace';
import {
  fixtureMailruPassword,
  fixtureMailruUsername,
  startWebDavFixture,
  type WebDavFixture,
} from '../fixtures/webdav-fixture';

const setup = () => {
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  });
  return { database, credentials, store: new ProfileStore(database, credentials) };
};
const draft = () => ({
  id: null,
  name: 'Mail.ru fixture',
  username: fixtureMailruUsername,
  initialDirectory: '/',
  timeout: 1000,
});

describe('Mail.ru profiles and workspace integration', () => {
  let fixture: WebDavFixture;
  let data: ReturnType<typeof setup>;
  let service: WorkspaceService;
  beforeEach(async () => {
    fixture = await startWebDavFixture();
    data = setup();
    service = new WorkspaceService(
      data.store,
      data.credentials,
      async () => [],
      async () => null,
      undefined,
      undefined,
      { mailruEndpoint: fixture.endpoint },
    );
  });
  afterEach(async () => {
    service.dispose();
    data.database.close();
    await fixture.close();
  });

  it('encrypts, preserves, replaces, duplicates and deletes the app password', async () => {
    const saved = await service.execute({
      action: 'save-mailru-profile',
      profile: draft(),
      password: 'mailru-password-canary',
    });
    const profile = saved.snapshot.profiles[0];
    if (profile?.kind !== 'mailru') throw new Error('Mail.ru profile missing.');
    expect(data.credentials.read(profile.authentication.secret.id)).toBe('mailru-password-canary');
    expect(JSON.stringify(saved.snapshot)).not.toContain('mailru-password-canary');
    const row = data.database.prepare('SELECT ciphertext FROM credentials').get();
    expect(
      Buffer.from(row?.ciphertext as Uint8Array).includes(Buffer.from('mailru-password-canary')),
    ).toBe(false);
    await service.execute({
      action: 'save-mailru-profile',
      profile: { ...draft(), id: profile.id, name: 'Edited cloud' },
    });
    expect(data.credentials.read(profile.authentication.secret.id)).toBe('mailru-password-canary');
    const cloned = await service.execute({
      action: 'clone-profile',
      profileId: profile.id,
      name: 'Copy',
    });
    const copy = cloned.snapshot.profiles.find((item) => item.id === cloned.savedProfileId);
    if (copy?.kind !== 'mailru') throw new Error('Clone missing.');
    expect(copy.authentication.secret.id).not.toBe(profile.authentication.secret.id);
    expect(data.credentials.read(copy.authentication.secret.id)).toBe('mailru-password-canary');
    data.store.replaceCredential(
      profile.id,
      profile.authentication.secret.id,
      fixtureMailruPassword,
    );
    expect(data.credentials.read(profile.authentication.secret.id)).toBe(fixtureMailruPassword);
    await service.execute({ action: 'delete-profile', profileId: profile.id });
    expect(
      data.database
        .prepare('SELECT count(*) AS count FROM credentials WHERE profile_id = ?')
        .get(profile.id)?.count,
    ).toBe(0);
  });

  it('exports and imports metadata without credentials, including diagnostics', async () => {
    await service.execute({
      action: 'save-mailru-profile',
      profile: draft(),
      password: fixtureMailruPassword,
    });
    const archive = exportProfiles(data.store);
    expect(archive).not.toMatch(/webdav-fixture-password-only|safe-storage|authentication/u);
    const other = setup();
    try {
      expect(importProfiles(other.store, archive)).toBe(1);
      expect(other.store.list()[0]).toMatchObject({
        kind: 'mailru',
        username: fixtureMailruUsername,
      });
      expect(other.database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(
        0,
      );
    } finally {
      other.database.close();
    }
    const report = new Diagnostics().report(service.snapshot());
    expect(JSON.parse(report)).toMatchObject({ profileCounts: { mailru: 1 } });
    expect(report).not.toMatch(/fixture@example|webdav-fixture|Mail.ru fixture/u);
  });

  it('prompts for a missing or incorrect app password, saves only a successful correction and restores paths', async () => {
    const created = await service.execute({ action: 'save-mailru-profile', profile: draft() });
    const profileId = created.savedProfileId ?? '';
    await expect(
      service.execute({ action: 'connect', workspaceId: 'one', profileId }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REQUIRED' });
    expect(service.snapshot().sessions[0]).toMatchObject({
      kind: 'mailru',
      passwordRequired: true,
    });
    await expect(
      service.execute({
        action: 'provide-password',
        workspaceId: 'one',
        password: 'wrong',
        save: true,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(data.database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(0);
    await service.execute({
      action: 'provide-password',
      workspaceId: 'one',
      password: fixtureMailruPassword,
      save: true,
    });
    await service.execute({ action: 'mkdir', workspaceId: 'one', path: '/nested' });
    const listed = await service.execute({ action: 'list', workspaceId: 'one', path: '/nested' });
    expect(listed.listing?.currentPath).toBe('/nested');
    await service.execute({ action: 'disconnect', workspaceId: 'one' });
    await service.execute({ action: 'connect', workspaceId: 'one', profileId });
    expect(
      (await service.execute({ action: 'list', workspaceId: 'one', path: null })).listing
        ?.currentPath,
    ).toBe('/nested');
    expect(service.snapshot().sessions[0]?.insecure).not.toBe(true);
  });

  it('allows app password correction after HTTP 403 at login but keeps file permission failures separate', async () => {
    const saved = await service.execute({
      action: 'save-mailru-profile',
      profile: draft(),
      password: fixtureMailruPassword,
    });
    fixture.overrides.set('PROPFIND /', { status: 403 });
    await expect(
      service.execute({
        action: 'connect',
        workspaceId: 'one',
        profileId: saved.savedProfileId ?? '',
      }),
    ).rejects.toMatchObject({ code: 'MAILRU_WEBDAV_ACCESS_DENIED' });
    expect(service.snapshot().sessions[0]).toMatchObject({
      state: 'failed',
      passwordRequired: true,
      connectionErrorKey: 'errors.mailru.webdavAccessDenied',
    });
    fixture.overrides.clear();
    await service.execute({
      action: 'provide-password',
      workspaceId: 'one',
      password: fixtureMailruPassword,
      save: true,
    });
    fixture.overrides.set('PROPFIND /', { status: 403 });
    await expect(
      service.execute({ action: 'list', workspaceId: 'one', path: '/' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ACCESS_DENIED' });
    expect(service.snapshot().sessions[0]).toMatchObject({
      state: 'connected',
      passwordRequired: false,
    });
  });

  it('tests a connection without creating a persistent session and isolates independent profiles', async () => {
    const first = await service.execute({
      action: 'save-mailru-profile',
      profile: draft(),
      password: fixtureMailruPassword,
    });
    const second = await service.execute({
      action: 'save-mailru-profile',
      profile: { ...draft(), name: 'Second profile' },
      password: fixtureMailruPassword,
    });
    await service.execute({ action: 'test-profile', profileId: first.savedProfileId ?? '' });
    expect(service.snapshot().sessions).toHaveLength(0);
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
    await service.execute({ action: 'disconnect', workspaceId: 'one' });
    expect(service.snapshot().sessions.find((item) => item.workspaceId === 'two')?.state).toBe(
      'connected',
    );
    expect(
      (await service.execute({ action: 'list', workspaceId: 'two', path: '/' })).listing
        ?.currentPath,
    ).toBe('/');
  });

  it('rejects endpoint/TLS injection, malformed email, traversal and changing profile kinds', async () => {
    const request = { action: 'save-mailru-profile', profile: draft() };
    expect(workspaceRequestSchema.safeParse(request).success).toBe(true);
    for (const fields of [
      { endpoint: 'https://untrusted.example' },
      { rejectUnauthorized: false },
      { username: 'invalid' },
      { initialDirectory: '/../outside' },
    ])
      expect(
        workspaceRequestSchema.safeParse({ ...request, profile: { ...draft(), ...fields } })
          .success,
      ).toBe(false);
    const id = randomUUID();
    data.store.save({ id, name: 'Existing S3', kind: 's3', forcePathStyle: false, region: 'test' });
    await expect(
      service.execute({ action: 'save-mailru-profile', profile: { ...draft(), id } }),
    ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' });
  });
});
