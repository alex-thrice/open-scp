import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import { createYandexProviderPath, type ProviderPath } from '@shared/models/provider-path';
import { yandexPathSchema } from '@shared/models/yandex-profile';
import type {
  DeleteOptions,
  FileSystemProvider,
  ProviderOperationOptions,
  RenameOptions,
  WriteOptions,
} from '@shared/providers/file-system-provider';
import type { ProviderOperation } from '@shared/providers/provider-error';
import { ProviderError } from '@shared/providers/provider-error';
import { readHttpBody } from '../../oauth/http-client';
import { YandexConnection } from './yandex-connection';
import { normalizeYandexError, yandexFailure, yandexStatusError } from './yandex-api';

const resourceSchema = z.object({
  name: z.string().max(1024),
  path: z.string().max(32773),
  type: z.enum(['dir', 'file']),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  modified: z.string().optional(),
  md5: z
    .string()
    .regex(/^[a-f\d]{32}$/iu)
    .optional(),
  resource_id: z.string().max(512).optional(),
});
const linkSchema = z.object({
  href: z.string().max(32768),
  method: z.string(),
  templated: z.literal(false).optional(),
});

export class YandexProvider implements FileSystemProvider {
  public readonly kind = 'yandex' as const;
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
  public constructor(public readonly connection: YandexConnection) {}
  public get connectionState() {
    return this.connection.state;
  }
  public connect(options?: ProviderOperationOptions): Promise<void> {
    return this.connection.connect(options);
  }
  public async disconnect(): Promise<void> {
    this.connection.disconnect();
  }
  private path(path: ProviderPath, operation: ProviderOperation): string {
    if (path.provider !== 'yandex' || !yandexPathSchema.safeParse(path.path).success)
      throw yandexFailure('invalidPath', operation);
    return path.path === '/' ? '/' : path.path.replace(/\/$/u, '');
  }
  private entry(value: unknown, operation: ProviderOperation): FileSystemEntry {
    const item = resourceSchema.parse(value);
    if (!item.path.startsWith('disk:/')) throw yandexFailure('invalidPath', operation);
    const path = item.path.slice(5);
    if (
      !yandexPathSchema.safeParse(path).success ||
      (path !== '/' && posix.basename(path) !== item.name)
    )
      throw yandexFailure('invalidPath', operation);
    if (item.type === 'file' && item.size === undefined) throw yandexFailure('ioError', operation);
    const modifiedAt =
      item.modified && Number.isFinite(Date.parse(item.modified))
        ? new Date(item.modified).toISOString()
        : undefined;
    return {
      kind: item.type === 'dir' ? 'directory' : 'file',
      name: path === '/' ? '/' : item.name,
      path: createYandexProviderPath(path),
      size: BigInt(item.size ?? 0),
      ...(modifiedAt ? { modifiedAt } : {}),
      ...(item.type === 'file' && item.md5
        ? { versionTag: `${item.resource_id ?? ''}:${item.md5}:${item.size}:${modifiedAt ?? ''}` }
        : {}),
    };
  }
  private async run<T>(
    operation: ProviderOperation,
    options: ProviderOperationOptions | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const normalized = normalizeYandexError(error, operation, options?.signal);
      this.connection.failed(normalized);
      throw normalized;
    }
  }
  public list(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    return this.run('list', options, async () => {
      const directory = this.path(path, 'list');
      const entries: FileSystemEntry[] = [];
      const seen = new Set<string>();
      let total: number | undefined;
      for (let page = 0; page < 10000; page += 1) {
        const result = await this.connection.api().request(
          'GET',
          '/resources',
          {
            path: `disk:${directory}`,
            offset: String(entries.length),
            limit: '200',
            sort: 'name',
          },
          'list',
          options?.signal,
        );
        const parent = this.entry(result.body, 'list');
        if (
          parent.kind !== 'directory' ||
          parent.path.provider !== 'yandex' ||
          parent.path.path !== directory
        )
          throw yandexFailure('invalidPath', 'list');
        const embedded = z
          .object({
            _embedded: z.object({
              offset: z.number().int().nonnegative(),
              total: z.number().int().nonnegative().max(1000000),
              items: z.array(z.unknown()).max(1000),
            }),
          })
          .parse(result.body)._embedded;
        if (embedded.offset !== entries.length || (total !== undefined && total !== embedded.total))
          throw yandexFailure('ioError', 'list');
        total = embedded.total;
        for (const value of embedded.items) {
          const item = this.entry(value, 'list');
          if (
            item.path.provider !== 'yandex' ||
            item.path.path === directory ||
            posix.dirname(item.path.path) !== directory ||
            seen.has(item.path.path)
          )
            throw yandexFailure('ioError', 'list');
          seen.add(item.path.path);
          entries.push(item);
        }
        if (entries.length === total) return entries;
        if (entries.length > total || embedded.items.length === 0)
          throw yandexFailure('ioError', 'list');
      }
      throw yandexFailure('ioError', 'list');
    });
  }
  public stat(path: ProviderPath, options?: ProviderOperationOptions): Promise<FileSystemEntry> {
    return this.run('stat', options, async () => {
      const resolved = this.path(path, 'stat');
      const result = await this.connection
        .api()
        .request(
          'GET',
          '/resources',
          { path: `disk:${resolved}`, fields: 'name,path,type,size,modified,md5,resource_id' },
          'stat',
          options?.signal,
        );
      const entry = this.entry(result.body, 'stat');
      if (entry.path.provider !== 'yandex' || entry.path.path !== resolved)
        throw yandexFailure('ioError', 'stat');
      return entry;
    });
  }
  private async existing(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry | undefined> {
    try {
      return await this.stat(path, options);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'PROVIDER_NOT_FOUND') return undefined;
      throw error;
    }
  }
  public createDirectory(path: ProviderPath, options?: ProviderOperationOptions): Promise<void> {
    return this.run('create-directory', options, async () => {
      const resolved = this.path(path, 'create-directory');
      if (resolved === '/') throw yandexFailure('conflict', 'create-directory');
      const result = await this.connection
        .api()
        .request(
          'PUT',
          '/resources',
          { path: `disk:${resolved}` },
          'create-directory',
          options?.signal,
        );
      await this.connection
        .api()
        .complete(result.status, result.body, 'create-directory', options?.signal);
    });
  }
  public delete(path: ProviderPath, options: DeleteOptions): Promise<void> {
    return this.run('delete', options, async () => {
      const resolved = this.path(path, 'delete');
      if (resolved === '/') throw yandexFailure('invalidPath', 'delete');
      const existing = await this.stat(path, options);
      if (
        existing.kind === 'directory' &&
        !options.recursive &&
        (await this.list(path, options)).length
      )
        throw yandexFailure('conflict', 'delete');
      const result = await this.connection
        .api()
        .request(
          'DELETE',
          '/resources',
          { path: `disk:${resolved}`, permanently: 'false' },
          'delete',
          options.signal,
        );
      await this.connection.api().complete(result.status, result.body, 'delete', options.signal);
    });
  }
  public rename(
    source: ProviderPath,
    destination: ProviderPath,
    options?: RenameOptions,
  ): Promise<void> {
    return this.run('rename', options, async () => {
      const from = this.path(source, 'rename');
      const to = this.path(destination, 'rename');
      if (
        from === '/' ||
        to === '/' ||
        from === to ||
        to.startsWith(`${from}/`) ||
        from.startsWith(`${to}/`)
      )
        throw yandexFailure('invalidPath', 'rename');
      const entry = await this.stat(source, options);
      const existing = await this.existing(destination, options);
      if (options?.versionTag && entry.versionTag !== options.versionTag)
        throw yandexFailure('conflict', 'rename');
      if (existing && (!options?.overwrite || entry.kind !== 'file' || existing.kind !== 'file'))
        throw yandexFailure('conflict', 'rename');
      const result = await this.connection.api().request(
        'POST',
        '/resources/move',
        {
          from: `disk:${from}`,
          path: `disk:${to}`,
          overwrite: options?.overwrite ? 'true' : 'false',
        },
        'rename',
        options?.signal,
      );
      await this.connection.api().complete(result.status, result.body, 'rename', options?.signal);
    });
  }
  public openRead(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.run('read', options, async () => {
      const resolved = this.path(path, 'read');
      if ((options?.offset ?? 0) !== 0) throw yandexFailure('unsupported', 'read');
      const entry = await this.stat(path, options);
      if (entry.kind !== 'file') throw yandexFailure('unsupported', 'read');
      if (options?.versionTag && entry.versionTag !== options.versionTag)
        throw yandexFailure('conflict', 'read');
      const result = await this.connection
        .api()
        .request(
          'GET',
          '/resources/download',
          { path: `disk:${resolved}` },
          'read',
          options?.signal,
        );
      const link = linkSchema.parse(result.body);
      if (link.method !== 'GET') throw yandexFailure('ioError', 'read');
      const { pending, response } = await this.connection
        .api()
        .download(link.href, options?.signal);
      const reader = (
        Readable.toWeb(response, {
          strategy: { highWaterMark: 65536, size: (chunk: Uint8Array) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>
      ).getReader();
      return new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            try {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(normalizeYandexError(error, 'read', options?.signal));
            }
          },
          cancel: async () => {
            pending.abort();
            await reader.cancel().catch(() => undefined);
          },
        },
        { highWaterMark: 1 },
      );
    });
  }
  public openWrite(path: ProviderPath, options: WriteOptions): Promise<WritableStream<Uint8Array>> {
    return this.run('write', options, async () => {
      const resolved = this.path(path, 'write');
      if ((options.offset ?? 0) !== 0) throw yandexFailure('unsupported', 'write');
      if (resolved === '/' || (options.expectedSize !== undefined && options.expectedSize < 0n))
        throw yandexFailure('invalidPath', 'write');
      const existing = await this.existing(path, options);
      if (existing && (!options.overwrite || existing.kind !== 'file'))
        throw yandexFailure('conflict', 'write');
      const result = await this.connection
        .api()
        .request(
          'GET',
          '/resources/upload',
          { path: `disk:${resolved}`, overwrite: options.overwrite ? 'true' : 'false' },
          'write',
          options.signal,
        );
      const link = linkSchema.parse(result.body);
      if (link.method !== 'PUT') throw yandexFailure('ioError', 'write');
      const api = this.connection.api();
      const pending = api.startTransfer(link.href, 'PUT', options.signal, {
        'Content-Type': 'application/octet-stream',
        ...(options.expectedSize === undefined
          ? {}
          : { 'Content-Length': options.expectedSize.toString() }),
      });
      let written = 0n;
      let controller: WritableStreamDefaultController;
      const completion = pending.response
        .then(async (response) => {
          const text = await readHttpBody(response);
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) throw yandexStatusError(status, 'write');
          await api.complete(
            status,
            text ? (JSON.parse(text) as unknown) : null,
            'write',
            options.signal,
          );
        })
        .catch((error: unknown) => {
          pending.abort();
          const normalized = normalizeYandexError(error, 'write', options.signal);
          controller?.error(normalized);
          throw normalized;
        });
      void completion.catch(() => undefined);
      return new WritableStream<Uint8Array>(
        {
          start: (value) => {
            controller = value;
          },
          write: async (chunk) => {
            if (
              options.expectedSize !== undefined &&
              written + BigInt(chunk.byteLength) > options.expectedSize
            ) {
              pending.abort();
              throw yandexFailure('ioError', 'write');
            }
            for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
              const part = chunk.subarray(offset, offset + 65536);
              await new Promise<void>((resolve, reject) =>
                pending.request.write(part, (error) =>
                  error ? reject(normalizeYandexError(error, 'write', options.signal)) : resolve(),
                ),
              );
            }
            written += BigInt(chunk.byteLength);
          },
          close: async () => {
            if (options.expectedSize !== undefined && written !== options.expectedSize) {
              pending.abort();
              throw yandexFailure('ioError', 'write');
            }
            pending.request.end();
            await completion;
          },
          abort: () => {
            pending.abort();
          },
        },
        { highWaterMark: 1 },
      );
    });
  }
}
