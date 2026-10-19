import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';

export interface GoogleFixtureEntry {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  version: number;
  trashed: boolean;
  capabilities: Record<string, boolean>;
  driveId?: string;
}
export const googleFixtureEntry = (
  name: string,
  content?: string | Buffer,
  parent = 'root-id',
  id: string = randomUUID(),
): GoogleFixtureEntry => ({
  id,
  name,
  mimeType:
    content === undefined ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
  parents: parent ? [parent] : [],
  content: content === undefined ? Buffer.alloc(0) : Buffer.from(content),
  version: 1,
  trashed: false,
  capabilities: {
    canDownload: true,
    canModifyContent: true,
    canRename: true,
    canTrash: true,
    canListChildren: true,
    canAddChildren: true,
    canMoveItemWithinDrive: true,
  },
});
export interface GoogleFixtureRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body?: URLSearchParams;
  json?: unknown;
  length?: number;
}
export async function startGoogleFixture() {
  const accounts = new Map<string, Map<string, GoogleFixtureEntry>>();
  const codes = new Map<string, { account: string; challenge: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const sessions = new Map<
    string,
    {
      account: string;
      id: string;
      name: string;
      parent: string;
      content: Buffer;
      total: number;
      complete: boolean;
    }
  >();
  const fixture = {
    origin: '',
    endpoint: '',
    accounts,
    sessions,
    requests: [] as GoogleFixtureRequest[],
    rejectedTokens: new Set<string>(),
    overrides: new Map<
      string,
      { status: number; body?: unknown; headers?: Record<string, string> }
    >(),
    nextAccount: 'one',
    authorizationMode: 'normal' as 'normal' | 'stall' | 'deny',
    refreshMode: 'normal' as 'normal' | 'invalid' | 'unavailable',
    pageSize: 2,
    sessionLocation: undefined as string | undefined,
    expireSessions: false,
    rangeOverride: undefined as string | undefined,
    chunkDelay: 0,
    partialChunkOnce: undefined as number | undefined,
    failChunkOnce: false,
    loseCompletionOnce: false,
    chunkSizes: [] as number[],
    afterChunk: undefined as (() => void) | undefined,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const tree = (account: string) => {
    let entries = accounts.get(account);
    if (!entries) {
      entries = new Map([['root-id', googleFixtureEntry('My Drive', undefined, '', 'root-id')]]);
      accounts.set(account, entries);
    }
    return entries;
  };
  const metadata = (entry: GoogleFixtureEntry) => ({
    id: entry.id,
    name: entry.name,
    mimeType: entry.mimeType,
    parents: entry.parents,
    size: String(entry.content.length),
    version: String(entry.version),
    modifiedTime: '2026-10-19T10:00:00Z',
    md5Checksum: createHash('md5').update(entry.content).digest('hex'),
    trashed: entry.trashed,
    capabilities: entry.capabilities,
    ...(entry.driveId ? { driveId: entry.driveId } : {}),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', fixture.origin);
    const record: GoogleFixtureRequest = {
      method: request.method ?? '',
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
    };
    fixture.requests.push(record);
    const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
      request.resume();
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    const collect = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    };
    try {
      const override = fixture.overrides.get(`${record.method} ${url.pathname}`);
      if (override) {
        json(override.status, override.body, override.headers);
        return;
      }
      if (url.pathname === '/authorize') {
        if (fixture.authorizationMode === 'stall') {
          json(200);
          return;
        }
        const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('state', url.searchParams.get('state') ?? '');
        if (fixture.authorizationMode === 'deny')
          callback.searchParams.set('error', 'access_denied');
        else {
          const code = randomUUID();
          codes.set(code, {
            account: fixture.nextAccount,
            challenge: url.searchParams.get('code_challenge') ?? '',
          });
          callback.searchParams.set('code', code);
        }
        response.writeHead(302, { Location: callback.href });
        response.end();
        return;
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams((await collect()).toString());
        record.body = body;
        let account: string | undefined;
        if (body.get('grant_type') === 'authorization_code') {
          const code = body.get('code') ?? '';
          const entry = codes.get(code);
          codes.delete(code);
          if (
            entry?.challenge ===
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest('base64url')
          )
            account = entry.account;
        } else {
          if (fixture.refreshMode !== 'normal') {
            json(fixture.refreshMode === 'invalid' ? 400 : 503, { error: 'invalid_grant' });
            return;
          }
          account = refresh.get(body.get('refresh_token') ?? '');
          refresh.delete(body.get('refresh_token') ?? '');
        }
        if (!account) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        tree(account);
        const accessToken = `fixture-access-${randomUUID()}`;
        const refreshToken = `fixture-refresh-${randomUUID()}`;
        access.set(accessToken, account);
        refresh.set(refreshToken, account);
        json(200, {
          token_type: 'Bearer',
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive',
        });
        return;
      }
      const rawToken = request.headers.authorization?.replace(/^Bearer /u, '') ?? '';
      const account = access.get(rawToken);
      if (!account || fixture.rejectedTokens.has(rawToken)) {
        json(401);
        return;
      }
      const entries = tree(account);
      if (url.pathname === '/drive/v3/about') {
        json(200, {
          user: {
            permissionId: account,
            emailAddress: `fixture-${account}@example.test`,
            displayName: account,
          },
        });
        return;
      }
      if (url.pathname === '/drive/v3/files/generateIds') {
        json(200, { ids: [randomUUID()] });
        return;
      }
      if (url.pathname.startsWith('/upload/drive/v3/files')) {
        const sessionId = url.searchParams.get('upload_id');
        if (!sessionId) {
          const body = JSON.parse((await collect()).toString()) as {
            id?: string;
            name?: string;
            parents?: string[];
          };
          record.json = body;
          const existing =
            record.method === 'PATCH'
              ? entries.get(url.pathname.split('/').at(-1) ?? '')
              : undefined;
          const id = existing?.id ?? body.id ?? '';
          if (!id || (!existing && entries.has(id))) {
            json(409);
            return;
          }
          const key = randomUUID();
          sessions.set(key, {
            account,
            id,
            name: existing?.name ?? body.name ?? '',
            parent: existing?.parents[0] ?? body.parents?.[0] ?? '',
            content: Buffer.alloc(0),
            total: Number(request.headers['x-upload-content-length']),
            complete: false,
          });
          json(
            200,
            {},
            {
              Location:
                fixture.sessionLocation ??
                `${fixture.origin}/upload/drive/v3/files?uploadType=resumable&upload_id=${key}`,
            },
          );
          return;
        }
        const session = sessions.get(sessionId);
        if (!session || session.account !== account || fixture.expireSessions) {
          json(404);
          return;
        }
        let bytes = await collect();
        record.length = bytes.length;
        const range = request.headers['content-range'];
        if (range === `bytes */${session.total}` && bytes.length === 0 && session.total > 0) {
          if (session.complete) {
            json(200, { id: session.id, size: String(session.total) });
            return;
          }
          json(
            308,
            {},
            fixture.rangeOverride
              ? { Range: fixture.rangeOverride }
              : session.content.length
                ? { Range: `bytes=0-${session.content.length - 1}` }
                : {},
          );
          return;
        }
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range ?? '');
        if (
          !(session.total === 0 && range === 'bytes */0') &&
          (!match ||
            Number(match[1]) !== session.content.length ||
            Number(match[2]) + 1 !== session.content.length + bytes.length ||
            Number(match[3]) !== session.total)
        ) {
          json(400);
          return;
        }
        fixture.chunkSizes.push(bytes.length);
        if (fixture.partialChunkOnce !== undefined) {
          bytes = bytes.subarray(0, fixture.partialChunkOnce);
          fixture.partialChunkOnce = undefined;
        }
        session.content = Buffer.concat([session.content, bytes]);
        fixture.afterChunk?.();
        if (fixture.chunkDelay)
          await new Promise((resolve) => setTimeout(resolve, fixture.chunkDelay));
        if (response.destroyed) return;
        if (fixture.failChunkOnce) {
          fixture.failChunkOnce = false;
          json(503);
          return;
        }
        if (session.content.length === session.total) {
          const existing = entries.get(session.id);
          const entry =
            existing ??
            googleFixtureEntry(session.name, session.content, session.parent, session.id);
          entry.content = session.content;
          entry.version += 1;
          entries.set(entry.id, entry);
          session.complete = true;
          if (fixture.loseCompletionOnce) {
            fixture.loseCompletionOnce = false;
            response.destroy();
            return;
          }
          json(200, {
            id: session.id,
            size: String(session.total),
            version: String(entry.version),
          });
          return;
        }
        json(308, {}, { Range: fixture.rangeOverride ?? `bytes=0-${session.content.length - 1}` });
        return;
      }
      if (url.pathname === '/drive/v3/files') {
        if (record.method === 'POST') {
          const body = JSON.parse((await collect()).toString()) as {
            id: string;
            name: string;
            parents: string[];
            mimeType: string;
          };
          record.json = body;
          if (entries.has(body.id)) {
            json(409);
            return;
          }
          const entry = googleFixtureEntry(body.name, undefined, body.parents[0], body.id);
          entry.mimeType = body.mimeType;
          entries.set(entry.id, entry);
          json(200, metadata(entry));
          return;
        }
        const parent = /'([^']+)' in parents/u.exec(url.searchParams.get('q') ?? '')?.[1];
        const all = [...entries.values()].filter(
          (entry) => entry.parents[0] === parent && !entry.trashed,
        );
        const offset = Number(url.searchParams.get('pageToken') ?? 0);
        const files = all.slice(offset, offset + fixture.pageSize).map(metadata);
        json(200, {
          files,
          ...(offset + files.length < all.length
            ? { nextPageToken: String(offset + files.length) }
            : {}),
          incompleteSearch: false,
        });
        return;
      }
      const parts = url.pathname.split('/');
      let id = parts[4] ?? '';
      if (id === 'root') id = 'root-id';
      const entry = entries.get(id);
      if (!entry || entry.trashed) {
        json(404);
        return;
      }
      if (record.method === 'PATCH') {
        const body = JSON.parse((await collect()).toString()) as {
          name?: string;
          trashed?: boolean;
        };
        record.json = body;
        if (body.trashed !== undefined) entry.trashed = body.trashed;
        if (body.name) entry.name = body.name;
        if (url.searchParams.get('addParents'))
          entry.parents = [url.searchParams.get('addParents') ?? ''];
        entry.version += 1;
        json(200, metadata(entry));
        return;
      }
      if (url.searchParams.get('alt') === 'media' || parts[5] === 'export') {
        if (!entry.capabilities.canDownload) {
          json(403);
          return;
        }
        const content =
          parts[5] === 'export'
            ? Buffer.from(`export:${entry.id}:${url.searchParams.get('mimeType')}`)
            : entry.content;
        const offset = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? '')?.[1] ?? 0);
        response.writeHead(offset ? 206 : 200, {
          'Content-Length': content.length - offset,
          ...(offset
            ? { 'Content-Range': `bytes ${offset}-${content.length - 1}/${content.length}` }
            : {}),
        });
        for (let position = offset; position < content.length; position += 65536)
          if (!response.write(content.subarray(position, position + 65536)))
            await once(response, 'drain');
        response.end();
        return;
      }
      json(200, metadata(entry));
    } catch {
      if (!response.headersSent) json(500);
      else response.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  fixture.origin = `http://127.0.0.1:${address.port}`;
  fixture.endpoint = `${fixture.origin}/drive/v3`;
  return fixture;
}
export type GoogleFixture = Awaited<ReturnType<typeof startGoogleFixture>>;
