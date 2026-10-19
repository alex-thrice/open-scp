import type { YandexConnectionProfile } from '@shared/models/connection-profile';
import type {
  ProviderConnectionStage,
  ProviderConnectionState,
} from '@shared/providers/provider-session';
import type { ProviderOperationOptions } from '@shared/providers/file-system-provider';
import type { ApplicationErrorCode } from '@shared/errors/application-error';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import type { OAuthVault } from '../../oauth/oauth-vault';
import { YandexApi, normalizeYandexError } from './yandex-api';
import { z } from 'zod';

export const yandexAccountSchema = z.object({
  user: z.object({
    uid: z.string().min(1).max(200),
    login: z.string().min(1).max(320),
    display_name: z.string().optional(),
  }),
});
export class YandexConnection {
  public state: ProviderConnectionState = 'disconnected';
  public stage: ProviderConnectionStage | undefined;
  public failureCode: ApplicationErrorCode | undefined;
  private lifetime = new AbortController();
  private connecting: Promise<void> | undefined;
  private client: YandexApi | undefined;
  public constructor(
    public readonly profile: YandexConnectionProfile,
    private readonly vault: OAuthVault,
    private readonly endpoint?: string,
  ) {}
  public connect(options?: ProviderOperationOptions): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (!this.connecting) {
      const connecting = this.establish(options).finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }
  private async establish(options?: ProviderOperationOptions): Promise<void> {
    this.disconnect();
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    const abort = () => lifetime.abort();
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) lifetime.abort();
    this.state = 'connecting';
    this.stage = 'authenticating';
    this.failureCode = undefined;
    const client = new YandexApi(
      (rejected) => this.vault.accessToken(this.profile.id, rejected),
      () => this.vault.forget(this.profile.id),
      this.profile.timeout,
      this.endpoint,
    );
    this.client = client;
    try {
      const account = yandexAccountSchema.parse(
        (await client.request('GET', '', {}, 'connect', lifetime.signal)).body,
      ).user;
      if (this.profile.accountId && account.uid !== this.profile.accountId)
        throw new ApplicationError(applicationErrorCodes.oauthAccountMismatch);
      if (lifetime.signal.aborted)
        throw new ApplicationError(applicationErrorCodes.providerCancelled);
      this.state = 'connected';
      this.stage = 'connected';
    } catch (error) {
      client.close();
      const normalized = normalizeYandexError(error, 'connect', lifetime.signal);
      if (this.lifetime === lifetime) {
        this.state = 'failed';
        this.stage = 'failed';
        this.failureCode = normalized.code as ApplicationErrorCode;
      }
      throw normalized;
    } finally {
      options?.signal?.removeEventListener('abort', abort);
    }
  }
  public api(): YandexApi {
    if (this.state !== 'connected' || !this.client)
      throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    return this.client;
  }
  public failed(error: unknown): void {
    if (error instanceof ApplicationError && error.code === applicationErrorCodes.oauthRequired) {
      this.state = 'failed';
      this.stage = 'failed';
      this.failureCode = applicationErrorCodes.oauthRequired;
    }
  }
  public setDirectoryLoading(value: boolean): void {
    if (this.state === 'connected') this.stage = value ? 'loading-directory' : 'connected';
  }
  public disconnect(): void {
    this.connecting = undefined;
    this.lifetime.abort();
    this.client?.close();
    this.client = undefined;
    this.state = 'disconnected';
    this.stage = undefined;
    this.failureCode = undefined;
  }
}
