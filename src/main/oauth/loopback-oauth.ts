import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';
import { HttpClient, readHttpBody } from './http-client';

const token = z
  .string()
  .min(1)
  .max(16384)
  .refine(
    (value) =>
      ![...value].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ),
  );
export const oauthBundleSchema = z.strictObject({
  accessToken: token,
  refreshToken: token.optional(),
  expiresAt: z.number().finite().positive().optional(),
  clientId: z.string().min(1).max(200),
});
export type OAuthBundle = z.infer<typeof oauthBundleSchema>;
export interface OAuthConfiguration {
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly callbackPath: string;
  readonly port: number;
  readonly scopes: readonly string[];
  readonly openBrowser: (url: string) => Promise<void>;
  readonly allowLoopbackEndpoints?: boolean;
  readonly timeout?: number;
}
interface PendingLogin {
  readonly verifier: string;
  readonly signal: AbortSignal;
  readonly finish: (code?: string, error?: ApplicationError) => void;
}
const same = (left: string, right: string) => {
  const expected = Buffer.from(left);
  const received = Buffer.from(right);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

export class LoopbackOAuth {
  private server: Server | undefined;
  private listening: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingLogin>();
  private readonly clients = new Set<HttpClient>();
  public constructor(private readonly configuration: OAuthConfiguration) {
    for (const endpoint of [configuration.authorizationEndpoint, configuration.tokenEndpoint]) {
      const url = new URL(endpoint);
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(
            configuration.allowLoopbackEndpoints &&
            url.protocol === 'http:' &&
            url.hostname === '127.0.0.1'
          ))
      )
        throw new ApplicationError(applicationErrorCodes.oauthConfiguration);
    }
  }
  public get configured(): boolean {
    return /^[A-Za-z\d._-]{1,200}$/u.test(this.configuration.clientId);
  }
  private async listen(): Promise<void> {
    if (this.listening) return this.listening;
    this.listening = new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        response.setHeader('Connection', 'close');
        const address = server.address();
        const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
        let url: URL;
        try {
          url = new URL(request.url ?? '/', `http://${host || '127.0.0.1'}`);
        } catch {
          response.writeHead(400);
          response.end('Invalid authorization response.');
          return;
        }
        const state = url.searchParams.get('state') ?? '';
        const pending = [...this.pending].find(([candidate]) => same(candidate, state))?.[1];
        if (
          request.method !== 'GET' ||
          request.headers.host !== host ||
          url.origin !== `http://${host}` ||
          url.pathname !== this.configuration.callbackPath ||
          !pending ||
          (request.url?.length ?? 0) > 8192 ||
          url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.getAll('code').length > 1 ||
          url.searchParams.getAll('error').length > 1
        ) {
          response.writeHead(400);
          response.end('Invalid authorization response.');
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if ((!code && !error) || (code && error) || (code?.length ?? 0) > 2048) {
          response.writeHead(400);
          response.end('Invalid authorization response.');
          return;
        }
        response.writeHead(200);
        response.end('OpenSCP: ответ получен. Можно закрыть эту вкладку и вернуться в приложение.');
        pending.finish(
          code ?? undefined,
          error ? new ApplicationError(applicationErrorCodes.oauthRequired) : undefined,
        );
      });
      this.server = server;
      server.maxHeadersCount = 40;
      server.headersTimeout = 10000;
      server.requestTimeout = 10000;
      server.once('error', () => {
        this.listening = undefined;
        this.server = undefined;
        reject(new ApplicationError(applicationErrorCodes.oauthCallbackUnavailable));
      });
      server.listen(this.configuration.port, '127.0.0.1', () => resolve());
    });
    return this.listening;
  }
  public async authorize(
    signal: AbortSignal,
    stage?: (stage: 'waiting' | 'exchanging') => void,
  ): Promise<OAuthBundle> {
    if (!this.configured) throw new ApplicationError(applicationErrorCodes.oauthConfiguration);
    if (signal.aborted) throw new ApplicationError(applicationErrorCodes.providerCancelled);
    await this.listen();
    if (signal.aborted) throw new ApplicationError(applicationErrorCodes.providerCancelled);
    const address = this.server?.address();
    if (!address || typeof address === 'string')
      throw new ApplicationError(applicationErrorCodes.oauthCallbackUnavailable);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const redirectUri = `http://127.0.0.1:${address.port}${this.configuration.callbackPath}`;
    const code = await new Promise<string>((resolve, reject) => {
      let finished = false;
      const finish = (value?: string, error?: ApplicationError) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending.delete(state);
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const abort = () =>
        finish(undefined, new ApplicationError(applicationErrorCodes.providerCancelled));
      const timer = setTimeout(
        () => finish(undefined, new ApplicationError(applicationErrorCodes.oauthTimeout)),
        this.configuration.timeout ?? 180000,
      );
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(state, { verifier, signal, finish });
      const url = new URL(this.configuration.authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: this.configuration.clientId,
        redirect_uri: redirectUri,
        scope: this.configuration.scopes.join(' '),
        force_confirm: 'yes',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      stage?.('waiting');
      void this.configuration
        .openBrowser(url.href)
        .catch(() =>
          finish(undefined, new ApplicationError(applicationErrorCodes.externalApplicationFailed)),
        );
    });
    stage?.('exchanging');
    return this.tokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      signal,
    );
  }
  public refresh(bundle: OAuthBundle, signal?: AbortSignal): Promise<OAuthBundle> {
    if (!bundle.refreshToken || bundle.clientId !== this.configuration.clientId)
      return Promise.reject(new ApplicationError(applicationErrorCodes.oauthRequired));
    return this.tokenRequest(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: bundle.refreshToken }),
      signal,
      bundle,
    );
  }
  private async tokenRequest(
    body: URLSearchParams,
    signal?: AbortSignal,
    previous?: OAuthBundle,
  ): Promise<OAuthBundle> {
    const client = new HttpClient();
    this.clients.add(client);
    try {
      body.set('client_id', this.configuration.clientId);
      const bytes = Buffer.from(body.toString());
      const pending = client.start(
        new URL(this.configuration.tokenEndpoint),
        'POST',
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(bytes.length),
        },
        signal,
      );
      pending.request.end(bytes);
      const response = await pending.response;
      const text = await readHttpBody(response, 65536);
      if (response.statusCode !== 200)
        throw new ApplicationError(
          response.statusCode === 400 || response.statusCode === 401 || response.statusCode === 403
            ? applicationErrorCodes.oauthRequired
            : applicationErrorCodes.connectionFailed,
        );
      const result = z
        .object({
          token_type: z.literal('bearer'),
          access_token: token,
          refresh_token: token.optional(),
          expires_in: z.number().finite().positive().optional(),
          scope: z.string().optional(),
        })
        .parse(JSON.parse(text));
      if (
        result.scope &&
        !this.configuration.scopes.every((scope) => result.scope?.split(' ').includes(scope))
      )
        throw new ApplicationError(applicationErrorCodes.oauthRequired);
      return oauthBundleSchema.parse({
        accessToken: result.access_token,
        clientId: this.configuration.clientId,
        ...(result.refresh_token || previous?.refreshToken
          ? { refreshToken: result.refresh_token ?? previous?.refreshToken }
          : {}),
        ...(result.expires_in ? { expiresAt: Date.now() + result.expires_in * 1000 } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ApplicationError(applicationErrorCodes.providerCancelled);
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(applicationErrorCodes.connectionFailed);
    } finally {
      client.close();
      this.clients.delete(client);
    }
  }
  public dispose(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
    for (const entry of this.pending.values())
      entry.finish(undefined, new ApplicationError(applicationErrorCodes.providerCancelled));
    this.pending.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
    this.listening = undefined;
  }
}
