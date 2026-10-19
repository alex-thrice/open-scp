// @vitest-environment node
import { createMailruProviderPath } from '../../src/shared/models/provider-path';
import { MailruConnection } from '../../src/main/providers/mailru/mailru-connection';
import { MailruProvider } from '../../src/main/providers/mailru/mailru-provider';
import {
  fixtureMailruPassword,
  fixtureMailruUsername,
  startWebDavFixture,
} from '../fixtures/webdav-fixture';
import { runFileSystemProviderContractTests } from './provider-contract';
import type { MailruConnectionProfile } from '../../src/shared/models/connection-profile';

export const mailruFixtureProfile = (): MailruConnectionProfile => ({
  id: '00000000-0000-4000-8000-000000000031',
  name: 'Mail.ru fixture',
  kind: 'mailru',
  username: fixtureMailruUsername,
  initialDirectory: '/',
  timeout: 1000,
  authentication: {
    method: 'password',
    secret: { id: '00000000-0000-4000-8000-000000000032', storage: 'safe-storage' },
  },
});

runFileSystemProviderContractTests('Mail.ru WebDAV', async () => {
  const fixture = await startWebDavFixture();
  const provider = new MailruProvider(
    new MailruConnection(
      mailruFixtureProfile(),
      async () => ({ password: fixtureMailruPassword }),
      fixture.endpoint,
    ),
  );
  return {
    provider,
    root: createMailruProviderPath('/'),
    path: (...segments) => createMailruProviderPath(`/${segments.join('/')}`),
    dispose: fixture.close,
  };
});
