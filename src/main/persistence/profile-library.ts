import { randomUUID } from 'node:crypto';
import type { ConnectionProfile } from '@shared/models/connection-profile';
import { profileArchiveSchema } from '@shared/models/profile-archive';
import type { ProfileStore } from './profile-store';

export const exportProfiles = (store: ProfileStore, profiles = store.list()): string =>
  JSON.stringify(
    {
      version: 1,
      folders: store.folders(),
      profiles: profiles.map((profile) => ({
        kind: profile.kind,
        group: store.getSetting(`group:${profile.id}`) ?? '',
        profile:
          profile.kind === 's3'
            ? {
                id: null,
                name: profile.name,
                region: profile.region,
                endpoint: profile.endpoint ?? '',
                bucket: profile.bucket ?? '',
                initialPrefix: profile.initialPrefix ?? '',
                accessKeyId: profile.accessKeyId ?? '',
                forcePathStyle: profile.forcePathStyle,
              }
            : profile.kind === 'ftp'
              ? {
                  id: null,
                  name: profile.name,
                  host: profile.host,
                  port: profile.port,
                  username: profile.username,
                  initialDirectory: profile.initialDirectory ?? '/',
                  timeout: profile.timeout ?? 20000,
                }
              : {
                  id: null,
                  name: profile.name,
                  host: profile.host,
                  port: profile.port,
                  username: profile.username,
                  authMode: profile.authentication.method,
                  privateKeyPath:
                    profile.authentication.method === 'private-key'
                      ? profile.authentication.privateKeyPath
                      : '',
                  initialDirectory: profile.initialDirectory ?? '/',
                  timeout: profile.timeout ?? 20000,
                  keepalive: profile.keepalive ?? 10000,
                },
      })),
    },
    null,
    2,
  );

export const importProfiles = (store: ProfileStore, content: string): number => {
  const archive = profileArchiveSchema.parse(JSON.parse(content));
  store.database.exec('BEGIN IMMEDIATE');
  try {
    for (const folder of archive.folders ?? []) store.addFolder(folder);
    for (const entry of archive.profiles) {
      const id = randomUUID();
      let profile: ConnectionProfile;
      if (entry.kind === 's3') {
        const draft = entry.profile;
        profile = {
          id,
          name: draft.name,
          kind: 's3',
          region: draft.region,
          forcePathStyle: draft.forcePathStyle,
          accessKeyId: draft.accessKeyId,
          initialPrefix: draft.initialPrefix,
          ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
          ...(draft.bucket ? { bucket: draft.bucket } : {}),
        };
      } else if (entry.kind === 'ftp') {
        const draft = entry.profile;
        profile = {
          id,
          name: draft.name,
          kind: 'ftp',
          host: draft.host,
          port: draft.port,
          username: draft.username,
          initialDirectory: draft.initialDirectory,
          timeout: draft.timeout,
          authentication: {
            method: 'password',
            secret: { id: randomUUID(), storage: 'safe-storage' },
          },
        };
      } else {
        const draft = entry.profile;
        profile = {
          id,
          name: draft.name,
          kind: 'sftp',
          host: draft.host,
          port: draft.port,
          username: draft.username,
          initialDirectory: draft.initialDirectory,
          timeout: draft.timeout,
          keepalive: draft.keepalive,
          authentication:
            draft.authMode === 'agent'
              ? { method: 'agent' }
              : draft.authMode === 'private-key'
                ? { method: 'private-key', privateKeyPath: draft.privateKeyPath }
                : { method: 'password', secret: { id: randomUUID(), storage: 'safe-storage' } },
        };
      }
      // Импорт создаёт новые профили без credential-записей; пароль запрашивается при настройке.
      store.database.prepare('INSERT INTO profiles VALUES (?, ?)').run(id, JSON.stringify(profile));
      store.addFolder(entry.group);
      store.setSetting(
        `group:${id}`,
        store
          .folders()
          .find((name) => name.toLocaleLowerCase() === entry.group.toLocaleLowerCase()) ??
          entry.group,
      );
    }
    store.database.exec('COMMIT');
  } catch (error) {
    store.database.exec('ROLLBACK');
    throw error;
  }
  return archive.profiles.length;
};
