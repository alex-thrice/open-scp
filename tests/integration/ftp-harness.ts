import { randomUUID } from 'node:crypto';
import type { FtpConnectionProfile } from '../../src/shared/models/connection-profile';
import { FtpConnection } from '../../src/main/providers/ftp/ftp-connection';
import { FtpProvider } from '../../src/main/providers/ftp/ftp-provider';

export const ftpFixtureProfile = (): FtpConnectionProfile => ({
  id: randomUUID(),
  name: 'Disposable FTP fixture',
  kind: 'ftp',
  host: '127.0.0.1',
  port: 21210,
  username: 'fixture',
  initialDirectory: '/data',
  timeout: 5000,
  authentication: {
    method: 'password',
    secret: { id: randomUUID(), storage: 'safe-storage' },
  },
});

export const createFtpFixtureProvider = (password = 'fixture-ftp-password-only') => {
  const connection = new FtpConnection(ftpFixtureProfile(), async () => ({ password }));
  return { connection, provider: new FtpProvider(connection) };
};
