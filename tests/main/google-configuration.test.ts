// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleConfiguration } from '../../src/main/oauth/google-configuration';

afterEach(() => vi.unstubAllEnvs());
describe('Google build/runtime configuration', () => {
  it.each([undefined, '', '   '])(
    'does not supply a client ID when configuration is %j',
    (value) => {
      vi.stubEnv('OPENSCP_GOOGLE_CLIENT_ID', value);
      expect(createGoogleConfiguration(true, async () => Promise.resolve()).clientId).toBe('');
    },
  );
  it('uses the public client ID and ignores fixture endpoints in packaged builds', () => {
    vi.stubEnv('OPENSCP_GOOGLE_CLIENT_ID', 'configured.apps.googleusercontent.com');
    vi.stubEnv('OPENSCP_GOOGLE_FIXTURE', '1');
    vi.stubEnv('OPENSCP_TEST_GOOGLE_ENDPOINT', 'http://127.0.0.1:3456/drive/v3');
    expect(createGoogleConfiguration(true, async () => Promise.resolve())).toMatchObject({
      clientId: 'configured.apps.googleusercontent.com',
    });
    expect(
      createGoogleConfiguration(true, async () => Promise.resolve()).apiEndpoint,
    ).toBeUndefined();
    expect(createGoogleConfiguration(false, async () => Promise.resolve())).toMatchObject({
      clientId: 'fixture.apps.googleusercontent.com',
      callbackPort: 0,
      apiEndpoint: 'http://127.0.0.1:3456/drive/v3',
    });
  });
  it('rejects a non-loopback development fixture', () => {
    vi.stubEnv('OPENSCP_GOOGLE_FIXTURE', '1');
    vi.stubEnv('OPENSCP_TEST_GOOGLE_ENDPOINT', 'http://evil.test/drive/v3');
    expect(() => createGoogleConfiguration(false, async () => Promise.resolve())).toThrow();
  });
});
