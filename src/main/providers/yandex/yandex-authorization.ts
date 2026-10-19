import type { YandexConnectionProfile } from '@shared/models/connection-profile';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError, serializeApplicationError } from '../../ipc/application-error';
import type { ProfileStore } from '../../persistence/profile-store';
import type { CredentialService } from '../../security/credential-service';
import { LoopbackOAuth } from '../../oauth/loopback-oauth';
import { OAuthVault } from '../../oauth/oauth-vault';
import { YandexApi } from './yandex-api';
import { yandexAccountSchema } from './yandex-connection';

export interface YandexConfiguration {
  readonly clientId: string;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly apiEndpoint?: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly callbackPort?: number;
  readonly allowLoopbackEndpoints?: boolean;
  readonly timeout?: number;
}
type AuthorizationState = 'waiting' | 'exchanging' | 'authorized' | 'failed' | 'cancelled';
interface Authorization {
  readonly controller: AbortController;
  state: AuthorizationState;
  errorKey: string | null;
}
export class YandexAuthorization {
  public readonly vault: OAuthVault;
  private readonly oauth: LoopbackOAuth;
  private readonly entries = new Map<string, Authorization>();
  public constructor(
    private readonly store: ProfileStore,
    credentials: CredentialService,
    private readonly configuration: YandexConfiguration,
  ) {
    this.oauth = new LoopbackOAuth({
      clientId: configuration.clientId,
      authorizationEndpoint:
        configuration.authorizationEndpoint ?? 'https://oauth.yandex.ru/authorize',
      tokenEndpoint: configuration.tokenEndpoint ?? 'https://oauth.yandex.ru/token',
      callbackPath: '/oauth/yandex/callback',
      port: configuration.callbackPort ?? 53682,
      scopes: ['cloud_api:disk.read', 'cloud_api:disk.write', 'cloud_api:disk.info'],
      openBrowser: configuration.openBrowser,
      ...(configuration.allowLoopbackEndpoints ? { allowLoopbackEndpoints: true } : {}),
      ...(configuration.timeout ? { timeout: configuration.timeout } : {}),
    });
    this.vault = new OAuthVault(store, credentials, this.oauth);
  }
  public get configured(): boolean {
    return /^[a-f\d]{32}$/iu.test(this.configuration.clientId);
  }
  public isAuthorizing(id: string): boolean {
    const state = this.entries.get(id)?.state;
    return state === 'waiting' || state === 'exchanging';
  }
  public snapshots() {
    return this.store
      .list()
      .filter((profile) => profile.kind === 'yandex')
      .map((profile) => {
        const entry = this.entries.get(profile.id);
        const authorized = this.vault.has(profile.id);
        return {
          profileId: profile.id,
          authorized,
          state:
            entry?.state === 'authorized' && !authorized
              ? ('signed-out' as const)
              : (entry?.state ?? (authorized ? ('authorized' as const) : ('signed-out' as const))),
          errorKey: entry?.errorKey ?? null,
        };
      });
  }
  private profile(id: string): YandexConnectionProfile {
    const profile = this.store.list().find((candidate) => candidate.id === id);
    if (profile?.kind !== 'yandex')
      throw new ApplicationError(applicationErrorCodes.providerNotFound);
    return profile;
  }
  public authorize(id: string): void {
    if (!this.configured) throw new ApplicationError(applicationErrorCodes.oauthConfiguration);
    if (this.isAuthorizing(id)) throw new ApplicationError(applicationErrorCodes.providerConflict);
    const profile = this.profile(id);
    const entry: Authorization = {
      controller: new AbortController(),
      state: 'waiting',
      errorKey: null,
    };
    this.entries.set(id, entry);
    const signal = entry.controller.signal;
    void (async () => {
      try {
        const bundle = await this.oauth.authorize(signal, (stage) => {
          entry.state = stage;
        });
        const api = new YandexApi(
          async () => bundle.accessToken,
          () => undefined,
          profile.timeout,
          this.configuration.apiEndpoint,
        );
        try {
          const user = yandexAccountSchema.parse(
            (await api.request('GET', '', {}, 'connect', signal)).body,
          ).user;
          if (profile.accountId && profile.accountId !== user.uid)
            throw new ApplicationError(applicationErrorCodes.oauthAccountMismatch);
          if (signal.aborted || this.entries.get(id) !== entry)
            throw new ApplicationError(applicationErrorCodes.providerCancelled);
          const current = this.profile(id);
          if (JSON.stringify(current) !== JSON.stringify(profile))
            throw new ApplicationError(applicationErrorCodes.providerConflict);
          this.vault.changed(id);
          this.store.save(
            { ...profile, accountId: user.uid, accountName: user.login },
            JSON.stringify(bundle),
          );
          entry.state = 'authorized';
        } finally {
          api.close();
        }
      } catch (error) {
        if (this.entries.get(id) !== entry) return;
        entry.state = signal.aborted ? 'cancelled' : 'failed';
        entry.errorKey = signal.aborted ? null : serializeApplicationError(error).messageKey;
      }
    })();
  }
  public cancel(id: string): void {
    const entry = this.entries.get(id);
    if (entry && this.isAuthorizing(id)) {
      entry.controller.abort();
      entry.state = 'cancelled';
      entry.errorKey = null;
    }
  }
  public forget(id: string): void {
    this.cancel(id);
    this.entries.delete(id);
    this.vault.forget(id);
    const profile = this.profile(id);
    this.store.save({
      id: profile.id,
      name: profile.name,
      kind: 'yandex',
      authentication: profile.authentication,
      ...(profile.initialDirectory === undefined
        ? {}
        : { initialDirectory: profile.initialDirectory }),
      ...(profile.timeout === undefined ? {} : { timeout: profile.timeout }),
    });
  }
  public dispose(): void {
    for (const id of this.entries.keys()) this.cancel(id);
    this.oauth.dispose();
    this.entries.clear();
  }
}
