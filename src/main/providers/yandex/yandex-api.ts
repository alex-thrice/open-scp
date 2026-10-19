import type { IncomingMessage } from 'node:http';
import {
  applicationErrorCodes,
  ApplicationError as DomainError,
} from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import {
  ProviderError,
  providerErrorCodes,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import {
  HttpClient,
  readHttpBody,
  cancellableDelay,
  type HttpPending,
} from '../../oauth/http-client';

export const yandexApiEndpoint = 'https://cloud-api.yandex.net/v1/disk';
export const yandexFailure = (
  code: keyof typeof providerErrorCodes,
  operation: ProviderOperation,
) => new ProviderError(providerErrorCodes[code], { provider: 'yandex', operation });
export const yandexStatusError = (status: number, operation: ProviderOperation): DomainError => {
  if (status === 401) return new ApplicationError(applicationErrorCodes.oauthRequired);
  return yandexFailure(
    status === 403
      ? 'accessDenied'
      : status === 404
        ? 'notFound'
        : status === 409 || status === 412 || status === 423
          ? 'conflict'
          : status === 507
            ? 'quotaExceeded'
            : status === 429
              ? 'rateLimited'
              : status === 405 || status === 501
                ? 'unsupported'
                : 'ioError',
    operation,
  );
};
export const normalizeYandexError = (
  error: unknown,
  operation: ProviderOperation,
  signal?: AbortSignal,
): DomainError =>
  signal?.aborted
    ? yandexFailure('cancelled', operation)
    : error instanceof DomainError && error.code === applicationErrorCodes.providerNotConnected
      ? yandexFailure('notConnected', operation)
      : error instanceof DomainError
        ? error
        : yandexFailure('ioError', operation);

export class YandexApi {
  private readonly http = new HttpClient();
  public readonly endpoint: URL;
  public constructor(
    private readonly token: (rejectedToken?: string) => Promise<string>,
    private readonly invalidate: () => void,
    private readonly timeout = 30000,
    endpoint = yandexApiEndpoint,
  ) {
    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      (this.endpoint.href.replace(/\/$/u, '') !== yandexApiEndpoint &&
        !(
          this.endpoint.protocol === 'http:' &&
          this.endpoint.hostname === '127.0.0.1' &&
          this.endpoint.pathname === '/v1/disk'
        ))
    )
      throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
  }
  public close(): void {
    this.http.close();
  }
  private url(path: string, parameters: Readonly<Record<string, string>>): URL {
    const url = new URL(this.endpoint.href.replace(/\/$/u, '') + path);
    url.search = new URLSearchParams(parameters).toString();
    return url;
  }
  public async request(
    method: string,
    path: string,
    parameters: Readonly<Record<string, string>>,
    operation: ProviderOperation,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    let accessToken = await this.token();
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const pending = this.http.start(
          this.url(path, parameters),
          method,
          { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' },
          signal,
          this.timeout,
        );
        pending.request.end();
        const response = await pending.response;
        const status = response.statusCode ?? 0;
        const body = await readHttpBody(response);
        if (status === 401) {
          if (method === 'GET' && !refreshed) {
            accessToken = await this.token(accessToken);
            refreshed = true;
            continue;
          }
          this.invalidate();
        }
        if (method === 'GET' && (status === 429 || status === 503) && attempt < 2) {
          const retryAfter = response.headers['retry-after'];
          const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
          const dateDelay = retryAfter === undefined ? NaN : Date.parse(retryAfter) - Date.now();
          const delay =
            Number.isFinite(seconds) && seconds >= 0
              ? Math.min(seconds * 1000, 5000)
              : Number.isFinite(dateDelay)
                ? Math.min(Math.max(dateDelay, 0), 5000)
                : 250 * 2 ** attempt;
          await cancellableDelay(delay, signal);
          continue;
        }
        if (status < 200 || status >= 300) throw yandexStatusError(status, operation);
        return { status, body: body ? (JSON.parse(body) as unknown) : null };
      } catch (error) {
        throw normalizeYandexError(error, operation, signal);
      }
    }
  }
  public transferUrl(href: string): URL {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw yandexFailure('ioError', 'read');
    }
    const fixture = this.endpoint.protocol === 'http:' && url.origin === this.endpoint.origin;
    const host = url.hostname.toLowerCase();
    const validHost = [
      'disk.yandex.ru',
      'disk.yandex.net',
      'storage.yandex.net',
      'disk.yandex.com',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (
      url.username ||
      url.password ||
      url.hash ||
      (!fixture && (url.protocol !== 'https:' || url.port || !validHost))
    )
      throw yandexFailure('ioError', 'read');
    return url;
  }
  public startTransfer(
    href: string,
    method: 'GET' | 'PUT',
    signal?: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
  ): HttpPending {
    return this.http.start(this.transferUrl(href), method, headers, signal, this.timeout);
  }
  public async download(
    href: string,
    signal?: AbortSignal,
  ): Promise<{ pending: HttpPending; response: IncomingMessage }> {
    let current = href;
    for (let count = 0; count <= 3; count += 1) {
      const pending = this.startTransfer(current, 'GET', signal);
      pending.request.end();
      const response = await pending.response;
      if (
        [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
        response.headers.location &&
        count < 3
      ) {
        response.destroy();
        const next = new URL(response.headers.location, this.transferUrl(current));
        this.transferUrl(next.href);
        current = next.href;
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw yandexStatusError(response.statusCode ?? 0, 'read');
      }
      return { pending, response };
    }
    throw yandexFailure('ioError', 'read');
  }
  public async complete(
    status: number,
    body: unknown,
    operation: ProviderOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (status !== 202) return;
    if (!body || typeof body !== 'object' || !('href' in body) || typeof body.href !== 'string')
      throw yandexFailure('ioError', operation);
    const url = new URL(body.href);
    if (
      url.origin !== this.endpoint.origin ||
      !url.pathname.startsWith(`${this.endpoint.pathname}/operations/`) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw yandexFailure('ioError', operation);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const result = await this.request(
        'GET',
        url.pathname.slice(this.endpoint.pathname.length),
        {},
        operation,
        signal,
      );
      const state =
        result.body && typeof result.body === 'object' && 'status' in result.body
          ? result.body.status
          : undefined;
      if (state === 'success') return;
      if (state !== 'in-progress') throw yandexFailure('ioError', operation);
      await cancellableDelay(500, signal);
    }
    throw yandexFailure('ioError', operation);
  }
}
