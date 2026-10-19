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
import { ICloudConnection } from './icloud-connection';
import { icloudFailure } from './rclone-process';
import { ApplicationError } from '../../ipc/application-error';

const entrySchema = z.object({
  Name: z.string().max(1024),
  Path: z.string().max(32768),
  IsDir: z.boolean(),
  Size: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  ModTime: z.string().optional(),
  ID: z.string().max(4096).optional(),
});

export class ICloudProvider implements FileSystemProvider {
  public readonly kind = 'icloud' as const;
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

  public constructor(public readonly connection: ICloudConnection) {}
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
    if (path.provider !== 'icloud' || !absoluteRemotePathSchema.safeParse(path.path).success)
      throw icloudFailure('invalidPath', operation);
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
        : icloudFailure('ioError', operation);
    }
  }
  private entry(value: unknown, path: string, operation: ProviderOperation): FileSystemEntry {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) throw icloudFailure('ioError', operation);
    const item = parsed.data;
    if ((!item.IsDir && item.Size < 0) || (path !== '/' && posix.basename(path) !== item.Name))
      throw icloudFailure('ioError', operation);
    const modifiedAt =
      item.ModTime && Number.isFinite(Date.parse(item.ModTime))
        ? new Date(item.ModTime).toISOString()
        : undefined;
    return {
      kind: item.IsDir ? 'directory' : 'file',
      name: path === '/' ? '/' : item.Name,
      path: createRemoteProviderPath('icloud', path),
      size: BigInt(Math.max(0, item.Size)),
      ...(modifiedAt ? { modifiedAt } : {}),
      ...(!item.IsDir
        ? { versionTag: JSON.stringify([item.ID ?? '', item.Size, item.ModTime ?? '']) }
        : {}),
    };
  }
  public async stat(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry> {
    const resolved = this.path(path, 'stat');
    const signal = this.connection.signal('stat', options);
    return this.run('stat', async () =>
      this.entry(
        await this.connection.process.json(
          ['lsjson', '--stat', '--no-mimetype', this.remote(resolved)],
          'stat',
          signal,
        ),
        resolved,
        'stat',
      ),
    );
  }
  public async list(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    const directory = this.path(path, 'list');
    const signal = this.connection.signal('list', options);
    if ((await this.stat(path, options)).kind !== 'directory')
      throw icloudFailure('unsupported', 'list');
    return this.run('list', async () => {
      const items = await this.connection.process.json(
        ['lsjson', '--no-mimetype', this.remote(directory)],
        'list',
        signal,
      );
      if (!Array.isArray(items)) throw icloudFailure('ioError', 'list');
      return items.map((value: unknown) => {
        const parsed = entrySchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.Path !== parsed.data.Name ||
          !parsed.data.Name ||
          /[/\\]/u.test(parsed.data.Name)
        )
          throw icloudFailure('invalidPath', 'list');
        const child =
          directory === '/' ? `/${parsed.data.Name}` : `${directory}/${parsed.data.Name}`;
        if (!absoluteRemotePathSchema.safeParse(child).success)
          throw icloudFailure('invalidPath', 'list');
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
      throw icloudFailure('conflict', 'create-directory');
    await this.mutation(['mkdir', this.remote(resolved)], 'create-directory', options);
  }
  public async delete(path: ProviderPath, options: DeleteOptions): Promise<void> {
    const resolved = this.path(path, 'delete');
    if (resolved === '/') throw icloudFailure('invalidPath', 'delete');
    const entry = await this.stat(path, options);
    if (options.versionTag && options.versionTag !== entry.versionTag)
      throw icloudFailure('conflict', 'delete');
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
      throw icloudFailure('invalidPath', 'rename');
    const original = await this.stat(source, options);
    if (options?.versionTag && options.versionTag !== original.versionTag)
      throw icloudFailure('conflict', 'rename');
    const existing = await this.existing(destination, options);
    if (existing && (!options?.overwrite || existing.kind !== 'file' || original.kind !== 'file'))
      throw icloudFailure('conflict', 'rename');
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
    if ((options?.offset ?? 0) !== 0) throw icloudFailure('unsupported', 'read');
    const entry = await this.stat(path, options);
    if (entry.kind !== 'file') throw icloudFailure('unsupported', 'read');
    if (options?.versionTag && options.versionTag !== entry.versionTag)
      throw icloudFailure('conflict', 'read');
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
              if (received !== entry.size) throw icloudFailure('ioError', 'read');
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
    if ((options.offset ?? 0) !== 0) throw icloudFailure('unsupported', 'write');
    if (
      resolved === '/' ||
      (options.expectedSize !== undefined &&
        (options.expectedSize < 0n || options.expectedSize > BigInt(Number.MAX_SAFE_INTEGER)))
    )
      throw icloudFailure('invalidPath', 'write');
    const existing = await this.existing(path, options);
    if (existing && (!options.overwrite || existing.kind !== 'file'))
      throw icloudFailure('conflict', 'write');
    if (options.versionTag && options.versionTag !== existing?.versionTag)
      throw icloudFailure('conflict', 'write');
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
              throw icloudFailure('ioError', 'write');
            for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
              await new Promise<void>((resolve, reject) =>
                pending.child.stdin.write(chunk.subarray(offset, offset + 65536), (error) =>
                  error ? reject(icloudFailure('ioError', 'write')) : resolve(),
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
              throw icloudFailure('ioError', 'write');
            pending.child.stdin.end();
            await this.run('write', () => pending.done);
            const staged = await this.stat(createRemoteProviderPath('icloud', temporary), options);
            if (staged.kind !== 'file' || staged.size !== written)
              throw icloudFailure('ioError', 'write');
            const current = await this.existing(path, options);
            if (existing?.versionTag !== current?.versionTag)
              throw icloudFailure('conflict', 'write');
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
