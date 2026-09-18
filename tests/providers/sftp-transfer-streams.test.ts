// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createSftpReadStream,
  createSftpWriteStream,
  sftpTransferChunkSize,
} from '../../src/main/providers/sftp/sftp-transfer-streams';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const writeFixture = (concurrency: number, signal?: AbortSignal) => {
  const requests: {
    buffer: Buffer;
    position: number;
    result: ReturnType<typeof deferred<boolean>>;
  }[] = [];
  const close = vi.fn(async () => undefined);
  const onProgress = vi.fn();
  const writer = createSftpWriteStream(
    {
      write: (buffer, position) => {
        const result = deferred<boolean>();
        requests.push({ buffer, position, result });
        return result.promise.then(() => undefined);
      },
      close,
    },
    17,
    concurrency,
    { overwrite: true, onProgress, ...(signal ? { signal } : {}) },
  ).getWriter();
  void writer.closed.catch(() => undefined);
  return { writer, requests, close, onProgress };
};

describe('bounded SFTP upload pipeline', () => {
  it('sends a window without acknowledgements, owns its buffers, and drains before close', async () => {
    const { writer, requests, close, onProgress } = writeFixture(64);
    const chunk = Buffer.alloc(sftpTransferChunkSize, 0x75);
    for (let index = 0; index < 64; index += 1) await writer.write(chunk);
    chunk.fill(0);
    expect(requests).toHaveLength(64);
    expect(requests[0]?.buffer[0]).toBe(0x75);
    expect(requests[63]?.position).toBe(17 + 63 * sftpTransferChunkSize);
    expect(onProgress).not.toHaveBeenCalled();
    const finished = writer.close();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    for (const request of [...requests].reverse()) request.result.resolve(true);
    await finished;
    expect(close).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(64);
    expect(onProgress.mock.calls.reduce((sum, [bytes]) => sum + Number(bytes), 0)).toBe(
      64 * chunk.length,
    );
  });

  it('bounds a large input chunk and waits for all writes after an out-of-order failure', async () => {
    const { writer, requests, close } = writeFixture(2);
    const writing = writer.write(Buffer.alloc(4 * sftpTransferChunkSize));
    const rejected = expect(writing).rejects.toThrow('permission denied');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[0]?.result.resolve(true);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[1]?.result.reject(new Error('permission denied'));
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    requests[2]?.result.resolve(true);
    await rejected;
    expect(requests).toHaveLength(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure after write resolved and never publishes an early close', async () => {
    const { writer, requests, close } = writeFixture(2);
    await writer.write(Buffer.alloc(2 * sftpTransferChunkSize));
    const closed = expect(writer.closed).rejects.toThrow('late server error');
    requests[1]?.result.reject(new Error('late server error'));
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    requests[0]?.result.resolve(true);
    await closed;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('preserves the write failure when closing the handle also fails', async () => {
    const { writer, requests, close } = writeFixture(1);
    close.mockRejectedValue(new Error('connection lost during close'));
    await writer.write(Buffer.from('payload'));
    const finished = expect(writer.close()).rejects.toThrow('access denied');
    requests[0]?.result.reject(new Error('access denied'));
    await finished;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels an idle buffered stream only after outstanding requests settle', async () => {
    const controller = new AbortController();
    const { writer, requests, close, onProgress } = writeFixture(2, controller.signal);
    await writer.write(Buffer.alloc(2 * sftpTransferChunkSize));
    const closed = expect(writer.closed).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    controller.abort();
    expect(close).not.toHaveBeenCalled();
    for (const request of requests) request.result.resolve(true);
    await closed;
    expect(onProgress).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('waits for pending writes on explicit abort and propagates CLOSE errors', async () => {
    const fixture = writeFixture(1);
    await fixture.writer.write(Buffer.from('payload'));
    const aborted = fixture.writer.abort();
    await Promise.resolve();
    expect(fixture.close).not.toHaveBeenCalled();
    fixture.requests[0]?.result.resolve(true);
    await aborted;
    expect(fixture.close).toHaveBeenCalledTimes(1);
    const writer = createSftpWriteStream(
      {
        write: async () => undefined,
        close: async () => {
          throw new Error('close failed');
        },
      },
      0,
      1,
      { overwrite: true },
    ).getWriter();
    await expect(writer.close()).rejects.toThrow('close failed');
  });
});

describe('bounded SFTP download pipeline', () => {
  it('orders out-of-order responses and completes short reads at their original offsets', async () => {
    const content = Buffer.alloc(sftpTransferChunkSize * 4 + 37);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    const first = deferred<boolean>();
    const positions: number[] = [];
    const close = vi.fn(async () => undefined);
    const reader = createSftpReadStream(
      {
        read: async (buffer, offset, length, position) => {
          positions.push(position);
          if (position === 13) await first.promise;
          const bytes = Math.min(length, 8191);
          content.copy(buffer, offset, position, position + bytes);
          return bytes;
        },
        close,
      },
      13,
      content.length,
      3,
    ).getReader();
    const reading = reader.read();
    await vi.waitFor(() => expect(positions).toContain(13 + 2 * sftpTransferChunkSize));
    expect(positions).not.toContain(13 + 3 * sftpTransferChunkSize);
    first.resolve(true);
    const firstPart = await reading;
    if (firstPart.done) throw new Error('Unexpected end of test file.');
    const chunks: Uint8Array[] = [firstPart.value];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
    }
    expect(Buffer.concat(chunks)).toEqual(content.subarray(13));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drains outstanding reads before cancellation closes the handle', async () => {
    const requests: ReturnType<typeof deferred<number>>[] = [];
    const close = vi.fn(async () => undefined);
    const reader = createSftpReadStream(
      {
        read: () => {
          const result = deferred<number>();
          requests.push(result);
          return result.promise;
        },
        close,
      },
      0,
      sftpTransferChunkSize * 10,
      3,
    ).getReader();
    const reading = reader.read();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const cancellation = reader.cancel();
    expect(close).not.toHaveBeenCalled();
    requests.forEach((result) => result.resolve(sftpTransferChunkSize));
    await cancellation;
    await expect(reading).resolves.toMatchObject({ done: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
  });

  it('rejects premature EOF instead of silently skipping part of the file', async () => {
    const close = vi.fn(async () => undefined);
    const reader = createSftpReadStream({ read: async () => 0, close }, 0, 100, 2).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: 'PROVIDER_IO_ERROR' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
