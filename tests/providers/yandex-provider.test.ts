// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createYandexProviderPath as path } from '../../src/shared/models/provider-path';
import { YandexApi } from '../../src/main/providers/yandex/yandex-api';
import { createYandexHarness, required } from '../fixtures/yandex-harness';
import { yandexFixtureEntry } from '../fixtures/yandex-fixture';

describe('Yandex REST protocol and transfer boundaries', () => {
  let harness: Awaited<ReturnType<typeof createYandexHarness>>;
  let provider: ReturnType<typeof harness.provider>;
  beforeEach(async () => {
    harness = await createYandexHarness();
    await harness.authorize();
    provider = harness.provider();
    await provider.connect();
  });
  afterEach(async () => {
    await provider.disconnect();
    await harness.close();
  });

  it('aborts an upload without publishing a partial file and rejects unsupported resume', async () => {
    const writer = (
      await provider.openWrite(path('/cancelled'), { overwrite: false, expectedSize: 1048576n })
    ).getWriter();
    await writer.write(Buffer.alloc(65536, 0x41));
    await writer.abort();
    expect(required(harness.fixture.accounts.get('one')).has('/cancelled')).toBe(false);
    await expect(
      provider.openWrite(path('/resumed'), { overwrite: false, offset: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
  });

  it('paginates without changing literal Unicode or percent-encoded names', async () => {
    const names = ['%2F.txt', 'Привет #%&.txt', '中文.txt', 'a', 'b'];
    for (const name of names)
      required(harness.fixture.accounts.get('one')).set(`/${name}`, yandexFixtureEntry(name));
    const listed = await provider.list(path('/'));
    expect(listed.map((entry) => entry.name).sort()).toEqual([...names].sort());
    expect(
      harness.fixture.requests
        .filter((entry) => entry.path === '/v1/disk/resources')
        .map((entry) => entry.query.get('offset')),
    ).toEqual(['0', '2', '4']);
    const content = await new Response(await provider.openRead(path('/%2F.txt'))).text();
    expect(content).toBe('%2F.txt');
    expect(
      harness.fixture.requests
        .filter((entry) => entry.path.startsWith('/transfer/'))
        .every((entry) => !entry.headers.authorization),
    ).toBe(true);
  });

  it('waits for asynchronous moves and never deletes the existing destination before replacing it', async () => {
    const tree = required(harness.fixture.accounts.get('one'));
    tree.set('/source', yandexFixtureEntry('new'));
    tree.set('/target', yandexFixtureEntry('old'));
    await provider.rename(path('/source'), path('/target'), { overwrite: true });
    expect(tree.get('/target')?.content.toString()).toBe('new');
    expect(tree.has('/source')).toBe(false);
    expect(harness.fixture.requests.some((entry) => entry.method === 'DELETE')).toBe(false);
    expect(
      harness.fixture.requests.filter((entry) => entry.path.startsWith('/v1/disk/operations/')),
    ).toHaveLength(2);
    tree.set('/source', yandexFixtureEntry('race-source'));
    tree.delete('/target');
    harness.fixture.beforeMove = () => tree.set('/target', yandexFixtureEntry('concurrent-writer'));
    await expect(provider.rename(path('/source'), path('/target'))).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
    expect(tree.get('/target')?.content.toString()).toBe('concurrent-writer');
    expect(tree.get('/source')?.content.toString()).toBe('race-source');
  });

  it('refreshes rejected GETs once but does not repeat mutations, and normalizes quota and rate errors', async () => {
    const token = await harness.authorization.vault.accessToken(harness.profile.id);
    harness.fixture.rejectedTokens.add(token);
    await provider.list(path('/'));
    expect(
      harness.fixture.requests.filter((entry) => entry.body?.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);
    harness.fixture.overrides.set('PUT /v1/disk/resources', { status: 503 });
    await expect(provider.createDirectory(path('/new'))).rejects.toMatchObject({
      code: 'PROVIDER_IO_ERROR',
    });
    expect(harness.fixture.requests.filter((entry) => entry.method === 'PUT')).toHaveLength(1);
    harness.fixture.overrides.set('GET /v1/disk/resources', {
      status: 429,
      headers: { 'Retry-After': '0' },
    });
    await expect(provider.list(path('/'))).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    harness.fixture.overrides.set('GET /v1/disk/resources', { status: 507 });
    await expect(provider.list(path('/'))).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA_EXCEEDED',
    });
  });

  it('rejects unexpected signed hosts, credentials, protocols and operation URLs before sending requests', async () => {
    required(harness.fixture.accounts.get('one')).set(
      '/file',
      yandexFixtureEntry('secret content'),
    );
    harness.fixture.transferHref = 'http://example.test/leak';
    await expect(provider.openRead(path('/file'))).rejects.toMatchObject({
      code: 'PROVIDER_IO_ERROR',
    });
    const api = new YandexApi(
      async () => 'never-leak',
      () => undefined,
    );
    try {
      for (const url of [
        'https://disk.yandex.ru.evil.test/a',
        'https://user:password@disk.yandex.ru/a',
        'http://disk.yandex.ru/a',
        'file:///tmp/test',
        'https://127.0.0.1/a',
      ])
        expect(() => api.transferUrl(url)).toThrow();
      expect(api.transferUrl('https://downloader.disk.yandex.ru/a?signature=test').hostname).toBe(
        'downloader.disk.yandex.ru',
      );
      await expect(
        api.complete(202, { href: 'https://evil.test/v1/disk/operations/id' }, 'rename'),
      ).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    } finally {
      api.close();
    }
  });

  it('validates each download redirect and never forwards API authorization', async () => {
    required(harness.fixture.accounts.get('one')).set('/redirected', yandexFixtureEntry('content'));
    harness.fixture.transferHref = `${harness.fixture.origin}/redirect`;
    harness.fixture.overrides.set('GET /redirect', {
      status: 302,
      headers: { Location: '/signed-content' },
    });
    harness.fixture.overrides.set('GET /signed-content', { status: 200, body: 'downloaded' });
    expect(await new Response(await provider.openRead(path('/redirected'))).text()).toBe(
      '"downloaded"',
    );
    expect(
      harness.fixture.requests
        .filter((entry) => ['/redirect', '/signed-content'].includes(entry.path))
        .every((entry) => !entry.headers.authorization),
    ).toBe(true);
    harness.fixture.overrides.set('GET /redirect', {
      status: 302,
      headers: { Location: 'https://evil.test/leak' },
    });
    await expect(provider.openRead(path('/redirected'))).rejects.toMatchObject({
      code: 'PROVIDER_IO_ERROR',
    });
  });

  it('rejects malformed pagination and dangerous paths, and honors cancellation during operation polling', async () => {
    harness.fixture.overrides.set('GET /v1/disk/resources', {
      status: 200,
      body: {
        name: 'disk',
        path: 'disk:/',
        type: 'dir',
        _embedded: { offset: 0, total: 5, items: [] },
      },
    });
    await expect(provider.list(path('/'))).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    harness.fixture.overrides.clear();
    await expect(provider.stat(path('/../escape'))).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_PATH',
    });
    required(harness.fixture.accounts.get('one')).set('/file', yandexFixtureEntry('content'));
    const controller = new AbortController();
    const promise = provider.rename(path('/file'), path('/renamed'), { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    clearTimeout(timer);
  });
});
