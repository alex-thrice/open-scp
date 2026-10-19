// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { workspaceRequestSchema } from '../../src/shared/ipc/workspace';
import { createYandexHarness, until, required } from '../fixtures/yandex-harness';

describe('Yandex profiles and workspace', () => {
  let harness: Awaited<ReturnType<typeof createYandexHarness>>;
  let service: WorkspaceService;
  beforeEach(async () => {
    harness = await createYandexHarness();
    service = new WorkspaceService(
      harness.store,
      harness.credentials,
      async () => [],
      async () => null,
      undefined,
      undefined,
      { yandex: harness.configuration },
    );
  });
  afterEach(async () => {
    service.dispose();
    await harness.close();
  });
  const authorize = async (profileId: string) => {
    await service.execute({ action: 'authorize-yandex-profile', profileId });
    await until(
      () =>
        service.snapshot().yandexAuthorizations?.find((entry) => entry.profileId === profileId)
          ?.state === 'authorized',
    );
  };
  it('saves and checks profiles, restores independent panel paths, and signs out without a password prompt', async () => {
    const saved = await service.execute({
      action: 'save-yandex-profile',
      profile: { id: null, name: 'Yandex test', initialDirectory: '/', timeout: 2000 },
    });
    const id = required(saved.savedProfileId);
    await expect(
      service.execute({ action: 'connect', workspaceId: 'left', profileId: id }),
    ).rejects.toMatchObject({ code: 'OAUTH_REQUIRED' });
    expect(service.snapshot().sessions[0]).toMatchObject({
      authorizationRequired: true,
      passwordRequired: false,
    });
    await authorize(id);
    const checked = await service.execute({ action: 'test-profile', profileId: id });
    expect(checked.connectionTest?.status).toBe('success');
    await service.execute({ action: 'connect', workspaceId: 'left', profileId: id });
    await service.execute({ action: 'connect', workspaceId: 'right', profileId: id });
    await service.execute({ action: 'mkdir', workspaceId: 'left', path: '/nested' });
    await service.execute({ action: 'list', workspaceId: 'left', path: '/nested' });
    await service.execute({ action: 'list', workspaceId: 'right', path: '/' });
    await service.execute({ action: 'disconnect', workspaceId: 'left' });
    await service.execute({ action: 'connect', workspaceId: 'left', profileId: id });
    expect(
      (await service.execute({ action: 'list', workspaceId: 'left', path: null })).listing
        ?.currentPath,
    ).toBe('/nested');
    expect(
      (await service.execute({ action: 'list', workspaceId: 'right', path: null })).listing
        ?.currentPath,
    ).toBe('/');
    expect(JSON.stringify(service.snapshot())).not.toMatch(/fixture-access-|fixture-refresh-/u);
    await service.execute({ action: 'forget-yandex-authorization', profileId: id });
    expect(service.snapshot().sessions.every((entry) => entry.state === 'disconnected')).toBe(true);
    await expect(
      service.execute({ action: 'connect', workspaceId: 'left', profileId: id }),
    ).rejects.toMatchObject({ code: 'OAUTH_REQUIRED' });
  });

  it('exports and clones without OAuth credentials and rejects renderer-supplied endpoints or tokens', async () => {
    await authorize(harness.profile.id);
    const exported = exportProfiles(harness.store);
    expect(exported).not.toMatch(
      /fixture-access-|fixture-refresh-|accountId|accountName|authentication/u,
    );
    const clone = await service.execute({
      action: 'clone-profile',
      profileId: harness.profile.id,
      name: 'Copy',
    });
    expect(
      service
        .snapshot()
        .yandexAuthorizations?.find((entry) => entry.profileId === clone.savedProfileId)
        ?.authorized,
    ).toBe(false);
    expect(importProfiles(harness.store, exported)).toBe(1);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'authorize-yandex-profile',
        profileId: harness.profile.id,
        token: 'token',
      }).success,
    ).toBe(false);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'save-yandex-profile',
        profile: {
          id: null,
          name: 'Unsafe',
          initialDirectory: '/',
          timeout: 2000,
          endpoint: 'http://evil.test',
        },
      }).success,
    ).toBe(false);
  });
});
