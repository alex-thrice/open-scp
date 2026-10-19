import { createServer, type IncomingHttpHeaders } from 'node:http';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';

export const fixtureMailruUsername = 'fixture@example.test';
export const fixtureMailruPassword = 'webdav-fixture-password-only';
interface FixtureEntry {
  readonly kind: 'directory' | 'file';
  readonly content: Buffer;
}
interface Override {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly delay?: number;
}
export interface WebDavFixture {
  readonly endpoint: string;
  readonly entries: Map<string, FixtureEntry>;
  readonly overrides: Map<string, Override>;
  readonly requests: { method: string; path: string; headers: IncomingHttpHeaders }[];
  beforeMove?: () => void;
  close(): Promise<void>;
}
const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const encodedPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const etag = (entry: FixtureEntry) =>
  `"${createHash('sha256').update(entry.content).digest('hex')}"`;

export const startWebDavFixture = async (): Promise<WebDavFixture> => {
  const entries = new Map<string, FixtureEntry>([
    ['/', { kind: 'directory', content: Buffer.alloc(0) }],
  ]);
  const overrides = new Map<string, Override>();
  const requests: WebDavFixture['requests'] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? '';
      const path =
        decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(
          /\/$/u,
          '',
        ) || '/';
      requests.push({ method, path, headers: request.headers });
      const send = (status: number, body = '') => {
        response.writeHead(status);
        response.end(body);
      };
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from(`${fixtureMailruUsername}:${fixtureMailruPassword}`).toString('base64')}`
      ) {
        request.resume();
        send(401);
        return;
      }
      const override = overrides.get(`${method} ${path}`);
      if (override) {
        if (override.delay) await new Promise((resolve) => setTimeout(resolve, override.delay));
        request.resume();
        response.writeHead(override.status, override.headers);
        response.end(override.body ?? '');
        return;
      }
      const entry = entries.get(path);
      if (method === 'PROPFIND') {
        request.resume();
        if (!entry) {
          send(404);
          return;
        }
        const listed = [...entries].filter(
          ([item]) =>
            item === path ||
            (request.headers.depth === '1' && item !== '/' && posix.dirname(item) === path),
        );
        const xml = listed
          .map(
            ([name, item]) =>
              `<D:response><D:href>${escapeXml(encodedPath(name))}${item.kind === 'directory' && name !== '/' ? '/' : ''}</D:href><D:propstat><D:prop><D:resourcetype>${item.kind === 'directory' ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>${item.content.length}</D:getcontentlength><D:getlastmodified>Mon, 19 Oct 2026 00:00:00 GMT</D:getlastmodified><D:getetag>${escapeXml(etag(item))}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
          )
          .join('');
        response.setHeader('Content-Type', 'application/xml; charset=utf-8');
        send(207, `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${xml}</D:multistatus>`);
        return;
      }
      if (method === 'MKCOL') {
        request.resume();
        if (entry) {
          send(405);
          return;
        }
        if (entries.get(posix.dirname(path))?.kind !== 'directory') {
          send(409);
          return;
        }
        entries.set(path, { kind: 'directory', content: Buffer.alloc(0) });
        send(201);
        return;
      }
      if (method === 'PUT') {
        if (
          (entry && request.headers['if-none-match'] === '*') ||
          (request.headers['if-match'] && (!entry || request.headers['if-match'] !== etag(entry)))
        ) {
          request.resume();
          send(412);
          return;
        }
        if (entry?.kind === 'directory' || entries.get(posix.dirname(path))?.kind !== 'directory') {
          request.resume();
          send(409);
          return;
        }
        const chunks: Buffer[] = [];
        request.once('aborted', () =>
          entries.set(path, { kind: 'file', content: Buffer.concat(chunks) }),
        );
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        entries.set(path, { kind: 'file', content: Buffer.concat(chunks) });
        send(entry ? 204 : 201);
        return;
      }
      if (method === 'GET') {
        request.resume();
        if (!entry) {
          send(404);
          return;
        }
        if (entry.kind !== 'file') {
          send(405);
          return;
        }
        if (request.headers['if-match'] && request.headers['if-match'] !== etag(entry)) {
          send(412);
          return;
        }
        response.writeHead(200, {
          'Content-Length': String(entry.content.length),
          ETag: etag(entry),
        });
        response.end(entry.content);
        return;
      }
      if (method === 'MOVE') {
        request.resume();
        fixture.beforeMove?.();
        if (!entry) {
          send(404);
          return;
        }
        const destination =
          decodeURIComponent(new URL(String(request.headers.destination)).pathname).replace(
            /\/$/u,
            '',
          ) || '/';
        if (entries.has(destination) && request.headers.overwrite !== 'T') {
          send(412);
          return;
        }
        if (entries.get(posix.dirname(destination))?.kind !== 'directory') {
          send(409);
          return;
        }
        const moved = [...entries].filter(([item]) => item === path || item.startsWith(`${path}/`));
        for (const [name, item] of moved) {
          entries.set(destination + name.slice(path.length), item);
          entries.delete(name);
        }
        send(201);
        return;
      }
      if (method === 'DELETE') {
        request.resume();
        if (!entry) {
          send(404);
          return;
        }
        for (const name of entries.keys())
          if (name === path || name.startsWith(`${path}/`)) entries.delete(name);
        send(204);
        return;
      }
      request.resume();
      send(405);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port.');
  const fixture: WebDavFixture = {
    endpoint: `http://127.0.0.1:${address.port}`,
    entries,
    overrides,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  return fixture;
};
