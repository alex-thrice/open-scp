import type { GoogleConnectionProfile } from '@shared/models/connection-profile';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError, serializeApplicationError } from '../../ipc/application-error';
import type { ProfileStore } from '../../persistence/profile-store';
import type { CredentialService } from '../../security/credential-service';
import { LoopbackOAuth } from '../../oauth/loopback-oauth';
import { OAuthVault } from '../../oauth/oauth-vault';
import { GoogleApi } from './google-api';
import { googleAccountSchema } from './google-connection';

export interface GoogleConfiguration {
  readonly clientId: string;
  readonly clientSecret?: string;
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
export class GoogleAuthorization {
  public readonly vault: OAuthVault;
  private readonly oauth: LoopbackOAuth;
  private readonly entries = new Map<string, Authorization>();
  public constructor(
    private readonly store: ProfileStore,
    credentials: CredentialService,
    private readonly configuration: GoogleConfiguration,
  ) {
    this.oauth = new LoopbackOAuth({
      clientId: configuration.clientId,
      authorizationEndpoint:
        configuration.authorizationEndpoint ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: configuration.tokenEndpoint ?? 'https://oauth2.googleapis.com/token',
      callbackPath: '/oauth/google/callback',
      port: configuration.callbackPort ?? 0,
      scopes: ['https://www.googleapis.com/auth/drive'],
      authorizationParameters: { access_type: 'offline', prompt: 'consent select_account' },
      ...(configuration.clientSecret ? { clientSecret: configuration.clientSecret } : {}),
      openBrowser: configuration.openBrowser,
      ...(configuration.allowLoopbackEndpoints ? { allowLoopbackEndpoints: true } : {}),
      ...(configuration.timeout ? { timeout: configuration.timeout } : {}),
    });
    this.vault = new OAuthVault(store, credentials, this.oauth, 'google');
  }
  public get configured(): boolean {
    return (
      this.oauth.configured &&
      /^[A-Za-z\d._-]+\.apps\.googleusercontent\.com$/u.test(this.configuration.clientId)
    );
  }
  public isAuthorizing(id: string): boolean {
    const state = this.entries.get(id)?.state;
    return state === 'waiting' || state === 'exchanging';
  }
  public snapshots() {
    return this.store
      .list()
      .filter((profile) => profile.kind === 'google')
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
  private profile(id: string): GoogleConnectionProfile {
    const profile = this.store.list().find((candidate) => candidate.id === id);
    if (profile?.kind !== 'google')
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
        const api = new GoogleApi(
          async () => bundle.accessToken,
          () => undefined,
          profile.timeout,
          this.configuration.apiEndpoint,
        );
        try {
          const user = googleAccountSchema.parse(
            (
              await api.request(
                'GET',
                '/about',
                { fields: 'user(permissionId,emailAddress,displayName)' },
                'connect',
                signal,
              )
            ).body,
          ).user;
          if (profile.accountId && profile.accountId !== user.permissionId)
            throw new ApplicationError(applicationErrorCodes.oauthAccountMismatch);
          if (signal.aborted || this.entries.get(id) !== entry)
            throw new ApplicationError(applicationErrorCodes.providerCancelled);
          const current = this.profile(id);
          if (JSON.stringify(current) !== JSON.stringify(profile))
            throw new ApplicationError(applicationErrorCodes.providerConflict);
          this.vault.changed(id);
          this.store.save(
            { ...profile, accountId: user.permissionId, accountName: user.emailAddress },
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
      kind: 'google',
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
