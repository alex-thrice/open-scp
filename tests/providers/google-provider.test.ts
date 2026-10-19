// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleHarness, required } from '../fixtures/google-harness';
import { googleFixtureEntry } from '../fixtures/google-fixture';
import { createGoogleProviderPath as path } from '../../src/shared/models/provider-path';
import {
  googleChildPath,
  googleExportPath,
  googleRootPath,
  parseGooglePath,
} from '../../src/shared/models/google-path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { HttpClient } from '../../src/main/oauth/http-client';
import { GoogleApi } from '../../src/main/providers/google/google-api';

describe('Google Drive API provider', () => {
  let harness: Awaited<ReturnType<typeof createGoogleHarness>>;
  let provider: ReturnType<typeof harness.provider>;
  beforeEach(async () => {
    harness = await createGoogleHarness();
    await harness.authorize();
    provider = harness.provider();
    await provider.connect();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await provider.disconnect();
    await harness.close();
  });
  const root = path(googleRootPath);
  const read = async (address: string, offset = 0) =>
    Buffer.from(
      await new Response(await provider.openRead(path(address), { offset })).arrayBuffer(),
    );
  const put = async (address: string, content: Buffer) => {
    const writer = (
      await provider.openWrite(path(address), {
        overwrite: false,
        expectedSize: BigInt(content.length),
      })
    ).getWriter();
    await writer.write(content);
    await writer.close();
  };
  it('does not replace a missing explicit target ID with a newly created object', async () => {
    await expect(
      provider.openWrite(path(googleChildPath(googleRootPath, 'missing', 'missing-id')), {
        overwrite: true,
        expectedSize: 3n,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    expect(harness.fixture.sessions.size).toBe(0);
  });
  it('rejects incomplete binary metadata instead of silently copying an empty file', async () => {
    harness.fixture.overrides.set('GET /drive/v3/files/incomplete', {
      status: 200,
      body: {
        id: 'incomplete',
        name: 'file',
        mimeType: 'application/octet-stream',
        parents: ['root-id'],
        version: '1',
        capabilities: { canDownload: true },
      },
    });
    await expect(
      provider.openRead(path(googleChildPath(googleRootPath, 'file', 'incomplete'))),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
  });
  it('honors a partial acknowledgement of the final chunk', async () => {
    const address = googleChildPath(googleRootPath, 'partial');
    harness.fixture.partialChunkOnce = 512;
    await put(address, Buffer.alloc(1024, 0x5a));
    const actual = await provider.stat(path(address));
    expect(
      (await read((actual.path as { path: string }).path)).equals(Buffer.alloc(1024, 0x5a)),
    ).toBe(true);
    expect(harness.fixture.chunkSizes).toEqual([1024, 512]);
  });
  it('sends no bearer header to a validated signed host and rejects a hostile redirect', async () => {
    const requests: { url: URL; headers: Readonly<Record<string, string>> }[] = [];
    let location = 'https://download.googleusercontent.com/file?signature=fixture';
    vi.spyOn(HttpClient.prototype, 'start').mockImplementation((url, _method, headers) => {
      requests.push({ url, headers });
      const response = Object.assign(Readable.from([]), {
        statusCode: requests.length === 1 ? 302 : 200,
        headers: requests.length === 1 ? { location } : {},
      }) as unknown as IncomingMessage;
      return {
        request: { end: () => undefined } as unknown as ClientRequest,
        response: Promise.resolve(response),
        abort: () => undefined,
      };
    });
    const api = new GoogleApi(
      async () => 'fixture-token',
      () => undefined,
      2000,
      harness.fixture.endpoint,
    );
    try {
      await api.media('file-id', 0);
      expect(requests[0]?.headers.Authorization).toBe('Bearer fixture-token');
      expect(requests[1]?.headers.Authorization).toBeUndefined();
      requests.length = 0;
      location = 'https://download.googleusercontent.com.evil.example/file';
      await expect(api.media('file-id', 0)).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_PATH',
      });
      expect(requests).toHaveLength(1);
    } finally {
      api.close();
    }
  });
  it('paginates duplicate names and uses IDs for stat, rename, trash and exact overwrite', async () => {
    const tree = required(harness.fixture.accounts.get('one'));
    const first = googleFixtureEntry('одинаковый #~?.txt', 'first');
    const second = googleFixtureEntry(first.name, 'second');
    tree.set(first.id, first);
    tree.set(second.id, second);
    tree.set('third', googleFixtureEntry('third', '3', 'root-id', 'third'));
    const entries = await provider.list(root);
    expect(entries).toHaveLength(3);
    expect(
      new Set(entries.map((entry) => (entry.path.provider === 'google' ? entry.path.path : '')))
        .size,
    ).toBe(3);
    const firstPath = googleChildPath(googleRootPath, first.name, first.id);
    const secondPath = googleChildPath(googleRootPath, second.name, second.id);
    await expect(
      provider.stat(path(googleChildPath(googleRootPath, first.name))),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect((await read(firstPath)).toString()).toBe('first');
    expect((await read(secondPath, 3)).toString()).toBe('ond');
    const writer = (
      await provider.openWrite(path(secondPath), { overwrite: true, expectedSize: 3n })
    ).getWriter();
    await writer.write(Buffer.from('new'));
    await writer.close();
    expect(first.content.toString()).toBe('first');
    expect(second.content.toString()).toBe('new');
    await provider.rename(path(firstPath), path(googleChildPath(googleRootPath, 'renamed')));
    expect(first.name).toBe('renamed');
    await provider.delete(path(secondPath), { recursive: false });
    expect(second.trashed).toBe(true);
    expect(first.trashed).toBe(false);
    expect(harness.fixture.requests.filter((request) => request.method === 'DELETE')).toHaveLength(
      0,
    );
  });
  it('validates My Drive ancestry, permissions, native docs and never traverses shortcuts', async () => {
    const tree = required(harness.fixture.accounts.get('one'));
    const foreign = googleFixtureEntry('foreign', 'secret', 'other-root');
    tree.set(foreign.id, foreign);
    await expect(
      provider.stat(path(googleChildPath(googleRootPath, foreign.name, foreign.id))),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    const denied = googleFixtureEntry('denied', 'secret');
    denied.capabilities = {};
    tree.set(denied.id, denied);
    const deniedPath = path(googleChildPath(googleRootPath, denied.name, denied.id));
    await expect(provider.openRead(deniedPath)).rejects.toMatchObject({
      code: 'PROVIDER_ACCESS_DENIED',
    });
    await expect(provider.delete(deniedPath, { recursive: false })).rejects.toMatchObject({
      code: 'PROVIDER_ACCESS_DENIED',
    });
    await expect(
      provider.openWrite(deniedPath, { overwrite: true, expectedSize: 1n }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    const doc = googleFixtureEntry('Документ', 'native');
    doc.mimeType = 'application/vnd.google-apps.document';
    tree.set(doc.id, doc);
    const docPath = googleChildPath(googleRootPath, doc.name, doc.id);
    expect((await provider.stat(path(docPath))).kind).toBe('special');
    await expect(provider.openRead(path(docPath))).rejects.toMatchObject({
      code: 'PROVIDER_ACCESS_DENIED',
    });
    await expect(
      provider.openWrite(path(docPath), { overwrite: true, expectedSize: 1n }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    const exported = googleExportPath(docPath, 'application/pdf');
    const info = await provider.stat(path(exported));
    expect(info.name).toBe('Документ.pdf');
    expect((await read(exported)).toString()).toBe(`export:${doc.id}:application/pdf`);
    expect(info.size).toBe(BigInt((await read(exported)).length));
    const shortcut = googleFixtureEntry('link', '');
    shortcut.mimeType = 'application/vnd.google-apps.shortcut';
    tree.set(shortcut.id, shortcut);
    const link = path(googleChildPath(googleRootPath, shortcut.name, shortcut.id));
    expect((await provider.stat(link)).kind).toBe('symbolic-link');
    await expect(provider.list(link)).rejects.toMatchObject({ code: 'PROVIDER_ACCESS_DENIED' });
    const nested = googleChildPath(
      googleChildPath(googleRootPath, shortcut.name, shortcut.id),
      'target',
      foreign.id,
    );
    await expect(provider.stat(path(nested))).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_PATH',
    });
  });
  it('creates folders and empty files, bounds upload chunks and resumes at the acknowledged offset', async () => {
    const folder = path(googleChildPath(googleRootPath, 'folder'));
    await provider.createDirectory(folder);
    const actual = await provider.stat(folder);
    expect(actual.kind).toBe('directory');
    const folderPath = required(actual.path.provider === 'google' ? actual.path.path : undefined);
    await put(googleChildPath(folderPath, 'empty'), Buffer.alloc(0));
    const address = googleChildPath(folderPath, 'large');
    const content = Buffer.alloc(5 * 1048576 + 19, 0x5a);
    let progress = 0;
    const writer = (
      await provider.openWrite(path(address), {
        expectedSize: BigInt(content.length),
        overwrite: false,
        onProgress: (bytes) => {
          progress += bytes;
        },
      })
    ).getWriter();
    await writer.write(content.subarray(0, 3 * 1048576));
    await writer.abort();
    expect(progress).toBe(2 * 1048576);
    const offset = await provider.resumeWriteOffset(path(address), {
      expectedSize: BigInt(content.length),
      overwrite: false,
    });
    expect(offset).toBe(progress);
    const resumed = (
      await provider.openWrite(path(address), {
        expectedSize: BigInt(content.length),
        overwrite: false,
        offset,
      })
    ).getWriter();
    await resumed.write(content.subarray(offset));
    await resumed.close();
    const result = await provider.stat(path(address));
    expect(result.size).toBe(BigInt(content.length));
    expect((await read((result.path as { path: string }).path)).equals(content)).toBe(true);
    expect(Math.max(...harness.fixture.chunkSizes)).toBeLessThanOrEqual(1048576);
    expect(
      harness.fixture.requests.some((request) => request.path === '/drive/v3/files/generateIds'),
    ).toBe(true);
  });
  it('rejects forged upload locations and impossible offsets and reports an expired session', async () => {
    const address = path(googleChildPath(googleRootPath, 'file'));
    harness.fixture.sessionLocation = 'https://attacker.example/upload?upload_id=x';
    await expect(
      provider.openWrite(address, { expectedSize: 4000000n, overwrite: false }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_PATH' });
    harness.fixture.sessionLocation = undefined;
    const writer = (
      await provider.openWrite(address, { expectedSize: 4000000n, overwrite: false })
    ).getWriter();
    await writer.write(Buffer.alloc(2000000));
    await writer.abort();
    harness.fixture.rangeOverride = 'bytes=0-3999999';
    await expect(
      provider.resumeWriteOffset(address, { expectedSize: 4000000n, overwrite: false }),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    harness.fixture.rangeOverride = undefined;
    harness.fixture.expireSessions = true;
    await expect(
      provider.resumeWriteOffset(address, { expectedSize: 4000000n, overwrite: false }),
    ).rejects.toMatchObject({ code: 'UNSAFE_RESUME' });
  });
  it.each([
    [403, 'storageQuotaExceeded', 'PROVIDER_QUOTA_EXCEEDED'],
    [403, 'rateLimitExceeded', 'PROVIDER_RATE_LIMITED'],
    [403, 'insufficientFilePermissions', 'PROVIDER_ACCESS_DENIED'],
    [429, '', 'PROVIDER_RATE_LIMITED'],
  ] as const)('normalizes %s %s', async (status, reason, code) => {
    harness.fixture.overrides.set('GET /drive/v3/files', {
      status,
      body: { error: { errors: [{ reason }] } },
      headers: { 'Retry-After': '0' },
    });
    await expect(provider.list(root)).rejects.toMatchObject({ code });
  });
  it('strictly validates ID addresses and isolates bearer credentials from signed redirects', async () => {
    const name = 'слэш/\\ #?~';
    const address = googleChildPath(googleRootPath, name, 'test-id');
    expect(parseGooglePath(address).segments[0]?.name).toBe(name);
    for (const invalid of [
      'gdrive:/name',
      'gdrive:/~new/id~child',
      'gdrive:/id~a?token=x',
      'gdrive:/id~%61',
      'gdrive:/id~a/../x',
      'https://evil',
    ])
      expect(() => parseGooglePath(invalid)).toThrow();
    const api = new GoogleApi(
      async () => 'fixture',
      () => undefined,
      2000,
      harness.fixture.endpoint,
    );
    expect(() =>
      api.session(
        'https://www.googleapis.com.evil/upload/drive/v3/files?uploadType=resumable&upload_id=x',
      ),
    ).toThrow();
    api.close();
  });
});
