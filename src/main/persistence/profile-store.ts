import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConnectionProfile } from '@shared/models/connection-profile';
import { connectionProfileSchema } from '@shared/models/profile-schema';
import { CredentialService } from '../security/credential-service';
import { ApplicationError } from '../ipc/application-error';
import { applicationErrorCodes } from '@shared/errors/application-error';

export class ProfileStore {
  public constructor(
    public readonly database: DatabaseSync,
    private readonly credentials: CredentialService,
  ) {}

  public list(): readonly ConnectionProfile[] {
    return this.database
      .prepare('SELECT metadata FROM profiles ORDER BY id')
      .all()
      .map((row) => connectionProfileSchema.parse(JSON.parse(String(row.metadata))));
  }

  public save(profile: ConnectionProfile, secret?: string): ConnectionProfile {
    let validated = connectionProfileSchema.parse(profile);
    const ciphertext = secret === undefined ? undefined : this.credentials.encrypt(secret);
    const secretId = randomUUID();
    if (ciphertext !== undefined) {
      const reference = { id: secretId, storage: 'safe-storage' as const };
      if (validated.kind === 'sftp' && validated.authentication.method === 'password') {
        validated = { ...validated, authentication: { method: 'password', secret: reference } };
      } else if (validated.kind === 'sftp' && validated.authentication.method === 'private-key') {
        validated = {
          ...validated,
          authentication: { ...validated.authentication, passphrase: reference },
        };
      } else if (validated.kind === 's3') validated = { ...validated, secret: reference };
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          'INSERT INTO profiles (id, metadata) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata',
        )
        .run(validated.id, JSON.stringify(validated));
      const references =
        validated.kind === 's3'
          ? [validated.secret?.id]
          : validated.authentication.method === 'agent'
            ? []
            : validated.authentication.method === 'password'
              ? [validated.authentication.secret.id]
              : [validated.authentication.passphrase?.id];
      for (const reference of references) {
        if (reference === undefined || (ciphertext !== undefined && reference === secretId))
          continue;
        const owner = this.database
          .prepare('SELECT profile_id FROM credentials WHERE id = ?')
          .get(reference);
        if (owner?.profile_id !== validated.id)
          throw new ApplicationError(applicationErrorCodes.credentialRequired);
      }
      for (const row of this.database
        .prepare('SELECT id FROM credentials WHERE profile_id = ?')
        .all(validated.id)) {
        if (!references.includes(String(row.id)))
          this.database.prepare('DELETE FROM credentials WHERE id = ?').run(String(row.id));
      }
      if (ciphertext !== undefined)
        this.database
          .prepare('INSERT INTO credentials VALUES (?, ?, ?)')
          .run(secretId, validated.id, ciphertext);
      this.database.exec('COMMIT');
      return validated;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public delete(id: string): void {
    this.database.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    this.database
      .prepare('DELETE FROM settings WHERE key IN (?, ?)')
      .run(`group:${id}`, `recent:${id}`);
  }
  public getSetting(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row === undefined ? undefined : String(row.value);
  }
  public folders(): string[] {
    const stored = JSON.parse(this.getSetting('profile-folders') ?? '[]') as string[];
    return [
      ...new Set(
        [
          ...stored,
          ...this.list().map((profile) => this.getSetting(`group:${profile.id}`) ?? ''),
        ].filter(Boolean),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }
  public addFolder(name: string): void {
    if (!name) return;
    const folders = this.folders();
    if (folders.some((folder) => folder.toLocaleLowerCase() === name.toLocaleLowerCase())) return;
    if (folders.length >= 1000) throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
    this.setSetting('profile-folders', JSON.stringify([...folders, name]));
  }
  public setSetting(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  public getHostKey(host: string, port: number): string | undefined {
    const row = this.database
      .prepare('SELECT fingerprint FROM trusted_hosts WHERE host = ? AND port = ?')
      .get(host.toLowerCase(), port);
    return row === undefined ? undefined : String(row.fingerprint);
  }
  public trustHost(host: string, port: number, fingerprint: string): void {
    this.database
      .prepare('INSERT INTO trusted_hosts VALUES (?, ?, ?) ON CONFLICT(host, port) DO NOTHING')
      .run(host.toLowerCase(), port, fingerprint);
  }
}
