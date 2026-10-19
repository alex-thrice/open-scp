import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import {
  ProviderError,
  providerErrorCodes,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import type { ProviderOperationOptions } from '@shared/providers/file-system-provider';

export const mailruEndpoint = 'https://webdav.cloud.mail.ru';
export const webDavMetadataLimit = 32 * 1024 * 1024;

export const webDavError = (error: unknown, operation: ProviderOperation): ApplicationError => {
  if (error instanceof ProviderError || error instanceof ApplicationError) return error;
  return new ProviderError(
    providerErrorCodes.ioError,
    { provider: 'mailru', operation },
    { cause: error },
  );
};

export const webDavStatusError = (
  status: number,
  operation: ProviderOperation,
): ApplicationError => {
  if (status === 401) return new ApplicationError(applicationErrorCodes.authenticationFailed);
  if (status === 403 && operation === 'connect')
    return new ApplicationError(applicationErrorCodes.mailruWebdavAccessDenied);
  const code =
    status === 403
      ? providerErrorCodes.accessDenied
      : status === 404
        ? providerErrorCodes.notFound
        : status === 409 ||
            status === 412 ||
            status === 423 ||
            (status === 405 && operation === 'create-directory')
          ? providerErrorCodes.conflict
          : status === 507
            ? providerErrorCodes.quotaExceeded
            : status === 429
              ? providerErrorCodes.rateLimited
              : status === 405 || status === 501
                ? providerErrorCodes.unsupported
                : providerErrorCodes.ioError;
  return new ProviderError(code, { provider: 'mailru', operation, code: String(status) });
};

export interface WebDavRequest {
  readonly request: ClientRequest;
  readonly response: Promise<IncomingMessage>;
  abort(): void;
}

export class WebDavTransport {
  public readonly endpoint: URL;
  private readonly agent: HttpAgent;
  private readonly active = new Set<ClientRequest>();
  private authorization: string | undefined;

  public constructor(
    username: string,
    password: string,
    private readonly timeout: number,
    endpoint = mailruEndpoint,
  ) {
    this.endpoint = new URL(endpoint);
    const loopback = ['127.0.0.1', '[::1]'].includes(this.endpoint.hostname);
    if (
      (this.endpoint.origin !== mailruEndpoint && !loopback) ||
      !['http:', 'https:'].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.pathname !== '/' ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    this.agent =
      this.endpoint.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 })
        : new HttpAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
  }

  public url(path: string): URL {
    const url = new URL(this.endpoint);
    url.pathname = path.split('/').map(encodeURIComponent).join('/');
    return url;
  }

  public start(
    method: string,
    path: string,
    operation: ProviderOperation,
    options?: ProviderOperationOptions,
    headers: Readonly<Record<string, string>> = {},
  ): WebDavRequest {
    if (options?.signal?.aborted)
      throw new ProviderError(providerErrorCodes.cancelled, { provider: 'mailru', operation });
    if (!this.authorization) throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    const createRequest = this.endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = createRequest(this.url(path), {
      method,
      agent: this.agent,
      headers: { ...headers, Authorization: this.authorization },
    });
    this.active.add(request);
    const abort = () =>
      request.destroy(
        new ProviderError(providerErrorCodes.cancelled, { provider: 'mailru', operation }),
      );
    options?.signal?.addEventListener('abort', abort, { once: true });
    const timeout = () =>
      request.destroy(
        new ProviderError(providerErrorCodes.ioError, {
          provider: 'mailru',
          operation,
          code: 'ETIMEDOUT',
        }),
      );
    const connectionTimer = setTimeout(timeout, this.timeout);
    request.once('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectionTimer);
      else
        socket.once(this.endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () =>
          clearTimeout(connectionTimer),
        );
    });
    request.setTimeout(this.timeout, timeout);
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('error', (error) => reject(webDavError(error, operation)));
      request.once('response', (message) => {
        message.on('error', () => undefined);
        const status = message.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          message.destroy();
          request.destroy();
          reject(webDavStatusError(status, operation));
        } else resolve(message);
      });
    });
    void response.catch(() => undefined);
    request.once('close', () => {
      clearTimeout(connectionTimer);
      options?.signal?.removeEventListener('abort', abort);
      this.active.delete(request);
    });
    return { request, response, abort };
  }

  public close(): void {
    this.authorization = undefined;
    for (const request of this.active)
      request.destroy(
        new ProviderError(providerErrorCodes.cancelled, {
          provider: 'mailru',
          operation: 'disconnect',
        }),
      );
    this.active.clear();
    this.agent.destroy();
  }
}

export const readWebDavBody = async (
  response: IncomingMessage,
  operation: ProviderOperation,
  options?: ProviderOperationOptions,
): Promise<string> => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > webDavMetadataLimit) {
        response.destroy();
        throw new ProviderError(providerErrorCodes.ioError, { provider: 'mailru', operation });
      }
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (options?.signal?.aborted)
      throw new ProviderError(providerErrorCodes.cancelled, { provider: 'mailru', operation });
    throw webDavError(error, operation);
  }
};

export const webDavProperties =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';
