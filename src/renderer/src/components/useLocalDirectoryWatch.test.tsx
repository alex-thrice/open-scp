import { act, renderHook, waitFor } from '@testing-library/react';
import type { DesktopApi } from '@shared/desktop-api';
import type { IpcEventEnvelope, LocalDirectoryChangedEvent } from '@shared/ipc/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalDirectoryWatch } from './useLocalDirectoryWatch';

const correlationId = '00000000-0000-4000-8000-000000000001';
const originalDesktop = window.desktop;
const path = 'C:\\fixture';
type ChangeListener = (event: IpcEventEnvelope<LocalDirectoryChangedEvent>) => void;
const listeners = new Set<ChangeListener>();
const setWatch = vi.fn<DesktopApi['setLocalDirectoryWatch']>();
const notify = (subscriptionId = 'left', changedPath = path): void => {
  for (const listener of listeners)
    listener({ correlationId, payload: { subscriptionId, path: changedPath } });
};

beforeEach(() => {
  listeners.clear();
  setWatch.mockReset();
  setWatch.mockResolvedValue({ correlationId, ok: true, data: null });
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      ...originalDesktop,
      setLocalDirectoryWatch: setWatch,
      onLocalDirectoryChanged: (listener: ChangeListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies DesktopApi,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'desktop', { configurable: true, value: originalDesktop });
});

describe('local directory watch lifecycle', () => {
  it('reconciles after subscribing, filters notifications and unsubscribes', async () => {
    const refresh = vi.fn(async () => undefined);
    const { unmount } = renderHook(() =>
      useLocalDirectoryWatch({
        subscriptionId: 'left',
        path,
        isActive: true,
        paused: false,
        refresh,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    act(() => {
      notify('right');
      notify('left', 'C:\\other');
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => notify());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    unmount();
    expect(listeners.size).toBe(0);
    expect(setWatch).toHaveBeenLastCalledWith({ subscriptionId: 'left', path: null });
  });

  it('coalesces changes while a dialog is open and refreshes when it closes', async () => {
    const refresh = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ paused }) =>
        useLocalDirectoryWatch({ subscriptionId: 'left', path, isActive: true, paused, refresh }),
      { initialProps: { paused: true } },
    );
    await act(async () => undefined);
    act(() => {
      notify();
      notify();
    });
    expect(refresh).not.toHaveBeenCalled();
    rerender({ paused: false });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('allows only one read at a time and repeats after changes during the read', async () => {
    let finish: (() => void) | undefined;
    const refresh = vi.fn(async (): Promise<void> => undefined);
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    renderHook(() =>
      useLocalDirectoryWatch({
        subscriptionId: 'left',
        path,
        isActive: true,
        paused: false,
        refresh,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    act(() => {
      notify();
      notify();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('invalidates reads from a previous directory and uses the latest refresh callback', async () => {
    let isOldReadCurrent: (() => boolean) | undefined;
    const firstRefresh = vi.fn(async (isCurrent: () => boolean) => {
      isOldReadCurrent = isCurrent;
    });
    const secondRefresh = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ currentPath, refresh }) =>
        useLocalDirectoryWatch({
          subscriptionId: 'left',
          path: currentPath,
          isActive: true,
          paused: false,
          refresh,
        }),
      { initialProps: { currentPath: path, refresh: firstRefresh } },
    );
    await waitFor(() => expect(firstRefresh).toHaveBeenCalledTimes(1));
    rerender({ currentPath: 'C:\\other', refresh: secondRefresh });
    expect(isOldReadCurrent?.()).toBe(false);
    await waitFor(() => expect(secondRefresh).toHaveBeenCalledTimes(1));
    act(() => notify());
    expect(secondRefresh).toHaveBeenCalledTimes(1);
    act(() => notify('left', 'C:\\other'));
    await waitFor(() => expect(secondRefresh).toHaveBeenCalledTimes(2));
  });

  it('pauses watching hidden tabs and reconciles on activation and window focus', async () => {
    const refresh = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ isActive }) =>
        useLocalDirectoryWatch({ subscriptionId: 'left', path, isActive, paused: false, refresh }),
      { initialProps: { isActive: false } },
    );
    expect(setWatch).not.toHaveBeenCalled();
    rerender({ isActive: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await act(async () => undefined);
    refresh.mockClear();
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(setWatch).toHaveBeenLastCalledWith({ subscriptionId: 'left', path });
    rerender({ isActive: false });
    expect(listeners.size).toBe(0);
    refresh.mockClear();
    act(() => notify());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reconciles a directory that disappeared before watch registration', async () => {
    setWatch.mockResolvedValue({
      correlationId,
      ok: false,
      error: { code: 'PROVIDER_NOT_FOUND', messageKey: 'errors.provider.notFound' },
    });
    const refresh = vi.fn(async () => undefined);
    renderHook(() =>
      useLocalDirectoryWatch({
        subscriptionId: 'left',
        path,
        isActive: true,
        paused: false,
        refresh,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('defers applying an in-flight read if an operation opens before it finishes', async () => {
    let isReadCurrent: (() => boolean) | undefined;
    let finish: (() => void) | undefined;
    const refresh = vi.fn(async (isCurrent: () => boolean) => {
      isReadCurrent = isCurrent;
    });
    refresh.mockImplementationOnce((isCurrent) => {
      isReadCurrent = isCurrent;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const { rerender } = renderHook(
      ({ paused }) =>
        useLocalDirectoryWatch({ subscriptionId: 'left', path, isActive: true, paused, refresh }),
      { initialProps: { paused: false } },
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    rerender({ paused: true });
    expect(isReadCurrent?.()).toBe(false);
    await act(async () => finish?.());
    rerender({ paused: false });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });
});
