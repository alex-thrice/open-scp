// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applicationErrorCodes } from '../../src/shared/errors/application-error';
import { ApplicationError } from '../../src/main/ipc/application-error';
import {
  SftpConnection,
  type SftpCredentials,
} from '../../src/main/providers/sftp/sftp-connection';

describe('SFTP lifecycle races', () => {
  it('does not create a client after disconnecting during credential retrieval', async () => {
    let complete: ((credentials: SftpCredentials) => void) | undefined;
    const credentials = new Promise<SftpCredentials>((resolve) => {
      complete = resolve;
    });
    const connection = new SftpConnection(
      {
        id: 'fixture',
        kind: 'sftp',
        name: 'Fixture',
        host: '127.0.0.1',
        port: 1,
        username: 'fixture',
        authentication: { method: 'agent' },
      },
      () => credentials,
      { getHostKey: () => undefined },
    );
    const connecting = connection.connect();
    expect(connection.state).toBe('connecting');
    expect(connection.stage).toBe('resolving-credentials');
    connection.disconnect();
    complete?.({ password: 'fixture-only' });
    await expect(connecting).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(connection.state).toBe('disconnected');
    expect(connection.stage).toBe('cancelled');
    expect(connection.failureCode).toBe('PROVIDER_CANCELLED');
  });

  it('keeps a credential failure distinct from network and host-key failures', async () => {
    const connection = new SftpConnection(
      {
        id: 'fixture',
        kind: 'sftp',
        name: 'Fixture',
        host: '127.0.0.1',
        port: 1,
        username: 'fixture',
        authentication: { method: 'agent' },
      },
      async () => {
        throw new ApplicationError(applicationErrorCodes.credentialRequired);
      },
      { getHostKey: () => undefined },
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: 'CREDENTIAL_REQUIRED' });
    expect(connection.state).toBe('failed');
    expect(connection.stage).toBe('failed');
    expect(connection.failureCode).toBe('CREDENTIAL_REQUIRED');
  });
});
