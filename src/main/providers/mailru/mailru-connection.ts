import type { MailruConnectionProfile } from '@shared/models/connection-profile';
import type {
  ProviderConnectionStage,
  ProviderConnectionState,
} from '@shared/providers/provider-session';
import type { ProviderOperationOptions } from '@shared/providers/file-system-provider';
import {
  ProviderError,
  providerErrorCodes,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import {
  applicationErrorCodes,
  ApplicationError as DomainApplicationError,
  type ApplicationErrorCode,
} from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import { parseWebDavEntries } from './webdav-xml';
import {
  mailruEndpoint,
  readWebDavBody,
  WebDavTransport,
  webDavProperties,
  type WebDavRequest,
} from './webdav-transport';

export class MailruConnection {
  public state: ProviderConnectionState = 'disconnected';
  public stage: ProviderConnectionStage | undefined;
  public failureCode: ApplicationErrorCode | undefined;
  private transport: WebDavTransport | undefined;
  private lifecycle = new AbortController();
  private connecting: Promise<void> | undefined;

  public constructor(
    public readonly profile: MailruConnectionProfile,
    private readonly getCredentials: () => Promise<{ password: string }>,
    private readonly endpoint = mailruEndpoint,
  ) {}

  public connect(options?: ProviderOperationOptions): Promise<void> {
    if (options?.signal?.aborted)
      return Promise.reject(new ApplicationError(applicationErrorCodes.providerCancelled));
    if (this.state === 'connected') return Promise.resolve();
    if (!this.connecting) {
      const pending = this.establish(options).finally(() => {
        if (this.connecting === pending) this.connecting = undefined;
      });
      this.connecting = pending;
    }
    return this.connecting;
  }

  private async establish(options?: ProviderOperationOptions): Promise<void> {
    this.disconnect();
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    const abort = () => lifecycle.abort();
    options?.signal?.addEventListener('abort', abort, { once: true });
    this.state = 'connecting';
    this.stage = 'resolving-credentials';
    this.failureCode = undefined;
    let transport: WebDavTransport | undefined;
    try {
      const credentials = await new Promise<{ password: string }>((resolve, reject) => {
        const cancelled = () =>
          reject(new ApplicationError(applicationErrorCodes.providerCancelled));
        lifecycle.signal.addEventListener('abort', cancelled, { once: true });
        void this.getCredentials()
          .then(resolve, reject)
          .finally(() => lifecycle.signal.removeEventListener('abort', cancelled));
      });
      if (lifecycle.signal.aborted)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      if (!credentials.password || /[\r\n\0]/u.test(credentials.password))
        throw new ApplicationError(applicationErrorCodes.authenticationFailed);
      this.stage = 'authenticating';
      transport = new WebDavTransport(
        this.profile.username,
        credentials.password,
        this.profile.timeout ?? 20000,
        this.endpoint,
      );
      this.transport = transport;
      const probe = transport.start(
        'PROPFIND',
        '/',
        'connect',
        { signal: lifecycle.signal },
        {
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
      );
      probe.request.end(webDavProperties);
      const response = await probe.response;
      const entries = parseWebDavEntries(
        await readWebDavBody(response, 'connect'),
        transport.url('/'),
        'connect',
      );
      if (
        !entries.some(
          (entry) =>
            entry.path.provider === 'mailru' &&
            entry.path.path === '/' &&
            entry.kind === 'directory',
        )
      )
        throw new ApplicationError(applicationErrorCodes.connectionFailed);
      if (lifecycle.signal.aborted)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      this.state = 'connected';
      this.stage = 'connected';
    } catch (error) {
      transport?.close();
      if (this.lifecycle !== lifecycle)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      if (lifecycle.signal.aborted) {
        this.state = 'disconnected';
        this.stage = 'cancelled';
        this.failureCode = applicationErrorCodes.providerCancelled;
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      }
      const normalized =
        error instanceof DomainApplicationError
          ? error
          : new ApplicationError(applicationErrorCodes.connectionFailed, { cause: error });
      this.failureCode = normalized.code as ApplicationErrorCode;
      this.state = 'failed';
      this.stage = 'failed';
      this.transport = undefined;
      throw normalized;
    } finally {
      options?.signal?.removeEventListener('abort', abort);
    }
  }

  public start(
    method: string,
    path: string,
    operation: ProviderOperation,
    options?: ProviderOperationOptions,
    headers?: Readonly<Record<string, string>>,
  ): WebDavRequest {
    if (this.state !== 'connected' || !this.transport)
      throw new ProviderError(providerErrorCodes.notConnected, { provider: 'mailru', operation });
    const pending = this.transport.start(method, path, operation, options, headers);
    const response = pending.response.catch((error: unknown) => {
      if (
        error instanceof ApplicationError &&
        error.code === applicationErrorCodes.authenticationFailed
      ) {
        this.state = 'failed';
        this.stage = 'failed';
        this.failureCode = applicationErrorCodes.authenticationFailed;
      }
      throw error;
    });
    void response.catch(() => undefined);
    return { ...pending, response };
  }

  public url(path: string): URL {
    if (!this.transport) throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    return this.transport.url(path);
  }

  public setDirectoryLoading(isLoading: boolean): void {
    if (this.state === 'connected') this.stage = isLoading ? 'loading-directory' : 'connected';
  }

  public disconnect(): void {
    const wasConnecting = this.state === 'connecting';
    this.lifecycle.abort();
    this.transport?.close();
    this.transport = undefined;
    this.connecting = undefined;
    this.state = 'disconnected';
    this.stage = wasConnecting ? 'cancelled' : undefined;
    this.failureCode = wasConnecting ? applicationErrorCodes.providerCancelled : undefined;
  }
}
