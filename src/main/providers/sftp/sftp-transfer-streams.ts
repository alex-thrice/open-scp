import type {
  ProviderOperationOptions,
  WriteOptions,
} from '@shared/providers/file-system-provider';
import { ProviderError, providerErrorCodes } from '@shared/providers/provider-error';

export const sftpTransferChunkSize = 64 * 1024;

interface SftpHandleOperations {
  close(): Promise<void>;
}

interface SftpWriteOperations extends SftpHandleOperations {
  write(buffer: Buffer, position: number): Promise<void>;
}

interface SftpReadOperations extends SftpHandleOperations {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
}

const cancelled = (operation: 'read' | 'write') =>
  new ProviderError(providerErrorCodes.cancelled, { provider: 'sftp', operation });

export const createSftpWriteStream = (
  operations: SftpWriteOperations,
  initialPosition: number,
  concurrency: number,
  options: WriteOptions,
): WritableStream<Uint8Array> => {
  let position = initialPosition;
  let stopped = false;
  let failure: unknown;
  let closePromise: Promise<void> | undefined;
  let controller: WritableStreamDefaultController;
  const pending = new Set<Promise<void>>();
  const close = (): Promise<void> => {
    stopped = true;
    options.signal?.removeEventListener('abort', abort);
    closePromise ??= (async () => {
      await Promise.all(pending);
      await operations.close();
    })();
    return closePromise;
  };
  const fail = (error: unknown) => {
    failure ??= error;
    // Ошибка потока становится видимой только после завершения отправленных запросов.
    void close()
      .catch(() => undefined)
      .then(() => controller.error(failure));
  };
  const abort = () => fail(cancelled('write'));
  const check = () => {
    if (failure) throw failure;
    if (options.signal?.aborted || stopped) throw cancelled('write');
  };
  return new WritableStream<Uint8Array>(
    {
      start: (streamController) => {
        controller = streamController;
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      },
      write: async (chunk) => {
        try {
          check();
          for (let offset = 0; offset < chunk.byteLength; offset += sftpTransferChunkSize) {
            while (pending.size >= concurrency) {
              await Promise.race(pending);
              check();
            }
            check();
            const buffer = Buffer.from(chunk.subarray(offset, offset + sftpTransferChunkSize));
            const writePosition = position;
            position += buffer.length;
            if (!Number.isSafeInteger(position))
              throw new ProviderError(providerErrorCodes.invalidPath, {
                provider: 'sftp',
                operation: 'write',
              });
            const task = operations
              .write(buffer, writePosition)
              .then(() => {
                if (!stopped) options.onProgress?.(buffer.length);
              })
              .catch(fail);
            pending.add(task);
            void task.then(() => pending.delete(task));
          }
        } catch (error) {
          failure ??= error;
          await close().catch(() => undefined);
          throw failure;
        }
      },
      close: async () => {
        // close() завершает очередь; успешные ответы ещё должны обновлять прогресс.
        await Promise.all(pending);
        await close().catch((error: unknown) => {
          failure ??= error;
        });
        if (failure) throw failure;
        if (options.signal?.aborted) throw cancelled('write');
      },
      abort: async () => {
        await close().catch(() => undefined);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: sftpTransferChunkSize }),
  );
};

export const createSftpReadStream = (
  operations: SftpReadOperations,
  initialPosition: number,
  size: number,
  concurrency: number,
  options?: ProviderOperationOptions,
): ReadableStream<Uint8Array> => {
  let position = initialPosition;
  let stopped = false;
  let failure: unknown;
  let closePromise: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const pending = new Set<Promise<Buffer | undefined>>();
  const queued: Promise<Buffer | undefined>[] = [];
  const close = (): Promise<void> => {
    stopped = true;
    options?.signal?.removeEventListener('abort', abort);
    closePromise ??= (async () => {
      await Promise.all(pending);
      queued.length = 0;
      await operations.close();
    })();
    return closePromise;
  };
  const abort = () => {
    failure ??= cancelled('read');
    void close()
      .catch(() => undefined)
      .then(() => controller.error(failure));
  };
  const fill = () => {
    while (!stopped && !failure && queued.length < concurrency && position < size) {
      const start = position;
      const length = Math.min(sftpTransferChunkSize, size - start);
      position += length;
      const task = (async () => {
        const buffer = Buffer.allocUnsafe(length);
        let used = 0;
        // Сервер вправе вернуть короткий блок: дочитываем его без пропусков в файле.
        while (used < length) {
          if (stopped || options?.signal?.aborted) throw cancelled('read');
          const bytes = await operations.read(buffer, used, length - used, start + used);
          if (!Number.isInteger(bytes) || bytes <= 0 || bytes > length - used)
            throw new ProviderError(providerErrorCodes.ioError, {
              provider: 'sftp',
              operation: 'read',
            });
          used += bytes;
        }
        return buffer;
      })().catch((error: unknown) => {
        failure ??= error;
        return undefined;
      });
      pending.add(task);
      queued.push(task);
      void task.then(() => pending.delete(task));
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start: (streamController) => {
        controller = streamController;
        options?.signal?.addEventListener('abort', abort, { once: true });
        if (options?.signal?.aborted) abort();
      },
      pull: async () => {
        try {
          if (failure) throw failure;
          if (stopped) return;
          fill();
          const next = queued.shift();
          if (!next) {
            await close();
            controller.close();
            return;
          }
          const buffer = await next;
          if (failure) throw failure;
          if (stopped) return;
          if (buffer) controller.enqueue(buffer);
        } catch (error) {
          await close().catch(() => undefined);
          controller.error(error);
        }
      },
      cancel: () => close().catch(() => undefined),
    },
    { highWaterMark: 1 },
  );
};
