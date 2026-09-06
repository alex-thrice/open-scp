import { applicationErrorCodes, getSafeApplicationError } from '@shared/errors/application-error';
import { ipcRequestChannels } from '@shared/ipc/channels';
import { ProviderError, providerErrorCodes } from '@shared/providers/provider-error';
import { describe, expect, it, vi } from 'vitest';
import {
  registerIpcHandlers,
  createIpcHandlerDependencies,
  type IpcHandlerDependencies,
  type IpcHandlerRegistrar,
} from '../../../src/main/ipc/register-ipc-handlers';

const correlationId = '00000000-0000-4000-8000-000000000001';

class FakeIpcMain implements IpcHandlerRegistrar {
  private readonly handlers = new Map<string, (request: unknown) => Promise<unknown>>();

  public readonly handle = (
    channel: string,
    handler: (request: unknown) => Promise<unknown>,
  ): void => {
    this.handlers.set(channel, handler);
  };

  public async invoke(channel: string, request: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);

    if (handler === undefined) {
      throw new Error(`No handler registered for ${channel}.`);
    }

    return handler(request);
  }
}

const registerRuntimeHandler = (
  registrar: IpcHandlerRegistrar,
  dependencies: IpcHandlerDependencies,
): void => {
  registerIpcHandlers(registrar, dependencies);
};

const createDependencies = (
  getRuntimeInfo: IpcHandlerDependencies['getRuntimeInfo'],
): IpcHandlerDependencies => ({
  getRuntimeInfo,
  listLocalDirectory: vi.fn(),
  listLocalDrives: vi.fn(),
});

describe('IPC handler registration', () => {
  it('uses cached OS drive icons and falls back without breaking drive discovery', async () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    const getDriveIcon = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error('Shell icon unavailable'))
      .mockResolvedValue('data:image/png;base64,YQ==');
    const dependencies = createIpcHandlerDependencies({
      allowMultipleDrives: false,
      localInitialPath: root,
      localRootPath: root,
      getDriveIcon,
    });
    expect(await dependencies.listLocalDrives()).toEqual([{ label: root, path: root }]);
    expect(await dependencies.listLocalDrives()).toEqual([
      { label: root, path: root, icon: 'data:image/png;base64,YQ==' },
    ]);
    await dependencies.listLocalDrives();
    expect(getDriveIcon).toHaveBeenCalledTimes(2);
  });
  it('validates the drive channel payload and response', async () => {
    const registrar = new FakeIpcMain();
    const drives = [
      { label: 'C:\\', path: 'C:\\' },
      { label: 'D:\\', path: 'D:\\' },
    ];
    const listLocalDrives = vi.fn(() => drives);
    registerIpcHandlers(registrar, { ...createDependencies(vi.fn()), listLocalDrives });

    await expect(
      registrar.invoke(ipcRequestChannels.listLocalDrives, { correlationId, payload: {} }),
    ).resolves.toEqual({ correlationId, data: drives, ok: true });
    await expect(
      registrar.invoke(ipcRequestChannels.listLocalDrives, {
        correlationId,
        payload: { path: 'D:\\' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: applicationErrorCodes.invalidIpcPayload },
    });
    expect(listLocalDrives).toHaveBeenCalledOnce();
    listLocalDrives.mockReturnValue([{ label: '', path: '' }]);
    await expect(
      registrar.invoke(ipcRequestChannels.listLocalDrives, { correlationId, payload: {} }),
    ).resolves.toMatchObject({ ok: false, error: { code: applicationErrorCodes.internalError } });
  });

  it('registers and serves only the declared request channel', async () => {
    const registrar = new FakeIpcMain();
    const getRuntimeInfo = vi.fn(() => ({
      platform: 'win32' as const,
      runtime: 'electron' as const,
    }));
    registerRuntimeHandler(registrar, createDependencies(getRuntimeInfo));

    await expect(
      registrar.invoke(ipcRequestChannels.getRuntimeInfo, {
        correlationId,
        payload: {},
      }),
    ).resolves.toEqual({
      correlationId,
      data: { platform: 'win32', runtime: 'electron' },
      ok: true,
    });
    await expect(registrar.invoke('app:unknown', {})).rejects.toThrow(
      'No handler registered for app:unknown.',
    );
    expect(getRuntimeInfo).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid payload before business logic runs', async () => {
    const registrar = new FakeIpcMain();
    const getRuntimeInfo = vi.fn(() => ({
      platform: 'win32' as const,
      runtime: 'electron' as const,
    }));
    registerRuntimeHandler(registrar, createDependencies(getRuntimeInfo));

    await expect(
      registrar.invoke(ipcRequestChannels.getRuntimeInfo, {
        correlationId,
        payload: { unexpected: true },
      }),
    ).resolves.toEqual({
      correlationId,
      error: getSafeApplicationError(applicationErrorCodes.invalidIpcPayload),
      ok: false,
    });
    expect(getRuntimeInfo).not.toHaveBeenCalled();
  });

  it('does not serialize internal messages, paths, or stack traces', async () => {
    const registrar = new FakeIpcMain();
    const getRuntimeInfo = vi.fn(() => {
      throw new Error('Cannot open C:\\Users\\private-user\\credentials.json.');
    });
    registerRuntimeHandler(registrar, createDependencies(getRuntimeInfo));

    const response = await registrar.invoke(ipcRequestChannels.getRuntimeInfo, {
      correlationId,
      payload: {},
    });
    const serializedResponse = JSON.stringify(response);

    expect(response).toEqual({
      correlationId,
      error: getSafeApplicationError(applicationErrorCodes.internalError),
      ok: false,
    });
    expect(serializedResponse).not.toContain('private-user');
    expect(serializedResponse).not.toContain('credentials.json');
    expect(serializedResponse).not.toContain('stack');
    expect(serializedResponse).not.toContain('Cannot open');
  });

  it('validates and serves the fixed local-directory channel', async () => {
    const registrar = new FakeIpcMain();
    const listLocalDirectory = vi.fn(() => ({
      breadcrumbs: [{ label: 'test', path: 'C:\\Users\\test' }],
      currentPath: 'C:\\Users\\test',
      entries: [
        {
          kind: 'file' as const,
          modifiedAt: '2026-08-30T12:00:00.000Z',
          name: 'notes.txt',
          path: 'C:\\Users\\test\\notes.txt',
          size: 42n,
        },
      ],
      parentPath: null,
    }));
    registerIpcHandlers(registrar, {
      getRuntimeInfo: vi.fn(),
      listLocalDirectory,
      listLocalDrives: vi.fn(),
    });

    await expect(
      registrar.invoke(ipcRequestChannels.listLocalDirectory, {
        correlationId,
        payload: { path: null },
      }),
    ).resolves.toEqual({
      correlationId,
      data: {
        breadcrumbs: [{ label: 'test', path: 'C:\\Users\\test' }],
        currentPath: 'C:\\Users\\test',
        entries: [
          {
            kind: 'file',
            modifiedAt: '2026-08-30T12:00:00.000Z',
            name: 'notes.txt',
            path: 'C:\\Users\\test\\notes.txt',
            size: 42n,
          },
        ],
        parentPath: null,
      },
      ok: true,
    });
    expect(listLocalDirectory).toHaveBeenCalledWith({ path: null });
  });

  it('returns a safe provider error without exposing the local path', async () => {
    const registrar = new FakeIpcMain();
    registerIpcHandlers(registrar, {
      getRuntimeInfo: vi.fn(),
      listLocalDrives: vi.fn(),
      listLocalDirectory: vi.fn(() => {
        throw new ProviderError(
          providerErrorCodes.accessDenied,
          { operation: 'list', provider: 'local' },
          { cause: new Error('Access denied for C:\\Users\\private-user.') },
        );
      }),
    });

    const response = await registrar.invoke(ipcRequestChannels.listLocalDirectory, {
      correlationId,
      payload: { path: 'C:\\Users\\private-user' },
    });

    expect(response).toEqual({
      correlationId,
      error: getSafeApplicationError(applicationErrorCodes.providerAccessDenied),
      ok: false,
    });
    expect(JSON.stringify(response)).not.toContain('private-user');
  });
});
