// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYandexConfiguration } from '../../src/main/oauth/yandex-configuration';

afterEach(() => vi.unstubAllEnvs());
describe('Yandex build/runtime configuration', () => {
  it.each([undefined, '', '   '])(
    'does not supply a client ID when configuration is %j',
    (value) => {
      vi.stubEnv('OPENSCP_YANDEX_CLIENT_ID', value);
      expect(createYandexConfiguration(true, async () => Promise.resolve()).clientId).toBe('');
    },
  );
  it('uses the public client ID and ignores fixture endpoints in packaged builds', () => {
    vi.stubEnv('OPENSCP_YANDEX_CLIENT_ID', 'a'.repeat(32));
    vi.stubEnv('OPENSCP_YANDEX_FIXTURE', '1');
    vi.stubEnv('OPENSCP_TEST_YANDEX_ENDPOINT', 'http://127.0.0.1:3456/v1/disk');
    expect(createYandexConfiguration(true, async () => Promise.resolve())).toMatchObject({
      clientId: 'a'.repeat(32),
    });
    expect(
      createYandexConfiguration(true, async () => Promise.resolve()).apiEndpoint,
    ).toBeUndefined();
    expect(createYandexConfiguration(false, async () => Promise.resolve())).toMatchObject({
      clientId: 'f'.repeat(32),
      callbackPort: 0,
      apiEndpoint: 'http://127.0.0.1:3456/v1/disk',
    });
  });
  it('rejects a non-loopback development fixture', () => {
    vi.stubEnv('OPENSCP_YANDEX_FIXTURE', '1');
    vi.stubEnv('OPENSCP_TEST_YANDEX_ENDPOINT', 'http://evil.test/v1/disk');
    expect(() => createYandexConfiguration(false, async () => Promise.resolve())).toThrow();
  });
});
