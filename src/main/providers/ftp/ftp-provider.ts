import { PassThrough, Readable } from 'node:stream';
import { posix } from 'node:path';
import { FTPError, type FileInfo } from 'basic-ftp';
import { applicationErrorCodes } from '@shared/errors/application-error';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import { createFtpProviderPath, type ProviderPath } from '@shared/models/provider-path';
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
import { FtpConnection } from './ftp-connection';

const failure = (code: ProviderErrorCode, operation: ProviderOperation) =>
  new ProviderError(code, { provider: 'ftp', operation });
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

export const normalizeFtpError = (error: unknown, operation: ProviderOperation): ProviderError => {
  if (error instanceof ProviderError) return error;
  const nativeCode: unknown =
    error instanceof FTPError
      ? error.code
      : typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
  const code =
    nativeCode === applicationErrorCodes.providerNotConnected
      ? providerErrorCodes.notConnected
      : nativeCode === applicationErrorCodes.providerCancelled
        ? providerErrorCodes.cancelled
        : nativeCode === 530 || nativeCode === 532
          ? providerErrorCodes.accessDenied
          : nativeCode === 500 || nativeCode === 501 || nativeCode === 502 || nativeCode === 504
            ? providerErrorCodes.unsupported
            : nativeCode === 553
              ? providerErrorCodes.invalidPath
              : nativeCode === 550
                ? operation === 'rename' || operation === 'write'
                  ? providerErrorCodes.conflict
                  : providerErrorCodes.notFound
                : providerErrorCodes.ioError;
  return new ProviderError(
    code,
    {
      provider: 'ftp',
      operation,
      ...(nativeCode === undefined ? {} : { code: String(nativeCode) }),
    },
    { cause: error },
  );
};

export class FtpProvider implements FileSystemProvider {
  public readonly kind = 'ftp' as const;
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

  public constructor(public readonly connection: FtpConnection) {}

  public get connectionState() {
    return this.connection.state;
  }

  public async connect(options?: ProviderOperationOptions): Promise<void> {
    this.checkAbort(options, 'connect');
    await this.connection.connect();
  }

  public async disconnect(): Promise<void> {
    this.connection.disconnect();
  }

  private checkAbort(
    options: ProviderOperationOptions | undefined,
    operation: ProviderOperation,
  ): void {
    if (options?.signal?.aborted) throw failure(providerErrorCodes.cancelled, operation);
  }

  private path(path: ProviderPath, operation: ProviderOperation): string {
    if (path.provider !== 'ftp' || !path.path.startsWith('/') || hasControlCharacter(path.path))
      throw failure(providerErrorCodes.invalidPath, operation);
    return posix.normalize(path.path);
  }

  private async call<T>(
    operation: ProviderOperation,
    action: (client: ReturnType<FtpConnection['client']>) => Promise<T>,
    options?: ProviderOperationOptions,
  ): Promise<T> {
    this.checkAbort(options, operation);
    try {
      const result = await action(this.connection.client());
      this.checkAbort(options, operation);
      return result;
    } catch (error) {
      if (options?.signal?.aborted) throw failure(providerErrorCodes.cancelled, operation);
      throw normalizeFtpError(error, operation);
    }
  }

  private entry(directory: string, item: FileInfo, operation: ProviderOperation): FileSystemEntry {
    if (
      !item.name ||
      item.name === '.' ||
      item.name === '..' ||
      item.name.includes('/') ||
      hasControlCharacter(item.name) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    )
      throw failure(providerErrorCodes.invalidPath, operation);
    return {
      path: createFtpProviderPath(posix.join(directory, item.name)),
      name: item.name,
      kind: item.isDirectory ? 'directory' : item.isFile ? 'file' : 'special',
      size: BigInt(item.size),
      ...(item.modifiedAt ? { modifiedAt: item.modifiedAt.toISOString() } : {}),
    };
  }

  public async list(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    const directory = this.path(path, 'list');
    return this.call(
      'list',
      async (client) =>
        (await client.list(directory))
          .filter((item) => item.name !== '.' && item.name !== '..')
          .map((item) => this.entry(directory, item, 'list')),
      options,
    );
  }

  public async stat(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<FileSystemEntry> {
    const resolved = this.path(path, 'stat');
    if (resolved === '/')
      return {
        path: createFtpProviderPath('/'),
        name: '/',
        kind: 'directory',
        size: 0n,
      };
    const parent = posix.dirname(resolved);
    const name = posix.basename(resolved);
    const item = await this.call(
      'stat',
      async (client) => (await client.list(parent)).find((candidate) => candidate.name === name),
      options,
    );
    if (!item) throw failure(providerErrorCodes.notFound, 'stat');
    return this.entry(parent, item, 'stat');
  }

  private async exists(path: ProviderPath): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof ProviderError && error.code === providerErrorCodes.notFound)
        return false;
      throw error;
    }
  }

  public async createDirectory(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<void> {
    const resolved = this.path(path, 'create-directory');
    if (resolved === '/' || (await this.exists(path)))
      throw failure(providerErrorCodes.conflict, 'create-directory');
    await this.call(
      'create-directory',
      async (client) => {
        const protectedPath = await client.protectWhitespace(resolved);
        await client.send(`MKD ${protectedPath}`);
      },
      options,
    );
  }

  public async delete(path: ProviderPath, options: DeleteOptions): Promise<void> {
    const resolved = this.path(path, 'delete');
    if (resolved === '/') throw failure(providerErrorCodes.invalidPath, 'delete');
    const entry = await this.stat(path, options);
    if (entry.kind === 'directory') {
      const children = await this.list(path, options);
      if (!options.recursive && children.length > 0)
        throw failure(providerErrorCodes.conflict, 'delete');
      for (const child of children) await this.delete(child.path, options);
      await this.call(
        'delete',
        (client) => client.removeEmptyDir(resolved).then(() => undefined),
        options,
      );
      return;
    }
    if (entry.kind !== 'file') throw failure(providerErrorCodes.unsupported, 'delete');
    await this.call('delete', (client) => client.remove(resolved).then(() => undefined), options);
  }

  public async rename(
    source: ProviderPath,
    destination: ProviderPath,
    options?: RenameOptions,
  ): Promise<void> {
    const from = this.path(source, 'rename');
    const to = this.path(destination, 'rename');
    if (from === '/' || to === '/' || from === to || to.startsWith(`${from}/`))
      throw failure(providerErrorCodes.invalidPath, 'rename');
    const sourceEntry = await this.stat(source, options);
    let destinationEntry: FileSystemEntry | undefined;
    try {
      destinationEntry = await this.stat(destination, options);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== providerErrorCodes.notFound)
        throw error;
    }
    if (destinationEntry) {
      if (!options?.overwrite || destinationEntry.kind !== sourceEntry.kind)
        throw failure(providerErrorCodes.conflict, 'rename');
      await this.delete(destination, { ...options, recursive: true });
    }
    await this.call('rename', (client) => client.rename(from, to).then(() => undefined), options);
  }

  private offset(
    options: ProviderOperationOptions | undefined,
    operation: 'read' | 'write',
  ): number {
    const offset = options?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw failure(providerErrorCodes.invalidPath, operation);
    if (offset !== 0) throw failure(providerErrorCodes.unsupported, operation);
    return offset;
  }

  public async openRead(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    this.checkAbort(options, 'read');
    this.offset(options, 'read');
    if ((await this.stat(path, options)).kind !== 'file')
      throw failure(providerErrorCodes.unsupported, 'read');
    const resolved = this.path(path, 'read');
    const stream = new PassThrough({ highWaterMark: 65536 });
    stream.on('error', () => undefined);
    let settled = false;
    const transfer = this.connection
      .client()
      .downloadTo(stream, resolved)
      .then(() => {
        settled = true;
      })
      .catch((error: unknown) => {
        settled = true;
        const normalized = options?.signal?.aborted
          ? failure(providerErrorCodes.cancelled, 'read')
          : normalizeFtpError(error, 'read');
        stream.destroy(normalized);
        throw normalized;
      });
    void transfer.catch(() => undefined);
    const abort = () => {
      if (settled) return;
      stream.destroy(failure(providerErrorCodes.cancelled, 'read'));
      this.connection.cancelOperation();
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    void transfer
      .finally(() => options?.signal?.removeEventListener('abort', abort))
      .catch(() => undefined);
    const reader = (Readable.toWeb(stream) as ReadableStream<Uint8Array>).getReader();
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const result = await reader.read();
            if (result.done) {
              await transfer;
              controller.close();
            } else controller.enqueue(result.value);
          } catch (error) {
            controller.error(normalizeFtpError(error, 'read'));
          }
        },
        cancel: async (reason) => {
          await reader.cancel(reason).catch(() => undefined);
          if (!settled) this.connection.cancelOperation();
          await transfer.catch(() => undefined);
        },
      },
      { highWaterMark: 1 },
    );
  }

  public async openWrite(
    path: ProviderPath,
    options: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    this.checkAbort(options, 'write');
    this.offset(options, 'write');
    const resolved = this.path(path, 'write');
    const existing = await this.exists(path);
    if (existing && !options.overwrite) throw failure(providerErrorCodes.conflict, 'write');
    if (existing && (await this.stat(path, options)).kind !== 'file')
      throw failure(providerErrorCodes.conflict, 'write');
    const stream = new PassThrough({ highWaterMark: 65536 });
    stream.on('error', () => undefined);
    let settled = false;
    const transfer = this.connection
      .client()
      .uploadFrom(stream, resolved)
      .then(() => {
        settled = true;
      })
      .catch((error: unknown) => {
        settled = true;
        const normalized = options.signal?.aborted
          ? failure(providerErrorCodes.cancelled, 'write')
          : normalizeFtpError(error, 'write');
        stream.destroy(normalized);
        throw normalized;
      });
    void transfer.catch(() => undefined);
    const abort = () => {
      if (settled) return;
      stream.destroy(failure(providerErrorCodes.cancelled, 'write'));
      this.connection.cancelOperation();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    void transfer
      .finally(() => options.signal?.removeEventListener('abort', abort))
      .catch(() => undefined);
    return new WritableStream<Uint8Array>(
      {
        write: (chunk) =>
          new Promise<void>((resolve, reject) => {
            stream.write(Buffer.from(chunk), (error) => {
              if (error) reject(normalizeFtpError(error, 'write'));
              else resolve();
            });
          }),
        close: async () => {
          stream.end();
          await transfer;
        },
        abort: async () => {
          stream.destroy(failure(providerErrorCodes.cancelled, 'write'));
          if (!settled) this.connection.cancelOperation();
          await transfer.catch(() => undefined);
        },
      },
      { highWaterMark: 1 },
    );
  }
}
