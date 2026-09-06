// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('workspace external actions', () => {
  it('opens only a validated regular file inside an available local root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'openscp-external-actions-'));
    temporaryDirectories.push(rootPath);
    const filePath = join(rootPath, 'notes.txt');
    await writeFile(filePath, 'fixture');
    const database = openDatabase(':memory:');
    const credentials = new CredentialService(database, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => Buffer.from(value).toString(),
    });
    const store = new ProfileStore(database, credentials);
    const openLocalFile = vi.fn(async () => undefined);
    const openEditor = vi.fn(async () => undefined);
    const service = new WorkspaceService(
      store,
      credentials,
      async () => [{ label: rootPath, path: rootPath }],
      async () => null,
      undefined,
      undefined,
      { openEditor, openLocalFile },
    );

    await service.execute({
      action: 'open-local-file',
      workspaceId: 'workspace:left',
      path: filePath,
    });
    expect(openLocalFile).toHaveBeenCalledWith(filePath);
    const editorPath = join(rootPath, 'editor.exe');
    await service.execute({ action: 'set-editor-path', path: editorPath });
    await service.execute({ action: 'edit-file', workspaceId: 'workspace:left', path: filePath });
    expect(openEditor).toHaveBeenCalledWith(filePath, editorPath);
    await expect(
      service.execute({
        action: 'open-local-file',
        workspaceId: 'workspace:left',
        path: rootPath,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });

    service.dispose();
    database.close();
  });

  it('persists the last successful local path per pane and root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'openscp-local-history-'));
    temporaryDirectories.push(rootPath);
    const childPath = join(rootPath, 'nested');
    await mkdir(childPath);
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
        async () => [{ label: rootPath, path: rootPath }],
        async () => null,
      );
    const first = createService();
    await first.execute({
      action: 'remember-local-path',
      workspaceId: 'workspace-3:right',
      path: childPath,
    });
    await first.execute({
      action: 'remember-workspace-layout',
      layout: {
        activeWorkspaceId: 'workspace-3',
        workspaceIds: ['workspace-1', 'workspace-3'],
      },
    });
    expect(first.snapshot()).toMatchObject({
      localPathHistory: { [rootPath]: childPath },
      localPaths: { 'workspace-3:right': childPath },
      workspaceLayout: {
        activeWorkspaceId: 'workspace-3',
        workspaceIds: ['workspace-1', 'workspace-3'],
      },
    });
    first.dispose();

    const restored = createService();
    expect(restored.snapshot().localPaths).toEqual({ 'workspace-3:right': childPath });
    expect(restored.snapshot().rememberPaths).toBe(true);
    expect(restored.snapshot().workspaceLayout).toEqual({
      activeWorkspaceId: 'workspace-3',
      workspaceIds: ['workspace-1', 'workspace-3'],
    });
    await restored.execute({ action: 'set-remember-paths', enabled: false });
    expect(restored.snapshot()).toMatchObject({
      localPathHistory: {},
      localPaths: {},
      recentPaths: {},
      rememberPaths: false,
    });
    await restored.execute({
      action: 'remember-local-path',
      workspaceId: 'workspace-3:right',
      path: childPath,
    });
    expect(restored.snapshot().localPaths).toEqual({});
    restored.dispose();
    database.close();
  });

  it('keeps a prompted password transient and does not save it after a failed attempt', async () => {
    const database = openDatabase(':memory:');
    const credentials = new CredentialService(database, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => Buffer.from(value).toString(),
    });
    const store = new ProfileStore(database, credentials);
    const service = new WorkspaceService(
      store,
      credentials,
      async () => [],
      async () => null,
    );
    const saved = await service.execute({
      action: 'save-profile',
      profile: {
        id: null,
        name: 'Prompted password',
        host: '127.0.0.1',
        port: 1,
        username: 'fixture',
        authMode: 'password',
        privateKeyPath: '',
        initialDirectory: '/',
        timeout: 1000,
        keepalive: 1000,
      },
    });
    const profileId = saved.savedProfileId ?? '';
    const profile = service.snapshot().profiles.find((item) => item.id === profileId);
    if (!profile || profile.kind !== 'sftp' || profile.authentication.method !== 'password')
      throw new Error('Expected a password profile.');
    const credentialId = profile.authentication.secret.id;

    await expect(
      service.execute({ action: 'connect', workspaceId: 'workspace:left', profileId }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REQUIRED' });
    expect(service.snapshot().sessions[0]).toMatchObject({
      connectionErrorKey: 'errors.security.credentialRequired',
      passwordRequired: true,
      state: 'failed',
    });
    await expect(
      service.execute({
        action: 'provide-password',
        workspaceId: 'workspace:left',
        password: 'transient-only',
        save: true,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(() => credentials.read(credentialId)).toThrow('errors.security.credentialRequired');
    expect(service.snapshot().sessions[0]?.passwordRequired).toBe(false);

    service.dispose();
    database.close();
  });
});
