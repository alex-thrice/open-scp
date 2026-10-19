import { applicationErrorCodes } from '@shared/errors/application-error';
import { ApplicationError } from '../../ipc/application-error';
import type { WriteOptions } from '@shared/providers/file-system-provider';
import { readHttpBody } from '../../oauth/http-client';
import { GoogleApi, googleFailure, googleStatusError, normalizeGoogleError } from './google-api';

export const googleChunkSize = 1024 * 1024;
export interface GoogleUploadSession {
  readonly url: URL;
  readonly id: string;
  readonly total: number;
  readonly originalVersion?: string;
  offset: number;
  sent: number;
  completed: boolean;
}
const completedUpload = (value: unknown, session: GoogleUploadSession): boolean =>
  value !== null &&
  typeof value === 'object' &&
  'id' in value &&
  value.id === session.id &&
  'size' in value &&
  typeof value.size === 'string' &&
  /^\d+$/u.test(value.size) &&
  BigInt(value.size) === BigInt(session.total);
const acceptedOffset = (range: string | undefined, maximum: number): number => {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > maximum)
    throw googleFailure('ioError', 'write');
  return offset;
};
export const queryGoogleUpload = async (
  api: GoogleApi,
  session: GoogleUploadSession,
  signal?: AbortSignal,
): Promise<number> => {
  const response = await api.raw(session.url, 'PUT', 'write', signal, {
    'Content-Length': '0',
    'Content-Range': `bytes */${session.total}`,
  });
  const body = await readHttpBody(response);
  const status = response.statusCode ?? 0;
  if (status === 404 || status === 410)
    throw new ApplicationError(applicationErrorCodes.unsafeResume);
  if (status === 200 || status === 201) {
    const value: unknown = JSON.parse(body);
    if (!completedUpload(value, session) || session.sent !== session.total)
      throw googleFailure('ioError', 'write');
    session.offset = session.total;
    session.completed = true;
  } else if (status === 308) {
    const offset = acceptedOffset(response.headers.range, session.sent);
    if (offset < session.offset || (offset === session.total && session.total > 0))
      throw googleFailure('ioError', 'write');
    session.offset = offset;
  } else throw googleStatusError(status, body, 'write');
  return session.offset;
};
export const googleUploadStream = (
  api: GoogleApi,
  session: GoogleUploadSession,
  options: WriteOptions,
  beforeClose: () => Promise<void>,
): WritableStream<Uint8Array> => {
  let buffer = Buffer.alloc(0);
  let received = session.offset;
  let aborted = false;
  const send = async (final: boolean) => {
    try {
      if (aborted || options.signal?.aborted) throw googleFailure('cancelled', 'write');
      const length = final ? buffer.length : googleChunkSize;
      const start = session.offset;
      const end = start + length;
      if (session.completed) {
        if (length !== 0) throw googleFailure('conflict', 'write');
        return;
      }
      session.sent = Math.max(session.sent, end);
      const response = await api.raw(
        session.url,
        'PUT',
        'write',
        options.signal,
        {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(length),
          'Content-Range': length
            ? `bytes ${start}-${end - 1}/${session.total}`
            : `bytes */${session.total}`,
        },
        buffer.subarray(0, length),
      );
      const body = await readHttpBody(response);
      const status = response.statusCode ?? 0;
      let offset: number;
      if (status === 308) {
        offset = acceptedOffset(response.headers.range, end);
        if (offset <= start || offset === session.total) throw googleFailure('ioError', 'write');
      } else if ((status === 200 || status === 201) && final && end === session.total) {
        const value: unknown = JSON.parse(body);
        if (!completedUpload(value, session)) throw googleFailure('ioError', 'write');
        offset = session.total;
        session.completed = true;
      } else {
        if (status === 404 || status === 410)
          throw new ApplicationError(applicationErrorCodes.unsafeResume);
        throw googleStatusError(status, body, 'write');
      }
      buffer = Buffer.from(buffer.subarray(offset - start));
      session.offset = offset;
      options.onProgress?.(offset - start);
    } catch (error) {
      throw normalizeGoogleError(error, 'write', options.signal);
    }
  };
  return new WritableStream<Uint8Array>(
    {
      write: async (chunk) => {
        if (aborted || options.signal?.aborted) throw googleFailure('cancelled', 'write');
        if (received + chunk.length > session.total) throw googleFailure('ioError', 'write');
        for (let offset = 0; offset < chunk.length; offset += googleChunkSize) {
          const part = chunk.subarray(offset, offset + googleChunkSize);
          buffer = Buffer.concat([buffer, part]);
          received += part.length;
          while (buffer.length > googleChunkSize) await send(false);
        }
      },
      close: async () => {
        if (received !== session.total) throw googleFailure('ioError', 'write');
        if (!session.completed) await beforeClose();
        do {
          await send(true);
        } while (!session.completed);
        buffer = Buffer.alloc(0);
      },
      abort: () => {
        aborted = true;
        buffer = Buffer.alloc(0);
      },
    },
    { highWaterMark: 1 },
  );
};
