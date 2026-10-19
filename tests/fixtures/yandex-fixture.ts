import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';

export interface YandexFixtureEntry {
  kind: 'file' | 'directory';
  content: Buffer;
  id: string;
}
export const yandexFixtureEntry = (content?: string | Buffer): YandexFixtureEntry => ({
  kind: content === undefined ? 'directory' : 'file',
  content: content === undefined ? Buffer.alloc(0) : Buffer.from(content),
  id: randomUUID(),
});
export interface YandexFixtureRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body?: URLSearchParams;
}
export async function startYandexFixture() {
  const accounts = new Map<string, Map<string, YandexFixtureEntry>>();
  const codes = new Map<string, { account: string; challenge: string }>();
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  const transfers = new Map<string, { account: string; path: string; overwrite: boolean }>();
  const operations = new Map<string, { polls: number; apply: () => void }>();
  const fixture = {
    origin: '',
    endpoint: '',
    accounts,
    requests: [] as YandexFixtureRequest[],
    rejectedTokens: new Set<string>(),
    overrides: new Map<
      string,
      { status: number; body?: unknown; headers?: Record<string, string> }
    >(),
    nextAccount: 'one',
    authorizationMode: 'normal' as 'normal' | 'stall' | 'deny',
    refreshMode: 'normal' as 'normal' | 'invalid' | 'unavailable',
    pageSize: 2,
    transferHref: undefined as string | undefined,
    beforeMove: undefined as (() => void) | undefined,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const entries = (account: string) => {
    let result = accounts.get(account);
    if (!result) {
      result = new Map([['/', yandexFixtureEntry()]]);
      accounts.set(account, result);
    }
    return result;
  };
  const metadata = (path: string, entry: YandexFixtureEntry) => ({
    name: path === '/' ? 'disk' : path.slice(path.lastIndexOf('/') + 1),
    path: `disk:${path}`,
    type: entry.kind === 'directory' ? 'dir' : 'file',
    size: entry.content.length,
    modified: '2026-10-19T10:00:00+00:00',
    resource_id: entry.id,
    md5: createHash('md5').update(entry.content).digest('hex'),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', fixture.origin);
    const record: YandexFixtureRequest = {
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
    const override = fixture.overrides.get(`${record.method} ${url.pathname}`);
    if (override) {
      json(override.status, override.body, override.headers);
      return;
    }
    try {
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
            account: url.searchParams.get('fixture_account') ?? fixture.nextAccount,
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
        if (body.has('client_secret') || request.headers.authorization) {
          json(400);
          return;
        }
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
        entries(account);
        const accessToken = `fixture-access-${randomUUID()}`;
        const refreshToken = `fixture-refresh-${randomUUID()}`;
        access.set(accessToken, account);
        refresh.set(refreshToken, account);
        json(200, {
          token_type: 'bearer',
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
        });
        return;
      }
      const transfer = transfers.get(url.pathname);
      if (transfer) {
        if (request.headers.authorization) {
          json(403);
          return;
        }
        const tree = entries(transfer.account);
        if (request.method === 'GET') {
          const entry = tree.get(transfer.path);
          if (!entry) {
            json(404);
            return;
          }
          response.writeHead(200, { 'Content-Length': entry.content.length });
          for (let offset = 0; offset < entry.content.length; offset += 65536) {
            if (!response.write(entry.content.subarray(offset, offset + 65536)))
              await once(response, 'drain');
          }
          response.end();
          return;
        }
        const content = await collect();
        if (tree.has(transfer.path) && !transfer.overwrite) {
          json(409);
          return;
        }
        tree.set(transfer.path, yandexFixtureEntry(content));
        json(201);
        return;
      }
      const rawToken = request.headers.authorization?.replace(/^OAuth /u, '') ?? '';
      const account = access.get(rawToken);
      if (!account || fixture.rejectedTokens.has(rawToken)) {
        json(401);
        return;
      }
      const tree = entries(account);
      if (url.pathname === '/v1/disk') {
        json(200, { user: { uid: account, login: `fixture-${account}`, display_name: account } });
        return;
      }
      const path = (url.searchParams.get('path') ?? '').replace(/^disk:/u, '');
      const entry = tree.get(path);
      if (url.pathname.startsWith('/v1/disk/operations/')) {
        const operation = operations.get(url.pathname);
        if (!operation) {
          json(404);
          return;
        }
        if (operation.polls++ === 0) {
          json(200, { status: 'in-progress' });
          return;
        }
        try {
          operation.apply();
          json(200, { status: 'success' });
        } catch {
          json(200, { status: 'failed' });
        }
        return;
      }
      if (
        url.pathname === '/v1/disk/resources/download' ||
        url.pathname === '/v1/disk/resources/upload'
      ) {
        const download = url.pathname.endsWith('/download');
        if (download && !entry) {
          json(404);
          return;
        }
        const transferPath = `/transfer/${randomUUID()}`;
        transfers.set(transferPath, {
          account,
          path,
          overwrite: url.searchParams.get('overwrite') === 'true',
        });
        json(200, {
          href: fixture.transferHref ?? `${fixture.origin}${transferPath}?signed=fixture-only`,
          method: download ? 'GET' : 'PUT',
          templated: false,
        });
        return;
      }
      if (url.pathname === '/v1/disk/resources' && request.method === 'GET') {
        if (!entry) {
          json(404);
          return;
        }
        const meta = metadata(path, entry);
        if (entry.kind === 'file' || url.searchParams.has('fields')) {
          json(200, meta);
          return;
        }
        const children = [...tree]
          .filter(
            ([candidate]) =>
              candidate !== path &&
              candidate.slice(0, candidate.lastIndexOf('/')) === (path === '/' ? '' : path),
          )
          .sort(([a], [b]) => a.localeCompare(b));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Math.min(fixture.pageSize, Number(url.searchParams.get('limit') ?? 200));
        json(200, {
          ...meta,
          _embedded: {
            offset,
            limit,
            total: children.length,
            items: children
              .slice(offset, offset + limit)
              .map(([name, item]) => metadata(name, item)),
          },
        });
        return;
      }
      if (url.pathname === '/v1/disk/resources' && request.method === 'PUT') {
        if (entry) {
          json(409);
          return;
        }
        if (!tree.has(path.slice(0, path.lastIndexOf('/')) || '/')) {
          json(404);
          return;
        }
        tree.set(path, yandexFixtureEntry());
        json(201);
        return;
      }
      let apply: (() => void) | undefined;
      if (url.pathname === '/v1/disk/resources/move' && request.method === 'POST') {
        fixture.beforeMove?.();
        fixture.beforeMove = undefined;
        const from = (url.searchParams.get('from') ?? '').replace(/^disk:/u, '');
        if (!tree.has(from)) {
          json(404);
          return;
        }
        if (tree.has(path) && url.searchParams.get('overwrite') !== 'true') {
          json(409);
          return;
        }
        apply = () => {
          const moved = [...tree].filter(([name]) => name === from || name.startsWith(`${from}/`));
          for (const [name, item] of moved) {
            tree.delete(name);
            tree.set(path + name.slice(from.length), item);
          }
        };
      }
      if (url.pathname === '/v1/disk/resources' && request.method === 'DELETE') {
        if (!entry) {
          json(404);
          return;
        }
        apply = () => {
          for (const name of tree.keys())
            if (name === path || name.startsWith(`${path}/`)) tree.delete(name);
        };
      }
      if (apply) {
        const operationPath = `/v1/disk/operations/${randomUUID()}`;
        operations.set(operationPath, { polls: 0, apply });
        json(202, { href: `${fixture.origin}${operationPath}`, method: 'GET', templated: false });
        return;
      }
      json(404);
    } catch {
      if (!response.headersSent) json(500);
      else response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  fixture.origin = `http://127.0.0.1:${address.port}`;
  fixture.endpoint = `${fixture.origin}/v1/disk`;
  return fixture;
}
export type YandexFixture = Awaited<ReturnType<typeof startYandexFixture>>;
