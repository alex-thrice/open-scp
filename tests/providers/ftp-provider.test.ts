// @vitest-environment node
import { FTPError, type Client } from 'basic-ftp';
import { describe, expect, it, vi } from 'vitest';
import { FtpConnection } from '../../src/main/providers/ftp/ftp-connection';
import { FtpProvider, normalizeFtpError } from '../../src/main/providers/ftp/ftp-provider';
import { createFtpProviderPath } from '../../src/shared/models/provider-path';
import type { FtpConnectionProfile } from '../../src/shared/models/connection-profile';

const profile = (): FtpConnectionProfile => ({
  id: '00000000-0000-4000-8000-000000000030',
  name: 'FTP fixture',
  kind: 'ftp',
  host: '127.0.0.1',
  port: 21,
  username: 'fixture',
  authentication: {
    method: 'password',
    secret: { id: '00000000-0000-4000-8000-000000000031', storage: 'safe-storage' },
  },
});

describe('FTP provider safety and errors', () => {
  it('does not create a protocol client after cancellation during credential retrieval', async () => {
    let complete: ((value: { password: string }) => void) | undefined;
    const credentials = new Promise<{ password: string }>((resolve) => {
      complete = resolve;
    });
    const factory = vi.fn();
    const connection = new FtpConnection(profile(), () => credentials, factory);
    const connecting = connection.connect();
    expect(connection.stage).toBe('resolving-credentials');
    connection.disconnect();
    complete?.({ password: 'fixture-only' });
    await expect(connecting).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(factory).not.toHaveBeenCalled();
    expect(connection.state).toBe('disconnected');
  });

  it('maps FTP authentication failures without exposing the server response', async () => {
    const client = {
      closed: false,
      connect: vi.fn(async () => ({ code: 220, message: 'ready' })),
      login: vi.fn(async () => {
        throw new FTPError({ code: 530, message: '530 secret server response' });
      }),
      useDefaultSettings: vi.fn(),
      close: vi.fn(),
    } as unknown as Client;
    const connection = new FtpConnection(
      profile(),
      async () => ({ password: 'fixture-only' }),
      () => client,
    );
    await expect(connection.connect()).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      messageKey: 'errors.security.authenticationFailed',
    });
    expect(connection.failureCode).toBe('AUTHENTICATION_FAILED');
    expect(connection.stage).toBe('failed');
  });

  it('rejects password command injection before creating a protocol client', async () => {
    const factory = vi.fn();
    const connection = new FtpConnection(
      profile(),
      async () => ({ password: 'fixture\r\nDELE /data' }),
      factory,
    );
    await expect(connection.connect()).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      messageKey: 'errors.security.authenticationFailed',
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('publishes conservative capabilities and rejects FTP command injection paths', async () => {
    const provider = new FtpProvider(
      new FtpConnection(profile(), async () => ({ password: 'fixture-only' })),
    );
    expect(provider.capabilities).toMatchObject({
      atomicRename: false,
      modificationTime: false,
      permissions: false,
      resumeRead: false,
      resumeWrite: false,
      symbolicLinks: false,
    });
    await expect(
      provider.stat(createFtpProviderPath('/safe\r\nDELE /other')),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_PATH' });
  });

  it('maps protocol codes by operation and keeps raw replies only as internal causes', () => {
    const missing = new FTPError({ code: 550, message: '550 private path details' });
    const denied = new FTPError({ code: 530, message: '530 private account details' });
    const unsupported = new FTPError({ code: 502, message: '502 raw feature response' });
    expect(normalizeFtpError(missing, 'stat')).toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
      messageKey: 'errors.provider.notFound',
      protocolCause: { provider: 'ftp', operation: 'stat', code: '550' },
    });
    expect(normalizeFtpError(denied, 'list').code).toBe('PROVIDER_ACCESS_DENIED');
    expect(normalizeFtpError(unsupported, 'list').code).toBe('PROVIDER_UNSUPPORTED');
  });
});
