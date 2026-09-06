import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, posix } from 'node:path';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import {
  createLocalProviderPath,
  createSftpProviderPath,
  createS3ProviderPath,
  type ProviderPath,
} from '@shared/models/provider-path';
import type { TransferConflictPolicy } from '@shared/models/transfer-operation';
import type { TransferSnapshot } from '@shared/models/transfer-snapshot';
import type { FileSystemProvider } from '@shared/providers/file-system-provider';
import { ProviderError, providerErrorCodes } from '@shared/providers/provider-error';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError, serializeApplicationError } from '../ipc/application-error';
import { formatS3Path, parseS3Path, s3Prefix, s3Name } from '@shared/models/s3-path';
import { classifyTransferError, waitForReconnect } from './reconnect-policy';
import type { QueueRecord, TransferIntent } from './queue-journal';

export interface TransferRequest {
  readonly source: FileSystemProvider;
  readonly destination: FileSystemProvider;
  readonly sourcePath: ProviderPath;
  readonly destinationPath: ProviderPath;
  readonly workspaceId: string;
  readonly direction: 'upload' | 'download' | 'remote';
  readonly destinationWorkspaceId?: string;
  readonly sourceProfileId?: string | undefined;
  readonly destinationProfileId?: string | undefined;
  readonly conflictPolicy: TransferConflictPolicy;
}
interface PartialFile {
  readonly temporary: ProviderPath;
  readonly sourceSize: bigint;
  readonly modifiedAt: string | undefined;
  readonly versionTag: string | undefined;
}
interface TransferJob {
  readonly request: TransferRequest;
  snapshot: TransferSnapshot;
  controller: AbortController;
  readonly partials: Map<string, PartialFile>;
  readonly completed: Map<string, bigint>;
  readonly targets: Map<string, ProviderPath>;
  readonly pendingTargets: Map<string, ProviderPath>;
  readonly overwriteTargets: Set<string>;
  readonly conflictResolutions: Map<string, TransferConflictPolicy>;
  started: number;
  resume: boolean;
  publishing: boolean;
}
const localPath = (path: ProviderPath): string => {
  if (path.provider === 's3') return formatS3Path(path);
  return path.path;
};
const childPath = (parent: ProviderPath, name: string): ProviderPath => {
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  )
    throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
  if (parent.provider === 's3')
    return createS3ProviderPath(parent.bucket, `${s3Prefix(parent.key)}${name}`);
  if (
    parent.provider === 'local' &&
    process.platform === 'win32' &&
    (/[<>:"|?*]/u.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      /[. ]$/u.test(name) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name))
  )
    throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
  return parent.provider === 'local'
    ? createLocalProviderPath(join(parent.path, name))
    : createSftpProviderPath(posix.join(localPath(parent), name));
};
const siblingPath = (path: ProviderPath, name: string): ProviderPath =>
  path.provider === 's3'
    ? createS3ProviderPath(
        path.bucket,
        `${path.key.slice(0, (path.key.endsWith('/') ? path.key.slice(0, -1) : path.key).lastIndexOf('/') + 1)}${name}${path.key.endsWith('/') ? '/' : ''}`,
      )
    : path.provider === 'local'
      ? createLocalProviderPath(join(dirname(path.path), name))
      : createSftpProviderPath(posix.join(posix.dirname(localPath(path)), name));
const nameOf = (path: ProviderPath) =>
  path.provider === 's3'
    ? s3Name(path.key)
    : path.provider === 'local'
      ? basename(path.path)
      : posix.basename(localPath(path));
const tryStat = async (
  provider: FileSystemProvider,
  path: ProviderPath,
): Promise<FileSystemEntry | undefined> => {
  try {
    return await provider.stat(path);
  } catch (error) {
    if (error instanceof ProviderError && error.code === providerErrorCodes.notFound)
      return undefined;
    throw error;
  }
};
const providerPathFromText = (reference: ProviderPath, path: string): ProviderPath =>
  reference.provider === 'local'
    ? createLocalProviderPath(path)
    : reference.provider === 'sftp'
      ? createSftpProviderPath(path)
      : parseS3Path(path);

export class TransferEngine {
  private readonly jobs = new Map<string, TransferJob>();
  private readonly restored = new Map<string, QueueRecord>();
  private readonly retrying = new Set<string>();
  private running = false;
  private disposed = false;
  public constructor(
    private readonly persistence?: {
      load(): QueueRecord[];
      save(records: readonly QueueRecord[]): void;
      resolve(intent: TransferIntent, snapshot: TransferSnapshot): Promise<TransferRequest>;
    },
  ) {
    for (const record of persistence?.load() ?? []) {
      const finished = ['completed', 'cancelled'].includes(record.snapshot.state);
      const pendingConflict =
        record.snapshot.state === 'requiring-review' && record.snapshot.conflictPath !== null;
      this.restored.set(record.snapshot.id, {
        ...record,
        snapshot:
          finished || pendingConflict
            ? record.snapshot
            : {
                ...record.snapshot,
                state: 'requiring-review',
                reviewReason: 'restart',
                conflictPolicy: 'ask',
                conflictPath: null,
                conflictSourcePath: null,
                errorKey: null,
                speed: 0,
                remaining: null,
              },
      });
    }
    this.persist();
  }
  private persist(): void {
    if (this.disposed) return;
    const records: QueueRecord[] = [
      ...this.restored.values(),
      ...[...this.jobs.values()].map(({ request, snapshot }) => ({
        snapshot,
        intent: {
          sourcePath: request.sourcePath,
          destinationPath: request.destinationPath,
          ...(request.sourceProfileId ? { sourceProfileId: request.sourceProfileId } : {}),
          ...(request.destinationProfileId
            ? { destinationProfileId: request.destinationProfileId }
            : {}),
        },
      })),
    ];
    this.persistence?.save(records);
  }
  public dispose(): void {
    this.persist();
    this.disposed = true;
    for (const job of this.jobs.values()) job.controller.abort();
  }
  public snapshots(): readonly TransferSnapshot[] {
    return [...this.restored.values()]
      .map((record) => record.snapshot)
      .concat([...this.jobs.values()].map((job) => job.snapshot));
  }
  public clearHistory(): void {
    for (const [id, job] of this.jobs)
      if (['completed', 'cancelled'].includes(job.snapshot.state)) this.jobs.delete(id);
    for (const [id, record] of this.restored)
      if (['completed', 'cancelled'].includes(record.snapshot.state)) this.restored.delete(id);
    this.persist();
  }
  public hasActive(workspaceId: string): boolean {
    return [...this.jobs.values()]
      .map((job) => job.snapshot)
      .some(
        (item) =>
          (item.workspaceId === workspaceId || item.destinationWorkspaceId === workspaceId) &&
          ['running', 'queued', 'requiring-review'].includes(item.state),
      );
  }
  public enqueue(request: TransferRequest, id: string = randomUUID()): string {
    if (this.jobs.size + this.restored.size >= 10000)
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    const snapshot: TransferSnapshot = {
      id,
      workspaceId: request.workspaceId,
      sourcePath: localPath(request.sourcePath),
      destinationPath: localPath(request.destinationPath),
      direction: request.direction,
      ...(request.destinationWorkspaceId
        ? { destinationWorkspaceId: request.destinationWorkspaceId }
        : {}),
      state: 'queued',
      conflictPolicy: request.conflictPolicy,
      transferredBytes: 0n,
      totalBytes: 0n,
      speed: 0,
      elapsed: 0,
      remaining: null,
      errorKey: null,
      conflictPath: null,
    };
    this.jobs.set(id, {
      request,
      snapshot,
      controller: new AbortController(),
      partials: new Map(),
      completed: new Map(),
      targets: new Map(),
      pendingTargets: new Map(),
      overwriteTargets: new Set(),
      conflictResolutions: new Map(),
      started: 0,
      resume: true,
      publishing: false,
    });
    this.persist();
    void this.drain();
    return id;
  }
  public cancel(id: string): void {
    const restored = this.restored.get(id);
    if (restored) {
      if (restored.snapshot.state !== 'completed')
        this.restored.set(id, {
          ...restored,
          snapshot: { ...restored.snapshot, state: 'cancelled' },
        });
      this.persist();
      return;
    }
    const job = this.requireJob(id);
    if (job.snapshot.state === 'completed') return;
    job.controller.abort();
    if (job.snapshot.state !== 'running') job.snapshot = { ...job.snapshot, state: 'cancelled' };
    this.persist();
  }
  public async retry(id: string, resume: boolean): Promise<void> {
    const restored = this.restored.get(id);
    if (restored && this.persistence) {
      if (restored.snapshot.state === 'completed' || this.retrying.has(id)) return;
      this.retrying.add(id);
      try {
        const request = await this.persistence.resolve(restored.intent, restored.snapshot);
        if (this.disposed || this.restored.get(id) !== restored) return;
        this.restored.delete(id);
        this.enqueue({ ...request, conflictPolicy: 'ask' }, id);
      } finally {
        this.retrying.delete(id);
      }
      return;
    }
    const job = this.requireJob(id);
    if (!['failed', 'cancelled', 'requiring-review'].includes(job.snapshot.state)) return;
    job.controller = new AbortController();
    job.resume = resume;
    const { reviewReason: _reviewReason, ...snapshot } = job.snapshot;
    void _reviewReason;
    if (job.publishing) {
      job.targets.clear();
      job.pendingTargets.clear();
      job.overwriteTargets.clear();
      job.publishing = false;
    }
    job.snapshot = {
      ...snapshot,
      state: 'queued',
      errorKey: null,
      conflictPath: null,
      conflictSourcePath: null,
      conflictPolicy: _reviewReason ? 'ask' : snapshot.conflictPolicy,
    };
    this.persist();
    void this.drain();
  }
  public async resolveConflict(
    id: string,
    policy: TransferConflictPolicy,
    applyToAll: boolean,
  ): Promise<void> {
    if (policy === 'ask' || policy === 'fail')
      throw new ApplicationError(applicationErrorCodes.providerConflict);

    const restored = this.restored.get(id);
    if (restored) {
      if (
        restored.snapshot.state !== 'requiring-review' ||
        !restored.snapshot.conflictPath ||
        !this.persistence
      )
        throw new ApplicationError(applicationErrorCodes.providerConflict);
      const request = await this.persistence.resolve(restored.intent, restored.snapshot);
      this.restored.delete(id);
      this.enqueue({ ...request, conflictPolicy: applyToAll ? policy : 'ask' }, id);
      const job = this.requireJob(id);
      if (restored.snapshot.conflictSourcePath)
        job.pendingTargets.set(
          restored.snapshot.conflictSourcePath,
          providerPathFromText(request.destinationPath, restored.snapshot.conflictPath),
        );
      if (!applyToAll) job.conflictResolutions.set(restored.snapshot.conflictPath, policy);
      return;
    }

    const job = this.requireJob(id);
    if (job.snapshot.state !== 'requiring-review' || !job.snapshot.conflictPath)
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (applyToAll) job.snapshot = { ...job.snapshot, conflictPolicy: policy };
    else job.conflictResolutions.set(job.snapshot.conflictPath, policy);
    void this.retry(id, true);
  }
  private requireJob(id: string): TransferJob {
    const job = this.jobs.get(id);
    if (!job) throw new ApplicationError(applicationErrorCodes.providerNotFound);
    return job;
  }
  private check(job: TransferJob): void {
    if (job.controller.signal.aborted)
      throw new ApplicationError(applicationErrorCodes.providerCancelled);
  }
  private async size(
    provider: FileSystemProvider,
    path: ProviderPath,
    job: TransferJob,
  ): Promise<bigint> {
    this.check(job);
    const entry = await provider.stat(path, { signal: job.controller.signal });
    if (entry.kind === 'file') return entry.size;
    if (entry.kind !== 'directory')
      throw new ApplicationError(applicationErrorCodes.providerUnsupported);
    let total = 0n;
    for (const child of await provider.list(path, { signal: job.controller.signal }))
      total += await this.size(provider, child.path, job);
    return total;
  }
  private progress(job: TransferJob, bytes: bigint): void {
    const elapsed = (Date.now() - job.started) / 1000;
    const transferredBytes = job.snapshot.transferredBytes + bytes;
    const speed = elapsed > 0 ? Number(transferredBytes) / elapsed : 0;
    job.snapshot = {
      ...job.snapshot,
      transferredBytes,
      elapsed,
      speed,
      remaining:
        speed > 0 ? Math.max(0, Number(job.snapshot.totalBytes - transferredBytes) / speed) : null,
    };
  }
  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.snapshot.state !== 'queued') continue;
        job.started = Date.now();
        job.snapshot = { ...job.snapshot, state: 'running' };
        this.persist();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            this.check(job);
            await job.request.source.connect();
            await job.request.destination.connect();
            const totalBytes = await this.size(job.request.source, job.request.sourcePath, job);
            const transferredBytes = [...job.completed.values()].reduce(
              (sum, value) => sum + value,
              0n,
            );
            job.snapshot = { ...job.snapshot, totalBytes, transferredBytes };
            await this.copy(job, job.request.sourcePath, job.request.destinationPath);
            this.check(job);
            job.snapshot = { ...job.snapshot, state: 'completed', remaining: 0 };
            break;
          } catch (error) {
            if (job.snapshot.state === 'requiring-review') break;
            const errorCategory = classifyTransferError(error);
            if (job.publishing && errorCategory !== 'auth' && errorCategory !== 'conflict') {
              job.snapshot = {
                ...job.snapshot,
                state: 'requiring-review',
                reviewReason: 'uncertain',
                errorKey: serializeApplicationError(error).messageKey,
              };
              break;
            }
            job.publishing = false;
            if (job.controller.signal.aborted) {
              job.snapshot = { ...job.snapshot, state: 'cancelled' };
              break;
            }
            if (errorCategory === 'transient' && attempt < 2) {
              await waitForReconnect(attempt, job.controller.signal);
              continue;
            }
            job.snapshot = {
              ...job.snapshot,
              state: 'failed',
              errorKey: serializeApplicationError(error).messageKey,
              errorCategory,
            };
            break;
          }
        }
        this.persist();
      }
    } finally {
      this.running = false;
      if ([...this.jobs.values()].some((job) => job.snapshot.state === 'queued')) void this.drain();
    }
  }
  private async target(
    job: TransferJob,
    sourcePath: ProviderPath,
    requested: ProviderPath,
    sourceEntry: FileSystemEntry,
  ): Promise<ProviderPath | undefined> {
    const key = localPath(requested);
    const cached = job.targets.get(key);
    if (cached) return cached;
    const existing = await tryStat(job.request.destination, requested);
    if (!existing) {
      job.conflictResolutions.delete(key);
      job.pendingTargets.delete(localPath(sourcePath));
      job.targets.set(key, requested);
      return requested;
    }
    const policy = job.conflictResolutions.get(key) ?? job.snapshot.conflictPolicy;
    if (policy === 'skip') {
      job.conflictResolutions.delete(key);
      job.pendingTargets.delete(localPath(sourcePath));
      return undefined;
    }
    if (policy === 'ask') {
      job.snapshot = {
        ...job.snapshot,
        state: 'requiring-review',
        conflictPath: key,
        conflictSourcePath: localPath(sourcePath),
      };
      job.pendingTargets.set(localPath(sourcePath), requested);
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    }
    if (policy === 'fail') throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (policy === 'overwrite') {
      if (
        existing.kind !== sourceEntry.kind ||
        (existing.kind !== 'file' && existing.kind !== 'directory')
      )
        throw new ApplicationError(applicationErrorCodes.providerConflict);
      job.conflictResolutions.delete(key);
      job.pendingTargets.delete(localPath(sourcePath));
      job.targets.set(key, requested);
      job.overwriteTargets.add(key);
      return requested;
    }
    for (let index = 1; index <= 10000; index += 1) {
      const candidate = siblingPath(requested, `${nameOf(requested)} (${index})`);
      if (!(await tryStat(job.request.destination, candidate))) {
        job.conflictResolutions.delete(key);
        job.pendingTargets.delete(localPath(sourcePath));
        job.targets.set(key, candidate);
        return candidate;
      }
    }
    throw new ApplicationError(applicationErrorCodes.providerConflict);
  }
  private pauseForConflict(
    job: TransferJob,
    sourcePath: ProviderPath,
    target: ProviderPath,
    error: unknown,
  ): never {
    if (classifyTransferError(error) !== 'conflict') throw error;
    const path = localPath(target);
    for (const [key, value] of job.targets) if (localPath(value) === path) job.targets.delete(key);
    job.pendingTargets.set(localPath(sourcePath), target);
    job.overwriteTargets.delete(path);
    job.publishing = false;
    job.snapshot = {
      ...job.snapshot,
      state: 'requiring-review',
      conflictPolicy: 'ask',
      conflictPath: path,
      conflictSourcePath: localPath(sourcePath),
    };
    throw new ApplicationError(applicationErrorCodes.providerConflict);
  }
  private async prefixHash(
    provider: FileSystemProvider,
    path: ProviderPath,
    length: bigint,
    job: TransferJob,
  ): Promise<string> {
    const reader = (await provider.openRead(path, { signal: job.controller.signal })).getReader();
    const hash = createHash('sha256');
    let remaining = length;
    try {
      while (remaining > 0n) {
        this.check(job);
        const part = await reader.read();
        if (part.done) throw new ApplicationError(applicationErrorCodes.unsafeResume);
        const size = Number(
          remaining < BigInt(part.value.length) ? remaining : BigInt(part.value.length),
        );
        hash.update(part.value.subarray(0, size));
        remaining -= BigInt(size);
      }
      return hash.digest('hex');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  private async copy(
    job: TransferJob,
    sourcePath: ProviderPath,
    requested: ProviderPath,
  ): Promise<void> {
    this.check(job);
    const key = localPath(sourcePath);
    if (job.completed.has(key)) return;
    const { source, destination } = job.request;
    const entry = await source.stat(sourcePath, { signal: job.controller.signal });
    requested = job.pendingTargets.get(key) ?? requested;
    if (requested.provider === 'local')
      childPath(createLocalProviderPath(dirname(requested.path)), basename(requested.path));
    if (requested.provider === 's3' && entry.kind === 'directory')
      requested = createS3ProviderPath(requested.bucket, s3Prefix(requested.key));
    const target = await this.target(job, sourcePath, requested, entry);
    if (target === undefined) {
      job.completed.set(key, entry.kind === 'file' ? entry.size : 0n);
      return;
    }
    if (entry.kind === 'directory') {
      if (!(await tryStat(destination, target)))
        await destination.createDirectory(target, { signal: job.controller.signal });
      for (const child of await source.list(sourcePath, { signal: job.controller.signal }))
        await this.copy(job, child.path, childPath(target, child.name));
      return;
    }
    if (entry.kind !== 'file')
      throw new ApplicationError(applicationErrorCodes.providerUnsupported);
    if (destination.kind === 's3') {
      const existing = await tryStat(destination, target);
      const reader = (
        await source.openRead(sourcePath, { signal: job.controller.signal })
      ).getReader();
      const writer = await destination
        .openWrite(target, {
          overwrite: job.overwriteTargets.has(localPath(target)) && existing !== undefined,
          expectedSize: entry.size,
          ...(existing?.versionTag ? { versionTag: existing.versionTag } : {}),
          signal: job.controller.signal,
        })
        .then((stream) => stream.getWriter())
        .catch(async (error: unknown) => {
          await reader.cancel();
          throw error;
        });
      try {
        while (true) {
          this.check(job);
          const part = await reader.read();
          if (part.done) break;
          await writer.write(part.value);
          this.progress(job, BigInt(part.value.byteLength));
        }
        const current = await source.stat(sourcePath, { signal: job.controller.signal });
        if (
          current.size !== entry.size ||
          current.modifiedAt !== entry.modifiedAt ||
          current.versionTag !== entry.versionTag
        )
          throw new ApplicationError(applicationErrorCodes.unsafeResume);
        this.check(job);
        job.publishing = true;
        this.persist();
        try {
          await writer.close();
        } catch (error) {
          this.pauseForConflict(job, sourcePath, target, error);
        }
        job.publishing = false;
        job.completed.set(key, entry.size);
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        writer.releaseLock();
      }
      return;
    }
    let partial = job.partials.get(key);
    if (partial === undefined) {
      partial = {
        temporary: siblingPath(target, `.openscp-part-${job.snapshot.id}-${randomUUID()}`),
        sourceSize: entry.size,
        modifiedAt: entry.modifiedAt,
        versionTag: entry.versionTag,
      };
      job.partials.set(key, partial);
    }
    if (!job.resume) {
      partial = {
        temporary: partial.temporary,
        sourceSize: entry.size,
        modifiedAt: entry.modifiedAt,
        versionTag: entry.versionTag,
      };
      job.partials.set(key, partial);
    }
    let offset = 0n;
    const previous = await tryStat(destination, partial.temporary);
    if (previous !== undefined && !job.resume) {
      await destination.delete(partial.temporary, { recursive: false });
    } else if (previous !== undefined) {
      if (
        previous.kind !== 'file' ||
        previous.size > entry.size ||
        partial.sourceSize !== entry.size ||
        partial.modifiedAt !== entry.modifiedAt ||
        partial.versionTag !== entry.versionTag ||
        !source.capabilities.resumeRead ||
        !destination.capabilities.resumeWrite
      )
        throw new ApplicationError(applicationErrorCodes.unsafeResume);
      if (
        (await this.prefixHash(source, sourcePath, previous.size, job)) !==
        (await this.prefixHash(destination, partial.temporary, previous.size, job))
      )
        throw new ApplicationError(applicationErrorCodes.unsafeResume);
      offset = previous.size;
    }
    if (offset > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ApplicationError(applicationErrorCodes.unsafeResume);
    this.progress(job, offset);
    const reader = (
      await source.openRead(sourcePath, {
        offset: Number(offset),
        signal: job.controller.signal,
        ...(entry.versionTag ? { versionTag: entry.versionTag } : {}),
      })
    ).getReader();
    const writer = await destination
      .openWrite(partial.temporary, {
        offset: Number(offset),
        overwrite: previous !== undefined && job.resume,
        signal: job.controller.signal,
      })
      .then((stream) => stream.getWriter())
      .catch(async (error: unknown) => {
        await reader.cancel();
        throw error;
      });
    try {
      while (true) {
        this.check(job);
        const part = await reader.read();
        if (part.done) break;
        await writer.write(part.value);
        this.progress(job, BigInt(part.value.byteLength));
      }
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      writer.releaseLock();
    }
    const current = await source.stat(sourcePath);
    const written = await destination.stat(partial.temporary);
    if (
      current.size !== partial.sourceSize ||
      current.modifiedAt !== partial.modifiedAt ||
      current.versionTag !== partial.versionTag ||
      written.size !== entry.size
    )
      throw new ApplicationError(applicationErrorCodes.unsafeResume);
    this.check(job);
    if (
      !job.overwriteTargets.has(localPath(target)) &&
      (await tryStat(destination, target)) !== undefined
    )
      this.pauseForConflict(
        job,
        sourcePath,
        target,
        new ApplicationError(applicationErrorCodes.providerConflict),
      );
    job.publishing = true;
    this.persist();
    try {
      await destination.rename(partial.temporary, target, {
        overwrite: job.overwriteTargets.has(localPath(target)),
        signal: job.controller.signal,
      });
    } catch (error) {
      this.pauseForConflict(job, sourcePath, target, error);
    }
    job.publishing = false;
    job.completed.set(key, entry.size);
    job.partials.delete(key);
  }
}
