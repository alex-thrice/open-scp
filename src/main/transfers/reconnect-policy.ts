import { serializeApplicationError } from '../ipc/application-error';

export type ErrorCategory = 'transient' | 'auth' | 'conflict' | 'permanent';

export const classifyTransferError = (error: unknown): ErrorCategory => {
  const code = serializeApplicationError(error).code;
  if (
    [
      'PROVIDER_IO_ERROR',
      'PROVIDER_NOT_CONNECTED',
      'CONNECTION_FAILED',
      'RCLONE_TIMEOUT',
      'S3_DNS',
    ].includes(code)
  )
    return 'transient';
  if (
    [
      'AUTHENTICATION_FAILED',
      'RCLONE_AUTHENTICATION',
      'CREDENTIAL_REQUIRED',
      'HOST_KEY_UNKNOWN',
      'HOST_KEY_CHANGED',
      'PROVIDER_ACCESS_DENIED',
    ].includes(code)
  )
    return 'auth';
  if (['PROVIDER_CONFLICT', 'UNSAFE_RESUME'].includes(code)) return 'conflict';
  return 'permanent';
};

export const reconnectDelay = (attempt: number, random = Math.random): number =>
  Math.round(Math.min(4000, 250 * 2 ** Math.min(attempt, 4)) * (0.75 + random() * 0.5));

export const waitForReconnect = (attempt: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, reconnectDelay(attempt));
    signal.addEventListener('abort', done, { once: true });
  });
