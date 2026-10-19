import type { GoogleConfiguration } from '../providers/google/google-authorization';
import { ApplicationError } from '../ipc/application-error';
import { applicationErrorCodes } from '@shared/errors/application-error';

declare const __OPENSCP_GOOGLE_CLIENT_ID__: string;
declare const __OPENSCP_GOOGLE_CLIENT_SECRET__: string;
const bundledClientSecret =
  typeof __OPENSCP_GOOGLE_CLIENT_SECRET__ === 'string' ? __OPENSCP_GOOGLE_CLIENT_SECRET__ : '';
const bundledClientId =
  typeof __OPENSCP_GOOGLE_CLIENT_ID__ === 'string' ? __OPENSCP_GOOGLE_CLIENT_ID__ : '';

export const createGoogleConfiguration = (
  isPackaged: boolean,
  openBrowser: (url: string) => Promise<void>,
): GoogleConfiguration => {
  const clientId = process.env.OPENSCP_GOOGLE_CLIENT_ID?.trim() || bundledClientId;
  if (
    !isPackaged &&
    process.env.OPENSCP_GOOGLE_FIXTURE === '1' &&
    process.env.OPENSCP_TEST_GOOGLE_ENDPOINT
  ) {
    const endpoint = new URL(process.env.OPENSCP_TEST_GOOGLE_ENDPOINT);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/drive/v3' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new ApplicationError(applicationErrorCodes.oauthConfiguration);
    return {
      clientId: 'fixture.apps.googleusercontent.com',
      apiEndpoint: endpoint.href,
      authorizationEndpoint: `${endpoint.origin}/authorize`,
      tokenEndpoint: `${endpoint.origin}/token`,
      callbackPort: 0,
      allowLoopbackEndpoints: true,
      openBrowser: async (url) => {
        await fetch(url);
      },
    };
  }
  const clientSecret = process.env.OPENSCP_GOOGLE_CLIENT_SECRET?.trim() || bundledClientSecret;
  return { clientId, openBrowser, ...(clientSecret ? { clientSecret } : {}) };
};
