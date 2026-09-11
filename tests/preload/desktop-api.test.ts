import { ipcEventChannels, ipcRequestChannels } from '@shared/ipc/channels';
import type {
  AppReadyEvent,
  ApplicationMenuCommandEvent,
  IpcEventEnvelope,
} from '@shared/ipc/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopApi, type PreloadIpcBridge } from '../../src/preload/desktop-api';

const correlationId = '00000000-0000-4000-8000-000000000001';

describe('preload desktop API', () => {
  it('starts native drags through a fixed channel and validates the acknowledgement', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({ correlationId, ok: true, data: null }));
    const desktopApi = createDesktopApi(
      { invoke, subscribe: vi.fn(() => () => undefined) },
      () => correlationId,
    );
    const request = { source: 'local' as const, paths: ['C:\\fixture\\one.txt'] };
    expect(await desktopApi.startFileDrag?.(request)).toEqual({
      correlationId,
      ok: true,
      data: null,
    });
    expect(invoke).toHaveBeenCalledWith(ipcRequestChannels.startFileDrag, {
      correlationId,
      payload: request,
    });
    invoke.mockResolvedValue({ correlationId, ok: true, data: { path: 'unexpected' } });
    expect(await desktopApi.startFileDrag?.(request)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_IPC_RESPONSE' },
    });
    invoke.mockRejectedValue(new Error('Disconnected'));
    expect(await desktopApi.startFileDrag?.(request)).toMatchObject({
      ok: false,
      error: { code: 'IPC_UNAVAILABLE' },
    });
  });
  it('lists drives only through the fixed channel', async () => {
    const drives = [{ label: 'D:\\', path: 'D:\\' }];
    const invoke = vi.fn(async () => ({ correlationId, data: drives, ok: true }));
    const desktopApi = createDesktopApi(
      { invoke, subscribe: vi.fn(() => () => undefined) },
      () => correlationId,
    );

    await expect(desktopApi.listLocalDrives()).resolves.toEqual({
      correlationId,
      data: drives,
      ok: true,
    });
    expect(invoke).toHaveBeenCalledWith(ipcRequestChannels.listLocalDrives, {
      correlationId,
      payload: {},
    });
  });

  it('rejects malformed drive lists and handles unavailable IPC', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      correlationId,
      data: [{ label: 'Disk', path: 7 }],
      ok: true,
    }));
    const desktopApi = createDesktopApi(
      { invoke, subscribe: vi.fn(() => () => undefined) },
      () => correlationId,
    );

    expect(await desktopApi.listLocalDrives()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_IPC_RESPONSE' },
    });
    invoke.mockRejectedValue(new Error('Disconnected'));
    expect(await desktopApi.listLocalDrives()).toMatchObject({
      ok: false,
      error: { code: 'IPC_UNAVAILABLE' },
    });
  });

  it('invokes only the fixed runtime-info channel', async () => {
    const invoke = vi.fn(async () => ({
      correlationId,
      data: { platform: 'win32', runtime: 'electron' },
      ok: true,
    }));
    const bridge: PreloadIpcBridge = {
      invoke,
      subscribe: vi.fn(() => () => undefined),
    };
    const desktopApi = createDesktopApi(bridge, () => correlationId);

    await expect(desktopApi.getRuntimeInfo()).resolves.toEqual({
      correlationId,
      data: { platform: 'win32', runtime: 'electron' },
      ok: true,
    });
    expect(invoke).toHaveBeenCalledWith(ipcRequestChannels.getRuntimeInfo, {
      correlationId,
      payload: {},
    });
    expect('invoke' in desktopApi).toBe(false);
    expect(Object.isFrozen(desktopApi)).toBe(true);
  });

  it('lists a local directory through a fixed channel and validates the response', async () => {
    const listing = {
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
    };
    const invoke = vi.fn(async () => ({ correlationId, data: listing, ok: true }));
    const desktopApi = createDesktopApi(
      { invoke, subscribe: vi.fn(() => () => undefined) },
      () => correlationId,
    );

    await expect(desktopApi.listLocalDirectory('C:\\Users\\test')).resolves.toEqual({
      correlationId,
      data: listing,
      ok: true,
    });
    expect(invoke).toHaveBeenCalledWith(ipcRequestChannels.listLocalDirectory, {
      correlationId,
      payload: { path: 'C:\\Users\\test' },
    });
  });

  it('rejects a malformed local-directory response at the preload boundary', async () => {
    const invoke = vi.fn(async () => ({
      correlationId,
      data: {
        breadcrumbs: [],
        currentPath: 'C:\\Users\\test',
        entries: [{ kind: 'file', name: 'notes.txt', path: 'notes.txt', size: 42 }],
        parentPath: null,
      },
      ok: true,
    }));
    const desktopApi = createDesktopApi(
      { invoke, subscribe: vi.fn(() => () => undefined) },
      () => correlationId,
    );

    await expect(desktopApi.listLocalDirectory(null)).resolves.toEqual({
      correlationId,
      error: {
        code: 'INVALID_IPC_RESPONSE',
        messageKey: 'errors.ipc.invalidResponse',
      },
      ok: false,
    });
  });

  it('exposes a fixed event subscription and filters malformed events', () => {
    let eventListener: ((payload: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge: PreloadIpcBridge = {
      invoke: vi.fn(),
      subscribe: vi.fn((channel, listener) => {
        expect(channel).toBe(ipcEventChannels.appReady);
        eventListener = listener;
        return unsubscribe;
      }),
    };
    const desktopApi = createDesktopApi(bridge, () => correlationId);
    const listener = vi.fn<(event: IpcEventEnvelope<AppReadyEvent>) => void>();
    const removeListener = desktopApi.onAppReady(listener);

    eventListener?.({ correlationId, payload: { occurredAt: 7 } });
    expect(listener).not.toHaveBeenCalled();

    const event = {
      correlationId,
      payload: { occurredAt: '2026-08-30T12:00:00.000Z' },
    };
    eventListener?.(event);
    expect(listener).toHaveBeenCalledWith(event);

    removeListener();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('accepts only known application menu commands', () => {
    let eventListener: ((payload: unknown) => void) | undefined;
    const bridge: PreloadIpcBridge = {
      invoke: vi.fn(),
      subscribe: vi.fn((channel, listener) => {
        expect(channel).toBe(ipcEventChannels.applicationMenuCommand);
        eventListener = listener;
        return () => undefined;
      }),
    };
    const desktopApi = createDesktopApi(bridge, () => correlationId);
    const listener = vi.fn<(event: IpcEventEnvelope<ApplicationMenuCommandEvent>) => void>();
    desktopApi.onApplicationMenuCommand(listener);

    eventListener?.({ correlationId, payload: { command: 'execute-arbitrary-command' } });
    expect(listener).not.toHaveBeenCalled();
    const event = { correlationId, payload: { command: 'settings' } } as const;
    eventListener?.(event);
    expect(listener).toHaveBeenCalledWith(event);
  });
});
