// @vitest-environment node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/persistence/database';
import { ProfileStore } from '../../src/main/persistence/profile-store';
import { CredentialService } from '../../src/main/security/credential-service';
import { exportProfiles, importProfiles } from '../../src/main/persistence/profile-library';
import { importKnownHosts } from '../../src/main/security/known-hosts';
import { Diagnostics } from '../../src/main/security/diagnostics';
import { WorkspaceService } from '../../src/main/sessions/workspace-service';
import { ApplicationError } from '../../src/main/ipc/application-error';
import { applicationErrorCodes } from '../../src/shared/errors/application-error';

const setup = () => {
  const database = openDatabase(':memory:');
  const credentials = new CredentialService(database, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  });
  const store = new ProfileStore(database, credentials);
  return { database, store, credentials };
};
describe('profile library and safe diagnostics', () => {
  it('persists appearance and empty connection folders and merges archives without secrets', async () => {
    const { database, store, credentials } = setup();
    const service = new WorkspaceService(
      store,
      credentials,
      async () => [],
      async () => null,
    );
    expect((await service.execute({ action: 'snapshot' })).snapshot.appearance).toEqual({
      theme: 'light',
      density: 'comfortable',
      showHidden: true,
    });
    await service.execute({
      action: 'set-appearance',
      appearance: { theme: 'system', density: 'compact', showHidden: false },
    });
    await service.execute({ action: 'create-profile-folder', name: 'Servers' });
    await service.execute({ action: 'create-profile-folder', name: 'servers' });
    await service.execute({ action: 'create-profile-folder', name: 'Empty' });
    const archive = exportProfiles(store);
    const imported = setup();
    imported.store.addFolder('Existing');
    expect(importProfiles(imported.store, archive)).toBe(0);
    expect(imported.store.folders()).toEqual(['Empty', 'Existing', 'Servers']);
    expect(store.folders()).toEqual(['Empty', 'Servers']);
    expect((await service.execute({ action: 'snapshot' })).snapshot.appearance).toEqual({
      theme: 'system',
      density: 'compact',
      showHidden: false,
    });
    store.setSetting('appearance', '{invalid');
    expect((await service.execute({ action: 'snapshot' })).snapshot.appearance?.theme).toBe(
      'light',
    );
    service.dispose();
    database.close();
    imported.database.close();
  });
  it('exports no secrets, imports under new IDs without credentials, and rejects credential injection atomically', async () => {
    const { database, store, credentials } = setup();
    const id = randomUUID();
    store.save(
      {
        id,
        kind: 'sftp',
        name: 'Fixture',
        host: 'fixture.test',
        port: 22,
        username: 'fixture',
        authentication: {
          method: 'password',
          secret: { id: randomUUID(), storage: 'safe-storage' },
        },
      },
      'password-canary-only',
    );
    store.setSetting(`group:${id}`, 'Servers');
    const archive = exportProfiles(store);
    expect(archive).not.toContain('password-canary-only');
    expect(archive).not.toContain('safe-storage');
    expect(importProfiles(store, archive)).toBe(1);
    expect(store.list()).toHaveLength(2);
    const imported = store.list().find((profile) => profile.id !== id);
    expect(store.getSetting(`group:${imported?.id}`)).toBe('Servers');
    expect(database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(1);
    const invalid = JSON.parse(archive) as { profiles: { profile: Record<string, unknown> }[] };
    const entry = invalid.profiles[0];
    if (!entry) throw new Error();
    entry.profile.secret = 'injected';
    expect(() => importProfiles(store, JSON.stringify(invalid))).toThrow();
    expect(store.list()).toHaveLength(2);
    const service = new WorkspaceService(
      store,
      credentials,
      async () => [],
      async () => null,
    );
    await service.execute({ action: 'clone-profile', profileId: id, name: 'Copy' });
    expect(database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(2);
    if (!imported) throw new Error('Missing imported profile.');
    await service.execute({
      action: 'clone-profile',
      profileId: imported.id,
      name: 'Copy without credentials',
    });
    expect(store.list()).toHaveLength(4);
    expect(database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(2);
    await service.execute({ action: 'delete-profile', profileId: id });
    expect(database.prepare('SELECT count(*) AS count FROM credentials').get()?.count).toBe(1);
    service.dispose();
    database.close();
  });
  it('imports plain and matching hashed hosts, reports conflicts and never replaces trusted keys', () => {
    const { database, store } = setup();
    store.save({
      id: randomUUID(),
      kind: 'sftp',
      name: 'Fixture',
      host: 'hashed.test',
      port: 2222,
      username: 'fixture',
      authentication: { method: 'agent' },
    });
    const type = Buffer.from('ssh-ed25519');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(type.length);
    const key = Buffer.concat([length, type, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
    const salt = Buffer.alloc(20, 1);
    const hash = createHmac('sha1', salt).update('[hashed.test]:2222').digest('base64');
    store.trustHost('changed.test', 22, 'SHA256:previous');
    const result = importKnownHosts(
      store,
      `plain.test ssh-ed25519 ${key.toString('base64')}\n|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}\nchanged.test ssh-ed25519 ${key.toString('base64')}\n@revoked other.test ssh-ed25519 ${key.toString('base64')}\n*.test ssh-ed25519 ${key.toString('base64')}`,
    );
    expect(result).toEqual({ imported: 2, skipped: 2, conflicts: 1 });
    expect(store.getHostKey('hashed.test', 2222)).toBe(fingerprint);
    expect(store.getHostKey('changed.test', 22)).toBe('SHA256:previous');
    database.close();
  });
  it('does not export raw SDK messages, paths, hosts, stack traces or any credential fields', () => {
    const diagnostics = new Diagnostics();
    diagnostics.record(new Error('AWS Authorization secret-canary https://user:password@host'));
    diagnostics.record(new ApplicationError(applicationErrorCodes.authenticationFailed));
    const report = diagnostics.report({
      language: 'ru',
      profiles: [
        {
          id: randomUUID(),
          name: 'private-name-canary',
          kind: 's3',
          endpoint: 'https://private-host-canary',
          region: 'us-east-1',
          forcePathStyle: false,
          accessKeyId: 'access-canary',
          secret: { id: randomUUID(), storage: 'safe-storage' },
        },
      ],
      sessions: [],
      transfers: [],
    });
    expect(report).not.toMatch(/canary|password|Authorization|stack|safe-storage/iu);
    expect(JSON.parse(report)).toMatchObject({
      events: [{ code: 'INTERNAL_ERROR' }, { code: 'AUTHENTICATION_FAILED', category: 'auth' }],
    });
  });
});
