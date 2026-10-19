import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../ipc/application-error';

export interface HttpPending {
  readonly request: ClientRequest;
  readonly response: Promise<IncomingMessage>;
  abort(): void;
}

export class HttpClient {
  private readonly http = new HttpAgent({ keepAlive: true, maxSockets: 4 });
  private readonly https = new HttpsAgent({ keepAlive: true, maxSockets: 4 });
  private readonly active = new Set<ClientRequest>();
  private closed = false;
  public start(
    url: URL,
    method: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    timeout = 30000,
  ): HttpPending {
    if (this.closed || signal?.aborted)
      throw new ApplicationError(applicationErrorCodes.providerCancelled);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method,
      headers,
      agent: url.protocol === 'https:' ? this.https : this.http,
    });
    this.active.add(request);
    const abort = () =>
      request.destroy(new ApplicationError(applicationErrorCodes.providerCancelled));
    const timer = setTimeout(() => request.destroy(new Error('HTTP_TIMEOUT')), timeout);
    request.once('socket', (socket) => {
      if (!socket.connecting) clearTimeout(timer);
      else
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () =>
          clearTimeout(timer),
        );
    });
    request.setTimeout(timeout, () => request.destroy(new Error('HTTP_TIMEOUT')));
    signal?.addEventListener('abort', abort, { once: true });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (message) => {
        message.on('error', () => undefined);
        resolve(message);
      });
    });
    void response.catch(() => undefined);
    request.once('close', () => {
      clearTimeout(timer);
      this.active.delete(request);
      signal?.removeEventListener('abort', abort);
    });
    return { request, response, abort };
  }
  public close(): void {
    this.closed = true;
    for (const request of this.active)
      request.destroy(new ApplicationError(applicationErrorCodes.providerCancelled));
    this.active.clear();
    this.http.destroy();
    this.https.destroy();
  }
}

export const readHttpBody = async (response: IncomingMessage, limit = 2097152): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) {
      response.destroy();
      throw new Error('HTTP_BODY_LIMIT');
    }
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
};

export const cancellableDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApplicationError(applicationErrorCodes.providerCancelled));
      return;
    }
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new ApplicationError(applicationErrorCodes.providerCancelled));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
