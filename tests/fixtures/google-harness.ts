import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import {
  GoogleAuthorization,
  type GoogleConfiguration,
} from '../../src/main/providers/google/google-authorization';
import { GoogleConnection } from '../../src/main/providers/google/google-connection';
import { GoogleProvider } from '../../src/main/providers/google/google-provider';
import type { GoogleConnectionProfile } from '../../src/shared/models/connection-profile';
import { startGoogleFixture, type GoogleFixture } from './google-fixture';

export function required<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error('Required fixture value missing');
  return value;
}

export const googleConfiguration = (fixture: GoogleFixture): GoogleConfiguration => ({
  clientId: 'fixture.apps.googleusercontent.com',
  apiEndpoint: fixture.endpoint,
  authorizationEndpoint: `${fixture.origin}/authorize`,
  tokenEndpoint: `${fixture.origin}/token`,
  callbackPort: 0,
  allowLoopbackEndpoints: true,
  timeout: 2000,
  openBrowser: async (url) => {
    await fetch(url);
  },
});
export const googleFixtureProfile = (): GoogleConnectionProfile => ({
  id: randomUUID(),
  name: 'Google fixture',
  kind: 'google',
  initialDirectory: 'gdrive:/',
  timeout: 2000,
  authentication: { method: 'oauth', secret: { id: randomUUID(), storage: 'safe-storage' } },
});
export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function createGoogleHarness() {
  const fixture = await startGoogleFixture();
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  });
  const store = new ProfileStore(database, credentials);
  const configuration = googleConfiguration(fixture);
  const authorization = new GoogleAuthorization(store, credentials, configuration);
  const profile = googleFixtureProfile();
  store.save(profile);
  const authorize = async (id = profile.id) => {
    authorization.authorize(id);
    await until(() => !authorization.isAuthorizing(id));
    if (!authorization.vault.has(id)) throw new Error(JSON.stringify(authorization.snapshots()));
  };
  const provider = (id = profile.id) =>
    new GoogleProvider(
      new GoogleConnection(
        store.list().find((candidate) => candidate.id === id) as GoogleConnectionProfile,
        authorization.vault,
        fixture.endpoint,
      ),
    );
  return {
    fixture,
    database,
    credentials,
    store,
    configuration,
    authorization,
    profile,
    authorize,
    provider,
    close: async () => {
      authorization.dispose();
      database.close();
      await fixture.close();
    },
  };
}
