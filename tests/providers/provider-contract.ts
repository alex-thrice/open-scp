import type { ProviderPath } from '@shared/models/provider-path';
import type { FileSystemProvider } from '@shared/providers/file-system-provider';
import { ProviderError, providerErrorCodes } from '@shared/providers/provider-error';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface ProviderContractHarness {
  readonly dispose: () => Promise<void>;
  readonly path: (...segments: readonly string[]) => ProviderPath;
  readonly provider: FileSystemProvider;
  readonly root: ProviderPath;
}

export type ProviderContractHarnessFactory = () => Promise<ProviderContractHarness>;

const writeChunks = async (
  provider: FileSystemProvider,
  destination: ProviderPath,
  chunks: readonly Uint8Array[],
): Promise<void> => {
  const stream = await provider.openWrite(destination, { overwrite: false });
  const writer = stream.getWriter();

  for (const chunk of chunks) {
    await writer.write(chunk);
  }

  await writer.close();
};

const readAll = async (provider: FileSystemProvider, source: ProviderPath): Promise<Uint8Array> => {
  const stream = await provider.openRead(source);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    chunks.push(result.value);
    totalLength += result.value.byteLength;
  }

  const content = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return content;
};

const expectProviderErrorCode = async (
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> => {
  try {
    await operation;
    throw new Error(`Expected provider error ${expectedCode}.`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProviderError);

    if (error instanceof ProviderError) {
      expect(error.code).toBe(expectedCode);
    }
  }
};

export const runFileSystemProviderContractTests = (
  providerName: string,
  createHarness: ProviderContractHarnessFactory,
): void => {
  describe(`${providerName} provider contract`, () => {
    let harness: ProviderContractHarness | undefined;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      if (harness !== undefined) {
        await harness.provider.disconnect();
        await harness.dispose();
      }
    });

    const getHarness = (): ProviderContractHarness => {
      if (harness === undefined) {
        throw new Error('Provider contract harness was not initialized.');
      }

      return harness;
    };

    it('enforces the connection lifecycle', async () => {
      const currentHarness = getHarness();
      expect(currentHarness.provider.connectionState).toBe('disconnected');
      await expectProviderErrorCode(
        currentHarness.provider.stat(currentHarness.root),
        providerErrorCodes.notConnected,
      );

      await currentHarness.provider.connect();
      expect(currentHarness.provider.connectionState).toBe('connected');
      await expect(currentHarness.provider.stat(currentHarness.root)).resolves.toMatchObject({
        kind: 'directory',
      });

      await currentHarness.provider.disconnect();
      expect(currentHarness.provider.connectionState).toBe('disconnected');
    });

    it('advertises capabilities used to enable provider commands', () => {
      const { capabilities } = getHarness().provider;

      expect(capabilities.createDirectory).toBe(true);
      expect(capabilities.delete).toBe(true);
      expect(capabilities.read).toBe(true);
      expect(capabilities.rename).toBe(true);
      expect(capabilities.trueDirectories).toBe(getHarness().provider.kind !== 's3');
      if (getHarness().provider.kind === 's3' || getHarness().provider.kind === 'ftp') {
        expect(capabilities.atomicRename).toBe(false);
        expect(capabilities.symbolicLinks).toBe(false);
        expect(capabilities.permissions).toBe(false);
      }
      if (getHarness().provider.kind === 'ftp') {
        expect(capabilities.resumeRead).toBe(false);
        expect(capabilities.resumeWrite).toBe(false);
      }
      expect(capabilities.write).toBe(true);
    });

    it('supports directory, streaming, rename, list, stat, and recursive delete operations', async () => {
      const currentHarness = getHarness();
      const directoryPath = currentHarness.path('Unicode каталог');
      const originalPath = currentHarness.path('Unicode каталог', 'file with spaces.txt');
      const renamedPath = currentHarness.path('Unicode каталог', 'renamed.txt');
      const firstChunk = new TextEncoder().encode('first ');
      const secondChunk = new TextEncoder().encode('second');
      await currentHarness.provider.connect();
      await currentHarness.provider.createDirectory(directoryPath);
      await writeChunks(currentHarness.provider, originalPath, [firstChunk, secondChunk]);

      await expect(currentHarness.provider.stat(originalPath)).resolves.toMatchObject({
        kind: 'file',
        name: 'file with spaces.txt',
        size: BigInt(firstChunk.byteLength + secondChunk.byteLength),
      });
      await expect(
        readAll(currentHarness.provider, originalPath).then((content) => [...content]),
      ).resolves.toEqual([...new TextEncoder().encode('first second')]);

      await currentHarness.provider.rename(originalPath, renamedPath);
      await expectProviderErrorCode(
        currentHarness.provider.stat(originalPath),
        providerErrorCodes.notFound,
      );
      await expect(currentHarness.provider.list(directoryPath)).resolves.toEqual([
        expect.objectContaining({ kind: 'file', name: 'renamed.txt' }),
      ]);
      await expectProviderErrorCode(
        currentHarness.provider.delete(directoryPath, { recursive: false }),
        providerErrorCodes.conflict,
      );

      await currentHarness.provider.delete(directoryPath, { recursive: true });
      await expectProviderErrorCode(
        currentHarness.provider.stat(directoryPath),
        providerErrorCodes.notFound,
      );
    });

    it('normalizes missing entries and destination conflicts', async () => {
      const currentHarness = getHarness();
      const directoryPath = currentHarness.path('conflict');
      await currentHarness.provider.connect();
      await expectProviderErrorCode(
        currentHarness.provider.stat(currentHarness.path('missing')),
        providerErrorCodes.notFound,
      );

      await currentHarness.provider.createDirectory(directoryPath);
      await expectProviderErrorCode(
        currentHarness.provider.createDirectory(directoryPath),
        providerErrorCodes.conflict,
      );
    });

    it('honors cancellation before a potentially long operation', async () => {
      const currentHarness = getHarness();
      const abortController = new AbortController();
      await currentHarness.provider.connect();
      abortController.abort();

      await expectProviderErrorCode(
        currentHarness.provider.list(currentHarness.root, {
          signal: abortController.signal,
        }),
        providerErrorCodes.cancelled,
      );
    });
  });
};
