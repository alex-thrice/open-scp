import { describe, expect, it, vi } from 'vitest';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../../../src/main/ipc/application-error';
import { createLocalDirectoryWatchHandler } from '../../../src/main/ipc/local-directory-watch-handler';

const correlationId = '00000000-0000-4000-8000-000000000001';
const request = (path: string | null, subscriptionId = 'left') => ({
  correlationId,
  payload: { subscriptionId, path },
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const createFixture = () => {
  const listeners: (() => void)[] = [];
  const unsubscribes: ReturnType<typeof vi.fn>[] = [];
  const options = {
    isAllowed: vi.fn(() => true),
    validateDirectory: vi.fn<(path: string) => Promise<unknown>>(async () => undefined),
    subscribe: vi.fn((_path: string, listener: () => void) => {
      const unsubscribe = vi.fn();
      listeners.push(listener);
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    }),
    sendChanged: vi.fn(),
  };
  return { ...createLocalDirectoryWatchHandler(options), options, listeners, unsubscribes };
};

describe('local directory watch IPC handler', () => {
  it('validates the directory, sends scoped events and unsubscribes', async () => {
    const fixture = createFixture();
    expect(await fixture.handle(request('/files'))).toEqual({
      correlationId,
      ok: true,
      data: null,
    });
    expect(fixture.options.validateDirectory).toHaveBeenCalledWith('/files');
    expect(fixture.options.subscribe).toHaveBeenCalledWith('/files', expect.any(Function));
    fixture.listeners[0]?.();
    expect(fixture.options.sendChanged).toHaveBeenCalledWith({
      correlationId: expect.any(String),
      payload: { subscriptionId: 'left', path: '/files' },
    });
    await fixture.handle(request(null));
    expect(fixture.unsubscribes[0]).toHaveBeenCalledOnce();
    fixture.listeners[0]?.();
    expect(fixture.options.sendChanged).toHaveBeenCalledOnce();
    fixture.dispose();
    expect(fixture.unsubscribes[0]).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { correlationId: 'invalid', payload: { subscriptionId: 'left', path: '/files' } },
    request('/files', ''),
    request('/files', 'x'.repeat(129)),
    request(''),
    request('x'.repeat(32_769)),
    { ...request('/files'), unexpected: true },
    { correlationId, payload: { subscriptionId: 'left', path: '/files', recursive: true } },
  ])('rejects a malformed request without touching the filesystem: %j', async (value) => {
    const fixture = createFixture();
    expect(await fixture.handle(value)).toMatchObject({
      ok: false,
      error: { code: applicationErrorCodes.invalidIpcPayload },
    });
    expect(fixture.options.validateDirectory).not.toHaveBeenCalled();
    expect(fixture.options.subscribe).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized sender before filesystem access', async () => {
    const fixture = createFixture();
    fixture.options.isAllowed.mockReturnValue(false);
    expect(await fixture.handle(request('/files'))).toMatchObject({
      ok: false,
      error: { code: applicationErrorCodes.invalidIpcPayload },
    });
    expect(fixture.options.validateDirectory).not.toHaveBeenCalled();
  });

  it('retains the existing subscription if validation of a replacement fails', async () => {
    const fixture = createFixture();
    await fixture.handle(request('/files'));
    fixture.options.validateDirectory.mockRejectedValueOnce(
      new ApplicationError(applicationErrorCodes.providerAccessDenied),
    );
    expect(await fixture.handle(request('/forbidden'))).toEqual({
      correlationId,
      ok: false,
      error: {
        code: applicationErrorCodes.providerAccessDenied,
        messageKey: 'errors.provider.accessDenied',
      },
    });
    expect(fixture.unsubscribes[0]).not.toHaveBeenCalled();
    expect(fixture.options.subscribe).toHaveBeenCalledOnce();
    fixture.listeners[0]?.();
    expect(fixture.options.sendChanged).toHaveBeenCalledOnce();
    fixture.dispose();
  });

  it('replaces subscriptions without letting old callbacks notify the renderer', async () => {
    const fixture = createFixture();
    await fixture.handle(request('/first'));
    await fixture.handle(request('/second'));
    expect(fixture.unsubscribes[0]).toHaveBeenCalledOnce();
    fixture.listeners[0]?.();
    expect(fixture.options.sendChanged).not.toHaveBeenCalled();
    fixture.listeners[1]?.();
    expect(fixture.options.sendChanged).toHaveBeenCalledWith({
      correlationId: expect.any(String),
      payload: { subscriptionId: 'left', path: '/second' },
    });
    fixture.dispose();
  });

  it('does not create a late subscription after unsubscribe', async () => {
    const fixture = createFixture();
    const validation = deferred();
    fixture.options.validateDirectory.mockReturnValueOnce(validation.promise);
    const response = fixture.handle(request('/files'));
    await fixture.handle(request(null));
    validation.resolve();
    expect(await response).toMatchObject({ ok: true });
    expect(fixture.options.subscribe).not.toHaveBeenCalled();
  });

  it('keeps only the latest request when validations finish out of order', async () => {
    const fixture = createFixture();
    const first = deferred();
    fixture.options.validateDirectory.mockReturnValueOnce(first.promise);
    const response = fixture.handle(request('/first'));
    await fixture.handle(request('/second'));
    first.resolve();
    await response;
    expect(fixture.options.subscribe).toHaveBeenCalledOnce();
    expect(fixture.options.subscribe).toHaveBeenCalledWith('/second', expect.any(Function));
    fixture.dispose();
  });

  it('cleans up active subscriptions and cancels pending validation on disposal', async () => {
    const fixture = createFixture();
    await fixture.handle(request('/first'));
    const validation = deferred();
    fixture.options.validateDirectory.mockReturnValueOnce(validation.promise);
    const response = fixture.handle(request('/second', 'right'));
    fixture.dispose();
    fixture.dispose();
    validation.resolve();
    await response;
    expect(fixture.options.subscribe).toHaveBeenCalledOnce();
    expect(fixture.unsubscribes[0]).toHaveBeenCalledOnce();
    fixture.listeners[0]?.();
    expect(fixture.options.sendChanged).not.toHaveBeenCalled();
    expect(await fixture.handle(request('/third'))).toMatchObject({ ok: false });
  });

  it('checks authorization again after asynchronous validation', async () => {
    const fixture = createFixture();
    const validation = deferred();
    fixture.options.validateDirectory.mockReturnValueOnce(validation.promise);
    const response = fixture.handle(request('/files'));
    fixture.options.isAllowed.mockReturnValue(false);
    validation.resolve();
    expect(await response).toMatchObject({
      ok: false,
      error: { code: applicationErrorCodes.invalidIpcPayload },
    });
    expect(fixture.options.subscribe).not.toHaveBeenCalled();
  });
});
