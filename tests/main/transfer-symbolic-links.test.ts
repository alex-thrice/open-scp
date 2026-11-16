// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine, type TransferRequest } from '../../src/main/transfers/transfer-engine';
import type { FileSystemEntry } from '../../src/shared/models/file-system-entry';
import {
  createLocalProviderPath,
  createSftpProviderPath,
  type ProviderPath,
} from '../../src/shared/models/provider-path';
import type {
  FileSystemProvider,
  ProviderOperationOptions,
} from '../../src/shared/providers/file-system-provider';
import { ProviderError, providerErrorCodes } from '../../src/shared/providers/provider-error';

type FixtureNode =
  | { kind: 'directory' | 'special' }
  | { kind: 'file'; content: Buffer }
  | { kind: 'symbolic-link'; target: string };

const remoteRoot = '/opt/wushu/certbot';
const certificate = Buffer.from(
  '-----BEGIN CERTIFICATE-----\ncertbot certificate\n-----END CERTIFICATE-----\n',
);
const archivePath = `${remoteRoot}/conf/archive/example.test/cert1.pem`;
const linkPath = `${remoteRoot}/conf/live/example.test/cert.pem`;

describe('skipping symbolic links in transfers', () => {
  const roots: string[] = [];
  const engines: TransferEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'openscp-transfer-links-'));
    roots.push(root);
    const destination = new LocalProvider({ rootPath: root });
    await destination.connect();
    const nodes = new Map<string, FixtureNode>([
      [remoteRoot, { kind: 'directory' }],
      [`${remoteRoot}/conf`, { kind: 'directory' }],
      [`${remoteRoot}/conf/archive`, { kind: 'directory' }],
      [`${remoteRoot}/conf/archive/example.test`, { kind: 'directory' }],
      [archivePath, { kind: 'file', content: certificate }],
      [`${remoteRoot}/conf/live`, { kind: 'directory' }],
      [`${remoteRoot}/conf/live/example.test`, { kind: 'directory' }],
      [linkPath, { kind: 'symbolic-link', target: archivePath }],
      [`${remoteRoot}/www`, { kind: 'directory' }],
    ]);
    const textPath = (path: ProviderPath) => {
      if (path.provider !== 'sftp') throw new Error('Expected SFTP path');
      return path.path;
    };
    const entryFor = (path: string): FileSystemEntry => {
      const node = nodes.get(path);
      if (!node)
        throw new ProviderError(providerErrorCodes.notFound, {
          provider: 'sftp',
          operation: 'stat',
        });
      return {
        path: createSftpProviderPath(path),
        name: posix.basename(path),
        kind: node.kind,
        size:
          node.kind === 'file'
            ? BigInt(node.content.length)
            : node.kind === 'symbolic-link'
              ? BigInt(Buffer.byteLength(node.target))
              : 0n,
        modifiedAt: '2026-11-16T00:00:00.000Z',
      };
    };
    const source = {
      kind: 'sftp' as const,
      connectionState: 'connected' as const,
      capabilities: { ...destination.capabilities, symbolicLinks: true },
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      stat: vi.fn(async (path: ProviderPath) => entryFor(textPath(path))),
      list: vi.fn(async (path: ProviderPath) =>
        [...nodes.keys()]
          .filter(
            (candidate) =>
              candidate !== textPath(path) && posix.dirname(candidate) === textPath(path),
          )
          .map((candidate) => entryFor(candidate)),
      ),
      openRead: vi.fn(async (path: ProviderPath, options?: ProviderOperationOptions) => {
        const node = nodes.get(textPath(path));
        if (node?.kind !== 'file')
          throw new ProviderError(providerErrorCodes.unsupported, {
            provider: 'sftp',
            operation: 'read',
          });
        const content = node.content;
        let position = options?.offset ?? 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (position >= content.length) {
              controller.close();
              return;
            }
            const end = Math.min(position + 16, content.length);
            controller.enqueue(content.subarray(position, end));
            position = end;
          },
        });
      }),
      createDirectory: vi.fn(async () => {
        throw new Error('Unexpected remote write');
      }),
      delete: vi.fn(async () => {
        throw new Error('Unexpected remote delete');
      }),
      rename: vi.fn(async () => {
        throw new Error('Unexpected remote rename');
      }),
      openWrite: vi.fn(async (): Promise<WritableStream<Uint8Array>> => {
        throw new Error('Unexpected remote write');
      }),
    } satisfies FileSystemProvider;
    const engine = new TransferEngine();
    engines.push(engine);
    const request: TransferRequest = {
      source,
      destination,
      sourcePath: createSftpProviderPath(remoteRoot),
      destinationPath: createLocalProviderPath(join(root, 'certbot')),
      workspaceId: 'workspace-1',
      direction: 'download',
      conflictPolicy: 'overwrite',
    };
    return { root, destination, source, nodes, engine, request };
  };

  const waitFor = async (engine: TransferEngine, state: string) => {
    await vi.waitFor(() => expect(engine.snapshots()[0]?.state).toBe(state), {
      timeout: 5000,
      interval: 20,
    });
  };

  it('downloads normal files in a Certbot tree while leaving its link-only directory empty', async () => {
    const { root, source, engine, request } = await setup();
    engine.enqueue(request);
    await waitFor(engine, 'completed');

    expect(await readFile(join(root, 'certbot/conf/archive/example.test/cert1.pem'))).toEqual(
      certificate,
    );
    expect(await readdir(join(root, 'certbot/conf/live/example.test'))).toEqual([]);
    expect(await readdir(join(root, 'certbot/www'))).toEqual([]);
    expect(engine.snapshots()[0]).toMatchObject({
      totalBytes: BigInt(certificate.length),
      transferredBytes: BigInt(certificate.length),
      errorKey: null,
    });
    expect(source.openRead.mock.calls.map(([path]) => path)).toEqual([
      createSftpProviderPath(archivePath),
    ]);
    expect(
      source.stat.mock.calls.some(([path]) => path.provider === 'sftp' && path.path === linkPath),
    ).toBe(false);
    expect(source.delete).not.toHaveBeenCalled();
    expect(source.rename).not.toHaveBeenCalled();
  });

  it.each([
    ['file', archivePath],
    ['directory', `${remoteRoot}/www`],
    ['dangling', `${remoteRoot}/missing`],
    ['cyclic', linkPath],
  ])('skips a selected %s link without touching an existing destination', async (_kind, target) => {
    const { root, nodes, destination, source, engine, request } = await setup();
    nodes.set(linkPath, { kind: 'symbolic-link', target });
    const localTarget = join(root, 'existing.pem');
    await writeFile(localTarget, 'existing certificate');
    const destinationStat = vi.spyOn(destination, 'stat');
    const openWrite = vi.spyOn(destination, 'openWrite');
    engine.enqueue({
      ...request,
      sourcePath: createSftpProviderPath(linkPath),
      destinationPath: createLocalProviderPath(localTarget),
      conflictPolicy: 'ask',
    });
    await waitFor(engine, 'completed');

    expect(await readFile(localTarget, 'utf8')).toBe('existing certificate');
    expect(engine.snapshots()[0]).toMatchObject({
      totalBytes: 0n,
      transferredBytes: 0n,
      conflictPath: null,
      errorKey: null,
    });
    expect(
      source.stat.mock.calls.every(([path]) => path.provider === 'sftp' && path.path === linkPath),
    ).toBe(true);
    expect(source.list).not.toHaveBeenCalled();
    expect(source.openRead).not.toHaveBeenCalled();
    expect(destinationStat).not.toHaveBeenCalled();
    expect(openWrite).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['existing.pem']);
  });

  it('skips nested links before validating their names as Windows destination paths', async () => {
    const { root, nodes, source, engine, request } = await setup();
    const invalidLink = `${remoteRoot}/conf/live/example.test/cert:old.pem`;
    nodes.set(invalidLink, { kind: 'symbolic-link', target: archivePath });
    engine.enqueue(request);
    await waitFor(engine, 'completed');

    expect(await readdir(join(root, 'certbot/conf/live/example.test'))).toEqual([]);
    expect(
      source.stat.mock.calls.some(
        ([path]) => path.provider === 'sftp' && path.path === invalidLink,
      ),
    ).toBe(false);
    expect(engine.snapshots()[0]?.transferredBytes).toBe(BigInt(certificate.length));
  });

  it('skips a file that becomes a symbolic link between sizing and copying', async () => {
    const { root, nodes, source, engine, request } = await setup();
    const stat = source.stat.getMockImplementation();
    if (!stat) throw new Error('Missing fixture stat implementation');
    source.stat.mockImplementationOnce(async (path) => {
      const entry = await stat(path);
      nodes.set(archivePath, { kind: 'symbolic-link', target: `${remoteRoot}/missing` });
      return entry;
    });
    engine.enqueue({
      ...request,
      sourcePath: createSftpProviderPath(archivePath),
      destinationPath: createLocalProviderPath(join(root, 'cert.pem')),
    });
    await waitFor(engine, 'completed');

    expect(source.openRead).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    expect(engine.snapshots()[0]?.transferredBytes).toBe(0n);
  });

  it.each(['upload', 'remote'] as const)(
    'skips symbolic links in %s operations',
    async (direction) => {
      const { root, source, engine, request } = await setup();
      engine.enqueue({ ...request, sourcePath: createSftpProviderPath(linkPath), direction });
      await waitFor(engine, 'completed');

      expect(engine.snapshots()[0]?.totalBytes).toBe(0n);
      expect(source.openRead).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('skips local source symbolic links during uploads', async () => {
    const { root, destination, source, engine, request } = await setup();
    const localLink = createLocalProviderPath(join(root, 'local-link'));
    vi.spyOn(destination, 'stat').mockResolvedValue({
      path: localLink,
      name: 'local-link',
      kind: 'symbolic-link',
      size: 100n,
    });
    const openRead = vi.spyOn(destination, 'openRead');
    engine.enqueue({
      ...request,
      source: destination,
      destination: source,
      sourcePath: localLink,
      destinationPath: createSftpProviderPath(`${remoteRoot}/upload.pem`),
      direction: 'upload',
    });
    await waitFor(engine, 'completed');

    expect(engine.snapshots()[0]?.totalBytes).toBe(0n);
    expect(openRead).not.toHaveBeenCalled();
    expect(source.stat).not.toHaveBeenCalled();
    expect(source.openWrite).not.toHaveBeenCalled();
  });

  it('continues to reject special entries', async () => {
    const { root, nodes, source, engine, request } = await setup();
    nodes.set(`${remoteRoot}/pipe`, { kind: 'special' });
    engine.enqueue({ ...request, sourcePath: createSftpProviderPath(`${remoteRoot}/pipe`) });
    await waitFor(engine, 'failed');

    expect(engine.snapshots()[0]?.errorKey).toBe('errors.provider.unsupported');
    expect(source.openRead).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
