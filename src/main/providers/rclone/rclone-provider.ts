import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import { absoluteRemotePathSchema } from '@shared/models/absolute-remote-path';
import { createRemoteProviderPath, type ProviderPath } from '@shared/models/provider-path';
import type {
  DeleteOptions,
  FileSystemProvider,
  ProviderOperationOptions,
  RenameOptions,
  WriteOptions,
} from '@shared/providers/file-system-provider';
import {
  ProviderError,
  providerErrorCodes,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import type { RcloneConnection } from './rclone-connection';
import { rcloneFailure, type RcloneConnectionProfile } from './rclone-process';
import { ApplicationError } from '../../ipc/application-error';

const entrySchema = z.object({
  Name: z.string().max(1024),
  Path: z.string().max(32768),
  IsDir: z.boolean(),
  Size: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  ModTime: z.string().optional(),
  ID: z.string().max(4096).optional(),
});

export class RcloneProvider<
  Connection extends RcloneConnection<RcloneConnectionProfile>,
> implements FileSystemProvider {
  public get kind() {
    return this.connection.profile.kind;
  }
  public readonly capabilities = Object.freeze({
    atomicRename: false,
    checksum: false,
    createDirectory: true,
    delete: true,
    modificationTime: false,
    multipartUpload: false,
    permissions: false,
    read: true,
    rename: true,
    resumeRead: false,
    resumeWrite: false,
    serverSideCopy: false,
    symbolicLinks: false,
    trueDirectories: true,
    write: true,
  });

  public constructor(public readonly connection: Connection) {}
  private failure(code: keyof typeof providerErrorCodes, operation: ProviderOperation) {
    return rcloneFailure(this.kind, code, operation);
  }

  public get connectionState() {
    return this.connection.state;
  }
  public connect(options?: ProviderOperationOptions): Promise<void> {
    return this.connection.connect(options);
  }
  public disconnect(): Promise<void> {
    return this.connection.disconnect();
  }

  private path(path: ProviderPath, operation: ProviderOperation): string {
    if (path.provider !== this.kind || !absoluteRemotePathSchema.safeParse(path.path).success)
      throw this.failure('invalidPath', operation);
    return path.path === '/' ? '/' : path.path.replace(/\/$/u, '');
  }
  private remote(path: string): string {
    return `${this.connection.profile.remote}:${path.slice(1)}`;
  }
  private async run<T>(operation: ProviderOperation, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      this.connection.failed(error);
      throw error instanceof ProviderError || error instanceof ApplicationError
        ? error
        : this.failure('ioError', operation);
    }
  }
  private entry(value: unknown, path: string, operation: ProviderOperation): FileSystemEntry {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) throw this.failure('ioError', operation);
    const item = parsed.data;
    if (this.kind === 'google' && path !== '/' && !item.ID)
      throw this.failure('ioError', operation);
    // lsjson --stat возвращает пустые Name и Path для корня запрошенного каталога.
    const name =
      item.IsDir && item.Name === '' && item.Path === '' ? posix.basename(path) : item.Name;
    if ((!item.IsDir && item.Size < 0) || (path !== '/' && posix.basename(path) !== name))
      throw this.failure('ioError', operation);
    const modifiedAt =
      item.ModTime && Number.isFinite(Date.parse(item.ModTime))
        ? new Date(item.ModTime).toISOString()
        : undefined;
    return {
      kind: item.IsDir ? 'directory' : 'file',
      name: path === '/' ? '/' : name,
      path: createRemoteProviderPath(this.kind, path),
      size: BigInt(Math.max(0, item.Size)),
      ...(this.kind === 'google' && item.ID ? { resourceId: item.ID } : {}),
      ...(modifiedAt ? { modifiedAt } : {}),
      ...(!item.IsDir
        ? { versionTag: JSON.stringify([item.ID ?? '', item.Size, item.ModTime ?? '']) }
        : {}),
    };
  }
  private async resolveGoogleEntry(
    path: string,
    operation: ProviderOperation,
    signal: AbortSignal,
  ): Promise<unknown> {
    let directory = '/';
    let result: unknown;
    for (const name of path.slice(1).split('/')) {
      const items = await this.connection.process.json(
        ['lsjson', '--no-mimetype', this.remote(directory)],
        operation,
        signal,
      );
      if (!Array.isArray(items)) throw this.failure('ioError', operation);
      const matches = items.filter((value: unknown) => {
        const parsed = entrySchema.safeParse(value);
        if (!parsed.success || parsed.data.Path !== parsed.data.Name)
          throw this.failure('ioError', operation);
        return parsed.data.Name === name;
      });
      if (matches.length > 1) throw this.failure('conflict', operation);
      if (matches.length === 0) throw this.failure('notFound', operation);
      result = matches[0];
      directory = directory === '/' ? `/${name}` : `${directory}/${name}`;
    }
    return result;
  }

  public async stat(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry> {
    const resolved = this.path(path, 'stat');
    const signal = this.connection.signal('stat', options);
    return this.run('stat', async () => {
      // Для каталогов --stat создаёт синтетический корень без ID; берём объект из родителя.
      if (this.kind === 'google' && resolved !== '/')
        return this.entry(
          await this.resolveGoogleEntry(resolved, 'stat', signal),
          resolved,
          'stat',
        );
      return this.entry(
        await this.connection.process.json(
          ['lsjson', '--stat', '--no-mimetype', this.remote(resolved)],
          'stat',
          signal,
        ),
        resolved,
        'stat',
      );
    });
  }
  public async list(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    const directory = this.path(path, 'list');
    const signal = this.connection.signal('list', options);
    if ((await this.stat(path, options)).kind !== 'directory')
      throw this.failure('unsupported', 'list');
    return this.run('list', async () => {
      const items = await this.connection.process.json(
        ['lsjson', '--no-mimetype', this.remote(directory)],
        'list',
        signal,
      );
      if (!Array.isArray(items)) throw this.failure('ioError', 'list');
      const names = new Set<string>();
      return items.map((value: unknown) => {
        const parsed = entrySchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.Path !== parsed.data.Name ||
          !parsed.data.Name ||
          /[/\\]/u.test(parsed.data.Name)
        )
          throw this.failure('invalidPath', 'list');
        if (this.kind === 'google' && names.has(parsed.data.Name))
          throw this.failure('conflict', 'list');
        names.add(parsed.data.Name);
        const child =
          directory === '/' ? `/${parsed.data.Name}` : `${directory}/${parsed.data.Name}`;
        if (!absoluteRemotePathSchema.safeParse(child).success)
          throw this.failure('invalidPath', 'list');
        return this.entry(value, child, 'list');
      });
    });
  }
  private async existing(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry | undefined> {
    try {
      return await this.stat(path, options);
    } catch (error) {
      if (error instanceof ProviderError && error.code === providerErrorCodes.notFound)
        return undefined;
      throw error;
    }
  }
  private async mutation(
    args: readonly string[],
    operation: ProviderOperation,
    options?: ProviderOperationOptions,
  ): Promise<void> {
    const signal = this.connection.signal(operation, options);
    await this.run(operation, () => this.connection.process.run(args, operation, signal));
  }
  public async createDirectory(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<void> {
    const resolved = this.path(path, 'create-directory');
    if (resolved === '/' || (await this.existing(path, options)))
      throw this.failure('conflict', 'create-directory');
    await this.mutation(['mkdir', this.remote(resolved)], 'create-directory', options);
  }
  public async delete(path: ProviderPath, options: DeleteOptions): Promise<void> {
    const resolved = this.path(path, 'delete');
    if (resolved === '/') throw this.failure('invalidPath', 'delete');
    const entry = await this.stat(path, options);
    if (options.versionTag && options.versionTag !== entry.versionTag)
      throw this.failure('conflict', 'delete');
    await this.mutation(
      [
        entry.kind === 'directory' ? (options.recursive ? 'purge' : 'rmdir') : 'deletefile',
        this.remote(resolved),
      ],
      'delete',
      options,
    );
  }
  public async rename(
    source: ProviderPath,
    destination: ProviderPath,
    options?: RenameOptions,
  ): Promise<void> {
    const from = this.path(source, 'rename');
    const to = this.path(destination, 'rename');
    if (
      from === '/' ||
      to === '/' ||
      from === to ||
      to.startsWith(`${from}/`) ||
      from.startsWith(`${to}/`)
    )
      throw this.failure('invalidPath', 'rename');
    const original = await this.stat(source, options);
    if (options?.versionTag && options.versionTag !== original.versionTag)
      throw this.failure('conflict', 'rename');
    const existing = await this.existing(destination, options);
    if (existing && (!options?.overwrite || existing.kind !== 'file' || original.kind !== 'file'))
      throw this.failure('conflict', 'rename');
    await this.mutation(
      [
        'moveto',
        this.remote(from),
        this.remote(to),
        ...(!options?.overwrite ? ['--immutable'] : []),
      ],
      'rename',
      options,
    );
  }
  public async openRead(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const resolved = this.path(path, 'read');
    if ((options?.offset ?? 0) !== 0) throw this.failure('unsupported', 'read');
    const entry = await this.stat(path, options);
    if (entry.kind !== 'file') throw this.failure('unsupported', 'read');
    if (options?.versionTag && options.versionTag !== entry.versionTag)
      throw this.failure('conflict', 'read');
    const pending = this.connection.process.start(
      ['cat', this.remote(resolved)],
      'read',
      this.connection.signal('read', options),
    );
    pending.child.stdin.end();
    const iterator = pending.child.stdout[Symbol.asyncIterator]();
    let received = 0n;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const next = await iterator.next();
            if (next.done) {
              await this.run('read', () => pending.done);
              if (received !== entry.size) throw this.failure('ioError', 'read');
              controller.close();
            } else {
              const chunk = Buffer.from(next.value as Uint8Array);
              received += BigInt(chunk.byteLength);
              controller.enqueue(chunk);
            }
          } catch (error) {
            pending.abort();
            await pending.done.catch(() => undefined);
            controller.error(error);
          }
        },
        cancel: async () => {
          pending.abort();
          await pending.done.catch(() => undefined);
        },
      },
      { highWaterMark: 1 },
    );
  }
  public async openWrite(
    path: ProviderPath,
    options: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const resolved = this.path(path, 'write');
    if ((options.offset ?? 0) !== 0) throw this.failure('unsupported', 'write');
    if (
      resolved === '/' ||
      (options.expectedSize !== undefined &&
        (options.expectedSize < 0n || options.expectedSize > BigInt(Number.MAX_SAFE_INTEGER)))
    )
      throw this.failure('invalidPath', 'write');
    const existing = await this.existing(path, options);
    if (existing && (!options.overwrite || existing.kind !== 'file'))
      throw this.failure('conflict', 'write');
    if (options.versionTag && options.versionTag !== existing?.versionTag)
      throw this.failure('conflict', 'write');
    const temporary = posix.join(posix.dirname(resolved), `.openscp-upload-${randomUUID()}`);
    const pending = this.connection.process.start(
      [
        'rcat',
        this.remote(temporary),
        '--streaming-upload-cutoff=1M',
        ...(options.expectedSize === undefined ? [] : ['--size', options.expectedSize.toString()]),
      ],
      'write',
      this.connection.signal('write', options),
    );
    pending.child.stdout.resume();
    let written = 0n;
    let published = false;
    const cleanup = async () => {
      pending.abort();
      await pending.done.catch(() => undefined);
      if (!published && this.connection.state === 'connected')
        await this.connection.process
          .run(['deletefile', this.remote(temporary)], 'delete', AbortSignal.timeout(2000))
          .catch(() => undefined);
    };
    return new WritableStream<Uint8Array>(
      {
        write: async (chunk) => {
          try {
            if (
              options.expectedSize !== undefined &&
              written + BigInt(chunk.byteLength) > options.expectedSize
            )
              throw this.failure('ioError', 'write');
            for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
              await new Promise<void>((resolve, reject) =>
                pending.child.stdin.write(chunk.subarray(offset, offset + 65536), (error) =>
                  error ? reject(this.failure('ioError', 'write')) : resolve(),
                ),
              );
            }
            written += BigInt(chunk.byteLength);
          } catch (error) {
            await cleanup();
            throw error;
          }
        },
        close: async () => {
          try {
            if (options.expectedSize !== undefined && written !== options.expectedSize)
              throw this.failure('ioError', 'write');
            pending.child.stdin.end();
            await this.run('write', () => pending.done);
            const staged = await this.stat(createRemoteProviderPath(this.kind, temporary), options);
            if (staged.kind !== 'file' || staged.size !== written)
              throw this.failure('ioError', 'write');
            const current = await this.existing(path, options);
            if (existing?.versionTag !== current?.versionTag)
              throw this.failure('conflict', 'write');
            await this.mutation(
              [
                'moveto',
                this.remote(temporary),
                this.remote(resolved),
                ...(!options.overwrite ? ['--immutable'] : []),
              ],
              'write',
              options,
            );
            if (this.kind === 'google') {
              const result = await this.stat(path, options);
              const stagedVersion: unknown = JSON.parse(staged.versionTag ?? 'null');
              const publishedVersion: unknown = JSON.parse(result.versionTag ?? 'null');
              if (
                result.kind !== 'file' ||
                result.size !== written ||
                !Array.isArray(stagedVersion) ||
                !Array.isArray(publishedVersion) ||
                !stagedVersion[0] ||
                stagedVersion[0] !== publishedVersion[0]
              )
                throw this.failure('conflict', 'write');
            }
            published = true;
          } finally {
            await cleanup();
          }
        },
        abort: cleanup,
      },
      { highWaterMark: 1 },
    );
  }
}
