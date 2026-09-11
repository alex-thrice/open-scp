import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExternalDragSnapshot } from '@shared/ipc/file-drag';
import { createLocalProviderPath, type ProviderPath } from '@shared/models/provider-path';
import type { FileSystemProvider } from '@shared/providers/file-system-provider';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';
import { LocalProvider } from '../providers/local/local-provider';
import { TransferEngine } from '../transfers/transfer-engine';

export interface RemoteDragEndpoint {
  readonly provider: FileSystemProvider;
  readonly path: ProviderPath;
}

interface PreparedDrag {
  readonly id: string;
  readonly workspaceId: string;
  readonly paths: string[];
  readonly transferIds: string[];
  readonly totalBytes: bigint;
  terminal?: ExternalDragSnapshot;
}

const retentionMilliseconds = 24 * 60 * 60 * 1000;
const safeFileName = (name: string): string => {
  const sanitized = [...name]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/u.test(character) ? '_' : character,
    )
    .join('')
    .replace(/[. ]+$/u, '');
  if (!sanitized || sanitized === '.' || sanitized === '..') return 'remote-file';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
};

export class ExternalDragService {
  private readonly transfers = new TransferEngine();
  private readonly records = new Map<string, PreparedDrag>();
  private readonly pending = new Map<
    string,
    { id: string; controller: AbortController; fileCount: number }
  >();
  private initialization: Promise<void> | undefined;
  private disposed = false;

  public constructor(private readonly directory: string) {}

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^drag-[A-Za-z0-9]+$/u.test(entry.name)) continue;
      const path = join(resolve(this.directory), entry.name);
      const details = await lstat(path);
      // Удаляем старые копии при следующей подготовке после перезапуска приложения.
      if (Date.now() - details.mtimeMs > retentionMilliseconds)
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public async prepare(
    workspaceId: string,
    endpoints: readonly RemoteDragEndpoint[],
  ): Promise<void> {
    if (
      this.disposed ||
      this.hasActive(workspaceId) ||
      (this.records.size >= 100 &&
        ![...this.records.values()].some((record) => record.workspaceId === workspaceId))
    )
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    if (endpoints.length === 0 || endpoints.length > 100)
      throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
    const controller = new AbortController();
    const id = randomUUID();
    this.pending.set(workspaceId, { id, controller, fileCount: endpoints.length });
    try {
      await this.prepareFiles(id, workspaceId, endpoints, controller.signal);
    } finally {
      this.pending.delete(workspaceId);
    }
  }

  private async prepareFiles(
    id: string,
    workspaceId: string,
    endpoints: readonly RemoteDragEndpoint[],
    signal: AbortSignal,
  ): Promise<void> {
    const entries = [];
    for (const endpoint of endpoints) {
      if (endpoint.provider.connectionState !== 'connected')
        throw new ApplicationError(applicationErrorCodes.providerNotConnected);
      const entry = await endpoint.provider.stat(endpoint.path, { signal });
      signal.throwIfAborted();
      if (entry.kind !== 'file' || !endpoint.provider.capabilities.read)
        throw new ApplicationError(applicationErrorCodes.providerUnsupported);
      entries.push(entry);
    }
    this.initialization ??= this.initialize().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
    signal.throwIfAborted();
    if (this.disposed) throw new ApplicationError(applicationErrorCodes.providerConflict);
    const directory = await mkdtemp(join(this.directory, 'drag-'));
    const transferIds: string[] = [];
    try {
      await chmod(directory, 0o700);
      const local = new LocalProvider({ rootPath: directory });
      await local.connect();
      const paths: string[] = [];
      for (const [index, entry] of entries.entries()) {
        const destination = join(directory, String(index));
        await mkdir(destination, { mode: 0o700 });
        paths.push(join(destination, safeFileName(entry.name)));
      }
      if (this.disposed) throw new ApplicationError(applicationErrorCodes.providerConflict);
      signal.throwIfAborted();
      this.snapshots();
      this.transfers.clearHistory();
      for (const [index, endpoint] of endpoints.entries()) {
        const destinationPath = paths[index];
        if (!destinationPath) throw new ApplicationError(applicationErrorCodes.providerInvalidPath);
        transferIds.push(
          this.transfers.enqueue({
            workspaceId,
            source: endpoint.provider,
            sourcePath: endpoint.path,
            destination: local,
            destinationPath: createLocalProviderPath(destinationPath),
            direction: 'download',
            conflictPolicy: 'fail',
          }),
        );
      }
      for (const record of this.records.values())
        if (record.workspaceId === workspaceId) this.records.delete(record.id);
      this.records.set(id, {
        id,
        workspaceId,
        paths,
        transferIds,
        totalBytes: entries.reduce((total, entry) => total + entry.size, 0n),
      });
    } catch (error) {
      for (const id of transferIds) this.transfers.cancel(id);
      // Активные потоки могут ещё закрывать файлы; такие каталоги очистит следующий запуск.
      if (transferIds.length === 0) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public snapshots(): ExternalDragSnapshot[] {
    const transfers = this.transfers.snapshots();
    const snapshots = [...this.records.values()].map((record): ExternalDragSnapshot => {
      if (record.terminal) return record.terminal;
      const jobs = transfers.filter((transfer) => record.transferIds.includes(transfer.id));
      const failed = jobs.find((job) =>
        ['failed', 'requiring-review', 'paused'].includes(job.state),
      );
      if (failed)
        for (const job of jobs) if (job.state !== 'completed') this.transfers.cancel(job.id);
      const snapshot: ExternalDragSnapshot = {
        id: record.id,
        workspaceId: record.workspaceId,
        fileCount: record.paths.length,
        state: failed
          ? 'failed'
          : jobs.some((job) => job.state === 'cancelled')
            ? 'cancelled'
            : jobs.length === record.paths.length && jobs.every((job) => job.state === 'completed')
              ? 'ready'
              : 'preparing',
        transferredBytes: jobs.reduce((total, job) => total + job.transferredBytes, 0n),
        totalBytes: record.totalBytes,
        errorKey: failed?.errorKey ?? null,
      };
      if (snapshot.state !== 'preparing') record.terminal = snapshot;
      return snapshot;
    });
    return [
      ...[...this.pending.entries()].map(([workspaceId, pending]): ExternalDragSnapshot => ({
        id: pending.id,
        workspaceId,
        fileCount: pending.fileCount,
        state: 'preparing',
        transferredBytes: 0n,
        totalBytes: 0n,
        errorKey: null,
      })),
      ...snapshots.filter((snapshot) => !this.pending.has(snapshot.workspaceId)),
    ];
  }

  public async files(id: string): Promise<string[]> {
    const record = this.records.get(id);
    if (!record || this.snapshots().find((item) => item.id === id)?.state !== 'ready')
      throw new ApplicationError(applicationErrorCodes.providerConflict);
    for (const path of record.paths)
      if (!(await lstat(path)).isFile())
        throw new ApplicationError(applicationErrorCodes.providerUnsupported);
    return [...record.paths];
  }

  public dismiss(id: string): void {
    for (const pending of this.pending.values()) if (pending.id === id) pending.controller.abort();
    const record = this.records.get(id);
    if (!record) return;
    for (const transfer of this.transfers.snapshots())
      if (record.transferIds.includes(transfer.id)) this.transfers.cancel(transfer.id);
    this.records.delete(id);
    // Готовые файлы сохраняются: внешнее приложение может читать их после отпускания мыши.
  }

  public cancelWorkspace(workspaceId: string): void {
    this.pending.get(workspaceId)?.controller.abort();
    for (const record of this.records.values())
      if (record.workspaceId === workspaceId) this.dismiss(record.id);
  }

  public hasActive(workspaceId?: string): boolean {
    return workspaceId
      ? this.pending.has(workspaceId) || this.transfers.hasActive(workspaceId)
      : this.pending.size > 0 || this.transfers.hasAnyActive();
  }

  public dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.transfers.dispose();
  }
}
