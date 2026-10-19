import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import { mailruPathSchema } from '@shared/models/mailru-profile';
import type { ProviderPath } from '@shared/models/provider-path';
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
  type ProviderErrorCode,
  type ProviderOperation,
} from '@shared/providers/provider-error';
import { MailruConnection } from './mailru-connection';
import { checkWebDavMultiStatus, parseWebDavEntries } from './webdav-xml';
import { readWebDavBody, webDavError, webDavProperties } from './webdav-transport';

const failure = (code: ProviderErrorCode, operation: ProviderOperation) =>
  new ProviderError(code, { provider: 'mailru', operation });

export class MailruProvider implements FileSystemProvider {
  public readonly kind = 'mailru' as const;
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

  public constructor(public readonly connection: MailruConnection) {}
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
    if (path.provider !== 'mailru' || !mailruPathSchema.safeParse(path.path).success)
      throw failure(providerErrorCodes.invalidPath, operation);
    return path.path === '/' ? '/' : path.path.replace(/\/$/u, '');
  }

  private async properties(
    path: string,
    depth: '0' | '1',
    operation: ProviderOperation,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry[]> {
    const pending = this.connection.start('PROPFIND', path, operation, options, {
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
    });
    pending.request.end(webDavProperties);
    const response = await pending.response;
    return parseWebDavEntries(
      await readWebDavBody(response, operation, options),
      this.connection.url(path),
      operation,
    );
  }

  public async list(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    const directory = this.path(path, 'list');
    const entries = await this.properties(directory, '1', 'list', options);
    const self = entries.find(
      (entry) => entry.path.provider === 'mailru' && entry.path.path === directory,
    );
    if (self?.kind !== 'directory') throw failure(providerErrorCodes.unsupported, 'list');
    return entries.filter((entry) => {
      if (entry.path.provider !== 'mailru') throw failure(providerErrorCodes.ioError, 'list');
      if (entry.path.path === directory) return false;
      if (posix.dirname(entry.path.path) !== directory)
        throw failure(providerErrorCodes.invalidPath, 'list');
      return true;
    });
  }

  public async stat(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry> {
    const resolved = this.path(path, 'stat');
    const entries = await this.properties(resolved, '0', 'stat', options);
    if (
      entries.length !== 1 ||
      entries[0]?.path.provider !== 'mailru' ||
      entries[0].path.path !== resolved
    )
      throw failure(providerErrorCodes.ioError, 'stat');
    return entries[0];
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
    method: string,
    path: string,
    operation: ProviderOperation,
    options?: ProviderOperationOptions,
    headers?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const pending = this.connection.start(method, path, operation, options, headers);
    pending.request.end();
    const response = await pending.response;
    const body = await readWebDavBody(response, operation, options);
    if (response.statusCode === 207) checkWebDavMultiStatus(body, operation);
  }

  public async createDirectory(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<void> {
    const resolved = this.path(path, 'create-directory');
    if (resolved === '/') throw failure(providerErrorCodes.conflict, 'create-directory');
    await this.mutation('MKCOL', resolved, 'create-directory', options);
  }

  public async delete(path: ProviderPath, options: DeleteOptions): Promise<void> {
    const resolved = this.path(path, 'delete');
    if (resolved === '/') throw failure(providerErrorCodes.invalidPath, 'delete');
    const entry = await this.stat(path, options);
    if (entry.kind === 'directory' && !options.recursive && (await this.list(path, options)).length)
      throw failure(providerErrorCodes.conflict, 'delete');
    await this.mutation('DELETE', resolved, 'delete', options, { Depth: 'infinity' });
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
      throw failure(providerErrorCodes.invalidPath, 'rename');
    const original = await this.stat(source, options);
    const existing = await this.existing(destination, options);
    if (existing && (!options?.overwrite || original.kind !== 'file' || existing.kind !== 'file'))
      throw failure(providerErrorCodes.conflict, 'rename');
    await this.mutation('MOVE', from, 'rename', options, {
      Destination: this.connection.url(to).href,
      Overwrite: options?.overwrite ? 'T' : 'F',
      ...(options?.versionTag ? { 'If-Match': options.versionTag } : {}),
    });
  }

  private offset(options: ProviderOperationOptions | undefined, operation: 'read' | 'write'): void {
    if ((options?.offset ?? 0) !== 0) throw failure(providerErrorCodes.unsupported, operation);
  }

  public async openRead(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const resolved = this.path(path, 'read');
    this.offset(options, 'read');
    if ((await this.stat(path, options)).kind !== 'file')
      throw failure(providerErrorCodes.unsupported, 'read');
    const pending = this.connection.start(
      'GET',
      resolved,
      'read',
      options,
      options?.versionTag ? { 'If-Match': options.versionTag } : {},
    );
    pending.request.end();
    const response = await pending.response;
    if (response.statusCode !== 200) {
      response.destroy();
      throw failure(providerErrorCodes.ioError, 'read');
    }
    const reader = (
      Readable.toWeb(response, {
        strategy: { highWaterMark: 65536, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>
    ).getReader();
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const result = await reader.read();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch (error) {
            controller.error(
              options?.signal?.aborted
                ? failure(providerErrorCodes.cancelled, 'read')
                : webDavError(error, 'read'),
            );
          }
        },
        cancel: async () => {
          pending.abort();
          await reader.cancel().catch(() => undefined);
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
    this.offset(options, 'write');
    if (options.expectedSize !== undefined && options.expectedSize < 0n)
      throw failure(providerErrorCodes.invalidPath, 'write');
    if (resolved === '/') throw failure(providerErrorCodes.conflict, 'write');
    const existing = await this.existing(path, options);
    if (existing && (!options.overwrite || existing.kind !== 'file'))
      throw failure(providerErrorCodes.conflict, 'write');
    const pending = this.connection.start('PUT', resolved, 'write', options, {
      'Content-Type': 'application/octet-stream',
      ...(!options.overwrite ? { 'If-None-Match': '*' } : {}),
      ...(options.versionTag ? { 'If-Match': options.versionTag } : {}),
      ...(options.expectedSize === undefined
        ? {}
        : { 'Content-Length': options.expectedSize.toString() }),
    });
    let controller: WritableStreamDefaultController;
    let written = 0n;
    void pending.response.catch((error: unknown) => {
      pending.request.destroy(webDavError(error, 'write'));
      controller?.error(error);
    });
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
            throw failure(providerErrorCodes.ioError, 'write');
          }
          for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
            const part = chunk.subarray(offset, offset + 65536);
            await new Promise<void>((resolve, reject) =>
              pending.request.write(part, (error) =>
                error ? reject(webDavError(error, 'write')) : resolve(),
              ),
            );
          }
          written += BigInt(chunk.byteLength);
        },
        close: async () => {
          if (options.expectedSize !== undefined && written !== options.expectedSize) {
            pending.abort();
            throw failure(providerErrorCodes.ioError, 'write');
          }
          pending.request.end();
          const response = await pending.response;
          const body = await readWebDavBody(response, 'write', options);
          if (response.statusCode === 207) checkWebDavMultiStatus(body, 'write');
        },
        abort: () => {
          pending.abort();
        },
      },
      { highWaterMark: 1 },
    );
  }
}
