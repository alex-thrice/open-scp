import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applicationErrorCodes } from '@shared/errors/application-error';
import type {
  IpcEventEnvelope,
  IpcResponseEnvelope,
  LocalDirectoryChangedEvent,
  LocalDirectoryWatchRequest,
} from '@shared/ipc/contracts';
import { ApplicationError } from './application-error';
import { correlationIdSchema } from './schemas';
import { createValidatedIpcHandler } from './validated-handler';

export interface LocalDirectoryWatchHandlerOptions {
  readonly isAllowed: () => boolean;
  readonly validateDirectory: (path: string) => Promise<unknown>;
  readonly subscribe: (path: string, listener: () => void) => () => void;
  readonly sendChanged: (event: IpcEventEnvelope<LocalDirectoryChangedEvent>) => void;
}

export interface LocalDirectoryWatchHandler {
  readonly handle: (request: unknown) => Promise<IpcResponseEnvelope<null>>;
  readonly dispose: () => void;
}

interface DirectorySubscription {
  readonly token: symbol;
  readonly unsubscribe: () => void;
}

export const createLocalDirectoryWatchHandler = (
  options: LocalDirectoryWatchHandlerOptions,
): LocalDirectoryWatchHandler => {
  const subscriptions = new Map<string, DirectorySubscription>();
  const pending = new Map<string, symbol>();
  let disposed = false;
  const handle = createValidatedIpcHandler<LocalDirectoryWatchRequest, null>({
    requestSchema: z.strictObject({
      correlationId: correlationIdSchema,
      payload: z.strictObject({
        subscriptionId: z.string().min(1).max(128),
        path: z.string().min(1).max(32_768).nullable(),
      }),
    }),
    responseSchema: z.null(),
    handle: async ({ subscriptionId, path }) => {
      if (disposed || !options.isAllowed())
        throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
      if (path === null) {
        pending.delete(subscriptionId);
        subscriptions.get(subscriptionId)?.unsubscribe();
        subscriptions.delete(subscriptionId);
        return null;
      }

      const token = Symbol();
      pending.set(subscriptionId, token);
      try {
        await options.validateDirectory(path);
        if (disposed || pending.get(subscriptionId) !== token) return null;
        if (!options.isAllowed())
          throw new ApplicationError(applicationErrorCodes.invalidIpcPayload);
        const unsubscribe = options.subscribe(path, () => {
          if (
            !disposed &&
            options.isAllowed() &&
            subscriptions.get(subscriptionId)?.token === token
          ) {
            options.sendChanged({
              correlationId: randomUUID(),
              payload: { subscriptionId, path },
            });
          }
        });
        const previous = subscriptions.get(subscriptionId);
        subscriptions.set(subscriptionId, { token, unsubscribe });
        previous?.unsubscribe();
        return null;
      } finally {
        if (pending.get(subscriptionId) === token) pending.delete(subscriptionId);
      }
    },
  });

  return {
    handle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pending.clear();
      for (const subscription of subscriptions.values()) subscription.unsubscribe();
      subscriptions.clear();
    },
  };
};
