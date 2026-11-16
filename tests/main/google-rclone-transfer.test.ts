// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalProvider } from '../../src/main/providers/local/local-provider';
import { TransferEngine } from '../../src/main/transfers/transfer-engine';
import {
  createGoogleProviderPath,
  createLocalProviderPath,
} from '../../src/shared/models/provider-path';
import { startGoogleFixture } from '../fixtures/google-fixture';

it('reviews a Google overwrite when the destination changes during streaming and preserves external content', async () => {
  const fixture = await startGoogleFixture();
  const google = fixture.create();
  const localRoot = join(fixture.root, 'local');
  const destinationFile = join(fixture.root, 'google', 'file.txt');
  const destinationPath = createGoogleProviderPath('/file.txt');
  await mkdir(localRoot);
  await writeFile(join(localRoot, 'file.txt'), 'new upload content');
  await writeFile(destinationFile, 'original destination');
  const local = new LocalProvider({ rootPath: localRoot });
  const engine = new TransferEngine();
  try {
    await google.connect();
    await local.connect();
    const original = await google.stat(destinationPath);
    const openWrite = google.openWrite.bind(google);
    const writeSpy = vi.spyOn(google, 'openWrite').mockImplementationOnce(async (path, options) => {
      const writer = (await openWrite(path, options)).getWriter();
      let isChanged = false;
      return new WritableStream<Uint8Array>({
        write: async (chunk) => {
          await writer.write(chunk);
          if (!isChanged) {
            isChanged = true;
            await writeFile(destinationFile, 'external change that must survive');
          }
        },
        close: async () => {
          try {
            await writer.close();
          } finally {
            writer.releaseLock();
          }
        },
        abort: async (reason) => {
          try {
            await writer.abort(reason);
          } finally {
            writer.releaseLock();
          }
        },
      });
    });
    const id = engine.enqueue({
      source: local,
      destination: google,
      sourcePath: createLocalProviderPath(join(localRoot, 'file.txt')),
      destinationPath,
      workspaceId: 'local',
      direction: 'upload',
      conflictPolicy: 'overwrite',
    });
    await vi.waitFor(
      () => {
        expect(engine.snapshots().find((item) => item.id === id)).toMatchObject({
          state: 'requiring-review',
          conflictPath: '/file.txt',
          conflictPolicy: 'ask',
        });
      },
      { timeout: 15000, interval: 20 },
    );
    expect(writeSpy).toHaveBeenCalledWith(
      destinationPath,
      expect.objectContaining({ versionTag: original.versionTag, overwrite: true }),
    );
    expect(await readFile(destinationFile, 'utf8')).toBe('external change that must survive');
    expect((await google.list(createGoogleProviderPath('/'))).map((entry) => entry.name)).toEqual([
      'file.txt',
    ]);
  } finally {
    engine.dispose();
    await google.disconnect();
    await local.disconnect();
    await fixture.close();
  }
}, 30000);
