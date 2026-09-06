import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type {
  ConnectionProfile,
  S3ConnectionProfile,
  SftpConnectionProfile,
} from '@shared/models/connection-profile';
import type {
  WorkspaceRequest,
  WorkspaceResult,
  WorkspaceSnapshot,
  RemoteDirectoryListing,
} from '@shared/ipc/workspace';
import {
  createLocalProviderPath,
  createSftpProviderPath,
  createS3ProviderPath,
} from '@shared/models/provider-path';
import { formatS3Path, parseS3Path, s3Prefix, s3Name } from '@shared/models/s3-path';
import { s3CredentialsSchema } from '@shared/models/s3-profile';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';
import { CredentialService } from '../security/credential-service';
import { ProfileStore } from '../persistence/profile-store';
import { SftpConnection, type SftpCredentials } from '../providers/sftp/sftp-connection';
import { SftpProvider } from '../providers/sftp/sftp-provider';
import { LocalProvider } from '../providers/local/local-provider';
import type { LocalDrive } from '@shared/ipc/contracts';
import { TransferEngine, type TransferRequest } from '../transfers/transfer-engine';
import { QueueJournal, type TransferIntent } from '../transfers/queue-journal';
import type { TransferSnapshot } from '@shared/models/transfer-snapshot';
import { S3Provider } from '../providers/s3/s3-provider';
import { SqliteMultipartJournal } from '../providers/s3/multipart-journal';
import { exportProfiles, importProfiles } from '../persistence/profile-library';
import { importKnownHosts } from '../security/known-hosts';
import { Diagnostics } from '../security/diagnostics';
import { appearanceSchema, defaultAppearance } from '@shared/ipc/workspace';

const readAppearance = (value: string | undefined) => {
  try {
    const parsed = appearanceSchema.safeParse(JSON.parse(value ?? 'null'));
    return parsed.success ? parsed.data : defaultAppearance;
  } catch {
    return defaultAppearance;
  }
};

export class WorkspaceService {
  public readonly transfers: TransferEngine;
  private readonly sessions = new Map<string, SftpProvider | S3Provider>();
  private readonly mutating = new Set<string>();
  private readonly currentPaths = new Map<string, string>();
  private readonly diagnostics = new Diagnostics();
  public constructor(
    private readonly store: ProfileStore,
    private readonly credentials: CredentialService,
    private readonly listDrives: () => Promise<readonly LocalDrive[]>,
    private readonly pickPrivateKey: () => Promise<string | null>,
    private readonly saveExport?: (
      kind: 'profiles' | 'diagnostics',
      content: string,
    ) => Promise<void>,
    private readonly changeLanguage?: (language: 'en' | 'ru') => void,
  ) {
    const journal = new QueueJournal(store);
    this.transfers = new TransferEngine({
      load: () => journal.load(),
      save: (records) => journal.save(records),
      resolve: (intent, snapshot) => this.restoreTransfer(intent, snapshot),
    });
  }
  private async restoreTransfer(
    intent: TransferIntent,
    snapshot: TransferSnapshot,
  ): Promise<TransferRequest> {
    const endpoint = async (
      path: TransferIntent['sourcePath'],
      profileId: string | undefined,
      workspaceId: string,
    ) => {
      if (path.provider === 'local') return this.localProvider(path.path);
      const profile = this.store.list().find((item) => item.id === profileId);
      if (!profile || profile.kind !== path.provider)
        throw new ApplicationError(applicationErrorCodes.providerNotFound);
      const current = this.sessions.get(workspaceId);
      if (current && this.profile(current).id !== profileId)
        throw new ApplicationError(applicationErrorCodes.providerConflict);
      const provider =
        current ??
        (profile.kind === 's3'
          ? this.s3Provider(profile)
          : new SftpProvider(
              new SftpConnection(profile, () => this.credentialsFor(profile), this.store),
            ));
      this.sessions.set(workspaceId, provider);
      return provider;
    };
    return {
      ...intent,
      workspaceId: snapshot.workspaceId,
      direction: snapshot.direction,
      ...(snapshot.destinationWorkspaceId
        ? { destinationWorkspaceId: snapshot.destinationWorkspaceId }
        : {}),
      conflictPolicy: 'ask',
      source: await endpoint(intent.sourcePath, intent.sourceProfileId, snapshot.workspaceId),
      destination: await endpoint(
        intent.destinationPath,
        intent.destinationProfileId,
        snapshot.destinationWorkspaceId ?? snapshot.workspaceId,
      ),
    };
  }
  public snapshot(): WorkspaceSnapshot {
    const language = this.store.getSetting('language');
    return {
      appearance: readAppearance(this.store.getSetting('appearance')),
      profileFolders: this.store.folders(),
      profileGroups: Object.fromEntries(
        this.store
          .list()
          .map((profile) => [profile.id, this.store.getSetting(`group:${profile.id}`) ?? '']),
      ),
      recentPaths: Object.fromEntries(
        this.store.list().map((profile) => [profile.id, this.recentPaths(profile.id)]),
      ),
      cleanups: this.store
        .list()
        .filter((profile) => profile.kind === 's3')
        .map((profile) => ({
          profileId: profile.id,
          count: this.journal(profile.id).list().length,
        }))
        .filter(
          (item) =>
            item.count > 0 &&
            ![...this.sessions].some(
              ([workspaceId, provider]) =>
                this.profile(provider).id === item.profileId &&
                (this.transfers.hasActive(workspaceId) || this.mutating.has(workspaceId)),
            ),
        ),
      profiles: [...this.store.list()],
      language: language === 'en' || language === 'ru' ? language : null,
      sessions: [...this.sessions].map(([workspaceId, provider]) => ({
        workspaceId,
        profileId: this.profile(provider).id,
        name: this.profile(provider).name,
        kind: provider.kind,
        state: provider.connectionState,
        hostKey: provider instanceof SftpProvider ? (provider.connection.hostKey ?? null) : null,
        ...(this.currentPaths.get(workspaceId)
          ? { currentPath: this.currentPaths.get(workspaceId) ?? '' }
          : {}),
        capabilities: {
          read: provider.capabilities.read,
          write: provider.capabilities.write,
          rename: provider.capabilities.rename,
          delete: provider.capabilities.delete,
          createDirectory: provider.capabilities.createDirectory,
          serverSideCopy: provider.capabilities.serverSideCopy,
        },
      })),
      transfers: [...this.transfers.snapshots()],
    };
  }
  private recentPaths(profileId: string): string[] {
    return JSON.parse(this.store.getSetting(`recent:${profileId}`) ?? '[]') as string[];
  }
  public dispose(): void {
    this.transfers.dispose();
    for (const provider of this.sessions.values()) void provider.disconnect();
    this.sessions.clear();
  }
  private session(workspaceId: string): SftpProvider | S3Provider {
    const provider = this.sessions.get(workspaceId);
    if (!provider) throw new ApplicationError(applicationErrorCodes.providerNotConnected);
    return provider;
  }
  private profile(provider: SftpProvider | S3Provider): ConnectionProfile {
    return provider instanceof S3Provider ? provider.profile : provider.connection.profile;
  }
  private journal(profileId: string) {
    return new SqliteMultipartJournal(this.store.database, profileId);
  }
  private s3Provider(profile: S3ConnectionProfile): S3Provider {
    return new S3Provider(
      profile,
      async () => {
        if (!profile.secret) throw new ApplicationError(applicationErrorCodes.credentialRequired);
        try {
          const value = s3CredentialsSchema.parse(
            JSON.parse(this.credentials.read(profile.secret.id)),
          );
          return {
            secretAccessKey: value.secretAccessKey,
            ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}),
          };
        } catch {
          throw new ApplicationError(applicationErrorCodes.credentialRequired);
        }
      },
      this.journal(profile.id),
    );
  }
  private remotePath(provider: SftpProvider | S3Provider, path: string) {
    if (provider instanceof SftpProvider) return createSftpProviderPath(path);
    try {
      return parseS3Path(path);
    } catch {
      throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
    }
  }
  private async credentialsFor(profile: SftpConnectionProfile): Promise<SftpCredentials> {
    const authentication = profile.authentication;
    if (authentication.method === 'password')
      return { password: this.credentials.read(authentication.secret.id) };
    if (authentication.method === 'agent') {
      const agent =
        process.env.SSH_AUTH_SOCK ??
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (!agent) throw new ApplicationError(applicationErrorCodes.credentialRequired);
      return { agent };
    }
    if (!isAbsolute(authentication.privateKeyPath))
      throw new ApplicationError(applicationErrorCodes.credentialRequired);
    try {
      const file = await open(authentication.privateKeyPath, 'r');
      let privateKey: Buffer;
      try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > 1048576) throw new Error('Invalid key file.');
        const buffer = Buffer.alloc(1048577);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, length);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > 1048576) throw new Error('Key too large.');
        privateKey = Buffer.from(buffer.subarray(0, length));
        buffer.fill(0);
      } finally {
        await file.close();
      }
      return {
        privateKey,
        ...(authentication.passphrase === undefined
          ? {}
          : { passphrase: this.credentials.read(authentication.passphrase.id) }),
      };
    } catch {
      throw new ApplicationError(applicationErrorCodes.credentialRequired);
    }
  }
  private async listing(
    workspaceId: string,
    requested: string | null,
  ): Promise<RemoteDirectoryListing> {
    const provider = this.session(workspaceId);
    if (provider instanceof S3Provider) {
      const profile = provider.profile;
      const path = this.remotePath(
        provider,
        requested ??
          formatS3Path(
            createS3ProviderPath(
              profile.bucket ?? '',
              profile.initialPrefix ? s3Prefix(profile.initialPrefix) : '',
            ),
          ),
      );
      if (path.provider !== 's3')
        throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
      const entries = await provider.list(path);
      const root = formatS3Path(createS3ProviderPath('', ''));
      const breadcrumbs = profile.bucket ? [] : [{ label: 'S3', path: root }];
      if (path.bucket)
        breadcrumbs.push({
          label: path.bucket,
          path: formatS3Path(createS3ProviderPath(path.bucket, '')),
        });
      let prefix = '';
      const segments = path.key.endsWith('/')
        ? path.key.slice(0, -1).split('/')
        : path.key.split('/');
      if (path.key)
        for (const segment of segments) {
          prefix += `${segment}/`;
          breadcrumbs.push({
            label: segment || '/',
            path: formatS3Path(createS3ProviderPath(path.bucket, prefix)),
          });
        }
      return {
        breadcrumbs,
        currentPath: formatS3Path(path),
        parentPath: breadcrumbs.length > 1 ? (breadcrumbs.at(-2)?.path ?? null) : null,
        entries: entries.map((entry) => ({
          name: entry.name,
          path: entry.path.provider === 's3' ? formatS3Path(entry.path) : '',
          kind: entry.kind,
          ...(entry.s3Kind ? { s3Kind: entry.s3Kind } : {}),
          size: entry.size,
          modifiedAt: entry.modifiedAt ?? null,
          permissions: null,
        })),
      };
    }
    const currentPath = posix.resolve(
      '/',
      requested ?? provider.connection.profile.initialDirectory ?? '/',
    );
    const entries = await provider.list(createSftpProviderPath(currentPath));
    const breadcrumbs = [{ label: '/', path: '/' }];
    let prefix = '/';
    for (const segment of currentPath.split('/').filter(Boolean)) {
      prefix = posix.join(prefix, segment);
      breadcrumbs.push({ label: segment, path: prefix });
    }
    return {
      currentPath,
      breadcrumbs,
      parentPath: currentPath === '/' ? null : posix.dirname(currentPath),
      entries: entries.map((entry) => ({
        name: entry.name,
        path: entry.path.provider === 'sftp' ? entry.path.path : '',
        kind: entry.kind,
        size: entry.size,
        modifiedAt: entry.modifiedAt ?? null,
        permissions: entry.permissions ?? null,
      })),
    };
  }
  private async localProvider(path: string): Promise<LocalProvider> {
    if (!isAbsolute(path)) throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
    const target = resolve(path);
    const drive = (await this.listDrives()).find((item) => {
      const remainder = relative(item.path, target);
      return remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
    });
    if (!drive) throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
    const provider = new LocalProvider({ rootPath: drive.path });
    await provider.connect();
    return provider;
  }
  public async execute(request: WorkspaceRequest): Promise<WorkspaceResult> {
    const workspaceId = 'workspaceId' in request ? request.workspaceId : undefined;
    const changesFiles = ['mkdir', 'rename', 'copy', 'delete', 'local-operation'].includes(
      request.action,
    );
    if (request.action === 'remote-transfer' && this.mutating.has(request.destinationWorkspaceId))
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (
      (request.action === 'save-profile' || request.action === 'save-s3-profile') &&
      request.profile.id &&
      [...this.sessions].some(
        ([id, provider]) =>
          this.profile(provider).id === request.profile.id &&
          (this.transfers.hasActive(id) || this.mutating.has(id)),
      )
    )
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (
      workspaceId &&
      (this.mutating.has(workspaceId) || (changesFiles && this.transfers.hasActive(workspaceId)))
    )
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (workspaceId && changesFiles) this.mutating.add(workspaceId);
    try {
      return await this.executeInternal(request);
    } catch (error) {
      this.diagnostics.record(error);
      throw error;
    } finally {
      if (workspaceId && changesFiles) this.mutating.delete(workspaceId);
    }
  }
  private async executeInternal(request: WorkspaceRequest): Promise<WorkspaceResult> {
    let listing: RemoteDirectoryListing | null = null;
    let deletion: WorkspaceResult['deletion'];
    let privateKeyPath: string | null = null;
    let document: string | undefined;
    let importSummary: WorkspaceResult['importSummary'];
    let savedProfileId: string | undefined;
    switch (request.action) {
      case 'clear-transfer-history':
        this.transfers.clearHistory();
        break;
      case 'save-export':
        await this.saveExport?.(
          request.kind,
          request.kind === 'profiles'
            ? exportProfiles(this.store)
            : this.diagnostics.report(this.snapshot()),
        );
        break;
      case 'export-diagnostics':
        document = this.diagnostics.report(this.snapshot());
        break;
      case 'export-profiles':
        document = exportProfiles(this.store);
        break;
      case 'import-profiles': {
        try {
          importSummary = {
            imported: importProfiles(this.store, request.content),
            skipped: 0,
            conflicts: 0,
          };
        } catch {
          throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
        }
        break;
      }
      case 'import-known-hosts':
        importSummary = importKnownHosts(this.store, request.content);
        break;
      case 'set-profile-group': {
        if (!this.store.list().some((profile) => profile.id === request.profileId))
          throw new ApplicationError(applicationErrorCodes.providerNotFound);
        this.store.addFolder(request.group);
        const group =
          this.store
            .folders()
            .find((name) => name.toLocaleLowerCase() === request.group.toLocaleLowerCase()) ??
          request.group;
        this.store.setSetting(`group:${request.profileId}`, group);
        break;
      }
      case 'clone-profile': {
        const profile = this.store.list().find((item) => item.id === request.profileId);
        if (!profile) throw new ApplicationError(applicationErrorCodes.providerNotFound);
        const reference =
          profile.kind === 's3'
            ? profile.secret
            : profile.authentication.method === 'password'
              ? profile.authentication.secret
              : profile.authentication.method === 'private-key'
                ? profile.authentication.passphrase
                : undefined;
        if (
          reference &&
          !this.store.database
            .prepare('SELECT id FROM credentials WHERE id = ? AND profile_id = ?')
            .get(reference.id, profile.id)
        ) {
          const existingIds = new Set(this.store.list().map((item) => item.id));
          importProfiles(
            this.store,
            exportProfiles(this.store, [{ ...profile, name: request.name }]),
          );
          savedProfileId = this.store.list().find((item) => !existingIds.has(item.id))?.id;
          break;
        }
        const clone = this.store.save(
          { ...profile, id: randomUUID(), name: request.name },
          reference ? this.credentials.read(reference.id) : undefined,
        );
        savedProfileId = clone.id;
        this.store.setSetting(
          `group:${clone.id}`,
          this.store.getSetting(`group:${profile.id}`) ?? '',
        );
        break;
      }
      case 'close-session': {
        for (const item of this.transfers.snapshots())
          if (
            item.workspaceId === request.workspaceId ||
            item.destinationWorkspaceId === request.workspaceId
          )
            this.transfers.cancel(item.id);
        // Дождаться завершения отмены перед отключением обоих концов потока.
        const deadline = Date.now() + 30000;
        while (this.transfers.hasActive(request.workspaceId) && Date.now() < deadline) {
          for (const item of this.transfers.snapshots())
            if (
              (item.workspaceId === request.workspaceId ||
                item.destinationWorkspaceId === request.workspaceId) &&
              item.state === 'requiring-review'
            )
              this.transfers.cancel(item.id);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (this.transfers.hasActive(request.workspaceId))
          throw new ApplicationError(applicationErrorCodes.providerConflict);
        await this.sessions.get(request.workspaceId)?.disconnect();
        this.sessions.delete(request.workspaceId);
        this.currentPaths.delete(request.workspaceId);
        break;
      }
      case 'local-operation': {
        const provider = await this.localProvider(request.path);
        const path = createLocalProviderPath(request.path);
        if (request.operation === 'mkdir') await provider.createDirectory(path);
        else if (request.operation === 'delete') await provider.delete(path, { recursive: true });
        else {
          if (!request.destinationPath)
            throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
          await this.localProvider(request.destinationPath);
          await provider.rename(path, createLocalProviderPath(request.destinationPath), {
            overwrite: false,
          });
        }
        break;
      }
      case 'local-transfer': {
        const source = await this.localProvider(request.sourcePath);
        const destination = await this.localProvider(request.destinationDirectory);
        const sourcePath = resolve(request.sourcePath);
        const destinationPath = resolve(request.destinationDirectory, basename(sourcePath));
        const remainder = relative(sourcePath, destinationPath);
        if (
          remainder === '' ||
          (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))
        )
          throw new ApplicationError(applicationErrorCodes.providerConflict);
        this.transfers.enqueue({
          workspaceId: request.workspaceId,
          direction: 'download',
          conflictPolicy: request.conflictPolicy,
          source,
          destination,
          sourcePath: createLocalProviderPath(sourcePath),
          destinationPath: createLocalProviderPath(destinationPath),
        });
        break;
      }
      case 'snapshot':
        break;
      case 'save-s3-profile': {
        const draft = request.profile;
        if (draft.id && this.journal(draft.id).list().length)
          throw new ApplicationError(applicationErrorCodes.s3Cleanup);
        const previous = this.store.list().find((item) => item.id === draft.id);
        if (previous && previous.kind !== 's3')
          throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
        let secretAccessKey = request.secretAccessKey;
        let sessionToken = request.sessionToken;
        if (previous?.secret) {
          const old = s3CredentialsSchema.parse(
            JSON.parse(this.credentials.read(previous.secret.id)),
          );
          secretAccessKey ??= old.secretAccessKey;
          sessionToken ??= old.sessionToken;
        }
        if (!secretAccessKey) throw new ApplicationError(applicationErrorCodes.credentialRequired);
        const profile: S3ConnectionProfile = {
          id: draft.id ?? randomUUID(),
          name: draft.name,
          kind: 's3',
          region: draft.region,
          accessKeyId: draft.accessKeyId,
          forcePathStyle: draft.forcePathStyle,
          initialPrefix: draft.initialPrefix,
          ...(draft.bucket ? { bucket: draft.bucket } : {}),
          ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
        };
        savedProfileId = this.store.save(
          profile,
          JSON.stringify({ secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }),
        ).id;
        break;
      }
      case 'preview-delete': {
        const provider = this.session(request.workspaceId);
        if (!(provider instanceof S3Provider))
          throw new ApplicationError(applicationErrorCodes.providerUnsupported);
        deletion = await provider.previewDelete(this.remotePath(provider, request.path));
        break;
      }
      case 'cleanup-multipart': {
        const profile = this.store.list().find((item) => item.id === request.profileId);
        if (profile?.kind !== 's3')
          throw new ApplicationError(applicationErrorCodes.providerNotFound);
        for (const [workspaceId, provider] of this.sessions)
          if (
            this.profile(provider).id === profile.id &&
            (this.transfers.hasActive(workspaceId) || this.mutating.has(workspaceId))
          )
            throw new ApplicationError(applicationErrorCodes.providerConflict);
        const provider = this.s3Provider(profile);
        const records = provider.journal.list();
        try {
          await provider.connect();
          for (const item of records) await provider.cleanupUpload(item.uploadId);
        } finally {
          await provider.disconnect();
        }
        break;
      }
      case 'save-profile': {
        const draft = request.profile;
        const previous = this.store.list().find((profile) => profile.id === draft.id);
        const existing = previous?.kind === 'sftp' ? previous.authentication : undefined;
        const reference = { id: randomUUID(), storage: 'safe-storage' as const };
        if (
          draft.authMode === 'password' &&
          request.secret === undefined &&
          existing?.method !== 'password'
        )
          throw new ApplicationError(applicationErrorCodes.credentialRequired);
        if (draft.authMode === 'private-key' && !isAbsolute(draft.privateKeyPath))
          throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
        const profile: SftpConnectionProfile = {
          id: draft.id ?? randomUUID(),
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
              : draft.authMode === 'password'
                ? {
                    method: 'password',
                    secret: existing?.method === 'password' ? existing.secret : reference,
                  }
                : {
                    method: 'private-key',
                    privateKeyPath: draft.privateKeyPath,
                    ...(existing?.method === 'private-key' && existing.passphrase
                      ? { passphrase: existing.passphrase }
                      : {}),
                  },
        };
        savedProfileId = this.store.save(profile, request.secret).id;
        break;
      }
      case 'delete-profile': {
        if (this.journal(request.profileId).list().length > 0)
          throw new ApplicationError(applicationErrorCodes.s3Cleanup);
        for (const [workspaceId, provider] of this.sessions)
          if (this.profile(provider).id === request.profileId) {
            if (this.transfers.hasActive(workspaceId))
              throw new ApplicationError(applicationErrorCodes.providerConflict);
            await provider.disconnect();
            this.sessions.delete(workspaceId);
          }
        this.store.delete(request.profileId);
        break;
      }
      case 'connect': {
        if (this.transfers.hasActive(request.workspaceId))
          throw new ApplicationError(applicationErrorCodes.providerConflict);
        const profile = this.store.list().find((entry) => entry.id === request.profileId);
        if (!profile) throw new ApplicationError(applicationErrorCodes.providerNotFound);
        let provider = this.sessions.get(request.workspaceId);
        if (
          provider === undefined ||
          JSON.stringify(this.profile(provider)) !== JSON.stringify(profile)
        ) {
          await provider?.disconnect();
          provider =
            profile.kind === 's3'
              ? this.s3Provider(profile)
              : new SftpProvider(
                  new SftpConnection(profile, () => this.credentialsFor(profile), this.store),
                );
          this.sessions.set(request.workspaceId, provider);
        }
        if (provider instanceof S3Provider) await provider.testConnection();
        else await provider.connect();
        break;
      }
      case 'trust-host': {
        const provider = this.session(request.workspaceId);
        if (!(provider instanceof SftpProvider))
          throw new ApplicationError(applicationErrorCodes.providerUnsupported);
        const pending = provider.connection.hostKey;
        if (!pending || pending.changed || pending.fingerprint !== request.fingerprint)
          throw new ApplicationError(applicationErrorCodes.hostKeyChanged);
        this.store.trustHost(
          provider.connection.profile.host,
          provider.connection.profile.port,
          pending.fingerprint,
        );
        break;
      }
      case 'disconnect':
        if (this.transfers.hasActive(request.workspaceId))
          throw new ApplicationError(applicationErrorCodes.providerConflict);
        await this.sessions.get(request.workspaceId)?.disconnect();
        this.sessions.delete(request.workspaceId);
        break;
      case 'list':
        listing = await this.listing(request.workspaceId, request.path);
        this.currentPaths.set(request.workspaceId, listing.currentPath);
        {
          const profileId = this.profile(this.session(request.workspaceId)).id;
          const currentPath = listing.currentPath;
          this.store.setSetting(
            `recent:${profileId}`,
            JSON.stringify(
              [
                currentPath,
                ...this.recentPaths(profileId).filter((path) => path !== currentPath),
              ].slice(0, 20),
            ),
          );
        }
        break;
      case 'mkdir': {
        const provider = this.session(request.workspaceId);
        await provider.createDirectory(this.remotePath(provider, request.path));
        break;
      }
      case 'copy':
      case 'rename': {
        const provider = this.session(request.workspaceId);
        if (request.action === 'copy') {
          if (!(provider instanceof S3Provider))
            throw new ApplicationError(applicationErrorCodes.providerUnsupported);
          await provider.copy(
            this.remotePath(provider, request.path),
            this.remotePath(provider, request.destinationPath),
          );
        } else
          await provider.rename(
            this.remotePath(provider, request.path),
            this.remotePath(provider, request.destinationPath),
          );
        break;
      }
      case 'delete': {
        const provider = this.session(request.workspaceId);
        if (provider instanceof S3Provider) {
          if (!request.confirmationId)
            throw new ApplicationError(applicationErrorCodes.providerConflict);
          await provider.deleteConfirmed(
            this.remotePath(provider, request.path),
            request.confirmationId,
          );
        } else
          await provider.delete(createSftpProviderPath(request.path), {
            recursive: request.recursive,
          });
        break;
      }
      case 'transfer': {
        const remote = this.session(request.workspaceId);
        if (remote.connectionState !== 'connected')
          throw new ApplicationError(applicationErrorCodes.providerNotConnected);
        const isUpload = request.direction === 'upload';
        const local = await this.localProvider(
          isUpload ? request.sourcePath : request.destinationDirectory,
        );
        const remoteSource = this.remotePath(
          remote,
          isUpload ? request.destinationDirectory : request.sourcePath,
        );
        const name = isUpload
          ? basename(request.sourcePath)
          : remoteSource.provider === 's3'
            ? s3Name(remoteSource.key)
            : posix.basename(request.sourcePath);
        if (
          !name ||
          name.includes('\\') ||
          name.includes('/') ||
          name.includes('\0') ||
          name === '.' ||
          name === '..'
        )
          throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
        this.transfers.enqueue({
          workspaceId: request.workspaceId,
          direction: request.direction,
          conflictPolicy: request.conflictPolicy,
          source: isUpload ? local : remote,
          destination: isUpload ? remote : local,
          ...(isUpload
            ? { destinationProfileId: this.profile(remote).id }
            : { sourceProfileId: this.profile(remote).id }),
          sourcePath: isUpload ? createLocalProviderPath(request.sourcePath) : remoteSource,
          destinationPath: isUpload
            ? remoteSource.provider === 's3'
              ? createS3ProviderPath(remoteSource.bucket, `${s3Prefix(remoteSource.key)}${name}`)
              : createSftpProviderPath(posix.join(request.destinationDirectory, name))
            : createLocalProviderPath(join(request.destinationDirectory, name)),
        });
        break;
      }
      case 'remote-transfer': {
        const source = this.session(request.workspaceId);
        const destination = this.session(request.destinationWorkspaceId);
        if (source.connectionState !== 'connected' || destination.connectionState !== 'connected')
          throw new ApplicationError(applicationErrorCodes.providerNotConnected);
        const sourcePath = this.remotePath(source, request.sourcePath);
        const parent = this.remotePath(destination, request.destinationDirectory);
        const name =
          sourcePath.provider === 's3'
            ? s3Name(sourcePath.key)
            : posix.basename(request.sourcePath);
        if (!name || /[\\/\0]/u.test(name) || name === '.' || name === '..')
          throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
        const destinationPath =
          parent.provider === 's3'
            ? createS3ProviderPath(parent.bucket, `${s3Prefix(parent.key)}${name}`)
            : createSftpProviderPath(posix.join(request.destinationDirectory, name));
        const sourceProfile = this.profile(source);
        const targetProfile = this.profile(destination);
        const sameServer =
          sourceProfile.kind === 'sftp' && targetProfile.kind === 'sftp'
            ? sourceProfile.host.toLowerCase() === targetProfile.host.toLowerCase() &&
              sourceProfile.port === targetProfile.port
            : sourceProfile.kind === 's3' &&
              targetProfile.kind === 's3' &&
              (sourceProfile.endpoint ?? 'aws') === (targetProfile.endpoint ?? 'aws');
        const original =
          sourcePath.provider === 's3'
            ? formatS3Path(sourcePath)
            : posix.resolve(request.sourcePath);
        const target =
          destinationPath.provider === 's3'
            ? formatS3Path(destinationPath)
            : posix.resolve(destinationPath.path);
        if (
          sameServer &&
          (target === original || target.startsWith(`${original.replace(/\/$/u, '')}/`))
        )
          throw new ApplicationError(applicationErrorCodes.providerConflict);
        this.transfers.enqueue({
          ...request,
          direction: 'remote',
          source,
          destination,
          sourcePath,
          destinationPath,
          sourceProfileId: this.profile(source).id,
          destinationProfileId: this.profile(destination).id,
        });
        break;
      }
      case 'cancel-transfer':
        this.transfers.cancel(request.id);
        break;
      case 'retry-transfer':
        await this.transfers.retry(request.id, request.resume);
        break;
      case 'resolve-conflict':
        this.transfers.resolveConflict(request.id, request.policy);
        break;
      case 'pick-private-key':
        privateKeyPath = await this.pickPrivateKey();
        break;
      case 'set-language':
        this.store.setSetting('language', request.language);
        this.changeLanguage?.(request.language);
        break;
      case 'create-profile-folder':
        this.store.addFolder(request.name);
        break;
      case 'set-appearance':
        this.store.setSetting('appearance', JSON.stringify(request.appearance));
        break;
    }
    return {
      snapshot: this.snapshot(),
      listing,
      privateKeyPath,
      ...(deletion ? { deletion } : {}),
      ...(document !== undefined ? { document } : {}),
      ...(importSummary ? { importSummary } : {}),
      ...(savedProfileId ? { savedProfileId } : {}),
    };
  }
}
