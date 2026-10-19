import type { YandexConfiguration } from '../providers/yandex/yandex-authorization';
import { ApplicationError } from '../ipc/application-error';
import { applicationErrorCodes } from '@shared/errors/application-error';

declare const __OPENSCP_YANDEX_CLIENT_ID__: string;
const bundledClientId =
  typeof __OPENSCP_YANDEX_CLIENT_ID__ === 'string' ? __OPENSCP_YANDEX_CLIENT_ID__ : '';

export const createYandexConfiguration = (
  isPackaged: boolean,
  openBrowser: (url: string) => Promise<void>,
): YandexConfiguration => {
  const clientId = process.env.OPENSCP_YANDEX_CLIENT_ID?.trim() || bundledClientId;
  if (
    !isPackaged &&
    process.env.OPENSCP_YANDEX_FIXTURE === '1' &&
    process.env.OPENSCP_TEST_YANDEX_ENDPOINT
  ) {
    const endpoint = new URL(process.env.OPENSCP_TEST_YANDEX_ENDPOINT);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/v1/disk' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new ApplicationError(applicationErrorCodes.oauthConfiguration);
    return {
      clientId: 'ffffffffffffffffffffffffffffffff',
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
  return { clientId, openBrowser };
};
