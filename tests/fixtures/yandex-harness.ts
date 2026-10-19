import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import {
  YandexAuthorization,
  type YandexConfiguration,
} from '../../src/main/providers/yandex/yandex-authorization';
import { YandexConnection } from '../../src/main/providers/yandex/yandex-connection';
import { YandexProvider } from '../../src/main/providers/yandex/yandex-provider';
import type { YandexConnectionProfile } from '../../src/shared/models/connection-profile';
import { startYandexFixture, type YandexFixture } from './yandex-fixture';

export function required<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error('Required fixture value missing');
  return value;
}

export const yandexConfiguration = (fixture: YandexFixture): YandexConfiguration => ({
  clientId: 'f'.repeat(32),
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
export const yandexFixtureProfile = (): YandexConnectionProfile => ({
  id: randomUUID(),
  name: 'Yandex fixture',
  kind: 'yandex',
  initialDirectory: '/',
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
export async function createYandexHarness() {
  const fixture = await startYandexFixture();
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  });
  const store = new ProfileStore(database, credentials);
  const configuration = yandexConfiguration(fixture);
  const authorization = new YandexAuthorization(store, credentials, configuration);
  const profile = yandexFixtureProfile();
  store.save(profile);
  const authorize = async (id = profile.id) => {
    authorization.authorize(id);
    await until(() => !authorization.isAuthorizing(id));
    if (!authorization.vault.has(id)) throw new Error(JSON.stringify(authorization.snapshots()));
  };
  const provider = (id = profile.id) =>
    new YandexProvider(
      new YandexConnection(
        store.list().find((candidate) => candidate.id === id) as YandexConnectionProfile,
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
