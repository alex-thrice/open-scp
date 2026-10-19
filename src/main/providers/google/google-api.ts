import type { IncomingMessage } from 'node:http';
import {
  ApplicationError as DomainError,
  applicationErrorCodes,
} from '@shared/errors/application-error';
import {
  ProviderError,
  providerErrorCodes,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import { ApplicationError } from '../../ipc/application-error';
import { HttpClient, readHttpBody, cancellableDelay } from '../../oauth/http-client';

export const googleApiEndpoint = 'https://www.googleapis.com/drive/v3';
export const googleFailure = (
  code: keyof typeof providerErrorCodes,
  operation: ProviderOperation,
) => new ProviderError(providerErrorCodes[code], { provider: 'google', operation });
export const normalizeGoogleError = (
  error: unknown,
  operation: ProviderOperation,
  signal?: AbortSignal,
): DomainError =>
  signal?.aborted
    ? googleFailure('cancelled', operation)
    : error instanceof DomainError
      ? error
      : googleFailure('ioError', operation);
export const googleStatusError = (
  status: number,
  body: unknown,
  operation: ProviderOperation,
): DomainError => {
  if (status === 401) return new ApplicationError(applicationErrorCodes.oauthRequired);
  const reasons = JSON.stringify(body);
  return googleFailure(
    /storageQuotaExceeded|quotaExceeded|teamDriveFileLimitExceeded/u.test(reasons)
      ? 'quotaExceeded'
      : status === 429 ||
          /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded/u.test(reasons)
        ? 'rateLimited'
        : status === 403
          ? 'accessDenied'
          : status === 404
            ? 'notFound'
            : status === 409 || status === 412
              ? 'conflict'
              : status === 400
                ? 'invalidPath'
                : 'ioError',
    operation,
  );
};
export class GoogleApi {
  private readonly http = new HttpClient();
  public readonly endpoint: URL;
  public constructor(
    private readonly token: (rejectedToken?: string) => Promise<string>,
    private readonly invalidate: () => void,
    private readonly timeout = 30000,
    endpoint = googleApiEndpoint,
  ) {
    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      (this.endpoint.href !== googleApiEndpoint &&
        !(
          this.endpoint.protocol === 'http:' &&
          this.endpoint.hostname === '127.0.0.1' &&
          this.endpoint.pathname === '/drive/v3'
        ))
    )
      throw googleFailure('invalidPath', 'connect');
  }
  public close(): void {
    this.http.close();
  }
  public url(path: string, parameters: Readonly<Record<string, string>> = {}, upload = false): URL {
    const url = new URL(
      this.endpoint.origin + (upload ? '/upload' : '') + this.endpoint.pathname + path,
    );
    url.search = new URLSearchParams(parameters).toString();
    return url;
  }
  public session(value: string): URL {
    const url = new URL(value);
    if (
      url.origin !== this.endpoint.origin ||
      (url.pathname !== '/upload/drive/v3/files' &&
        !/^\/upload\/drive\/v3\/files\/[A-Za-z\d_-]+$/u.test(url.pathname)) ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.get('uploadType') !== 'resumable' ||
      !url.searchParams.get('upload_id')
    )
      throw googleFailure('invalidPath', 'write');
    return url;
  }
  public async raw(
    url: URL,
    method: string,
    operation: ProviderOperation,
    signal?: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
    body?: Uint8Array,
  ): Promise<IncomingMessage> {
    if (url.origin !== this.endpoint.origin || url.username || url.password || url.hash)
      throw googleFailure('invalidPath', operation);
    let accessToken = await this.token();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = this.http.start(
        url,
        method,
        { ...headers, Authorization: `Bearer ${accessToken}` },
        signal,
        this.timeout,
      );
      pending.request.end(body);
      const response = await pending.response;
      if (response.statusCode !== 401) return response;
      response.resume();
      if (attempt === 0) accessToken = await this.token(accessToken);
      else this.invalidate();
    }
    throw new ApplicationError(applicationErrorCodes.oauthRequired);
  }
  public async request(
    method: string,
    path: string,
    parameters: Readonly<Record<string, string>>,
    operation: ProviderOperation,
    signal?: AbortSignal,
    body?: unknown,
    upload = false,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<{ body: unknown; status: number; headers: IncomingMessage['headers'] }> {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.raw(
        this.url(path, parameters, upload),
        method,
        operation,
        signal,
        {
          ...headers,
          ...(bytes
            ? {
                'Content-Type': 'application/json; charset=UTF-8',
                'Content-Length': String(bytes.length),
              }
            : {}),
        },
        bytes,
      );
      const text = await readHttpBody(response, 8388608);
      const result: unknown = text ? JSON.parse(text) : null;
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) return { body: result, status, headers: response.headers };
      const error = googleStatusError(status, result, operation);
      if (
        method === 'GET' &&
        attempt < 2 &&
        (status >= 500 || error.code === applicationErrorCodes.providerRateLimited)
      ) {
        const seconds = Number(response.headers['retry-after']);
        await cancellableDelay(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, 5000)
            : 250 * 2 ** attempt,
          signal,
        );
        continue;
      }
      throw error;
    }
  }
  public async media(
    id: string,
    offset: number,
    signal?: AbortSignal,
    exportMimeType?: string,
  ): Promise<IncomingMessage> {
    let url = this.url(
      `/files/${encodeURIComponent(id)}${exportMimeType ? '/export' : ''}`,
      exportMimeType ? { mimeType: exportMimeType } : { alt: 'media' },
    );
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const headers = offset ? { Range: `bytes=${offset}-` } : {};
      let response: IncomingMessage;
      if (url.origin === this.endpoint.origin)
        response = await this.raw(url, 'GET', 'read', signal, headers);
      else {
        if (
          url.protocol !== 'https:' ||
          !url.hostname.endsWith('.googleusercontent.com') ||
          url.username ||
          url.password ||
          url.hash ||
          url.port
        )
          throw googleFailure('invalidPath', 'read');
        const pending = this.http.start(url, 'GET', headers, signal, this.timeout);
        pending.request.end();
        response = await pending.response;
      }
      if (
        [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
        response.headers.location
      ) {
        response.resume();
        url = new URL(response.headers.location, url);
        continue;
      }
      if (
        response.statusCode !== (offset ? 206 : 200) ||
        (offset && !response.headers['content-range']?.startsWith(`bytes ${offset}-`))
      ) {
        const body = await readHttpBody(response);
        throw googleStatusError(response.statusCode ?? 0, body, 'read');
      }
      return response;
    }
    throw googleFailure('ioError', 'read');
  }
}
