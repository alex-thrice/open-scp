import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FileSystemEntry } from '@shared/models/file-system-entry';
import { createGoogleProviderPath, type ProviderPath } from '@shared/models/provider-path';
import {
  parseGooglePath,
  googleChildPath,
  googleParentPath,
  googlePathName,
  googleExportFormats,
  googleRootPath,
} from '@shared/models/google-path';
import type {
  FileSystemProvider,
  ProviderOperationOptions,
  DeleteOptions,
  RenameOptions,
  WriteOptions,
} from '@shared/providers/file-system-provider';
import { ProviderError, type ProviderOperation } from '@shared/providers/provider-error';
import { GoogleConnection } from './google-connection';
import { googleFailure, normalizeGoogleError } from './google-api';
import { googleUploadStream, queryGoogleUpload, type GoogleUploadSession } from './google-upload';

const folderMime = 'application/vnd.google-apps.folder';
const shortcutMime = 'application/vnd.google-apps.shortcut';
const fields =
  'id,name,mimeType,parents,size,modifiedTime,version,md5Checksum,driveId,trashed,capabilities';
const metadataSchema = z.object({
  id: z.string().regex(/^[A-Za-z\d_-]{1,200}$/u),
  name: z.string().min(1).max(1024),
  mimeType: z.string().max(200),
  parents: z.array(z.string()).max(1).optional(),
  size: z.string().max(20).regex(/^\d+$/u).optional(),
  modifiedTime: z.string().optional(),
  version: z.string().max(32).regex(/^\d+$/u).optional(),
  md5Checksum: z
    .string()
    .regex(/^[a-f\d]{32}$/iu)
    .optional(),
  driveId: z.string().optional(),
  trashed: z.boolean().optional(),
  capabilities: z
    .object({
      canDownload: z.boolean().optional(),
      canModifyContent: z.boolean().optional(),
      canRename: z.boolean().optional(),
      canTrash: z.boolean().optional(),
      canListChildren: z.boolean().optional(),
      canAddChildren: z.boolean().optional(),
      canMoveItemWithinDrive: z.boolean().optional(),
    })
    .optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
export class GoogleProvider implements FileSystemProvider {
  public readonly kind = 'google' as const;
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
    resumeRead: true,
    resumeWrite: true,
    serverSideCopy: false,
    symbolicLinks: false,
    trueDirectories: true,
    write: true,
    writeProgress: true,
  });
  private readonly sessions = new Map<string, GoogleUploadSession>();
  private readonly reservations = new Map<string, string>();
  private readonly exports = new Map<
    string,
    { bytes: Buffer; version: string | undefined; time: number }
  >();
  public constructor(public readonly connection: GoogleConnection) {}
  public get connectionState() {
    return this.connection.state;
  }
  public connect(options?: ProviderOperationOptions): Promise<void> {
    return this.connection.connect(options);
  }
  public async disconnect(): Promise<void> {
    this.sessions.clear();
    this.reservations.clear();
    this.exports.clear();
    this.connection.disconnect();
  }
  private path(path: ProviderPath): string {
    if (path.provider !== 'google') throw googleFailure('invalidPath', 'stat');
    try {
      parseGooglePath(path.path);
    } catch {
      throw googleFailure('invalidPath', 'stat');
    }
    return path.path;
  }
  private async run<T>(
    operation: ProviderOperation,
    options: ProviderOperationOptions | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const normalized = normalizeGoogleError(error, operation, options?.signal);
      this.connection.failed(normalized);
      throw normalized;
    }
  }
  private async metadata(id: string, options?: ProviderOperationOptions): Promise<Metadata> {
    const item = metadataSchema.parse(
      (
        await this.connection
          .api()
          .request('GET', `/files/${encodeURIComponent(id)}`, { fields }, 'stat', options?.signal)
      ).body,
    );
    if (item.trashed || item.driveId) throw googleFailure('notFound', 'stat');
    if (id !== 'root' && id !== item.id) throw googleFailure('ioError', 'stat');
    return item;
  }
  private async resolve(path: string, options?: ProviderOperationOptions): Promise<Metadata> {
    const { segments } = parseGooglePath(path);
    let item = await this.metadata(this.connection.rootId, options);
    const seen = new Set([item.id]);
    for (const segment of segments) {
      if (!segment.id || seen.has(segment.id) || item.mimeType !== folderMime)
        throw googleFailure('invalidPath', 'stat');
      const child = await this.metadata(segment.id, options);
      if (child.parents?.length !== 1 || child.parents[0] !== item.id)
        throw googleFailure('notFound', 'stat');
      seen.add(child.id);
      item = child;
    }
    return item;
  }
  private entry(item: Metadata, path: string): FileSystemEntry {
    const type =
      item.mimeType === folderMime
        ? 'folder'
        : item.mimeType === shortcutMime
          ? 'shortcut'
          : item.mimeType.startsWith('application/vnd.google-apps.')
            ? 'native'
            : 'binary';
    const capabilities = item.capabilities;
    if (type === 'binary' && (item.size === undefined || item.version === undefined))
      throw googleFailure('ioError', 'stat');
    const size = BigInt(item.size ?? '0');
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw googleFailure('unsupported', 'stat');
    return {
      kind:
        type === 'folder'
          ? 'directory'
          : type === 'binary'
            ? 'file'
            : type === 'shortcut'
              ? 'symbolic-link'
              : 'special',
      name: path === googleRootPath ? 'My Drive' : item.name,
      path: createGoogleProviderPath(path),
      size,
      ...(item.modifiedTime ? { modifiedAt: item.modifiedTime } : {}),
      ...(item.version
        ? { versionTag: `${item.id}:${item.version}:${item.md5Checksum ?? ''}` }
        : {}),
      google: {
        id: item.id,
        mimeType: item.mimeType,
        type,
        canDownload: capabilities?.canDownload === true,
        canWrite: type === 'binary' && capabilities?.canModifyContent === true,
        canRename: capabilities?.canRename === true,
        canTrash: capabilities?.canTrash === true,
        canListChildren: capabilities?.canListChildren === true,
        canAddChildren: capabilities?.canAddChildren === true,
      },
    };
  }
  public list(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    return this.run('list', options, async () => {
      const address = this.path(path);
      if (parseGooglePath(address).exportMimeType) throw googleFailure('invalidPath', 'list');
      const parent = await this.resolve(address, options);
      if (parent.mimeType !== folderMime || !parent.capabilities?.canListChildren)
        throw googleFailure('accessDenied', 'list');
      const entries: FileSystemEntry[] = [];
      const seen = new Set<string>();
      const pages = new Set<string>();
      let pageToken = '';
      for (let page = 0; page < 10000; page += 1) {
        const result = z
          .object({
            files: z.array(metadataSchema).max(1000),
            nextPageToken: z.string().max(16384).optional(),
            incompleteSearch: z.boolean().optional(),
          })
          .parse(
            (
              await this.connection.api().request(
                'GET',
                '/files',
                {
                  q: `'${parent.id}' in parents and trashed = false`,
                  spaces: 'drive',
                  corpora: 'user',
                  pageSize: '1000',
                  fields: `nextPageToken,incompleteSearch,files(${fields})`,
                  ...(pageToken ? { pageToken } : {}),
                },
                'list',
                options?.signal,
              )
            ).body,
          );
        if (result.incompleteSearch) throw googleFailure('ioError', 'list');
        for (const item of result.files) {
          if (item.driveId || item.trashed || item.parents?.[0] !== parent.id || seen.has(item.id))
            throw googleFailure('ioError', 'list');
          seen.add(item.id);
          entries.push(this.entry(item, googleChildPath(address, item.name, item.id)));
        }
        if (!result.nextPageToken) return entries;
        if (pages.has(result.nextPageToken)) throw googleFailure('ioError', 'list');
        pageToken = result.nextPageToken;
        pages.add(pageToken);
      }
      throw googleFailure('ioError', 'list');
    });
  }
  public async conflictCandidates(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<readonly FileSystemEntry[]> {
    const address = this.path(path);
    const parsed = parseGooglePath(address);
    if (parsed.exportMimeType) throw googleFailure('invalidPath', 'stat');
    if (!parsed.segments.length || parsed.segments.at(-1)?.id)
      return [await this.stat(path, options)];
    return (await this.list(createGoogleProviderPath(googleParentPath(address)), options)).filter(
      (item) => item.name === googlePathName(address),
    );
  }
  public stat(path: ProviderPath, options?: ProviderOperationOptions): Promise<FileSystemEntry> {
    return this.run('stat', options, async () => {
      const address = this.path(path);
      const parsed = parseGooglePath(address);
      if (parsed.segments.length && !parsed.segments.at(-1)?.id) {
        const candidates = await this.conflictCandidates(path, options);
        if (!candidates.length) throw googleFailure('notFound', 'stat');
        if (candidates.length !== 1) throw googleFailure('conflict', 'stat');
        const candidate = candidates[0];
        if (!candidate) throw googleFailure('notFound', 'stat');
        return candidate;
      }
      const item = await this.resolve(address, options);
      const entry = this.entry(item, address);
      if (!parsed.exportMimeType) return entry;
      const formats = googleExportFormats[item.mimeType as keyof typeof googleExportFormats];
      if (
        !entry.google?.canDownload ||
        !formats?.some((format) => format.mimeType === parsed.exportMimeType)
      )
        throw googleFailure('unsupported', 'read');
      let prepared = this.exports.get(address);
      if (
        !prepared ||
        prepared.version !== entry.versionTag ||
        prepared.time < Date.now() - 60000
      ) {
        const response = await this.connection
          .api()
          .media(item.id, 0, options?.signal, parsed.exportMimeType);
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > 10485760) {
            response.destroy();
            throw googleFailure('unsupported', 'read');
          }
          chunks.push(bytes);
        }
        const after = this.entry(await this.resolve(address, options), address);
        if (!entry.versionTag || after.versionTag !== entry.versionTag)
          throw googleFailure('conflict', 'read');
        if (this.exports.size >= 2) {
          const oldest = this.exports.keys().next().value;
          if (oldest) this.exports.delete(oldest);
        }
        prepared = { bytes: Buffer.concat(chunks), version: entry.versionTag, time: Date.now() };
        this.exports.set(address, prepared);
      }
      return {
        ...entry,
        kind: 'file',
        name: googlePathName(address),
        size: BigInt(prepared.bytes.length),
      };
    });
  }
  private async reserve(address: string, options?: ProviderOperationOptions): Promise<string> {
    let id = this.reservations.get(address);
    if (!id) {
      id = z
        .object({ ids: z.array(z.string().regex(/^[A-Za-z\d_-]{1,200}$/u)).length(1) })
        .parse(
          (
            await this.connection
              .api()
              .request(
                'GET',
                '/files/generateIds',
                { count: '1', space: 'drive', type: 'files' },
                'write',
                options?.signal,
              )
          ).body,
        ).ids[0];
      if (!id) throw googleFailure('ioError', 'write');
      this.reservations.set(address, id);
    }
    return id;
  }
  public createDirectory(path: ProviderPath, options?: ProviderOperationOptions): Promise<void> {
    return this.run('create-directory', options, async () => {
      const address = this.path(path);
      const parsed = parseGooglePath(address);
      if (
        !parsed.segments.length ||
        parsed.exportMimeType ||
        parsed.segments.at(-1)?.id ||
        (await this.conflictCandidates(path, options)).length
      )
        throw googleFailure('conflict', 'create-directory');
      const parent = await this.resolve(googleParentPath(address), options);
      if (!parent.capabilities?.canAddChildren)
        throw googleFailure('accessDenied', 'create-directory');
      const id = await this.reserve(address, options);
      await this.connection
        .api()
        .request('POST', '/files', { fields: 'id' }, 'create-directory', options?.signal, {
          id,
          name: googlePathName(address),
          parents: [parent.id],
          mimeType: folderMime,
        });
    });
  }
  public delete(path: ProviderPath, options: DeleteOptions): Promise<void> {
    return this.run('delete', options, async () => {
      const address = this.path(path);
      if (!parseGooglePath(address).segments.at(-1)?.id || parseGooglePath(address).exportMimeType)
        throw googleFailure('invalidPath', 'delete');
      const entry = await this.stat(path, options);
      if (!entry.google?.canTrash) throw googleFailure('accessDenied', 'delete');
      if (
        entry.kind === 'directory' &&
        !options.recursive &&
        (await this.list(entry.path, options)).length
      )
        throw googleFailure('conflict', 'delete');
      await this.connection
        .api()
        .request(
          'PATCH',
          `/files/${entry.google.id}`,
          { fields: 'id,trashed' },
          'delete',
          options.signal,
          { trashed: true },
        );
    });
  }
  public rename(
    source: ProviderPath,
    destination: ProviderPath,
    options?: RenameOptions,
  ): Promise<void> {
    return this.run('rename', options, async () => {
      const from = this.path(source);
      const to = this.path(destination);
      const parsed = parseGooglePath(to);
      if (
        !parseGooglePath(from).segments.length ||
        parseGooglePath(from).exportMimeType ||
        !parsed.segments.length ||
        parsed.exportMimeType ||
        parsed.segments.at(-1)?.id
      )
        throw googleFailure('invalidPath', 'rename');
      const item = await this.resolve(from, options);
      const entry = this.entry(item, from);
      if (
        !entry.google?.canRename ||
        (options?.versionTag && entry.versionTag !== options.versionTag)
      )
        throw googleFailure('accessDenied', 'rename');
      if (
        (await this.conflictCandidates(destination, options)).some(
          (candidate) => candidate.google?.id !== item.id,
        )
      )
        throw googleFailure('conflict', 'rename');
      const parent = await this.resolve(googleParentPath(to), options);
      const oldParent = item.parents?.[0];
      const moving = oldParent !== parent.id;
      if (
        parsed.segments.some((segment) => segment.id === item.id) ||
        (moving &&
          (!parent.capabilities?.canAddChildren || !item.capabilities?.canMoveItemWithinDrive))
      )
        throw googleFailure('accessDenied', 'rename');
      await this.connection.api().request(
        'PATCH',
        `/files/${item.id}`,
        {
          fields: 'id',
          ...(moving ? { addParents: parent.id, removeParents: oldParent ?? '' } : {}),
        },
        'rename',
        options?.signal,
        { name: googlePathName(to) },
      );
    });
  }
  public openRead(
    path: ProviderPath,
    options?: ProviderOperationOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.run('read', options, async () => {
      const address = this.path(path);
      const parsed = parseGooglePath(address);
      if (!parsed.segments.at(-1)?.id) throw googleFailure('invalidPath', 'read');
      const entry = await this.stat(path, options);
      const offset = options?.offset ?? 0;
      if (!entry.google?.canDownload || entry.kind !== 'file')
        throw googleFailure('accessDenied', 'read');
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        BigInt(offset) > entry.size ||
        (parsed.exportMimeType && offset !== 0)
      )
        throw googleFailure('unsupported', 'read');
      if (options?.versionTag && entry.versionTag !== options.versionTag)
        throw googleFailure('conflict', 'read');
      if (parsed.exportMimeType) {
        const prepared = this.exports.get(address);
        if (!prepared) throw googleFailure('conflict', 'read');
        const bytes = prepared.bytes;
        return new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      if (BigInt(offset) === entry.size)
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      const response = await this.connection.api().media(entry.google.id, offset, options?.signal);
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
              controller.error(normalizeGoogleError(error, 'read', options?.signal));
            }
          },
          cancel: async () => {
            response.destroy();
            await reader.cancel().catch(() => undefined);
          },
        },
        { highWaterMark: 1 },
      );
    });
  }
  public resumeWriteOffset(path: ProviderPath, options: WriteOptions): Promise<number> {
    return this.run('write', options, async () => {
      const session = this.sessions.get(this.path(path));
      if (!session || BigInt(session.total) !== options.expectedSize)
        throw googleFailure('unsupported', 'write');
      return queryGoogleUpload(this.connection.api(), session, options.signal);
    });
  }
  public openWrite(path: ProviderPath, options: WriteOptions): Promise<WritableStream<Uint8Array>> {
    return this.run('write', options, async () => {
      const address = this.path(path);
      const parsed = parseGooglePath(address);
      if (
        !parsed.segments.length ||
        parsed.exportMimeType ||
        options.expectedSize === undefined ||
        options.expectedSize < 0n ||
        options.expectedSize > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw googleFailure('unsupported', 'write');
      let session = this.sessions.get(address);
      if (options.offset !== undefined) {
        if (
          !session ||
          session.offset !== options.offset ||
          BigInt(session.total) !== options.expectedSize
        )
          throw googleFailure('conflict', 'write');
      } else {
        let existing: FileSystemEntry | undefined;
        try {
          existing = await this.stat(path, options);
        } catch (error) {
          if (!(error instanceof ProviderError && error.code === 'PROVIDER_NOT_FOUND')) throw error;
        }
        if (!existing && parsed.segments.at(-1)?.id) throw googleFailure('notFound', 'write');
        if (
          existing &&
          (!options.overwrite || !parsed.segments.at(-1)?.id || !existing.google?.canWrite)
        )
          throw googleFailure('conflict', 'write');
        if (options.versionTag && existing?.versionTag !== options.versionTag)
          throw googleFailure('conflict', 'write');
        const parent = await this.resolve(googleParentPath(address), options);
        if (!existing && !parent.capabilities?.canAddChildren)
          throw googleFailure('accessDenied', 'write');
        const id = existing?.google?.id ?? (await this.reserve(address, options));
        const result = await this.connection.api().request(
          existing ? 'PATCH' : 'POST',
          existing ? `/files/${id}` : '/files',
          { uploadType: 'resumable', fields: 'id,size,version' },
          'write',
          options.signal,
          existing
            ? {}
            : {
                id,
                name: googlePathName(address),
                parents: [parent.id],
                mimeType: 'application/octet-stream',
              },
          true,
          {
            'X-Upload-Content-Type': 'application/octet-stream',
            'X-Upload-Content-Length': options.expectedSize.toString(),
          },
        );
        const location = result.headers.location;
        if (!location) throw googleFailure('ioError', 'write');
        session = {
          id,
          url: this.connection.api().session(location),
          total: Number(options.expectedSize),
          ...(existing?.versionTag ? { originalVersion: existing.versionTag } : {}),
          offset: 0,
          sent: 0,
          completed: false,
        };
        this.sessions.set(address, session);
      }
      const upload = session;
      return googleUploadStream(this.connection.api(), upload, options, async () => {
        if (parsed.segments.at(-1)?.id) {
          const current = await this.stat(path, options);
          if (!current.google?.canWrite) throw googleFailure('accessDenied', 'write');
          if (upload.originalVersion && current.versionTag !== upload.originalVersion)
            throw googleFailure('conflict', 'write');
        } else if (
          (await this.conflictCandidates(path, options)).some(
            (candidate) => candidate.google?.id !== upload.id,
          )
        ) {
          throw googleFailure('conflict', 'write');
        }
      });
    });
  }
}
