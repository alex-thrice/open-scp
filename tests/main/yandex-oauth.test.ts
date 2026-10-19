// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { LoopbackOAuth } from '../../src/main/oauth/loopback-oauth';
import { startYandexFixture, type YandexFixture } from '../fixtures/yandex-fixture';
import {
  createYandexHarness,
  until,
  yandexFixtureProfile,
  required,
} from '../fixtures/yandex-harness';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const setup = async () => {
  const harness = await createYandexHarness();
  cleanup.push(harness.close);
  return harness;
};
const oauth = (
  fixture: YandexFixture,
  openBrowser: (url: string) => Promise<void>,
  timeout = 2000,
) => {
  const client = new LoopbackOAuth({
    clientId: 'f'.repeat(32),
    authorizationEndpoint: `${fixture.origin}/authorize`,
    tokenEndpoint: `${fixture.origin}/token`,
    callbackPath: '/oauth/yandex/callback',
    port: 0,
    scopes: ['cloud_api:disk.read'],
    allowLoopbackEndpoints: true,
    timeout,
    openBrowser,
  });
  cleanup.push(() => client.dispose());
  return client;
};

describe('desktop Yandex OAuth', () => {
  it('routes simultaneous accounts by state even when callbacks arrive in reverse order', async () => {
    const fixture = await startYandexFixture();
    cleanup.push(fixture.close);
    const callbacks: string[] = [];
    let opened = 0;
    const client = oauth(fixture, async (url) => {
      const target = new URL(url);
      target.searchParams.set('fixture_account', String(++opened));
      const response = await fetch(target, { redirect: 'manual' });
      callbacks.push(required(response.headers.get('location')));
    });
    const first = client.authorize(new AbortController().signal);
    const second = client.authorize(new AbortController().signal);
    await until(() => callbacks.length === 2);
    await fetch(required(callbacks[1]));
    await fetch(required(callbacks[0]));
    const bundles = await Promise.all([first, second]);
    const accounts = await Promise.all(
      bundles.map(async (bundle) => {
        const response = await fetch(fixture.endpoint, {
          headers: { Authorization: `OAuth ${bundle.accessToken}` },
        });
        return (await response.json()) as { user: { uid: string } };
      }),
    );
    expect(accounts.map((entry) => entry.user.uid)).toEqual(['1', '2']);
  });

  it('uses state and S256 PKCE, rejects forged and duplicate callbacks, and sends no client secret', async () => {
    const fixture = await startYandexFixture();
    cleanup.push(fixture.close);
    let callback = '';
    let authorizationUrl = '';
    const client = oauth(fixture, async (url) => {
      authorizationUrl = url;
      const response = await fetch(url, { redirect: 'manual' });
      callback = required(response.headers.get('location'));
      const forged = new URL(callback);
      forged.searchParams.set('state', 'я'.repeat(43));
      expect((await fetch(forged)).status).toBe(400);
      expect((await fetch(callback)).status).toBe(200);
      expect((await fetch(callback)).status).toBe(400);
    });
    const bundle = await client.authorize(new AbortController().signal);
    expect(bundle.accessToken).toMatch(/^fixture-access-/u);
    const request = required(fixture.requests.find((entry) => entry.path === '/token'));
    const query = new URL(authorizationUrl).searchParams;
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(required(query.get('state')).length).toBeGreaterThanOrEqual(43);
    expect(query.get('code_challenge')).toBe(
      createHash('sha256')
        .update(required(required(request.body).get('code_verifier')))
        .digest('base64url'),
    );
    expect(required(request.body).has('client_secret')).toBe(false);
    expect(request.headers.authorization).toBeUndefined();
  });

  it('supports cancellation, timeout, denial and independent parallel profiles', async () => {
    const harness = await setup();
    const fixture = harness.fixture;
    fixture.authorizationMode = 'stall';
    harness.authorization.authorize(harness.profile.id);
    await until(() => fixture.requests.some((entry) => entry.path === '/authorize'));
    harness.authorization.cancel(harness.profile.id);
    await until(() => !harness.authorization.isAuthorizing(harness.profile.id));
    expect(harness.authorization.vault.has(harness.profile.id)).toBe(false);
    const timeoutClient = oauth(
      fixture,
      async (url) => {
        await fetch(url);
      },
      30,
    );
    await expect(timeoutClient.authorize(new AbortController().signal)).rejects.toMatchObject({
      code: 'OAUTH_TIMEOUT',
    });
    fixture.authorizationMode = 'deny';
    const denied = oauth(fixture, async (url) => {
      await fetch(url);
    });
    await expect(denied.authorize(new AbortController().signal)).rejects.toMatchObject({
      code: 'OAUTH_REQUIRED',
    });
    fixture.authorizationMode = 'normal';
    const other = yandexFixtureProfile();
    harness.store.save(other);
    await Promise.all([harness.authorize(), harness.authorize(other.id)]);
    expect(harness.authorization.snapshots().every((entry) => entry.authorized)).toBe(true);
    const references = harness.store
      .list()
      .map((profile) => (profile.kind === 'yandex' ? profile.authentication.secret.id : ''));
    expect(new Set(references).size).toBe(2);
  });

  it('rotates refresh tokens once for concurrent callers and keeps tokens encrypted', async () => {
    const harness = await setup();
    await harness.authorize();
    const profile = harness.store.list()[0];
    if (profile?.kind !== 'yandex') throw new Error('Missing profile');
    const original = JSON.parse(harness.credentials.read(profile.authentication.secret.id)) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
    harness.store.replaceCredential(
      profile.id,
      profile.authentication.secret.id,
      JSON.stringify({ ...original, clientId: 'f'.repeat(32), expiresAt: 1 }),
    );
    const values = await Promise.all(
      Array.from({ length: 12 }, () => harness.authorization.vault.accessToken(profile.id)),
    );
    expect(new Set(values).size).toBe(1);
    expect(values[0]).not.toBe(original.accessToken);
    expect(
      harness.fixture.requests.filter((entry) => entry.body?.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);
    const updated = harness.credentials.read(profile.authentication.secret.id);
    expect(updated).not.toContain(original.refreshToken);
    const row = required(harness.database.prepare('SELECT ciphertext FROM credentials').get());
    expect(Buffer.from(row.ciphertext as Uint8Array).toString()).not.toContain(values[0]);
    expect(JSON.stringify(harness.store.list())).not.toContain('fixture-access-');
  });

  it('keeps authorization on a temporary refresh failure and forgets a revoked refresh token', async () => {
    const harness = await setup();
    await harness.authorize();
    const id = harness.profile.id;
    const accessToken = await harness.authorization.vault.accessToken(id);
    harness.fixture.refreshMode = 'unavailable';
    await expect(harness.authorization.vault.accessToken(id, accessToken)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
    expect(harness.authorization.vault.has(id)).toBe(true);
    harness.fixture.refreshMode = 'invalid';
    await expect(harness.authorization.vault.accessToken(id, accessToken)).rejects.toMatchObject({
      code: 'OAUTH_REQUIRED',
    });
    expect(harness.authorization.vault.has(id)).toBe(false);
  });

  it('binds the profile to its account and requires explicit sign-out to change accounts', async () => {
    const harness = await setup();
    await harness.authorize();
    harness.fixture.nextAccount = 'two';
    harness.authorization.authorize(harness.profile.id);
    await until(() => !harness.authorization.isAuthorizing(harness.profile.id));
    expect(harness.authorization.snapshots()[0]).toMatchObject({
      authorized: true,
      state: 'failed',
      errorKey: 'errors.oauth.accountMismatch',
    });
    expect(harness.store.list()[0]).toMatchObject({ accountId: 'one' });
    harness.authorization.forget(harness.profile.id);
    await harness.authorize();
    expect(harness.store.list()[0]).toMatchObject({ accountId: 'two' });
  });
});
