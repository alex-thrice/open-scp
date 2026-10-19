// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { CredentialService } from '../../src/main/security/credential-service';
import { Diagnostics } from '../../src/main/security/diagnostics';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { workspaceRequestSchema, workspaceSnapshotSchema } from '../../src/shared/ipc/workspace';
import { startICloudFixture } from '../fixtures/icloud-harness';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceResultSchema } from '../../src/shared/ipc/workspace';

const setup = () => {
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('No credentials should be stored.');
    },
    decryptString: () => {
      throw new Error('No credentials should be read.');
    },
  });
  return { database, credentials, store: new ProfileStore(database, credentials) };
};
const draft = {
  id: null,
  name: 'Personal iCloud',
  remote: 'icloud',
  initialDirectory: '/',
  timeout: 1000,
};
describe('iCloud workspace profiles', () => {
  let fixture: Awaited<ReturnType<typeof startICloudFixture>>;
  let data: ReturnType<typeof setup>;
  let service: WorkspaceService;
  beforeEach(async () => {
    fixture = await startICloudFixture();
    data = setup();
    service = new WorkspaceService(
      data.store,
      data.credentials,
      async () => [],
      async () => null,
      undefined,
      undefined,
      {
        icloudLaunch: fixture.launch,
        rcloneAvailable: true,
        icloudRemotes: ['icloud', 'second'],
        pickRclone: async () => join(fixture.root, 'rclone.exe'),
      },
    );
  });
  afterEach(async () => {
    service.dispose();
    await fixture.close();
    data.database.close();
  });

  it('saves, tests, clones and exports only metadata without requiring an OS keyring', async () => {
    const saved = await service.execute({ action: 'save-icloud-profile', profile: draft });
    const profileId = saved.savedProfileId ?? '';
    expect(saved.snapshot.icloudRemotes).toEqual(['icloud', 'second']);
    await service.execute({ action: 'test-profile', profileId });
    expect(service.snapshot().sessions).toHaveLength(0);
    await service.execute({ action: 'clone-profile', profileId, name: 'Copy' });
    expect(data.store.list()).toHaveLength(2);
    const exported = exportProfiles(data.store);
    expect(exported).not.toMatch(/authentication|password|safe-storage|executable|configPath/u);
    const other = setup();
    try {
      expect(importProfiles(other.store, exported)).toBe(2);
      expect(other.store.list()[0]).toMatchObject({ kind: 'icloud', remote: 'icloud' });
    } finally {
      other.database.close();
    }
    expect(data.database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(0);
    expect(JSON.parse(new Diagnostics().report(service.snapshot()))).toMatchObject({
      profileCounts: { icloud: 2 },
    });
  });

  it('persists the executable path outside profiles and refreshes availability after changing it', async () => {
    const path = join(fixture.root, 'rclone.exe');
    expect((await service.execute({ action: 'pick-rclone' })).selectedPath).toBe(path);
    const saved = await service.execute({ action: 'set-rclone-path', path });
    expect(saved.snapshot).toMatchObject({
      rclonePath: path,
      rcloneAvailable: true,
      icloudRemotes: ['icloud', 'second'],
    });
    expect(data.store.getSetting('rclone-path')).toBe(path);
    await service.execute({ action: 'save-icloud-profile', profile: draft });
    expect(exportProfiles(data.store)).not.toContain(path);
    await fixture.behavior({ remotes: {} });
    expect((await service.execute({ action: 'refresh-rclone' })).snapshot).toMatchObject({
      rclonePath: path,
      rcloneAvailable: true,
      icloudRemotes: [],
    });
    expect(data.store.getSetting('rclone-path')).toBe(path);
    await fixture.behavior({ versionOutput: 'not-rclone' });
    expect((await service.execute({ action: 'refresh-rclone' })).snapshot).toMatchObject({
      rcloneAvailable: false,
      icloudRemotes: [],
    });
    await fixture.behavior({ remotes: { icloud: 'iclouddrive' } });
    expect((await service.execute({ action: 'refresh-rclone' })).snapshot).toMatchObject({
      rcloneAvailable: true,
      icloudRemotes: ['icloud'],
    });
    await fixture.behavior({ remotes: {} });
    expect(
      (await service.execute({ action: 'set-rclone-path', path: null })).snapshot,
    ).toMatchObject({ rclonePath: null, rcloneAvailable: true, icloudRemotes: [] });
    expect(data.store.list()).toHaveLength(1);
    await expect(
      service.execute({ action: 'set-rclone-path', path: 'relative/rclone.exe' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_PATH' });
    expect(data.store.getSetting('rclone-path')).toBe('');
  });

  it('configures a new account, refreshes sources and saves no Apple credentials in profiles', async () => {
    const id = randomUUID();
    const started = await service.execute({
      action: 'start-icloud-configuration',
      id,
      remote: 'new_account',
      appleId: 'workspace-canary@example.invalid',
      password: 'password-canary',
    });
    expect(started.icloudConfiguration).toMatchObject({
      status: 'question',
      kind: 'verification-code',
    });
    expect(workspaceResultSchema.safeParse(started).success).toBe(true);
    await expect(
      service.execute({ action: 'set-rclone-path', path: join(fixture.root, 'other.exe') }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect(data.store.list()).toHaveLength(0);
    const complete = await service.execute({
      action: 'continue-icloud-configuration',
      id,
      answer: '123456',
    });
    expect(complete.icloudConfiguration).toEqual({ id, status: 'complete' });
    expect(complete.snapshot.icloudRemotes).toContain('new_account');
    await service.execute({
      action: 'save-icloud-profile',
      profile: { ...draft, remote: 'new_account' },
    });
    expect(exportProfiles(data.store)).not.toMatch(/workspace-canary|password-canary|123456/u);
    expect(JSON.stringify(service.snapshot())).not.toMatch(
      /workspace-canary|password-canary|123456/u,
    );
    expect(
      workspaceRequestSchema.safeParse({
        action: 'start-icloud-configuration',
        id,
        remote: 'icloud',
        appleId: 'test@example.invalid',
        password: 'test',
        executable: 'other.exe',
      }).success,
    ).toBe(false);
  });

  it('connects both panes, runs filesystem operations and restores the last directory', async () => {
    const saved = await service.execute({ action: 'save-icloud-profile', profile: draft });
    const profileId = saved.savedProfileId ?? '';
    await service.execute({ action: 'connect', workspaceId: 'one', profileId });
    await service.execute({ action: 'connect', workspaceId: 'two', profileId });
    await service.execute({ action: 'mkdir', workspaceId: 'one', path: '/Nested' });
    const listing = await service.execute({ action: 'list', workspaceId: 'one', path: '/Nested' });
    expect(listing.listing?.currentPath).toBe('/Nested');
    expect(workspaceSnapshotSchema.safeParse(listing.snapshot).success).toBe(true);
    expect(listing.snapshot.sessions[0]).toMatchObject({
      kind: 'icloud',
      passwordRequired: false,
      state: 'connected',
    });
    await service.execute({ action: 'disconnect', workspaceId: 'one' });
    expect(
      service.snapshot().sessions.find((session) => session.workspaceId === 'two')?.state,
    ).toBe('connected');
    await service.execute({ action: 'connect', workspaceId: 'one', profileId });
    expect(
      (await service.execute({ action: 'list', workspaceId: 'one', path: null })).listing
        ?.currentPath,
    ).toBe('/Nested');
  });

  it('rejects command, remote and executable injection across IPC and import', () => {
    for (const remote of ['user+tag@example.invalid', 'Рабочий диск', 'profile.name', '9account'])
      expect(
        workspaceRequestSchema.safeParse({
          action: 'save-icloud-profile',
          profile: { ...draft, remote },
        }).success,
      ).toBe(true);
    for (const remote of [
      ':local:',
      'icloud:',
      '--config',
      'x,y=z',
      'x\ny',
      '../x',
      '',
      ' name',
      'name ',
      'a',
      'user!mail@example.invalid',
      'x'.repeat(321),
    ])
      expect(
        workspaceRequestSchema.safeParse({
          action: 'save-icloud-profile',
          profile: { ...draft, remote },
        }).success,
      ).toBe(false);
    for (const value of [
      { executable: 'malicious.exe' },
      { password: 'secret' },
      { configPath: '/private.conf' },
      { initialDirectory: '/../x' },
    ])
      expect(
        workspaceRequestSchema.safeParse({
          action: 'save-icloud-profile',
          profile: { ...draft, ...value },
        }).success,
      ).toBe(false);
    const exported = JSON.parse(exportProfiles(data.store));
    exported.profiles = [
      { kind: 'icloud', group: '', profile: { ...draft, executable: 'malicious.exe' } },
    ];
    expect(() => importProfiles(data.store, JSON.stringify(exported))).toThrow();
  });
});
