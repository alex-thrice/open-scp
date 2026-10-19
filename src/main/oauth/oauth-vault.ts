import type { YandexConnectionProfile } from '@shared/models/connection-profile';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';
import type { CredentialService } from '../security/credential-service';
import type { ProfileStore } from '../persistence/profile-store';
import { oauthBundleSchema, type LoopbackOAuth, type OAuthBundle } from './loopback-oauth';

export class OAuthVault {
  private readonly refreshing = new Map<string, Promise<OAuthBundle>>();
  private readonly generations = new Map<string, number>();
  public constructor(
    private readonly store: ProfileStore,
    private readonly credentials: CredentialService,
    private readonly oauth: LoopbackOAuth,
  ) {}
  private profile(id: string): YandexConnectionProfile {
    const profile = this.store.list().find((candidate) => candidate.id === id);
    if (profile?.kind !== 'yandex')
      throw new ApplicationError(applicationErrorCodes.providerNotFound);
    return profile;
  }
  public has(id: string): boolean {
    return (
      Number(
        this.store.database
          .prepare('SELECT count(*) AS count FROM credentials WHERE profile_id = ?')
          .get(id)?.count,
      ) > 0
    );
  }
  public forget(id: string): void {
    this.changed(id);
    this.store.database.prepare('DELETE FROM credentials WHERE profile_id = ?').run(id);
  }
  public changed(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }
  public async accessToken(id: string, rejectedToken?: string): Promise<string> {
    const profile = this.profile(id);
    let bundle: OAuthBundle;
    try {
      bundle = oauthBundleSchema.parse(
        JSON.parse(this.credentials.read(profile.authentication.secret.id)),
      );
    } catch {
      throw new ApplicationError(applicationErrorCodes.oauthRequired);
    }
    if (
      (!rejectedToken || bundle.accessToken !== rejectedToken) &&
      (!bundle.expiresAt || bundle.expiresAt > Date.now() + 60000)
    )
      return bundle.accessToken;
    let pending = this.refreshing.get(id);
    if (!pending) {
      const generation = this.generations.get(id) ?? 0;
      const reference = profile.authentication.secret.id;
      pending = this.oauth
        .refresh(bundle)
        .then((updated) => {
          const current = this.profile(id);
          if (
            (this.generations.get(id) ?? 0) !== generation ||
            current.authentication.secret.id !== reference
          )
            throw new ApplicationError(applicationErrorCodes.oauthRequired);
          this.store.replaceCredential(id, reference, JSON.stringify(updated));
          return updated;
        })
        .catch((error: unknown) => {
          if (
            error instanceof ApplicationError &&
            error.code === applicationErrorCodes.oauthRequired &&
            (this.generations.get(id) ?? 0) === generation
          )
            this.forget(id);
          throw error;
        })
        .finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, pending);
    }
    return (await pending).accessToken;
  }
}
