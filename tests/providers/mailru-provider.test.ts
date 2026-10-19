// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailruConnection } from '../../src/main/providers/mailru/mailru-connection';
import { MailruProvider } from '../../src/main/providers/mailru/mailru-provider';
import { parseWebDavEntries } from '../../src/main/providers/mailru/webdav-xml';
import { WebDavTransport } from '../../src/main/providers/mailru/webdav-transport';
import { createMailruProviderPath as path } from '../../src/shared/models/provider-path';
import type { MailruConnectionProfile } from '../../src/shared/models/connection-profile';
import {
  fixtureMailruPassword,
  fixtureMailruUsername,
  startWebDavFixture,
  type WebDavFixture,
} from '../fixtures/webdav-fixture';
import { serializeApplicationError } from '../../src/main/ipc/application-error';

const profile = (): MailruConnectionProfile => ({
  id: '00000000-0000-4000-8000-000000000031',
  name: 'Mail fixture',
  kind: 'mailru',
  username: fixtureMailruUsername,
  timeout: 1000,
  authentication: {
    method: 'password',
    secret: { id: '00000000-0000-4000-8000-000000000032', storage: 'safe-storage' },
  },
});
const write = async (provider: MailruProvider, name: string, content: string) => {
  const writer = (await provider.openWrite(path(name), { overwrite: false })).getWriter();
  await writer.write(Buffer.from(content));
  await writer.close();
};

describe('Mail.ru WebDAV protocol and safety', () => {
  let fixture: WebDavFixture;
  let provider: MailruProvider;
  beforeEach(async () => {
    fixture = await startWebDavFixture();
    provider = new MailruProvider(
      new MailruConnection(
        profile(),
        async () => ({ password: fixtureMailruPassword }),
        fixture.endpoint,
      ),
    );
    await provider.connect();
  });
  afterEach(async () => {
    await provider?.disconnect();
    await fixture?.close();
  });

  it('encodes Unicode, percent signs, XML characters, spaces and URL punctuation once', async () => {
    const name = '/Привет %2F +#?&<>.txt';
    await write(provider, name, 'fixture content');
    expect((await provider.list(path('/'))).map((entry) => entry.name)).toEqual([name.slice(1)]);
    expect(await new Response(await provider.openRead(path(name))).text()).toBe('fixture content');
    await provider.rename(path(name), path('/renamed %25.txt'));
    expect(fixture.entries.has('/renamed %25.txt')).toBe(true);
    expect(
      fixture.requests.some(
        (request) => request.method === 'MOVE' && request.headers.destination?.includes('%2525'),
      ),
    ).toBe(true);
  });

  it('uses a conditional MOVE and never deletes the old destination before publishing', async () => {
    await write(provider, '/part', 'new');
    await write(provider, '/target', 'old');
    fixture.overrides.set('MOVE /part', { status: 503, body: 'private server details' });
    await expect(
      provider.rename(path('/part'), path('/target'), { overwrite: true }),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    expect(fixture.entries.get('/target')?.content.toString()).toBe('old');
    expect(fixture.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
    fixture.overrides.clear();
    await provider.rename(path('/part'), path('/target'), { overwrite: true });
    expect(fixture.entries.get('/target')?.content.toString()).toBe('new');
    expect(fixture.requests.at(-1)?.headers.overwrite).toBe('T');
  });

  it('protects a destination created between the final stat and MOVE', async () => {
    await write(provider, '/part', 'new');
    fixture.beforeMove = () =>
      fixture.entries.set('/target', { kind: 'file', content: Buffer.from('concurrent') });
    await expect(
      provider.rename(path('/part'), path('/target'), { overwrite: false }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect(fixture.entries.get('/target')?.content.toString()).toBe('concurrent');
    expect(fixture.requests.at(-1)?.headers.overwrite).toBe('F');
  });

  it('protects conditional PUT and GET against concurrent changes', async () => {
    const writer = (await provider.openWrite(path('/race'), { overwrite: false })).getWriter();
    void writer.closed.catch(() => undefined);
    fixture.entries.set('/race', { kind: 'file', content: Buffer.from('concurrent') });
    await expect(
      (async () => {
        await writer.write(Buffer.from('replacement'));
        await writer.close();
      })(),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    expect(fixture.entries.get('/race')?.content.toString()).toBe('concurrent');
    const original = await provider.stat(path('/race'));
    if (!original.versionTag) throw new Error('Fixture ETag is missing.');
    fixture.entries.set('/race', { kind: 'file', content: Buffer.from('changed') });
    await expect(
      provider.openRead(path('/race'), { versionTag: original.versionTag }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  });

  it.each([
    [403, 'PROVIDER_ACCESS_DENIED'],
    [404, 'PROVIDER_NOT_FOUND'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [507, 'PROVIDER_QUOTA_EXCEEDED'],
  ])('maps HTTP %i without exposing response details', async (status, code) => {
    fixture.overrides.set('PROPFIND /', {
      status: Number(status),
      body: 'private response canary',
    });
    const error = await provider.list(path('/')).catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(serializeApplicationError(error))).not.toContain('canary');
  });

  it('rejects redirects without sending authorization to the redirect target', async () => {
    await write(provider, '/file', 'content');
    const other = await startWebDavFixture();
    try {
      fixture.overrides.set('GET /file', {
        status: 302,
        headers: { Location: `${other.endpoint}/stolen` },
      });
      await expect(provider.openRead(path('/file'))).rejects.toMatchObject({
        code: 'PROVIDER_IO_ERROR',
      });
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('rejects credentials at an arbitrary endpoint even when injected in main', () => {
    expect(
      () => new WebDavTransport('fixture', 'fixture', 1000, 'https://untrusted.example'),
    ).toThrow();
    expect(
      () => new WebDavTransport('fixture', 'fixture', 1000, 'http://webdav.cloud.mail.ru'),
    ).toThrow();
  });

  it('handles an expired app password as authentication failure and allows reconnect', async () => {
    fixture.overrides.set('PROPFIND /', { status: 401 });
    await expect(provider.list(path('/'))).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(provider.connection.failureCode).toBe('AUTHENTICATION_FAILED');
    fixture.overrides.clear();
    await provider.connect();
    expect(provider.connectionState).toBe('connected');
  });

  it('explains a refused WebDAV connection without exposing the server response', async () => {
    await provider.disconnect();
    fixture.overrides.set('PROPFIND /', { status: 403, body: 'private response canary' });
    const error = await provider.connect().catch((value: unknown) => value);
    expect(provider.connection.failureCode).toBe('MAILRU_WEBDAV_ACCESS_DENIED');
    expect(serializeApplicationError(error)).toEqual({
      code: 'MAILRU_WEBDAV_ACCESS_DENIED',
      messageKey: 'errors.mailru.webdavAccessDenied',
    });
    expect(JSON.stringify(serializeApplicationError(error))).not.toContain('canary');
    fixture.overrides.clear();
    await provider.connect();
    expect(provider.connectionState).toBe('connected');
  });

  it('cancels an active PUT and keeps the final filename untouched', async () => {
    const cancellation = new AbortController();
    const writer = (
      await provider.openWrite(path('/.openscp-part-fixture'), {
        overwrite: false,
        signal: cancellation.signal,
      })
    ).getWriter();
    const finished = writer.closed.catch((error: unknown) => error);
    await writer.write(Buffer.alloc(65536));
    cancellation.abort();
    expect(await finished).toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(fixture.entries.has('/final')).toBe(false);
    await provider.list(path('/'));
  });

  it('waits for the upload response and rejects an unacknowledged write', async () => {
    const writer = (
      await provider.openWrite(path('/declared'), { overwrite: false, expectedSize: 5n })
    ).getWriter();
    void writer.closed.catch(() => undefined);
    await writer.write(Buffer.from('123'));
    await expect(writer.close()).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
  });

  it('cancels a download between bounded reads', async () => {
    fixture.entries.set('/large', { kind: 'file', content: Buffer.alloc(8 * 1048576) });
    const cancellation = new AbortController();
    const reader = (
      await provider.openRead(path('/large'), { signal: cancellation.signal })
    ).getReader();
    await reader.read();
    cancellation.abort();
    const failed = async () => {
      while (!(await reader.read()).done) {
        /* Ограниченная очередь может содержать уже принятый чанк. */
      }
    };
    await expect(failed()).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
  });

  it('ignores weak ETags that cannot protect an If-Match request', () => {
    const xml =
      '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/weak</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>0</D:getcontentlength><D:getetag>W/&quot;weak&quot;</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
    expect(
      parseWebDavEntries(xml, new URL(fixture.endpoint), 'stat')[0]?.versionTag,
    ).toBeUndefined();
  });

  it('reports partial multi-status DELETE as a failure', async () => {
    await write(provider, '/protected', 'content');
    fixture.overrides.set('DELETE /protected', {
      status: 207,
      body: '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/protected</D:href><D:status>HTTP/1.1 423 Locked</D:status></D:response></D:multistatus>',
    });
    await expect(provider.delete(path('/protected'), { recursive: true })).rejects.toMatchObject({
      code: 'PROVIDER_CONFLICT',
    });
    expect(fixture.entries.has('/protected')).toBe(true);
  });

  it('cancels connection while credentials are unresolved without making a request', async () => {
    let resolveCredentials: ((value: { password: string }) => void) | undefined;
    const connection = new MailruConnection(
      profile(),
      () =>
        new Promise((resolve) => {
          resolveCredentials = resolve;
        }),
      fixture.endpoint,
    );
    const before = fixture.requests.length;
    const pending = connection.connect();
    connection.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    resolveCredentials?.({ password: fixtureMailruPassword });
    expect(fixture.requests).toHaveLength(before);
    expect(connection.state).toBe('disconnected');
  });

  it('rejects corrupt XML and external entities', async () => {
    expect(() =>
      parseWebDavEntries(
        '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]><D:multistatus xmlns:D="DAV:"/>',
        new URL(fixture.endpoint),
        'list',
      ),
    ).toThrow();
    for (const body of ['<broken', '<D:multistatus xmlns:D="wrong"/>']) {
      fixture.overrides.set('PROPFIND /', { status: 207, body });
      await expect(provider.list(path('/'))).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    }
  });
});
