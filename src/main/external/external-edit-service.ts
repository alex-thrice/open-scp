import { createHash, randomUUID } from 'node:crypto';
import { chmod, open, mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ProviderPath } from '@shared/models/provider-path';
import { createLocalProviderPath } from '@shared/models/provider-path';
import type { FileSystemProvider } from '@shared/providers/file-system-provider';
import { ProviderError, providerErrorCodes } from '@shared/providers/provider-error';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';
import type { ProfileStore } from '../persistence/profile-store';
import type { TransferEngine } from '../transfers/transfer-engine';

type ExternalEditState = 'changed' | 'conflict' | 'failed' | 'recovered' | 'uploading' | 'watching';

interface ExternalEditRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly remotePath: string;
  readonly fileName: string;
  readonly temporaryDirectory: string;
  readonly temporaryPath: string;
  readonly originalSize: string;
  readonly originalModifiedAt: string | null;
  readonly originalVersionTag: string | null;
  readonly originalHash?: string | undefined;
  readonly localSize: number;
  readonly localModifiedAt: number;
  state: ExternalEditState;
  errorKey: string | null;
  transferId?: string | undefined;
}

export interface ExternalEditSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly remotePath: string;
  readonly fileName: string;
  readonly state: ExternalEditState;
  readonly errorKey: string | null;
}

export interface RemoteEditEndpoint {
  readonly provider: FileSystemProvider;
  readonly path: ProviderPath;
  readonly profileId: string;
}

const recordSchema = z.strictObject({
  id: z.string().uuid(),
  workspaceId: z.string().min(1).max(200),
  profileId: z.string().min(1).max(200),
  remotePath: z.string().min(1).max(32768),
  fileName: z.string().min(1).max(1024),
  temporaryDirectory: z.string().min(1).max(32768),
  temporaryPath: z.string().min(1).max(32768),
  originalSize: z.string().regex(/^\d+$/u),
  originalModifiedAt: z.string().nullable(),
  originalVersionTag: z.string().nullable(),
  originalHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  localSize: z.number().int().nonnegative(),
  localModifiedAt: z.number().nonnegative(),
  state: z.enum(['changed', 'conflict', 'failed', 'recovered', 'uploading', 'watching']),
  errorKey: z.string().nullable(),
  transferId: z.string().optional(),
});

const isSafeTemporaryDirectory = (path: string): boolean => {
  if (!isAbsolute(path) || !basename(path).startsWith('openscp-edit-')) return false;
  const remainder = relative(resolve(tmpdir()), resolve(path));
  return remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`);
};

const readRecords = (store: ProfileStore): ExternalEditRecord[] => {
  try {
    const parsed = z
      .array(recordSchema)
      .max(100)
      .parse(JSON.parse(store.getSetting('external-edits-v1') ?? '[]'));
    return parsed.filter(
      (record) =>
        isSafeTemporaryDirectory(record.temporaryDirectory) &&
        resolve(record.temporaryPath).startsWith(`${resolve(record.temporaryDirectory)}${sep}`) &&
        existsSync(record.temporaryPath),
    );
  } catch {
    return [];
  }
};

export class ExternalEditService {
  private readonly records = new Map<string, ExternalEditRecord>();

  public constructor(
    private readonly store: ProfileStore,
    private readonly transfers: TransferEngine,
    private readonly launchEditor: (path: string, configuredPath: string | null) => Promise<void>,
    private readonly resolveRemote: (
      workspaceId: string,
      path: string,
    ) => Promise<RemoteEditEndpoint>,
    private readonly resolveLocal: (path: string) => Promise<FileSystemProvider>,
  ) {
    for (const stored of readRecords(store))
      this.records.set(stored.id, {
        ...stored,
        state: stored.state === 'uploading' ? 'uploading' : 'recovered',
        errorKey: null,
      });
    this.persist();
  }

  private persist(): void {
    this.store.setSetting('external-edits-v1', JSON.stringify([...this.records.values()]));
  }

  private cleanup(record: ExternalEditRecord): void {
    if (isSafeTemporaryDirectory(record.temporaryDirectory))
      rmSync(record.temporaryDirectory, { recursive: true, force: true });
  }

  private refresh(): void {
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.state === 'watching') {
        try {
          const current = statSync(record.temporaryPath);
          if (current.size !== record.localSize || current.mtimeMs !== record.localModifiedAt) {
            record.state = 'changed';
            changed = true;
          }
        } catch {
          record.state = 'failed';
          record.errorKey = 'errors.provider.notFound';
          changed = true;
        }
      } else if (record.state === 'uploading' && record.transferId) {
        const transfer = this.transfers.snapshots().find((item) => item.id === record.transferId);
        if (transfer?.state === 'completed') {
          this.cleanup(record);
          this.records.delete(id);
          changed = true;
        } else if (transfer && ['failed', 'cancelled'].includes(transfer.state)) {
          record.state = 'failed';
          record.errorKey = transfer.errorKey;
          changed = true;
        }
      }
    }
    if (changed) this.persist();
  }

  public snapshots(): readonly ExternalEditSnapshot[] {
    this.refresh();
    return [...this.records.values()].map((record) => ({
      id: record.id,
      workspaceId: record.workspaceId,
      remotePath: record.remotePath,
      fileName: record.fileName,
      state: record.state,
      errorKey: record.errorKey,
    }));
  }

  public async open(workspaceId: string, remotePath: string): Promise<void> {
    if (
      [...this.records.values()].some(
        (record) => record.workspaceId === workspaceId && record.remotePath === remotePath,
      )
    )
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    const endpoint = await this.resolveRemote(workspaceId, remotePath);
    const entry = await endpoint.provider.stat(endpoint.path);
    if (entry.kind !== 'file')
      throw new ApplicationError(applicationErrorCodes.providerUnsupported);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'openscp-edit-'));
    try {
      await chmod(temporaryDirectory, 0o700);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    const safeName = entry.name.split(/[\\/]/u).at(-1);
    const fileName = !safeName || safeName === '.' || safeName === '..' ? 'remote-file' : safeName;
    const temporaryPath = join(temporaryDirectory, fileName);
    const file = await open(temporaryPath, 'wx', 0o600);
    const reader = (await endpoint.provider.openRead(endpoint.path)).getReader();
    const originalHash = createHash('sha256');
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        originalHash.update(part.value);
        await file.write(part.value);
      }
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await file.close();
    }
    const local = await stat(temporaryPath);
    const record: ExternalEditRecord = {
      id: randomUUID(),
      workspaceId,
      profileId: endpoint.profileId,
      remotePath,
      fileName,
      temporaryDirectory,
      temporaryPath,
      originalSize: entry.size.toString(),
      originalModifiedAt: entry.modifiedAt ?? null,
      originalVersionTag: entry.versionTag ?? null,
      originalHash: originalHash.digest('hex'),
      localSize: local.size,
      localModifiedAt: local.mtimeMs,
      state: 'watching',
      errorKey: null,
    };
    this.records.set(record.id, record);
    this.persist();
    try {
      await this.launchEditor(temporaryPath, this.store.getSetting('editor-path') || null);
    } catch (error) {
      this.records.delete(record.id);
      this.cleanup(record);
      this.persist();
      throw error;
    }
  }

  private async destinationChanged(record: ExternalEditRecord): Promise<boolean> {
    const endpoint = await this.resolveRemote(record.workspaceId, record.remotePath);
    try {
      const current = await endpoint.provider.stat(endpoint.path);
      if (
        current.kind !== 'file' ||
        current.size.toString() !== record.originalSize ||
        (current.modifiedAt ?? null) !== record.originalModifiedAt ||
        (current.versionTag ?? null) !== record.originalVersionTag
      )
        return true;
      if (!record.originalHash) return true;
      const hash = createHash('sha256');
      const reader = (await endpoint.provider.openRead(endpoint.path)).getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          hash.update(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return hash.digest('hex') !== record.originalHash;
    } catch (error) {
      if (error instanceof ProviderError && error.code === providerErrorCodes.notFound) return true;
      throw error;
    }
  }

  public async resolve(id: string, resolution: 'upload' | 'overwrite' | 'discard'): Promise<void> {
    this.refresh();
    const record = this.records.get(id);
    if (!record) throw new ApplicationError(applicationErrorCodes.providerNotFound);
    if (record.state === 'uploading')
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (resolution === 'discard') {
      this.cleanup(record);
      this.records.delete(id);
      this.persist();
      return;
    }
    if (resolution === 'upload' && (await this.destinationChanged(record))) {
      record.state = 'conflict';
      record.errorKey = null;
      this.persist();
      return;
    }
    const endpoint = await this.resolveRemote(record.workspaceId, record.remotePath);
    if (endpoint.profileId !== record.profileId)
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    const source = await this.resolveLocal(record.temporaryPath);
    const transferId = this.transfers.enqueue({
      workspaceId: record.workspaceId,
      direction: 'upload',
      conflictPolicy: 'overwrite',
      source,
      destination: endpoint.provider,
      destinationProfileId: record.profileId,
      sourcePath: createLocalProviderPath(record.temporaryPath),
      destinationPath: endpoint.path,
    });
    record.state = 'uploading';
    record.errorKey = null;
    record.transferId = transferId;
    this.persist();
  }

  public dispose(): void {
    this.refresh();
    this.persist();
  }
}
